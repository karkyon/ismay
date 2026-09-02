/**
 * PEM Execution Session Persistence(Phase 0B-2)。
 * 出典: ISMAY_PEMサブシステム_統合正本仕様書_v4_0 7.1節・7.2節・7.3節。
 *
 * Phase 0B(初版)のsessionProjection.ts/sessionQuery.tsは、ExecutionSessionを
 * 都度計算するだけの一時的な投影(db非保存)だった。v4.0 7.2節はこれをinsert-onlyの
 * ExecutionSessionIdentity/ExecutionSessionRevisionとして永続化することを要求する。
 * 本ファイルはその永続化層を実装する(sessionQuery.tsの旧経路は後方互換のため残す)。
 *
 * 決定論性についての設計判断: 進行中(OPEN)セッションのrawElapsedSecondsは、
 * 「現時点(now)」ではなく「今回処理した最後のEventのeffectiveOccurredAt」を基準に
 * 計算する。壁時計時刻を基準にすると、同じEvent列に対して呼び出しタイミングごとに
 * 異なる値になり、v4.0 7.3節「同じ入力・versionに対する再実行は同一内容を生成する」
 * という決定論要件に違反するため。projectAndPersistExecutionSessions()は
 * transitions/route.tsのトランザクション内、Execution Event記録直後に呼ばれる想定
 * (=呼び出しは常に「新しいEventが1件増えた」タイミングと一致する)。
 */
import { db } from "@/lib/db";
import type { Prisma } from "@/generated/prisma/client";
import {
  computeExecutionSessions,
  deriveExecutionPresence,
  type ExecutionPresence,
} from "./sessionProjection";
import type { PemAuthorizationContext } from "./authorizationBoundary";

export const SESSION_DERIVATION_VERSION = "v1";

/** v4.0原本に正式な値集合の記載が無いため、7.1節・7.3節本文の記述から導出した
 * (schema.prismaのExecutionSessionRevisionコメント参照)。 */
export const SESSION_REVISION_STATUSES = ["OPEN", "CLOSED_CONFIRMED", "CLOSED_UNCONFIRMED"] as const;
export type SessionRevisionStatus = (typeof SESSION_REVISION_STATUSES)[number];

/** v4.0 7.3節の確定終了トリガー + TIMEOUT(推定終了。PEM-SESSION-TIMEOUTで
 * 実装済み。worker/sessionTimeoutJob.ts参照)。 */
export const SESSION_END_REASONS = [
  "INTERRUPT",
  "DEFER",
  "SWITCH_OUT",
  "COMPLETE",
  "AUTO_PAUSE_CONFIRMED",
  "TIMEOUT",
] as const;
export type SessionEndReason = (typeof SESSION_END_REASONS)[number];

type SessionDbClient = typeof db | Prisma.TransactionClient;

interface RevisionContent {
  status: SessionRevisionStatus;
  startedAt: Date;
  endedAt: Date | null;
  endReason: SessionEndReason | null;
  rawElapsedSeconds: number;
  measurementQuality: string;
  qualityReasonCodes: string[];
}

function contentEquals(a: RevisionContent, b: RevisionContent): boolean {
  return (
    a.status === b.status &&
    a.startedAt.getTime() === b.startedAt.getTime() &&
    (a.endedAt?.getTime() ?? null) === (b.endedAt?.getTime() ?? null) &&
    a.endReason === b.endReason &&
    a.rawElapsedSeconds === b.rawElapsedSeconds &&
    a.measurementQuality === b.measurementQuality &&
    JSON.stringify(a.qualityReasonCodes) === JSON.stringify(b.qualityReasonCodes)
  );
}

/**
 * 指定Responsibilityの全ExecutionEventからSessionを再計算し、内容が変わった
 * 論理SessionについてのみExecutionSessionRevisionを追記する(insert-only)。
 * transitions/route.tsのトランザクション内、Execution Event記録直後から呼ぶ想定。
 * PEM同意が無い等でExecution Event自体が記録されなかった場合は呼び出し元が
 * このスキップを判断する(本関数はEvent Ledgerの状態のみを見て動く)。
 */
