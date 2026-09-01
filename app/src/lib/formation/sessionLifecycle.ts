import { createHash } from "node:crypto";
import { db } from "@/lib/db";
import type { Prisma } from "@/generated/prisma/client";
import {
  resolveFormationSessionTransition,
  isValidFormationSessionTransitionTriple,
  type FormationSessionState,
  type FormationEventType,
} from "@/lib/formation/coreTypes";

/**
 * V5-M1-B6B Session Lifecycle(defer/dismiss/resume/retry)。
 * 出典: Claude向け ISMAY 69b5a87以降 監査是正・M1-B6完遂・PEM-0連続実装指示
 *       (2026-08-31) Gate M1-B6B。統合正本§6.3の状態遷移表(coreTypes.ts
 *       FORMATION_SESSION_TRANSITIONS)をそのまま実装する。
 *
 * [設計方針] materialize.tsのmaterializeFormationSession/recordCandidateDecisionと
 * 同じ不変条件パターンを踏襲する: Session行FOR UPDATE lock、version CAS、
 * clientEventId+requestHashのidempotency(tx外事前確認+tx内race-safe再確認)。
 *
 * [RESUMEの状態復元について・最重要] 「推測で常にREVIEW_READYへ戻さない」
 * (指示書)。DEFERRED状態のSessionは、必ず直前にこのfileのdeferFormationSession
 * (またはdismissFormationSessionと対になるdefer相当操作)を経由しており、
 * その際にformation_session_lifecycle_eventsへ(action=DEFER, fromState=<defer
 * 直前の実状態>)を記録している。resumeFormationSessionは、そのSessionの
 * 直近のDEFER行のfromStateを実際に検索して使う(想像で"REVIEW_READY"等の
 * 固定値を返さない)。PARTIALLY_CONFIRMEDからdeferした場合はfromState=
 * PARTIALLY_CONFIRMEDと記録されるが、coreTypes.tsの遷移表はRESUME先として
 * REVIEW_READYしか持たない(guard「defer前がREVIEW_READY/PARTIALLY_CONFIRMED」)
 * ため、その場合はREVIEW_READYへ解決する(想定される唯一の遷移表適合先)。
 *
 * [scope・2026-08-31時点] RETRYは状態遷移(FAILED→ANALYZING)とEvent記録のみを
 * 行う。「同じSessionで新AiRunを作る」実際のAI再抽出の起動(既存extract.ts
 * パイプラインの呼出し)は、この関数の呼出し元(API route)の責務とする
 * (この関数はDB transaction内で完結する必要があり、外部AI呼出しをtx内に
 * 混在させると長時間lockの危険・AI課金テスト制約の両方に反するため、
 * 意図的に分離する)。DISMISSはREVIEW_READY起点(DISMISS_ALL)のみを対象とし、
 * PARTIALLY_CONFIRMED起点のRESOLVE_REMAINING(残りpendingの個別解決を伴う、
 * より複雑な操作)はscope外とする(このfileのコメント末尾参照)。
 */

export interface SessionLifecycleActionParams {
  sessionId: string;
  workspaceId: string;
  clientEventId: string;
  actorUserId: string;
  reasonCode?: string;
  /** [M1-B6C-4新設・2026-09-01指示書§6.1「optimistic concurrency」] クライアントが
   *  直前に見ていたFormationSession.version。Session行lock後にDBの実際のversionと
   *  一致しない場合はVERSION_CONFLICTで拒否する(materialize.ts/answerService.tsと
   *  同じ楽観ロック契約)。 */
  expectedVersion: number;
}

export type SessionLifecycleActionResult =
  | { ok: true; replay: boolean; fromState: FormationSessionState; toState: FormationSessionState }
  | { ok: false; error: "NOT_FOUND" }
  | { ok: false; error: "INVALID_SESSION_STATE"; sessionState: FormationSessionState }
  | { ok: false; error: "IDEMPOTENCY_KEY_REUSED" }
  | { ok: false; error: "VERSION_CONFLICT"; latestVersion: number }
  | { ok: false; error: "COREYPES_TRANSITION_UNDEFINED" };

function computeLifecycleRequestHash(input: {
  sessionId: string;
  workspaceId: string;
  action: string;
  reasonCode?: string;
  expectedVersion: number;
}): string {
  return createHash("sha256")
    .update(
      JSON.stringify({
        sessionId: input.sessionId,
        workspaceId: input.workspaceId,
        action: input.action,
        reasonCode: input.reasonCode ?? null,
        // [M1-B6C-4新設] expectedVersionをrequestHashへ含める。同一clientEventIdで
        // 異なるexpectedVersion(=異なる前提状態)から送られた場合、それは
        // 「同じ要求の再送」ではなく別の要求とみなし、IDEMPOTENCY_KEY_REUSEDで
        // 拒否する(materialize.tsのrequestHash B31-02是正と同じ設計判断)。
        expectedVersion: input.expectedVersion,
      }),
    )
    .digest("hex");
}

