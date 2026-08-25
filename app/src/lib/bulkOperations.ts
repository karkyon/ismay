import { randomUUID, createHash } from "node:crypto";
import type { Prisma } from "@/generated/prisma/client";
import { db } from "@/lib/db";
import { debugServer } from "@/lib/debugServer";
import { transitionsForType, isTypeSpecificTerminalStatus } from "@/lib/responsibility";
import { buildPemAuthorizationContext } from "@/lib/pem/authorizationBoundary";
import { recordExecutionLedgerEvent } from "@/lib/pem/executionLedger";
import { projectAndPersistExecutionSessions } from "@/lib/pem/sessionPersistence";
import { isExecutionLedgerApplicableType } from "@/lib/pem/eventDefinitionRegistry";
import {
  buildCompleteUndoIdempotencyKey,
  buildCompleteUndoRequestPayloadHash,
  decideCompleteUndoAction,
  IdempotencyKeyReusedError,
} from "@/lib/bulkCompleteUndoDecision";

// [2026-08-25是正・db非依存テストとの分離] 実際の判定ロジック(純粋関数、
// db.ts非依存)はbulkCompleteUndoDecision.tsへ移した。呼び出し元
// (bulk/undo/route.ts、テストコード)のimport経路の互換性のため、ここから再exportする。
export { buildCompleteUndoIdempotencyKey, buildCompleteUndoRequestPayloadHash, IdempotencyKeyReusedError };

/**
 * FN-WK-04 一括操作(2026-08-23新設)。
 * 出典: Webシステム要件定義書v2.1 FR-WK-09「一括操作を提供する。対象件数と影響を確認し、
 * 誤操作を取り消せる」、システム基本設計書v1.2 API-RESP-06。
 *
 * [設計判断・2026-08-23] 「誤操作を取り消せる」をUndo専用テーブル無しで実現するため、
 * 各アクションの実行結果に「元に戻すための最小限の情報」を含めて返す
 * (ステートレスUndo)。フロントはその情報をそのままPOST /bulk/undoへ渡すだけでよい。
 *
 * [スコープ・2026-08-23] 今回実装するアクションはCOMPLETE/DELETE/ADD_TAG/REMOVE_TAGの
 * 4つ。DomainのSET_DOMAIN一括変更は、既存UI(ResponsibilitiesClient)にドメイン選択の
 * 導線が無く新規に追加するとスコープが大きく膨らむため、今回は見送る
 * (想像で新しいドメイン選択UIを作り込まない)。
 *
 * COMPLETEはDECISIONのみ対象外とする。DECISIONの完了(DECIDE)はreason(決定理由)の
 * 個別入力が要件上必須(Webシステム要件定義書v2.1 7.1節)であり、一括操作で理由を
 * 一律に付与するのは実質的な理由の形骸化を招くため、安全側に倒して除外する。
 */

export type BulkAction = "COMPLETE" | "DELETE" | "ADD_TAG" | "REMOVE_TAG";

export interface BulkSkip {
  id: string;
  reason: string;
}

export interface CompleteUndoPayload {
  action: "COMPLETE";
  snapshot: { id: string; status: string; completedAt: string | null }[];
}
export interface DeleteUndoPayload {
  action: "DELETE";
  ids: string[];
}
export interface TagUndoPayload {
  action: "ADD_TAG" | "REMOVE_TAG";
  ids: string[];
  tagId: string;
}
export type UndoPayload = CompleteUndoPayload | DeleteUndoPayload | TagUndoPayload;

export interface BulkResult {
  affected: number;
  skipped: BulkSkip[];
  undo: UndoPayload | null;
}

interface TargetRow {
  id: string;
  type: string;
  status: string;
  completedAt: Date | null;
  deletedAt: Date | null;
  /// [2026-08-25追加・Completion Gate 2] Execution Ledgerのversion整合に必要。
  version: number;
}

/** workspaceIdスコープで対象を取得する(IDOR対策。他Workspaceのidが混ざっていても無視される)。 */
async function fetchTargets(ids: string[], workspaceId: string): Promise<TargetRow[]> {
  return db.responsibility.findMany({
    where: { id: { in: ids }, workspaceId },
    select: { id: true, type: true, status: true, completedAt: true, deletedAt: true, version: true },
  });
}