export async function projectAndPersistExecutionSessions(
  tx: Prisma.TransactionClient,
  ctx: PemAuthorizationContext,
  responsibilityId: string,
): Promise<void> {
  const events = await tx.responsibilityExecutionEvent.findMany({
    where: { responsibilityId, workspaceId: ctx.tenantId },
    orderBy: { responsibilitySequence: "asc" },
    select: {
      id: true,
      eventType: true,
      fromState: true,
      toState: true,
      effectiveOccurredAt: true,
      occurredAtQuality: true,
      responsibilitySequence: true,
    },
  });
  if (events.length === 0) return;

  const lastEventOccurredAt = events[events.length - 1]!.effectiveOccurredAt;
  const sessions = computeExecutionSessions(responsibilityId, events);

  for (const session of sessions) {
    const status: SessionRevisionStatus = session.isOpen ? "OPEN" : "CLOSED_CONFIRMED";
    const endReason = session.closedByEventType as SessionEndReason | null;
    const asOfForElapsed = session.endedAt ?? lastEventOccurredAt;
    const rawElapsedSeconds = Math.round(
      (asOfForElapsed.getTime() - session.startedAt.getTime()) / 1000,
    );
    const qualityReasonCodes: string[] = session.anomalyDetected ? ["NEGATIVE_DURATION_DETECTED"] : [];

    const content: RevisionContent = {
      status,
      startedAt: session.startedAt,
      endedAt: session.endedAt,
      endReason,
      rawElapsedSeconds,
      measurementQuality: session.measurementQuality,
      qualityReasonCodes,
    };

    const identity = await tx.executionSessionIdentity.upsert({
      where: {
        workspaceId_startEventId: { workspaceId: ctx.tenantId, startEventId: session.startEventId },
      },
      create: {
        workspaceId: ctx.tenantId,
        subjectUserId: ctx.subjectUserId,
        responsibilityId,
        startEventId: session.startEventId,
      },
      update: {},
    });

    const latestRevision = await tx.executionSessionRevision.findFirst({
      where: { sessionIdentityId: identity.id },
      orderBy: { revision: "desc" },
    });

    if (
      latestRevision &&
      contentEquals(content, {
        status: latestRevision.status as SessionRevisionStatus,
        startedAt: latestRevision.startedAt,
        endedAt: latestRevision.endedAt,
        endReason: latestRevision.endReason as SessionEndReason | null,
        rawElapsedSeconds: latestRevision.rawElapsedSeconds,
        measurementQuality: latestRevision.measurementQuality,
        qualityReasonCodes: (latestRevision.qualityReasonCodes as unknown as string[] | null) ?? [],
      })
    ) {
      continue; // 内容不変。insert-onlyの重複Revisionを増やさない。
    }

    await tx.executionSessionRevision.create({
      data: {
        sessionIdentityId: identity.id,
        revision: (latestRevision?.revision ?? 0) + 1,
        derivationVersion: SESSION_DERIVATION_VERSION,
        status: content.status,
        startedAt: content.startedAt,
        endedAt: content.endedAt,
        endReason: content.endReason,
        rawElapsedSeconds: content.rawElapsedSeconds,
        correctedActiveSeconds: null,
        measurementMode: "EXECUTION_LEDGER_ONLY",
        measurementQuality: content.measurementQuality,
        qualityReasonCodes: content.qualityReasonCodes,
        timeZoneId: null,
        utcOffsetMinutes: null,
        supersedesRevisionId: latestRevision?.id ?? null,
      },
    });
  }
}

/**
 * v4.0 7.1節。Responsibility単位の現在のexecutionPresenceを返す。
 * 「直近に開始したSession Identityの最新Revision」のstatusから導出する
 * (同時に開けるSessionは高々1つのため、これで十分)。
 */
export async function getExecutionPresence(
  ctx: PemAuthorizationContext,
  responsibilityId: string,
  client: SessionDbClient = db,
): Promise<ExecutionPresence> {
  const latestIdentity = await client.executionSessionIdentity.findFirst({
    where: { workspaceId: ctx.tenantId, responsibilityId },
    orderBy: { createdAt: "desc" },
    select: { id: true },
  });
  if (!latestIdentity) return deriveExecutionPresence(null);

  const latestRevision = await client.executionSessionRevision.findFirst({
    where: { sessionIdentityId: latestIdentity.id },
    orderBy: { revision: "desc" },
    select: { status: true },
  });
  return deriveExecutionPresence(latestRevision?.status ?? null);
}