/**
 * 共通実装。DEFER/DISMISS/RESUME/RETRYの4操作は「Session行lock→idempotency
 * 確認→state guard→coreTypes遷移表で遷移先を決める→state更新→lifecycle event
 * +timeline event記録」という同一shapeを持つため、遷移先解決部分だけを
 * 呼出し元から注入する。
 */
async function runSessionLifecycleAction(
  params: SessionLifecycleActionParams,
  action: "DEFER" | "DISMISS" | "RESUME" | "RETRY",
  timelineEventType: FormationEventType,
  resolveTarget: (
    tx: Prisma.TransactionClient,
    session: { id: string; workspaceId: string; state: string },
  ) => Promise<{ ok: true; toState: FormationSessionState } | { ok: false; error: SessionLifecycleActionResult }>,
): Promise<SessionLifecycleActionResult> {
  const { sessionId, workspaceId, clientEventId, actorUserId, reasonCode, expectedVersion } = params;
  const requestHash = computeLifecycleRequestHash({ sessionId, workspaceId, action, reasonCode, expectedVersion });

  const existing = await db.formationSessionLifecycleEvent.findFirst({ where: { workspaceId, clientEventId } });
  if (existing) {
    if (existing.requestHash !== requestHash) {
      return { ok: false, error: "IDEMPOTENCY_KEY_REUSED" };
    }
    return {
      ok: true,
      replay: true,
      fromState: existing.fromState as FormationSessionState,
      toState: existing.toState as FormationSessionState,
    };
  }

  return await db.$transaction(async (tx: Prisma.TransactionClient) => {
    const sessionRows = await tx.$queryRaw<{ id: string; workspaceId: string; state: string; version: number }[]>`
      SELECT id, workspace_id AS "workspaceId", state, version FROM formation_sessions
      WHERE id = ${sessionId} AND workspace_id = ${workspaceId}
      FOR UPDATE`;
    const session = sessionRows[0];
    if (!session) return { ok: false, error: "NOT_FOUND" } as const;

    // [race-safe] lock獲得後の再確認(materialize.ts B3.1是正と同じ設計)。
    const existingInTx = await tx.formationSessionLifecycleEvent.findFirst({ where: { workspaceId, clientEventId } });
    if (existingInTx) {
      if (existingInTx.requestHash !== requestHash) {
        return { ok: false, error: "IDEMPOTENCY_KEY_REUSED" } as const;
      }
      return {
        ok: true,
        replay: true,
        fromState: existingInTx.fromState as FormationSessionState,
        toState: existingInTx.toState as FormationSessionState,
      } as const;
    }

    // [M1-B6C-4新設・§6.1] version CAS。idempotency確認(上記existingInTx)を
    // 通過した=新規リクエストであることが確定した後にのみ検証する。これにより、
    // 「versionが既に進んだ後の同一内容replay」は(idempotency一致により)この
    // チェックへ到達せず常に同じ結果を返し続ける(指示書§6.1「idempotent replay
    // はversionが進んだ後でも同じ結果」を満たす)。新規リクエストのみが実際の
    // 楽観ロックの対象になる。state guard(resolveTarget)より先に検証する:
    // クライアントの前提versionが古い場合、それに基づくstate判断自体が古い
    // 情報に基づいている可能性があるため、より根本的な不整合を先に報告する。
    if (session.version !== expectedVersion) {
      return { ok: false, error: "VERSION_CONFLICT", latestVersion: session.version } as const;
    }

    const resolved = await resolveTarget(tx, session);
    if (!resolved.ok) return resolved.error;

    await tx.formationSession.update({
      where: { id: sessionId },
      data: { state: resolved.toState, version: { increment: 1 } },
    });

    await tx.formationSessionLifecycleEvent.create({
      data: {
        workspaceId,
        sessionId,
        clientEventId,
        requestHash,
        action,
        fromState: session.state,
        toState: resolved.toState,
        reasonCode: reasonCode ?? null,
        actorUserId,
      },
    });

    const lastSequenceRow = await tx.formationSessionEvent.findFirst({
      where: { workspaceId, sessionId },
      orderBy: { sequence: "desc" },
      select: { sequence: true },
    });
    await tx.formationSessionEvent.create({
      data: {
        workspaceId,
        sessionId,
        sequence: (lastSequenceRow?.sequence ?? 0) + 1,
        eventType: timelineEventType,
        actorType: "USER",
        actorUserId,
        payload: { fromState: session.state, toState: resolved.toState, reasonCode: reasonCode ?? null },
      },
    });

    return {
      ok: true,
      replay: false,
      fromState: session.state as FormationSessionState,
      toState: resolved.toState,
    } as const;
  });
}