/**
 * [2026-08-23バグ修正] 種別ごとの「完了」に相当するactionは統一されていない
 * (COMMON=COMPLETE、COMMITMENT=FULFILL、WAITING=RESOLVE、RISK=CLOSE)。
 * 当初の実装は固定で"COMPLETE"のみを探しており、種別固有型は常に
 * 「現在の状態からは一括完了できません」としてスキップされてしまっていた
 * (実質的にTASK/EVENT/CONCERN/HABIT/IDEAでしか一括完了が機能していなかった)。
 * これは設計コメント「COMPLETEはDECISIONのみ対象外とする」という意図と矛盾する
 * 実装上の見落としであり、全ソース総点検で発見・修正した。
 */
const COMPLETE_ACTION_BY_TYPE: Record<string, string> = {
  COMMITMENT: "FULFILL",
  WAITING: "RESOLVE",
  RISK: "CLOSE",
};
function completeActionFor(type: string): string {
  return COMPLETE_ACTION_BY_TYPE[type] ?? "COMPLETE";
}

async function bulkComplete(ids: string[], workspaceId: string, userId: string): Promise<BulkResult> {
  const targets = await fetchTargets(ids, workspaceId);
  const skipped: BulkSkip[] = [];
  const snapshot: CompleteUndoPayload["snapshot"] = [];
  const now = new Date();
  // [2026-08-25追加・Completion Gate 2、外部監査「Transition以外の状態変更経路の
  // 棚卸し」対応] 単一アイテムのtransitions/route.tsと同じくExecution Ledgerへ
  // 記録する。requestId/requestPayloadHashはバッチ全体で1つ発行する(バルク操作は
  // 1回のクライアント要求が複数Responsibilityへ及ぶため)。
  const pemCtx = await buildPemAuthorizationContext(userId, userId);
  const bulkRequestId = randomUUID();
  const bulkRequestPayloadHash = createHash("sha256")
    .update(JSON.stringify({ action: "BULK_COMPLETE", ids }))
    .digest("hex");

  for (const t of targets) {
    if (t.deletedAt) {
      skipped.push({ id: t.id, reason: "削除済みのため対象外" });
      continue;
    }
    if (isTypeSpecificTerminalStatus(t.type, t.status) || t.status === "COMPLETED") {
      skipped.push({ id: t.id, reason: "既に完了状態のため対象外" });
      continue;
    }
    if (t.type === "DECISION") {
      skipped.push({ id: t.id, reason: "判断は理由の記録が必須のため一括完了できません(個別に操作してください)" });
      continue;
    }
    const completeAction = completeActionFor(t.type);
    const rule = transitionsForType(t.type).find(
      (r) => r.action === completeAction && (r.from as readonly string[]).includes(t.status),
    );
    if (!rule) {
      skipped.push({ id: t.id, reason: "現在の状態からは一括完了できません(個別に操作してください)" });
      continue;
    }
    const nextStatus = typeof rule.to === "function" ? rule.to(t.status) : rule.to;
    // [2026-08-25改訂] 個別更新の羅列(部分失敗の余地あり)からトランザクションへ変更。
    // Execution Ledger記録がRegistry不整合等で例外を投げた場合、このResponsibility
    // 1件分のstatus変更・EventLog・Ledger記録が全てrollbackされる(他のidには影響しない)。
    await db.$transaction(async (tx: Prisma.TransactionClient) => {
      await tx.responsibility.update({
        where: { id: t.id },
        data: { status: nextStatus, completedAt: now, updatedById: userId, version: { increment: 1 } },
      });
      await tx.eventLog.create({
        data: {
          aggregateType: "Responsibility",
          aggregateId: t.id,
          eventType: "STATUS_CHANGED",
          beforeJson: { status: t.status },
          afterJson: { status: nextStatus, bulk: true },
          actorType: "USER",
          actorId: userId,
          reason: "一括操作による完了",
        },
      });
      const ledgerResult = await recordExecutionLedgerEvent({
        tx,
        ctx: pemCtx,
        responsibilityId: t.id,
        responsibilityType: t.type,
        action: completeAction,
        fromState: t.status,
        toState: nextStatus,
        versionBefore: t.version,
        versionAfter: t.version + 1,
        clientOccurredAt: now,
        actorType: "USER",
        source: "WEB",
        requestId: bulkRequestId,
        requestPayloadHash: bulkRequestPayloadHash,
      });
      if (ledgerResult) {
        await projectAndPersistExecutionSessions(tx, pemCtx, t.id);
      }
    });
    snapshot.push({ id: t.id, status: t.status, completedAt: t.completedAt?.toISOString() ?? null });
  }

  debugServer.event("bulkOperations/COMPLETE", "一括完了", { affected: snapshot.length, skipped: skipped.length });
  return {
    affected: snapshot.length,
    skipped,
    undo: snapshot.length > 0 ? { action: "COMPLETE", snapshot } : null,
  };
}

