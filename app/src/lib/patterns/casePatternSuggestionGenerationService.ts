/**
 * Case Pattern Suggestion Generator本体(PATTERN-SUGGEST-01B新設・2026-09-05)。
 * 出典: Claude向け_ISMAY_3b695d9以降_再監査是正・CasePattern実機能完遂指示_
 * 2026-09-04.md §6 PATTERN-SUGGEST-01B。
 *
 * [scope宣言] このファイルは「1件のCasePatternSuggestJob(=1 candidateId)を
 * 処理し、既存ACTIVE/STRONG_SUGGESTION段階のPatternへ照合し、MATCHEDの場合のみ
 * CasePatternSuggestionIdentity/Revisionを書き込む」という単位の処理のみを行う。
 * queue管理(caseSuggestQueue.ts)・worker接続(caseSuggestQueueJob.ts)・
 * 読取API・Feedback記録(PATTERN-SUGGEST-01C)は別ファイル/別Gateの責務。
 *
 * [AMBIGUOUS方針] 指示書§6「AMBIGUOUSは自動選択せず候補比較表示か提案なし」。
 * 「候補比較表示」用のデータ構造(複数Pattern候補を横並び表示するUI契約)は
 * 正本に定義が無く、このGateで想像発明しない。従ってこのGateでは
 * AMBIGUOUS時は「提案なし」を選択する(Suggestionを作らずjobをDONEにする)。
 * 候補比較表示が必要になった場合は、CasePatternMatchResultのAMBIGUOUS分岐が
 * 既に候補一覧(candidates配列)を保持しているため、別Gateでそのまま使える。
 *
 * [candidate text構築・データ最小化] casePatternDetectionService.tsの
 * candidateInputForと同じ方針(representativeTextは`${type}: ${title}`のみ、
 * descriptionは含めない)。FormationCandidateRevision.proposedFieldsを
 * decompositionTemplateとして使うかどうかは検討したが、既存の
 * MATERIALIZATION_RECEIPT_ITEM経路(casePatternDetectionService.ts)が
 * 常にdecompositionTemplate: nullでPatternを作成/比較してきたため、同じ
 * 本人のPattern空間に対して異なる正規化規則で埋め込むと類似度比較が
 * 非対称になる(P1-2で是正した問題の再発)。symmetry優先でnullに揃える。
 *
 * [同一transaction] MATCHED時のCasePatternSuggestionIdentity(初回のみ)+
 * CasePatternSuggestionRevision作成は単一transaction内で行う
 * (casePatternDetectionService.tsのNEW_PATTERN_CREATEDと同じ設計方針)。
 *
 * [並行性] 同一candidateIdに対するCasePatternSuggestJobはactive partial
 * unique制約(case_pattern_suggest_jobs_active_uq)により常に高々1件しか
 * PENDING/PROCESSINGにならず、FOR UPDATE SKIP LOCKEDのclaimも1 workerのみが
 * 成功するため、同一candidateIdに対するこの関数の並行実行は構造的に
 *発生しない(casePatternRevisionService.tsがCasePattern行を明示的に
 * FOR UPDATEでlockしているのとは異なる前提。あちらは複数の独立した
 * source eventが同一Patternへ競合し得るため必要、こちらは1 candidateId
 * につき1 job・1 workerに queue自体が既に直列化している)。
 */
import { db } from "@/lib/db";
import type { Prisma } from "@/generated/prisma/client";
import { debugServer } from "@/lib/debugServer";
import {
  resolveCasePatternEmbeddingProvider,
  embedCasePatternCandidate,
  classifyCasePatternVectorForSuggestion,
  CASE_PATTERN_MATCH_POLICY_VERSION,
  type CasePatternEmbeddingOverrides,
} from "./casePatternMatching";
import type { CasePatternDetectionCandidateInput } from "./casePatternEmbeddingText";
import { isCasePatternLearningConsentGrantedForOwner } from "./casePatternConsentGate";
import { buildCasePatternSuggestionDto, CASE_PATTERN_ADOPTION_POLICY_VERSION } from "./casePatternSuggestion";

/** CasePatternSuggestionRevision.schemaVersion(このGateで確定した最初のversion)。 */
const CASE_PATTERN_SUGGESTION_REVISION_SCHEMA_VERSION = "1.0";

export type CaseSuggestionGenerationOutcome =
  | { outcome: "SUGGESTION_CREATED"; suggestionId: string; suggestionRevisionId: string; patternId: string }
  | { outcome: "SUGGESTION_REVISED"; suggestionId: string; suggestionRevisionId: string; patternId: string }
  | { outcome: "NO_MATCH" }
  | { outcome: "AMBIGUOUS_NO_SUGGESTION" }
  | { outcome: "SKIPPED"; reasonCode: string }
  | { outcome: "FAILED"; errorKind: "TRANSIENT" | "FATAL"; reason: string };