/**
 * [PEM-SESSION-TIMEOUT新設] v4.0 7.1節「timeoutは`CLOSED_UNCONFIRMED`として
 * Sessionだけを閉じ、責任状態を変えない」。開いたまま一定時間経過したSessionを
 * 検出し、TIMEOUT終了として新しいRevisionを追記する(insert-only、既存
 * projectAndPersistExecutionSessionsと同じ設計)。
 *
 * [未確定事項の扱い] v4.0原本にタイムアウト閾値の具体的数値は明記されていない
 * (SESSION_REVISION_STATUSES同様「正式な記載が無い」状況)。想像で数値を断定
 * せず、呼び出し元(Worker)が既定値または環境変数由来の値を明示的に渡す設計に
 * する(このファイル自体はデフォルト値を持たない純粋なパラメータ受け取り関数)。
 *
 * [決定論性] endedAtは「タイムアウト検出時のnow」ではなく「startedAt+
 * timeoutMs」に固定する。これによりtimeoutMsが変わらない限り、同じセッションに
 * 対して複数回この関数を呼んでも同一のendedAt/rawElapsedSecondsを生成できる
 * (projectAndPersistExecutionSessionsの決定論性方針を踏襲)。
 *
 * DOC-05(Execution Event・Session Projection仕様書) 14.2節
 * 「SESSION_TIMEOUT_CLOSEをExecution Ledgerへ保存しない」に従い、
 * ResponsibilityExecutionEventは作成しない(Session Revisionのみ追記する)。
 *
 * @param timeoutMs 呼び出し元が指定するタイムアウト閾値(ミリ秒)。
 * @param now 判定基準時刻(テスト容易性のため注入可能。既定は実行時のnow)。
 */
export async function closeTimedOutSessions(
  timeoutMs: number,
  now: Date = new Date(),
): Promise<{ closedCount: number }> {
  if (!(timeoutMs > 0)) {
    throw new Error("closeTimedOutSessions: timeoutMsは正の数である必要があります");
  }
  const cutoff = new Date(now.getTime() - timeoutMs);

  // 最新Revisionがstatus="OPEN"かつstartedAtがcutoffより前のSessionIdentityを
  // 検出する。ExecutionSessionRevisionはinsert-onlyのため「最新」はrevision最大だが、
  // まず候補を広く絞り込み(status="OPEN"のrevisionを1件以上持つ)、各Identityごとに
  // 本当に「最新」revisionがOPENのままかを個別に再確認する(下のループ内)。
  const candidates = await db.executionSessionIdentity.findMany({
    where: {
      revisions: {
        some: { status: "OPEN", startedAt: { lt: cutoff } },
      },
    },
    select: { id: true },
  });

  let closedCount = 0;
  for (const identity of candidates) {
    const latestRevision = await db.executionSessionRevision.findFirst({
      where: { sessionIdentityId: identity.id },
      orderBy: { revision: "desc" },
    });
    // 最新revisionが既にOPENでない(他の経路で先にクローズ済み)、またはstartedAtが
    // cutoff以降(まだタイムアウトに達していない)なら対象外。
    if (!latestRevision || latestRevision.status !== "OPEN") continue;
    if (latestRevision.startedAt >= cutoff) continue;

    const endedAt = new Date(latestRevision.startedAt.getTime() + timeoutMs);
    const rawElapsedSeconds = Math.round(timeoutMs / 1000);

    await db.executionSessionRevision.create({
      data: {
        sessionIdentityId: identity.id,
        revision: latestRevision.revision + 1,
        derivationVersion: SESSION_DERIVATION_VERSION,
        status: "CLOSED_UNCONFIRMED",
        startedAt: latestRevision.startedAt,
        endedAt,
        endReason: "TIMEOUT",
        rawElapsedSeconds,
        correctedActiveSeconds: null,
        measurementMode: "EXECUTION_LEDGER_ONLY",
        // 推定終了(実際の終了イベントが無い)のためHIGH/MEDIUMを名乗らずLOWにする。
        measurementQuality: "LOW",
        // 統合正本v5.0 16.7節の正式語彙(coreTypes.ts QUALITY_REASON_CODES参照)。
        qualityReasonCodes: ["AUTO_TIMEOUT_ESTIMATE"],
        timeZoneId: null,
        utcOffsetMinutes: null,
        supersedesRevisionId: latestRevision.id,
      },
    });
    closedCount++;
  }

  return { closedCount };
}