async function bulkDelete(ids: string[], workspaceId: string): Promise<BulkResult> {
  const targets = await fetchTargets(ids, workspaceId);
  const skipped: BulkSkip[] = [];
  const affectedIds: string[] = [];
  const now = new Date();

  for (const t of targets) {
    if (t.deletedAt) {
      skipped.push({ id: t.id, reason: "既に削除済み" });
      continue;
    }
    affectedIds.push(t.id);
  }
  if (affectedIds.length > 0) {
    await db.responsibility.updateMany({ where: { id: { in: affectedIds } }, data: { deletedAt: now } });
  }

  debugServer.event("bulkOperations/DELETE", "一括削除", { affected: affectedIds.length, skipped: skipped.length });
  return {
    affected: affectedIds.length,
    skipped,
    undo: affectedIds.length > 0 ? { action: "DELETE", ids: affectedIds } : null,
  };
}

async function bulkRestore(ids: string[]): Promise<void> {
  if (ids.length === 0) return;
  await db.responsibility.updateMany({ where: { id: { in: ids } }, data: { deletedAt: null } });
}

async function bulkTag(
  action: "ADD_TAG" | "REMOVE_TAG",
  ids: string[],
  workspaceId: string,
  tagId: string,
): Promise<BulkResult> {
  const tag = await db.tag.findFirst({ where: { id: tagId, workspaceId, deletedAt: null }, select: { id: true } });
  if (!tag) {
    return { affected: 0, skipped: ids.map((id) => ({ id, reason: "指定されたタグが見つかりません" })), undo: null };
  }

  const targets = await fetchTargets(ids, workspaceId);
  const existingLinks = await db.responsibilityTag.findMany({
    where: { responsibilityId: { in: targets.map((t) => t.id) }, tagId },
    select: { responsibilityId: true },
  });
  const linkedIds = new Set(existingLinks.map((l: { responsibilityId: string }) => l.responsibilityId));

  const skipped: BulkSkip[] = [];
  const affectedIds: string[] = [];

  if (action === "ADD_TAG") {
    for (const t of targets) {
      if (linkedIds.has(t.id)) {
        skipped.push({ id: t.id, reason: "既にこのタグが付与されています" });
        continue;
      }
      affectedIds.push(t.id);
    }
    if (affectedIds.length > 0) {
      await db.responsibilityTag.createMany({
        data: affectedIds.map((id) => ({ responsibilityId: id, tagId })),
        skipDuplicates: true,
      });
    }
  } else {
    for (const t of targets) {
      if (!linkedIds.has(t.id)) {
        skipped.push({ id: t.id, reason: "このタグは付与されていません" });
        continue;
      }
      affectedIds.push(t.id);
    }
    if (affectedIds.length > 0) {
      await db.responsibilityTag.deleteMany({ where: { responsibilityId: { in: affectedIds }, tagId } });
    }
  }

  debugServer.event(`bulkOperations/${action}`, "タグ一括操作", { affected: affectedIds.length, skipped: skipped.length });
  return {
    affected: affectedIds.length,
    skipped,
    undo: affectedIds.length > 0 ? { action, ids: affectedIds, tagId } : null,
  };
}

export async function executeBulkAction(params: {
  action: BulkAction;
  ids: string[];
  workspaceId: string;
  userId: string;
  tagId?: string;
}): Promise<BulkResult> {
  const { action, ids, workspaceId, userId, tagId } = params;
  switch (action) {
    case "COMPLETE":
      return bulkComplete(ids, workspaceId, userId);
    case "DELETE":
      return bulkDelete(ids, workspaceId);
    case "ADD_TAG":
    case "REMOVE_TAG":
      if (!tagId) return { affected: 0, skipped: ids.map((id) => ({ id, reason: "tagIdが必要です" })), undo: null };
      return bulkTag(action, ids, workspaceId, tagId);
  }
}