export interface GenerateCaseSuggestionParams {
  workspaceId: string;
  ownerSubjectUserId: string;
  candidateId: string;
}

function candidateInputForRevision(revision: { type: string; title: string }): CasePatternDetectionCandidateInput {
  // [データ最小化・casePatternDetectionService.tsのcandidateInputForと同じ方針]
  // descriptionはPII/CONFIDENTIAL相当のfree textを含み得るため含めない。
  return { representativeText: `${revision.type}: ${revision.title}`, decompositionTemplate: null };
}

/**
 * 1件のCandidate(candidateId)について、既存ACTIVE/STRONG_SUGGESTION段階の
 * Patternへ照合し、MATCHEDの場合のみCasePatternSuggestionIdentity/Revisionを
 * 書き込む。呼び出し元(caseSuggestQueueJob.ts)はこの関数の戻り値に関わらず
 * jobをDONEにしてよい(FAILED/TRANSIENTのみリトライ対象、呼び出し元がその
 * 判定をtry/catch的に行う)。
 */
export async function generateCaseSuggestionForCandidate(
  params: GenerateCaseSuggestionParams,
  overrides: CasePatternEmbeddingOverrides = {},
): Promise<CaseSuggestionGenerationOutcome> {
  const { workspaceId, ownerSubjectUserId, candidateId } = params;

  const identity = await db.formationCandidateIdentity.findFirst({
    where: { id: candidateId, workspaceId },
    select: { id: true, sessionId: true, currentRevision: true },
  });
  if (!identity || identity.currentRevision < 1) {
    return { outcome: "SKIPPED", reasonCode: "CANDIDATE_NOT_FOUND" };
  }

  const revision = await db.formationCandidateRevision.findFirst({
    where: { candidateId: identity.id, workspaceId, revision: identity.currentRevision },
    select: { id: true, type: true, title: true },
  });
  if (!revision) {
    return { outcome: "SKIPPED", reasonCode: "CANDIDATE_NOT_FOUND" };
  }

  // [consent・casePatternDetectionService.tsと同じ理由] Embedding生成はAI呼出し
  // であり、Pattern照合(読取目的)であってもCASE_PATTERN_LEARNING同意の対象と
  // する(学習/照合を同意区分で分けるという定義が正本に無いため、想像で
  // 「照合は同意不要」という別ルールを発明しない)。
  const consentGranted = await isCasePatternLearningConsentGrantedForOwner(workspaceId, ownerSubjectUserId);
  if (!consentGranted) {
    return { outcome: "SKIPPED", reasonCode: "CONSENT_NOT_GRANTED" };
  }

  const provider = await resolveCasePatternEmbeddingProvider(workspaceId, overrides);
  const candidateInput = candidateInputForRevision(revision);
  const embedOutcome = await embedCasePatternCandidate(workspaceId, candidateInput, overrides, provider);
  if (!embedOutcome.ok) {
    debugServer.error("patterns/casePatternSuggestionGenerationService", "Suggestion照合用Embedding生成失敗", {
      candidateId,
      errorKind: embedOutcome.errorKind,
      reason: embedOutcome.reason,
    });
    return { outcome: "FAILED", errorKind: embedOutcome.errorKind, reason: embedOutcome.reason };
  }

  const matchResult = await classifyCasePatternVectorForSuggestion({
    workspaceId,
    ownerSubjectUserId,
    vectorLiteral: embedOutcome.vectorLiteral,
    model: embedOutcome.model,
    dimensions: embedOutcome.dimensions,
  });

  if (matchResult.kind === "NO_MATCH") {
    return { outcome: "NO_MATCH" };
  }
  // EMBEDDING_FAILEDはembedCasePatternCandidate側で既に弾いているため、
  // ここに到達するのは常にMATCHED/AMBIGUOUSのみ(型上はEMBEDDING_FAILEDを
  // 含むため網羅チェックのため明示的に扱う)。
  if (matchResult.kind === "EMBEDDING_FAILED") {
    return { outcome: "FAILED", errorKind: matchResult.errorKind, reason: matchResult.reason };
  }

  // [AMBIGUOUS方針・改訂] 「候補比較表示」用の専用UI契約は発明しないが、
  // classifyCasePatternMatchCandidatesが既に返す客観的な候補一覧
  // (patternId/revisionId/similarityの配列)をdecompositionProposalへ
  // そのまま保存することは「想像で構造を発明する」ことにはならない
  // (既存の判定結果をそのまま記録するだけ)。これにより指示書§6の
  // 「AMBIGUOUS候補確認」読取APIが実現できる。matchedPatternId/
  // matchedPatternRevisionIdは両方nullのまま保存する(CHECK制約
  // case_pattern_suggestion_revisions_matched_pair_checkは「両方null」も
  // 「両方非null」も許可する、実DB検証済み)。自動選択(1件をmatchedとして
  // 確定させる)はしない(指示書§6「AMBIGUOUSは自動選択しない」)。
  const isAmbiguous = matchResult.kind === "AMBIGUOUS";
  const patternId = matchResult.kind === "AMBIGUOUS" ? null : matchResult.patternId;
  const matchedPatternRevisionId = matchResult.kind === "AMBIGUOUS" ? null : matchResult.revisionId;
  const similarity = matchResult.kind === "AMBIGUOUS" ? matchResult.candidates[0]!.similarity : matchResult.similarity;

  const matchedRevision = patternId
    ? await db.casePatternRevision.findFirst({
        where: { id: matchedPatternRevisionId!, patternId, workspaceId },
        select: { decompositionTemplate: true },
      })
    : null;

  const dto = patternId ? await buildCasePatternSuggestionDto(workspaceId, patternId) : null;

  const decompositionProposal: Prisma.InputJsonValue = matchResult.kind === "AMBIGUOUS"
    ? {
        // [想像で構造を発明しない] classifyCasePatternMatchCandidatesの生の
        // 判定結果(候補一覧)をそのまま保存する。UI固有の比較表示形式は
        // 発明しない(必要になった時点で別Gateがこのデータから組み立てる)。
        ambiguousCandidates: matchResult.candidates,
      }
    : {
        // [想像で構造を先行発明しない] decompositionTemplateは現行システムで
        // 常にnull(casePatternDetectionService.tsのcandidateInputForがnullを
        // 渡してきたため)。安定child key採番規則は、実際に非null構造を持つ
        // Patternが現れるまで発明しない(01A schemaコメントの明示的先送りに
        // 従い、この場でも同様に先送りする)。
        patternDecompositionTemplate: matchedRevision?.decompositionTemplate ?? null,
      };
  const evidenceSnapshot: Prisma.InputJsonValue = {
    rawSampleSize: dto?.rawSampleSize ?? null,
    distinctContextCount: dto?.distinctContextCount ?? null,
    confidence: dto?.confidence ?? null,
    adoptionRate: dto?.adoptionRate ?? null,
    adoptionPolicyVersion: CASE_PATTERN_ADOPTION_POLICY_VERSION,
  };

  const result = await db.$transaction(async (tx: Prisma.TransactionClient) => {
    let suggestionIdentity = await tx.casePatternSuggestionIdentity.findFirst({
      where: { workspaceId, formationSessionId: identity.sessionId, candidateId: identity.id },
      select: { id: true, currentRevision: true },
    });
    const isNewIdentity = !suggestionIdentity;
    if (!suggestionIdentity) {
      suggestionIdentity = await tx.casePatternSuggestionIdentity.create({
        data: {
          workspaceId,
          ownerSubjectUserId,
          formationSessionId: identity.sessionId,
          candidateId: identity.id,
          // [01A schemaコメント準拠] suggestionKeyは対象CandidateのcandidateKeyを
          // そのまま複製する(独自キー生成を発明しない)。
          suggestionKey: (await tx.formationCandidateIdentity.findFirst({ where: { id: identity.id }, select: { candidateKey: true } }))!.candidateKey,
          currentRevision: 0,
          state: "PENDING",
        },
        select: { id: true, currentRevision: true },
      });
    }

    const newRevisionNumber = suggestionIdentity.currentRevision + 1;
    const suggestionRevision = await tx.casePatternSuggestionRevision.create({
      data: {
        workspaceId,
        suggestionId: suggestionIdentity.id,
        revision: newRevisionNumber,
        candidateId: identity.id,
        sourceCandidateRevisionId: revision.id,
        matchedPatternId: patternId,
        matchedPatternRevisionId,
        matchPolicyVersion: CASE_PATTERN_MATCH_POLICY_VERSION,
        similarity,
        decompositionProposal,
        evidenceSnapshot,
        schemaVersion: CASE_PATTERN_SUGGESTION_REVISION_SCHEMA_VERSION,
      },
    });

    await tx.casePatternSuggestionIdentity.update({
      where: { id: suggestionIdentity.id },
      data: { currentRevision: newRevisionNumber },
    });

    debugServer.event("patterns/casePatternSuggestionGenerationService", "CASE_PATTERN_SUGGESTION_WRITTEN", {
      candidateId,
      suggestionId: suggestionIdentity.id,
      suggestionRevisionId: suggestionRevision.id,
      patternId,
      isAmbiguous,
      isNewIdentity,
    });

    return { suggestionId: suggestionIdentity.id, suggestionRevisionId: suggestionRevision.id, isNewIdentity };
  });

  if (isAmbiguous) {
    return { outcome: "AMBIGUOUS_NO_SUGGESTION" };
  }
  return result.isNewIdentity
    ? { outcome: "SUGGESTION_CREATED", suggestionId: result.suggestionId, suggestionRevisionId: result.suggestionRevisionId, patternId: patternId! }
    : { outcome: "SUGGESTION_REVISED", suggestionId: result.suggestionId, suggestionRevisionId: result.suggestionRevisionId, patternId: patternId! };
}
