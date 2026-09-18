/**
 * Case Pattern検出の欠落enqueue契機(PATTERN-DETECT-02B新設・2026-09-04、
 * PATTERN-DETECT-TRIGGERS-03でEMBEDDING_MODEL_CHANGED/MANUAL_REBUILDを追加)。
 * 出典: Claude向け_ISMAY_3b695d9以降_再監査是正・CasePattern実機能完遂指示_
 * 2026-09-04.md §4「欠落enqueue契機」、Claude向け_ISMAY_d68e9bf以降_
 * ActionSlot正本準拠・CasePattern実分解完遂・残工程連続実装指示_2026-09-17.md
 * P1「10. 残り4 reason配線」。
 *
 * [4種のうち配線できたのは2種のみ・想像で先行実装しない] 当初PATTERN-DETECT-
 * 02Bで配線したRESPONSIBILITY_CORRECTED/EVIDENCE_EXCLUDEDに加え、本Gateで
 * EMBEDDING_MODEL_CHANGED(trigger配線元: PATCH /api/v1/admin/ai-providers、
 * capability=EMBEDDINGでprovider/modelが実際に変化した場合)と
 * MANUAL_REBUILD(trigger配線元: 新設POST /api/v1/admin/case-patterns/rebuild、
 * 管理者操作)を配線する。残る2種は個別精査の結果、実在するtrigger配線元が
 * 無いことを確認した:
 *   - PATTERN_REVISION_CHANGED: 「Pattern編集API」はGET専用の
 *     /api/v1/case-patterns/[id]/route.tsのみで、CasePatternRevisionを
 *     ユーザー操作で直接変更するAPIは存在しない(検出時の自動revision追加
 *     以外に変更経路が無い)。架空のPattern編集APIを想像で作らない。
 *   - EMBEDDING_SOURCE_VERSION_CHANGED: CASE_PATTERN_EMBEDDING_SOURCE_VERSION
 *     (casePatternMatchPolicy.ts)はコード内の固定定数であり、デプロイ時に
 *     開発者が値を書き換える以外に変化する経路が無い(実行時APIが存在しない)。
 *     この定数を変更するdeployが発生した場合の再構築は、MANUAL_REBUILDを
 *     管理者が手動実行することで対応する運用とし、専用の自動trigger配線は
 *     架空のAPIを発明することになるため追加しない。
 * この2種は宣言のみ残し(CASE_PATTERN_DETECT_REASON_CODESから削除しない、
 * 既存Receipt冪等keyやtype定義との後方互換のため)、想像で偽のtrigger元を
 * 作らない。
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
 *
 * [PATTERN-INTEGRITY-03B是正・2026-09-05] ISMAY_ハンドオフ資料_2026-09-05_
 * 続き3.md §3「未着手: PATTERN-INTEGRITY-03B」。
 * 従来はenqueueCaseDetectを呼ぶのみで、旧title由来の既存CasePatternSourceLink
 * を除外していなかった。再判定が別Patternへ一致した場合、旧SourceLink(旧
 * Pattern向け)と新SourceLink(新Pattern向け)が両方残り二重計上される欠陥が
 * あった。03A(PRIMARY_UNLINKED、
 * app/src/app/api/v1/project-contexts/[id]/links/[responsibilityId]/route.ts
 * DELETEハンドラ)と同一の是正パターンを適用する: 唯一のSourceLink除外入口
 * excludeCasePatternSourceLinksForResponsibilityを呼び、影響を受けた全owner
 * (通常はresolveOwnerForPrimaryLinkedResponsibilityの解決先と一致するが、
 * 過去データ不整合等に備え和集合で扱う)へ再検出をenqueueする。
 * 除外済みSourceLinkが同一Patternへ再一致した場合の再有効化は
 * sourceLinkService.ts::linkPatternSourceEvent側で処理する(本関数の責務外)。
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

  const { affectedOwnerIds } = await excludeCasePatternSourceLinksForResponsibility(txOrDb, {
    workspaceId: params.workspaceId,
    responsibilityId: params.responsibilityId,
    reason: "RESPONSIBILITY_CORRECTED",
  });

  // 通常はaffectedOwnerIds === [ownerSubjectUserId](CasePattern.ownerSubjectUserIdは
  // 常にPRIMARY Context.ownerSubjectUserIdと一致するため)だが、03Aのunlink是正と
  // 同じく万一の不一致に備え和集合で再集計をenqueueする。
  const ownersToEnqueue = new Set<string>([ownerSubjectUserId, ...affectedOwnerIds]);
  for (const id of ownersToEnqueue) {
    await enqueueCaseDetect(txOrDb, {
      workspaceId: params.workspaceId,
      ownerSubjectUserId: id,
      reasonCode: "RESPONSIBILITY_CORRECTED",
    });
  }
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

/**
 * このworkspace内で既にCase Pattern(CasePattern行)を持つ全ownerを列挙し、
 * それぞれへreasonCode付きでenqueueする(EMBEDDING_MODEL_CHANGED/
 * MANUAL_REBUILDの共通実装)。まだ1件もPatternを持たないownerは、既存
 * Pattern自体が存在しないため再検出の対象外(enqueue不要、想像で無関係な
 * ownerへ書き込まない)。
 */
export async function enqueueCaseDetectForAllOwnersInWorkspace(
  txOrDb: PatternDbClient,
  params: { workspaceId: string; reasonCode: "EMBEDDING_MODEL_CHANGED" | "MANUAL_REBUILD" },
): Promise<{ ownerCount: number }> {
  const owners = await txOrDb.casePattern.findMany({
    where: { workspaceId: params.workspaceId },
    select: { ownerSubjectUserId: true },
    distinct: ["ownerSubjectUserId"],
  });
  for (const { ownerSubjectUserId } of owners) {
    await enqueueCaseDetect(txOrDb, {
      workspaceId: params.workspaceId,
      ownerSubjectUserId,
      reasonCode: params.reasonCode,
    });
  }
  return { ownerCount: owners.length };
}