/**
 * [2026-08-25新設・Completion Gate 2.1、v4.0 8.1節「Correction」是正]
 * 従来はスナップショットの任意のstatusへ直接書き戻すだけで、Execution Ledgerの正本
 * (ResponsibilityExecutionEvent)には一切触れない「無音の改変」だった。これは
 * v4.0 8.1節が要求する「元Evidenceを更新せず、Correction Eventを追記する」に反する。
 *
 * 是正方針(想像で新しい語彙を発明しない):
 *  - Execution Ledger対象型(TASK/EVENT/CONCERN/HABIT/IDEA)かつ、取消対象のCOMPLETE
 *    Eventが実際にExecution Ledger上に見つかる場合のみ、既存のREOPEN語彙
 *    (Registry固定: COMPLETED/NOT_NEEDED→PLANNED)をそのまま再利用してExecution
 *    Ledgerへ記録する。「元のstatusへ戻す」という従来の挙動は、単一アイテムの
 *    REOPENアクション(常にPLANNEDへ戻り、元のstatusは復元しない)と挙動を揃える形で
 *    置き換える。
 *  - 上記に該当しない場合(COMMITMENT/WAITING/RISK等のExecution Ledger対象外型、
 *    または対象イベントが見つからない場合)は、従来通りスナップショットのstatusへ
 *    直接復元する(Execution Ledgerに対応語彙が無いため、これ以上の対応はしない)。
 *  - ResponsibilityLifecycleEventが記録されるのは、訂正対象の元COMPLETE Eventを
 *    実際に特定できた場合のみ(「いずれの場合も必ず記録する」わけではない)。
 *
 * 冪等性の判定はbulkCompleteUndoDecision.tsのdecideCompleteUndoActionへ分離済み
 * (既存Lifecycle Eventの有無を必ず現在statusの検査より先に確認する。理由は
 * decideCompleteUndoActionのコメントを参照)。
 */
