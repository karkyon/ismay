/**
 * PEM Evidence Deletion Event(Phase 0C-2)。
 * 出典: ISMAY_PEMサブシステム_統合正本仕様書_v4_0 16.3節、
 *       PHASE_0G_COMPATIBILITY_LEDGER.md「PemObservation.deletedAt」行。
 *
 * 設計方針: Phase 0S consent.tsのgetConsentStateと同じ「insert-onlyイベント→
 * 都度投影」パターンを踏襲する。PemObservationへの論理削除は、行への直接UPDATEを
 * やめ、本イベントの追記のみで表現する。「削除済みかどうか」は都度、対象idの
 * 削除イベント有無から導出する(投影。専用の真偽値列はテーブルへ持たない)。
 *
 * スコープ: 現時点でtargetTypeはPEM_OBSERVATIONのみ(衝突台帳がフラグしているのは
 * PemObservation.deletedAtのみのため。PemHypothesis.deletedAt(forget機能)は
 * 別の未フラグ事項であり、本パッチでは変更しない)。
 */
import { db } from "@/lib/db";
import type { EvidenceDeletionMode } from "./coreTypes";

export type DeletableEvidenceTargetType = "PEM_OBSERVATION";

/**
 * 削除イベントを追記する(insert-only)。targetIdsが空なら何もしない。
 * 一括操作(POST /pem/reset等)からも呼べるよう、targetIdsは配列で受け取る。
 */
export async function recordEvidenceDeletionEvents(
  userId: string,
  targetType: DeletableEvidenceTargetType,
  targetIds: readonly string[],
  deletionMode: EvidenceDeletionMode,
  reason?: string,
): Promise<void> {
  if (targetIds.length === 0) return;
  await db.pemEvidenceDeletionEvent.createMany({
    data: targetIds.map((targetId) => ({
      userId,
      targetType,
      targetId,
      deletionMode,
      reason,
    })),
  });
}

/**
 * 現在削除済み(=1件以上の削除イベントが存在する)targetIdの集合を返す(投影)。
 * userIdを省略した場合は全ユーザー横断(recomputeAggregates等のバッチ処理向け。
 * 削除イベントのtargetId=PemObservation.idはグローバルに一意なため、
 * userIdでの絞り込みは性能上の最適化であり正しさには影響しない)。
 */
export async function getDeletedEvidenceIds(
  targetType: DeletableEvidenceTargetType,
  userId?: string,
): Promise<Set<string>> {
  const rows = await db.pemEvidenceDeletionEvent.findMany({
    where: { targetType, ...(userId ? { userId } : {}) },
    select: { targetId: true },
  });
  return new Set((rows as { targetId: string }[]).map((r) => r.targetId));
}
