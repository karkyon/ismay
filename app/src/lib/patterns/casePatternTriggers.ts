/**
 * Case Pattern検出の欠落enqueue契機(PATTERN-DETECT-02B新設・2026-09-04)。
 * 出典: Claude向け_ISMAY_3b695d9以降_再監査是正・CasePattern実機能完遂指示_
 * 2026-09-04.md §4「欠落enqueue契機」。
 *
 * [対象2種のみ・想像で先行実装しない] このGateで配線するのは
 * RESPONSIBILITY_CORRECTED(Responsibility.title変更)と
 * EVIDENCE_EXCLUDED(Responsibility論理削除)の2種のみ。
 * PATTERN_REVISION_CHANGED/EMBEDDING_MODEL_CHANGED/
 * EMBEDDING_SOURCE_VERSION_CHANGED/MANUAL_REBUILDは、対応するtrigger配線元
 * (Pattern編集API・AI Provider設定変更経路・管理操作)の個別精査が必要な
 * ため、次Gateへ延期する。
 *
 * [なぜtitleのみか] Case Pattern候補テキストは
 * `${responsibility.type}: ${responsibility.title}`のみを使う
 * (casePatternDetectionService.ts candidateInputFor参照)。
 * `PATCH /api/v1/responsibilities/[id]`が編集可能なフィールドのうち、
 * このテキストに影響するのはtitleのみ(typeはPATCHの編集対象に含まれない
 * ことをsrc/app/api/v1/responsibilities/[id]/route.tsで確認済み)。
 * description等の変更はcandidate textに影響しないためenqueueしない
 * (無差別enqueueの禁止、指示書§4「全Correctionを無差別enqueueせず」)。
 */
import { db } from "@/lib/db";
import type { Prisma } from "@/generated/prisma/client";
import { enqueueCaseDetect } from "./caseDetectQueue";
import { excludeCasePatternSourceLinksForResponsibility } from "./sourceLinkService";

type PatternDbClient = typeof db | Prisma.TransactionClient;

/**
 * この責任(responsibilityId)がactiveなPRIMARY Linkを持つContextのowner本人を
 * 解決する。DR-A(sourceLinkService.tsのassertEligible)と同じ「同一
 * Responsibilityへの2件目のactive PRIMARYはapplication層で拒否される」
 * 前提(V5-M1-A1 invariant test確認済み)により、高々1件しか存在しない。
 * PRIMARY Linkが無ければnull(Case Pattern学習対象外のResponsibilityであり、
 * enqueue不要)。
 */
async function resolveOwnerForPrimaryLinkedResponsibility(
  txOrDb: PatternDbClient,
  workspaceId: string,
  responsibilityId: string,
): Promise<string | null> {
  const link = await txOrDb.projectContextLink.findFirst({
    where: { workspaceId, responsibilityId, role: "PRIMARY", unlinkedAt: null },
    select: { context: { select: { ownerSubjectUserId: true } } },
  });
  return link?.context.ownerSubjectUserId ?? null;
}

/**
 * `PATCH /api/v1/responsibilities/[id]`でtitleが実際に変化した直後に呼ぶ。
 * PRIMARY Linkが無ければ何もしない(このResponsibilityはCase Pattern学習の
 * eligible source対象外のため)。
 */
export async function enqueueCaseDetectForResponsibilityCorrection(
  txOrDb: PatternDbClient,
  params: { workspaceId: string; responsibilityId: string },
): Promise<void> {
  const ownerSubjectUserId = await resolveOwnerForPrimaryLinkedResponsibility(
    txOrDb,
    params.workspaceId,
    params.responsibilityId,
  );
  if (!ownerSubjectUserId) return;
  await enqueueCaseDetect(txOrDb, {
    workspaceId: params.workspaceId,
    ownerSubjectUserId,
    reasonCode: "RESPONSIBILITY_CORRECTED",
  });
}

/**
 * `DELETE /api/v1/responsibilities/[id]`(論理削除)の直後に呼ぶ。この
 * Responsibilityに紐づく既存CasePatternSourceLinkを除外し、影響を受けた
 * 全ownerへEVIDENCE_EXCLUDEDでenqueueする(worker側で
 * computeAndPersistCasePatternAggregatesForOwnerが再実行され、
 * raw/weighted/confidenceが減算される)。
 */
export async function enqueueCaseDetectForResponsibilityDeletion(
  txOrDb: PatternDbClient,
  params: { workspaceId: string; responsibilityId: string },
): Promise<void> {
  const { affectedOwnerIds } = await excludeCasePatternSourceLinksForResponsibility(txOrDb, {
    workspaceId: params.workspaceId,
    responsibilityId: params.responsibilityId,
    reason: "RESPONSIBILITY_DELETED",
  });
  for (const ownerSubjectUserId of affectedOwnerIds) {
    await enqueueCaseDetect(txOrDb, {
      workspaceId: params.workspaceId,
      ownerSubjectUserId,
      reasonCode: "EVIDENCE_EXCLUDED",
    });
  }
}