async function executeCompleteUndo(
  payload: CompleteUndoPayload,
  workspaceId: string,
  userId: string,
): Promise<{ restored: number }> {
  const ids = payload.snapshot.map((s) => s.id);
  const targets = await fetchTargets(ids, workspaceId);
  const targetById = new Map(targets.map((t) => [t.id, t]));
  const pemCtx = await buildPemAuthorizationContext(userId, userId);

  let restored = 0;
  for (const s of payload.snapshot) {
    const t = targetById.get(s.id);
    if (!t) continue; // 対象が存在しない(他Workspace混入等。fetchTargetsで既に除外済み)

    const didCount = await db.$transaction(async (tx: Prisma.TransactionClient) => {
      // Execution Ledger対象型の場合のみ、取消対象の元COMPLETE Eventを探す。
      // [P0-1是正] このEvent探索・idempotencyKey算出は、現在のstatusに関わらず
      // 必ず先に行う(status検査はdecideCompleteUndoActionの中でのみ行う)。
      const originalCompleteEvent = isExecutionLedgerApplicableType(t.type)
        ? await tx.responsibilityExecutionEvent.findFirst({
            where: { workspaceId, responsibilityId: t.id, eventType: "COMPLETE" },
            orderBy: { responsibilitySequence: "desc" },
            select: { id: true },
          })
        : null;

      const requestPayloadHash = buildCompleteUndoRequestPayloadHash({
        responsibilityId: t.id,
        snapshotStatus: s.status,
        snapshotCompletedAt: s.completedAt,
      });
      // Execution Ledger対象外型、またはCOMPLETE Eventが見つからない場合(例:
      // PEM同意未取得により記録自体がスキップされていた)は、取消対象イベントを
      // 特定できないためidempotencyKeyを発行できない。この場合もUndo機能自体は
      // 提供するが、Lifecycle Eventとしては記録しない(既知のギャップ)。
      const undoIdempotencyKey = originalCompleteEvent
        ? buildCompleteUndoIdempotencyKey(t.id, originalCompleteEvent.id)
        : null;

      const existingLifecycleEvent = undoIdempotencyKey
        ? await tx.responsibilityLifecycleEvent.findFirst({
            where: { workspaceId, subjectUserId: userId, idempotencyKey: undoIdempotencyKey },
            select: { requestPayloadHash: true },
          })
        : null;

      const decision = decideCompleteUndoAction({
        currentStatus: t.status,
        existingLifecycleEvent,
        requestPayloadHash,
      });

      if (decision.kind === "REPLAY_SUCCESS") {
        // 同一key・同一payloadの再送: 何もせず、初回と同じ成功として数える。
        return true;
      }
      if (decision.kind === "REJECT_REUSED") {
        throw new IdempotencyKeyReusedError(
          "同一の取消対象に対して内容の異なる取消要求が送信されました",
        );
      }
      if (decision.kind === "SKIP_NOT_COMPLETED") {
        // 取消対象イベントが特定できない(Ledger対象外型等)場合はundoIdempotencyKeyが
        // nullのため冪等判定自体が働かない。その場合は従来通りCOMPLETED以外を
        // 単純にスキップする。
        return false;
      }

      // decision.kind === "APPLY"
      const useReopenVocabulary = Boolean(originalCompleteEvent);
      const nextStatus = useReopenVocabulary ? "PLANNED" : s.status;
      const nextCompletedAt = nextStatus === "PLANNED" ? null : s.completedAt ? new Date(s.completedAt) : null;

      const updateResult = await tx.responsibility.updateMany({
        where: { id: t.id, version: t.version },
        data: { status: nextStatus, completedAt: nextCompletedAt, updatedById: userId, version: { increment: 1 } },
      });
      // 楽観ロック競合(取消の直前に他操作でversionが進んでいた): このidはスキップする。
      if (updateResult.count === 0) return false;

      let resultingEventId: string | null = null;
      if (useReopenVocabulary) {
        const reopenEvent = await recordExecutionLedgerEvent({
          tx,
          ctx: pemCtx,
          responsibilityId: t.id,
          responsibilityType: t.type,
          action: "REOPEN",
          fromState: "COMPLETED",
          toState: "PLANNED",
          versionBefore: t.version,
          versionAfter: t.version + 1,
          clientOccurredAt: new Date(),
          actorType: "USER",
          source: "WEB",
          requestId: randomUUID(),
          requestPayloadHash,
          reason: "一括完了の取消(Undo)",
        });
        resultingEventId = reopenEvent?.id ?? null;
        if (reopenEvent) {
          await projectAndPersistExecutionSessions(tx, pemCtx, t.id);
        }
      }

      if (undoIdempotencyKey && originalCompleteEvent) {
        await tx.responsibilityLifecycleEvent.create({
          data: {
            workspaceId,
            subjectUserId: userId,
            responsibilityId: t.id,
            kind: "CORRECTION",
            correctionType: "REVOKE",
            correctionOfEventId: originalCompleteEvent.id,
            resultingEventId,
            fromState: "COMPLETED",
            toState: nextStatus,
            reason: "一括完了の取消(Undo)",
            actorType: "USER",
            actorUserId: userId,
            idempotencyKey: undoIdempotencyKey,
            requestPayloadHash,
          },
        });
      }
      return true;
    });
    if (didCount) restored++;
  }
  return { restored };
}

/** POST /bulk/undo本体。undoペイロードの種類ごとに元へ戻す。 */
export async function executeUndo(
  payload: UndoPayload,
  workspaceId: string,
  userId: string,
): Promise<{ restored: number }> {
  if (payload.action === "COMPLETE") {
    return executeCompleteUndo(payload, workspaceId, userId);
  }
  if (payload.action === "DELETE") {
    const targets = await fetchTargets(payload.ids, workspaceId);
    const validIds = targets.map((t) => t.id);
    await bulkRestore(validIds);
    return { restored: validIds.length };
  }
  // ADD_TAG/REMOVE_TAGの取り消しは逆操作を実行するだけでよい
  // (executeBulkActionのbulkTagは既存リンク有無を見て冪等に振る舞うため安全)。
  const inverse = payload.action === "ADD_TAG" ? "REMOVE_TAG" : "ADD_TAG";
  const result = await bulkTag(inverse, payload.ids, workspaceId, payload.tagId);
  return { restored: result.affected };
}