/** REVIEW_READY/CLARIFYING --DEFER_SESSION--> DEFERRED、PARTIALLY_CONFIRMED --DEFER_REMAINING--> DEFERRED。 */
export async function deferFormationSession(params: SessionLifecycleActionParams): Promise<SessionLifecycleActionResult> {
  return runSessionLifecycleAction(params, "DEFER", "SESSION_DEFERRED", async (_tx, session) => {
    const operation =
      session.state === "PARTIALLY_CONFIRMED"
        ? "DEFER_REMAINING"
        : session.state === "CLARIFYING" || session.state === "REVIEW_READY"
          ? "DEFER_SESSION"
          : null;
    if (!operation) {
      return { ok: false, error: { ok: false, error: "INVALID_SESSION_STATE", sessionState: session.state as FormationSessionState } };
    }
    const toState = resolveFormationSessionTransition(session.state, operation);
    if (!toState) {
      return { ok: false, error: { ok: false, error: "COREYPES_TRANSITION_UNDEFINED" } };
    }
    return { ok: true, toState };
  });
}

/**
 * REVIEW_READY --DISMISS_ALL--> DISMISSED。
 * [scope・上部コメント参照] PARTIALLY_CONFIRMED起点のRESOLVE_REMAINING→DISMISSED
 * (残りpending候補の個別解決を伴う)はこの関数のscope外。
 */
export async function dismissFormationSession(params: SessionLifecycleActionParams): Promise<SessionLifecycleActionResult> {
  return runSessionLifecycleAction(params, "DISMISS", "SESSION_DISMISSED", async (_tx, session) => {
    if (session.state !== "REVIEW_READY") {
      return { ok: false, error: { ok: false, error: "INVALID_SESSION_STATE", sessionState: session.state as FormationSessionState } };
    }
    const toState = resolveFormationSessionTransition(session.state, "DISMISS_ALL");
    if (!toState) {
      return { ok: false, error: { ok: false, error: "COREYPES_TRANSITION_UNDEFINED" } };
    }
    return { ok: true, toState };
  });
}

/**
 * DEFERRED --RESUME--> {ANALYZING|CLARIFYING|REVIEW_READY}。
 * [是正の核心・ファイル冒頭コメント参照] 遷移先は直近のDEFER lifecycle event
 * のfromStateを実際に検索して決める(想像で固定値を返さない)。
 */
export async function resumeFormationSession(params: SessionLifecycleActionParams): Promise<SessionLifecycleActionResult> {
  return runSessionLifecycleAction(params, "RESUME", "SESSION_RESUMED", async (tx, session) => {
    if (session.state !== "DEFERRED") {
      return { ok: false, error: { ok: false, error: "INVALID_SESSION_STATE", sessionState: session.state as FormationSessionState } };
    }
    const lastDefer = await tx.formationSessionLifecycleEvent.findFirst({
      where: { workspaceId: session.workspaceId, sessionId: session.id, action: "DEFER" },
      orderBy: { occurredAt: "desc" },
    });
    // [防御的分岐] DEFERRED状態のSessionには必ず対になるDEFER lifecycle eventが
    // 存在するはずだが(このfile経由でのみDEFERREDへ遷移できる)、万一見つからない
    // 場合は「defer前の状態が不明」という事実を隠さず、想像でREVIEW_READYへ
    // fallbackしない。
    const deferredFromState = lastDefer?.fromState;
    if (!deferredFromState) {
      return { ok: false, error: { ok: false, error: "COREYPES_TRANSITION_UNDEFINED" } };
    }
    // coreTypes.ts遷移表: DEFERRED--RESUME-->{ANALYZING|CLARIFYING|REVIEW_READY}。
    // PARTIALLY_CONFIRMEDからのdeferはREVIEW_READYへ解決する(guard「defer前が
    // REVIEW_READY/PARTIALLY_CONFIRMED」、遷移表にPARTIALLY_CONFIRMEDという
    // to値自体が存在しないため)。
    const target: FormationSessionState = deferredFromState === "PARTIALLY_CONFIRMED" ? "REVIEW_READY" : (deferredFromState as FormationSessionState);
    if (!isValidFormationSessionTransitionTriple("DEFERRED", "RESUME", target)) {
      return { ok: false, error: { ok: false, error: "COREYPES_TRANSITION_UNDEFINED" } };
    }
    return { ok: true, toState: target };
  });
}

/**
 * FAILED --RETRY--> ANALYZING。
 * [scope・ファイル冒頭コメント参照] 実際の新AiRun起動はこの関数のtx外(呼出元
 * API route)の責務。
 */
export async function retryFormationSession(params: SessionLifecycleActionParams): Promise<SessionLifecycleActionResult> {
  return runSessionLifecycleAction(params, "RETRY", "SESSION_RETRIED", async (_tx, session) => {
    if (session.state !== "FAILED") {
      return { ok: false, error: { ok: false, error: "INVALID_SESSION_STATE", sessionState: session.state as FormationSessionState } };
    }
    const toState = resolveFormationSessionTransition(session.state, "RETRY");
    if (!toState) {
      return { ok: false, error: { ok: false, error: "COREYPES_TRANSITION_UNDEFINED" } };
    }
    return { ok: true, toState };
  });
}
