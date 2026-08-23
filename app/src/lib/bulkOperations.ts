import { db } from "@/lib/db";
import { debugServer } from "@/lib/debugServer";
import { transitionsForType, isTypeSpecificTerminalStatus } from "@/lib/responsibility";

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
}

/** workspaceIdスコープで対象を取得する(IDOR対策。他Workspaceのidが混ざっていても無視される)。 */
async function fetchTargets(ids: string[], workspaceId: string): Promise<TargetRow[]> {
  return db.responsibility.findMany({
    where: { id: { in: ids }, workspaceId },
    select: { id: true, type: true, status: true, completedAt: true, deletedAt: true },
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
    await db.responsibility.update({
      where: { id: t.id },
      data: { status: nextStatus, completedAt: now, updatedById: userId, version: { increment: 1 } },
    });
    await db.eventLog.create({
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

/** POST /bulk/undo本体。undoペイロードの種類ごとに元へ戻す。 */
export async function executeUndo(payload: UndoPayload, workspaceId: string): Promise<{ restored: number }> {
  if (payload.action === "COMPLETE") {
    const ids = payload.snapshot.map((s) => s.id);
    const targets = await fetchTargets(ids, workspaceId);
    const validIds = new Set(targets.map((t) => t.id));
    let restored = 0;
    for (const s of payload.snapshot) {
      if (!validIds.has(s.id)) continue;
      await db.responsibility.update({
        where: { id: s.id },
        data: { status: s.status, completedAt: s.completedAt ? new Date(s.completedAt) : null, version: { increment: 1 } },
      });
      restored++;
    }
    return { restored };
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
