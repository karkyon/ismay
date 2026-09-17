/**
 * Case Pattern Detector本体(PATTERN-DETECT-02A新設・2026-09-04)。
 * 出典: Claude向け_ISMAY_3b695d9以降_再監査是正・CasePattern実機能完遂指示_
 * 2026-09-04.md §2 P0-1〜P0-3・P1-4、§3(PATTERN-DETECT-02A)。
 *
 * [これまでの状態(監査で確認済み)] linkPatternSourceEvent()・matchCasePattern()・
 * embedAndStoreCasePatternRevision()はいずれも部品としては実装済みだったが、
 * production workerから一度も呼ばれていなかった(caseDetectQueueJob.tsの
 * runDetection()はcomputeAndPersistCasePatternAggregatesForOwner()、つまり
 * 「既存Patternの再集計」しか呼んでいなかった)。本ファイルが、これらの部品を
 * 実際につなぐ最初の実装になる。
 *
 * [v1学習対象・§3.1] MATERIALIZATION_RECEIPT_ITEMのみ。対応Responsibilityへの
 * active PRIMARY ProjectContextLinkが存在するもののみ(DR-A、既存
 * sourceLinkService.assertEligibleが最終防御として再検証する)。
 * FORMATION_CANDIDATE_REVISIONはContextとの正式対応が未確定なため、本Gateでは
 * 自動学習対象に含めない(想像で対応方法を発明しない、指示書§3.1)。
 *
 * [Responsibility「deletedでない」について] schema.prisma Responsibilityモデルに
 * deletedAt相当の列は存在しない(確認済み、2026-09-04監査)。ハード/ソフト削除の
 * 概念自体が正本上Responsibilityに定義されていないため、想像でdeletedAt相当の
 * 判定を発明せず、「Responsibility行が実在し、かつactiveなPRIMARY Linkを持つ」
 * ことをもって条件を満たすとみなす。
 *
 * [candidate text構築・データ最小化] representativeTextは
 * `${type}: ${title}`のみを用いる。description(Reason free text相当、DOC-09 §4
 * CONFIDENTIAL classification)は含めない(指示書§3.2「PII/consent policy適用前
 * の原文を直接providerへ渡さない」、DOC-09データ最小化原則)。
 *
 * [independenceGroup] DOC-06 §3「Case Patternの独立単位はProject Context
 * instance」に従い、contextIdをそのまま使う(既存verify script群と同じ慣行)。
 *
 * [qualityWeight] Metric Definition別のqualityWeight分類はこのGateのscope外
 * (casePatternAggregation.tsの既存「暫定プレースホルダ」注記と同じ理由、
 * metricDefinitionRegistry.tsとの統合は別Gate)。既定値1(HIGH相当)を使う。
 *
 * [AI呼出しとtransactionの分離・§3.2] Embedding生成(embedCasePatternCandidate)は
 * transaction外で行い、長時間ロックを保持しない。MATCHED/NEW_PATTERN_CREATEDの
 * DB確定はEmbedding計算結果(ベクトル)を再利用し、追加のAI呼出しをしない。
 *
 * [同一transaction・§3.2手順7] NEW_PATTERN_CREATEDはCasePattern identity +
 * revision 1 + embedding + SourceLinkを単一のdb.$transaction内で作成する
 * (createCasePatternIdentity(..., tx) + storeCasePatternEmbedding(tx, ...) +
 * tx.casePatternSourceLink.createを同じtxで実行)。
 */
import { db } from "@/lib/db";
import type { Prisma } from "@/generated/prisma/client";
import { debugServer } from "@/lib/debugServer";
import { createHash } from "node:crypto";
import {
  CASE_PATTERN_MATCH_POLICY_VERSION,
  CASE_PATTERN_EMBEDDING_SOURCE_VERSION,
  resolveCasePatternEmbeddingProvider,
  embedCasePatternCandidate,
  storeCasePatternEmbedding,
  classifyCasePatternVector,
  type CasePatternEmbeddingOverrides,
} from "./casePatternMatching";
import { buildCasePatternEmbeddingText, type CasePatternDetectionCandidateInput } from "./casePatternEmbeddingText";
import { linkPatternSourceEvent, PatternSourceEligibilityError, PatternSourceProvenanceError } from "./sourceLinkService";
import { createCasePatternIdentity } from "./casePatternRevisionService";
import { isCasePatternLearningConsentGrantedForOwner } from "./casePatternConsentGate";
import { CASE_PATTERN_WINDOW_CYCLES, CASE_PATTERN_NULL_INTERVAL_CONFIDENCE_CAP } from "./casePatternMath";
import { assertCaseDetectJobGenerationCurrent, type CaseDetectJobGenerationContext } from "./caseDetectQueue";

/** CasePatternRevision.thresholdsへ保存するスナップショット(casePatternMath.tsの現行定数)。 */
const CASE_PATTERN_REVISION_THRESHOLDS_SNAPSHOT = {
  windowCycles: CASE_PATTERN_WINDOW_CYCLES,
  nullIntervalConfidenceCap: CASE_PATTERN_NULL_INTERVAL_CONFIDENCE_CAP,
};
/** 既存verify script群と同じ慣行(casePatternRevisionService.ts利用箇所参照)。 */
const CASE_PATTERN_REVISION_SCHEMA_VERSION = "1.0";

/**
 * [PATTERN-INTEGRITY-03C新設・2026-09-05] ISMAY_ハンドオフ資料_2026-09-05_
 * 続き3.md §4「generation確認と全DB副作用を同一transaction内で確定する」。
 * 1sourceあたりのDB確定処理(Receipt/SourceLink/新規Pattern作成のいずれか
 * 一つ以上を含む)を、単一のdb.$transaction内で行う共通ラッパー。jobContext
 * (caseDetectQueueJob.ts経由の実worker実行時のみ渡される)が指定されている
 * 場合、transaction先頭でassertCaseDetectJobGenerationCurrentを呼び、claim時
 * generationと現在generationの不一致を検出したらCaseDetectJobGenerationStaleError
 * を投げてtransaction全体をrollbackさせる(この関数はそれを握りつぶさず
 * そのまま再送出し、呼び出し元のrunCasePatternDetectionForOwnerループ全体を
 * 中断させる。「旧generation失効時は取得済みEmbedding結果を破棄し、新
 * generationで再実行する」の実装)。jobContext未指定時(verify script等の
 * 単独呼び出し)はgeneration lockを行わない(既存呼び出し元との後方互換)。
 */
async function commitSourceOutcome<T>(
  jobContext: CaseDetectJobGenerationContext | undefined,
  fn: (tx: Prisma.TransactionClient) => Promise<T>,
): Promise<T> {
  return db.$transaction(async (tx: Prisma.TransactionClient): Promise<T> => {
    if (jobContext) {
      await assertCaseDetectJobGenerationCurrent(tx, jobContext.jobId, jobContext.generation);
    }
    return fn(tx);
  });
}

export interface DetectionSourceOutcome {
  sourceEventId: string;
  outcome: "MATCHED" | "NEW_PATTERN_CREATED" | "AMBIGUOUS" | "SKIPPED" | "FAILED";
  reasonCode?: string;
}

interface EligibleSourceRow {
  itemId: string;
  contextId: string;
  responsibilityId: string;
  sourceOccurredAt: Date;
  responsibilityType: string;
  responsibilityTitle: string;
}

/**
 * v1学習対象(§3.1)のMATERIALIZATION_RECEIPT_ITEMを列挙する。
 * 「active PRIMARY ProjectContextLinkが存在」かつ「そのContextのowner本人が
 * このjobのownerSubjectUserId」を満たすResponsibilityに紐づくitemのみを対象
 * とする(DR-A、sourceLinkService.assertEligibleが最終防御として再検証)。
 */
async function listEligibleMaterializationSources(
  workspaceId: string,
  ownerSubjectUserId: string,
): Promise<EligibleSourceRow[]> {
  const primaryLinks = await db.projectContextLink.findMany({
    where: {
      workspaceId,
      role: "PRIMARY",
      unlinkedAt: null,
      context: { ownerSubjectUserId, deletedAt: null },
    },
    select: { contextId: true, responsibilityId: true },
  });
  if (primaryLinks.length === 0) return [];

  const rows: EligibleSourceRow[] = [];
  for (const link of primaryLinks) {
    const items = await db.materializationReceiptItem.findMany({
      where: {
        workspaceId,
        responsibilityId: link.responsibilityId,
        // [PATTERN-DETECT-02B是正・2026-09-04] Responsibility.deletedAtの
        // 実在を見落としていた(02A時点の誤判定)。論理削除済みResponsibilityを
        // eligible source対象から除外する。既存SourceLinkの除外自体は
        // casePatternTriggers.ts::enqueueCaseDetectForResponsibilityDeletion
        // (DELETE route)が別途行う。
        responsibility: { deletedAt: null },
      },
      select: {
        id: true,
        receipt: { select: { committedAt: true } },
        responsibility: { select: { type: true, title: true } },
      },
    });
    for (const item of items) {
      rows.push({
        itemId: item.id,
        contextId: link.contextId,
        responsibilityId: link.responsibilityId,
        sourceOccurredAt: item.receipt.committedAt,
        responsibilityType: item.responsibility.type,
        responsibilityTitle: item.responsibility.title,
      });
    }
  }
  return rows;
}

function candidateInputFor(row: EligibleSourceRow): CasePatternDetectionCandidateInput {
  return { representativeText: `${row.responsibilityType}: ${row.responsibilityTitle}`, decompositionTemplate: null };
}

function digestOf(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

/**
 * 既存Receipt(冪等unique: workspace+owner+source+policy+model+sourceVersion)を
 * 引く。inputDigestも返す(呼び出し元が現在の入力から計算したdigestと比較し、
 * 「本当に処理済みか」「入力が変わったので再処理が必要か」を判定するため)。
 */
async function findExistingReceipt(params: {
  workspaceId: string;
  ownerSubjectUserId: string;
  sourceEventId: string;
  policyVersion: string;
  model: string;
  sourceVersion: number;
}) {
  return db.casePatternDetectionReceipt.findFirst({
    where: {
      workspaceId: params.workspaceId,
      ownerSubjectUserId: params.ownerSubjectUserId,
      sourceEventKind: "MATERIALIZATION_RECEIPT_ITEM",
      sourceEventId: params.sourceEventId,
      policyVersion: params.policyVersion,
      model: params.model,
      sourceVersion: params.sourceVersion,
    },
    select: { id: true, inputDigest: true },
  });
}

interface WriteReceiptParams {
  workspaceId: string;
  ownerSubjectUserId: string;
  sourceEventId: string;
  contextId: string;
  responsibilityId: string;
  inputDigest: string;
  policyVersion: string;
  model: string;
  dimensions: number | null;
  sourceVersion: number;
  outcome: DetectionSourceOutcome["outcome"];
  matchedPatternId?: string;
  matchedPatternRevisionId?: string;
  createdPatternId?: string;
  bestSimilarity?: number;
  secondSimilarity?: number;
  reasonCode?: string;
  /** [PATTERN-DETECT-02B新設] 指定時はcreateではなくこのidの行をupdateする
   *  (Receiptが既存だがinputDigestが変わった=再処理が必要なケース)。 */
  existingReceiptId?: string;
}

async function writeReceipt(txOrDb: typeof db | Prisma.TransactionClient, p: WriteReceiptParams): Promise<void> {
  const data = {
    workspaceId: p.workspaceId,
    ownerSubjectUserId: p.ownerSubjectUserId,
    sourceEventKind: "MATERIALIZATION_RECEIPT_ITEM" as const,
    sourceEventId: p.sourceEventId,
    contextId: p.contextId,
    responsibilityId: p.responsibilityId,
    inputDigest: p.inputDigest,
    policyVersion: p.policyVersion,
    model: p.model,
    dimensions: p.dimensions,
    sourceVersion: p.sourceVersion,
    outcome: p.outcome,
    matchedPatternId: p.matchedPatternId,
    matchedPatternRevisionId: p.matchedPatternRevisionId,
    createdPatternId: p.createdPatternId,
    bestSimilarity: p.bestSimilarity,
    secondSimilarity: p.secondSimilarity,
    reasonCode: p.reasonCode,
  };

  if (p.existingReceiptId) {
    // [PATTERN-DETECT-02B新設] 入力(title等)が変わった既存Receiptを上書きする。
    // matchedPatternId等、前回のoutcomeにのみ存在したフィールドが今回の
    // outcomeに無い場合はnullで明示的にクリアする(古い値が残留しない)。
    await txOrDb.casePatternDetectionReceipt.update({
      where: { id: p.existingReceiptId },
      data: {
        ...data,
        matchedPatternId: p.matchedPatternId ?? null,
        matchedPatternRevisionId: p.matchedPatternRevisionId ?? null,
        createdPatternId: p.createdPatternId ?? null,
        bestSimilarity: p.bestSimilarity ?? null,
        secondSimilarity: p.secondSimilarity ?? null,
        reasonCode: p.reasonCode ?? null,
        processedAt: new Date(),
      },
    });
    return;
  }

  try {
    await txOrDb.casePatternDetectionReceipt.create({ data });
  } catch (err) {
    // [冪等性・並行競合] 冪等unique違反(P2002)は「別workerが同時に同じsourceを
    // 処理し、先にReceiptを作成した」ケース。PE2E-02同様、例外を投げず成功
    // 扱いにする(既存レコードがある = 処理済みという事実は変わらない)。
    if ((err as { code?: string }).code === "P2002") {
      debugServer.event("patterns/casePatternDetectionService", "Receipt冪等競合(既存行を採用)", {
        sourceEventId: p.sourceEventId,
      });
      return;
    }
    throw err;
  }
}

/**
 * この本人(ownerSubjectUserId)のeligible sourceを列挙し、未処理分を検出処理
 * する(§3.2手順1〜9)。
 *
 * [PATTERN-INTEGRITY-03C是正・2026-09-05] 従来のコメント「generationの
 * 古さ検出(手順10)はcaseDetectQueueJob.ts側の既存completeCaseDetectJobが
 * 担う」は誤りだった(ISMAY_ハンドオフ資料_2026-09-05_続き3.md §4「単に
 * completeCaseDetectJobでPENDINGへ戻すだけでは不合格」)。completeCaseDetectJob
 * は全source処理完了後の最終チェックに過ぎず、処理中にcoalescingが起きても
 * 既にcommit済みの副作用(旧generationの入力に基づくPattern/Revision/
 * Embedding/SourceLink/Aggregate/Receipt)は残ってしまっていた。
 * jobContext(caseDetectQueueJob.ts経由の実worker実行時のみ)が指定されて
 * いる場合、各sourceのDB確定処理をcommitSourceOutcome経由でgeneration
 * lock付きtransactionへ包む。generation不一致を検出した場合は
 * CaseDetectJobGenerationStaleErrorがこの関数の外まで伝播し、残りの
 * source処理を中断する(取得済みEmbedding結果は破棄され、次回の再実行
 * (enqueueCaseDetectでのcoalescing済みgenerationによる再claim)で
 * 最初からやり直される)。jobContext未指定時(verify script等の直接呼び
 * 出し)はgeneration lockを行わない従来通りの挙動(既存呼び出し元との
 * 後方互換)。
 */
export async function runCasePatternDetectionForOwner(
  workspaceId: string,
  ownerSubjectUserId: string,
  overrides: CasePatternEmbeddingOverrides = {},
  jobContext?: CaseDetectJobGenerationContext,
): Promise<DetectionSourceOutcome[]> {
  const results: DetectionSourceOutcome[] = [];

  const consentGranted = await isCasePatternLearningConsentGrantedForOwner(workspaceId, ownerSubjectUserId);
  if (!consentGranted) {
    debugServer.event("patterns/casePatternDetectionService", "CASE_PATTERN_LEARNING同意未取得のためスキップ", {
      workspaceId,
      ownerSubjectUserId,
    });
    return results;
  }

  const sources = await listEligibleMaterializationSources(workspaceId, ownerSubjectUserId);
  if (sources.length === 0) return results;

  // [不要なAI呼出しを避ける・PE2E-02] modelNameを知るためだけならprovider解決
  // (設定read)のみで足り、embed() API呼出しは不要。この本人の全sourceで
  // 1回だけ解決し、既存Receiptとの突合に使う。
  const provider = await resolveCasePatternEmbeddingProvider(workspaceId, overrides);

  for (const source of sources) {
    const candidate = candidateInputFor(source);
    const candidateText = buildCasePatternEmbeddingText(candidate);
    const inputDigest = digestOf(candidateText);

    const existingReceipt = await findExistingReceipt({
      workspaceId,
      ownerSubjectUserId,
      sourceEventId: source.itemId,
      policyVersion: CASE_PATTERN_MATCH_POLICY_VERSION,
      model: provider.modelName,
      sourceVersion: CASE_PATTERN_EMBEDDING_SOURCE_VERSION,
    });
    if (existingReceipt && existingReceipt.inputDigest === inputDigest) {
      // [PE2E-02] 同一input/policy/model/sourceVersionは既に処理済み。
      // embed() API呼出し自体を行わずスキップする。
      results.push({ sourceEventId: source.itemId, outcome: "SKIPPED", reasonCode: "ALREADY_PROCESSED" });
      continue;
    }
    // [PATTERN-DETECT-02B新設・2026-09-04] Receiptが存在してもinputDigestが
    // 異なる場合(RESPONSIBILITY_CORRECTEDでtitleが変わった等)は「入力が
    // 変わった」ため再処理する。既存Receipt行はappend-onlyではなく
    // 処理済み管理台帳という性質上、この場合はcreateではなくupdateで
    // 上書きする(existingReceiptIdをwriteReceiptへ渡す)。
    const existingReceiptId = existingReceipt?.id;

    // [AI呼出しとtransactionの分離] embedCasePatternCandidateはtransaction外で
    // 行う(§3.2、既存方針を維持)。この後のDB確定処理のみをcommitSourceOutcome
    // (generation lock付きtransaction)へ包む。
    const embedOutcome = await embedCasePatternCandidate(workspaceId, candidate, overrides, provider);
    if (!embedOutcome.ok) {
      const reasonCode = embedOutcome.errorKind === "TRANSIENT" ? "EMBEDDING_TRANSIENT_FAILURE" : "EMBEDDING_FATAL_FAILURE";
      // [model不明時] provider解決自体に失敗した場合、modelは不明("UNKNOWN")として
      // 記録する(受入試験可視化のため、秘密情報は含めない)。
      await commitSourceOutcome(jobContext, async (tx) => {
        await writeReceipt(tx, {
          existingReceiptId,
          workspaceId,
          ownerSubjectUserId,
          sourceEventId: source.itemId,
          contextId: source.contextId,
          responsibilityId: source.responsibilityId,
          inputDigest,
          policyVersion: CASE_PATTERN_MATCH_POLICY_VERSION,
          model: "UNKNOWN",
          dimensions: null,
          sourceVersion: CASE_PATTERN_EMBEDDING_SOURCE_VERSION,
          outcome: "FAILED",
          reasonCode,
        });
      });
      results.push({ sourceEventId: source.itemId, outcome: "FAILED", reasonCode });
      continue;
    }

    const matchResult = await classifyCasePatternVector({
      workspaceId,
      ownerSubjectUserId,
      vectorLiteral: embedOutcome.vectorLiteral,
      model: embedOutcome.model,
      dimensions: embedOutcome.dimensions,
    });

    if (matchResult.kind === "MATCHED") {
      // [PATTERN-INTEGRITY-03C是正・2026-09-05] linkPatternSourceEvent(SourceLink
      // 確定)とwriteReceipt(Receipt確定)を、generation lock付きの単一
      // transactionへ包む。PatternSourceEligibilityError/
      // PatternSourceProvenanceErrorはDB制約違反を伴わない検証エラー
      // (linkPatternSourceEventCore内でDB書込み前にthrowされる)ため、tx内で
      // catchして後続のwriteReceipt(SKIPPED)を同一tx内で継続してよい
      // (postgresのtransaction-abort状態を引き起こさない)。
      const outcome = await commitSourceOutcome(jobContext, async (tx) => {
        try {
          await linkPatternSourceEvent(tx, {
            workspaceId,
            patternRevisionId: matchResult.revisionId,
            contextId: source.contextId,
            sourceEventKind: "MATERIALIZATION_RECEIPT_ITEM",
            sourceEventId: source.itemId,
            responsibilityId: source.responsibilityId,
            independenceGroup: source.contextId,
            independenceWeight: 1,
            qualityWeight: 1,
          });
        } catch (err) {
          if (err instanceof PatternSourceEligibilityError || err instanceof PatternSourceProvenanceError) {
            await writeReceipt(tx, {
              existingReceiptId,
              workspaceId,
              ownerSubjectUserId,
              sourceEventId: source.itemId,
              contextId: source.contextId,
              responsibilityId: source.responsibilityId,
              inputDigest,
              policyVersion: CASE_PATTERN_MATCH_POLICY_VERSION,
              model: embedOutcome.model,
              dimensions: embedOutcome.dimensions,
              sourceVersion: CASE_PATTERN_EMBEDDING_SOURCE_VERSION,
              outcome: "SKIPPED",
              reasonCode: "NOT_ELIGIBLE_NO_PRIMARY_LINK",
            });
            return "SKIPPED_NOT_ELIGIBLE" as const;
          }
          throw err;
        }

        await writeReceipt(tx, {
          existingReceiptId,
          workspaceId,
          ownerSubjectUserId,
          sourceEventId: source.itemId,
          contextId: source.contextId,
          responsibilityId: source.responsibilityId,
          inputDigest,
          policyVersion: CASE_PATTERN_MATCH_POLICY_VERSION,
          model: embedOutcome.model,
          dimensions: embedOutcome.dimensions,
          sourceVersion: CASE_PATTERN_EMBEDDING_SOURCE_VERSION,
          outcome: "MATCHED",
          matchedPatternId: matchResult.patternId,
          matchedPatternRevisionId: matchResult.revisionId,
          bestSimilarity: matchResult.similarity,
        });
        return "MATCHED" as const;
      });

      if (outcome === "SKIPPED_NOT_ELIGIBLE") {
        results.push({ sourceEventId: source.itemId, outcome: "SKIPPED", reasonCode: "NOT_ELIGIBLE_NO_PRIMARY_LINK" });
      } else {
        results.push({ sourceEventId: source.itemId, outcome: "MATCHED" });
      }
      continue;
    }

    if (matchResult.kind === "AMBIGUOUS") {
      const best = matchResult.candidates[0]!;
      const second = matchResult.candidates[1];
      await commitSourceOutcome(jobContext, async (tx) => {
        await writeReceipt(tx, {
          existingReceiptId,
          workspaceId,
          ownerSubjectUserId,
          sourceEventId: source.itemId,
          contextId: source.contextId,
          responsibilityId: source.responsibilityId,
          inputDigest,
          policyVersion: CASE_PATTERN_MATCH_POLICY_VERSION,
          model: embedOutcome.model,
          dimensions: embedOutcome.dimensions,
          sourceVersion: CASE_PATTERN_EMBEDDING_SOURCE_VERSION,
          outcome: "AMBIGUOUS",
          matchedPatternId: best.patternId,
          matchedPatternRevisionId: best.revisionId,
          bestSimilarity: best.similarity,
          secondSimilarity: second?.similarity,
        });
      });
      results.push({ sourceEventId: source.itemId, outcome: "AMBIGUOUS" });
      continue;
    }

    if (matchResult.kind === "EMBEDDING_FAILED") {
      // classifyCasePatternVectorはEmbedding生成後のDB照会のみなので通常
      // 到達しないが、型契約上の網羅性のためFAILEDとして扱う。
      await commitSourceOutcome(jobContext, async (tx) => {
        await writeReceipt(tx, {
          existingReceiptId,
          workspaceId,
          ownerSubjectUserId,
          sourceEventId: source.itemId,
          contextId: source.contextId,
          responsibilityId: source.responsibilityId,
          inputDigest,
          policyVersion: CASE_PATTERN_MATCH_POLICY_VERSION,
          model: embedOutcome.model,
          dimensions: embedOutcome.dimensions,
          sourceVersion: CASE_PATTERN_EMBEDDING_SOURCE_VERSION,
          outcome: "FAILED",
          reasonCode: "EMBEDDING_FATAL_FAILURE",
        });
      });
      results.push({ sourceEventId: source.itemId, outcome: "FAILED", reasonCode: "EMBEDDING_FATAL_FAILURE" });
      continue;
    }

    // NO_MATCH: 新規CasePattern identity + revision 1 + embedding + SourceLink +
    // Receiptを単一transactionで作成する(§3.2手順7、03Cでgeneration lock・
    // Receiptを同一tx内へ統合)。title/representativeTextは入力根拠
    // (Responsibility.type/title)から決定論的に構築する(AIに捏造させない)。
    await commitSourceOutcome(jobContext, async (tx) => {
      const identity = await createCasePatternIdentity(
        {
          workspaceId,
          ownerSubjectUserId,
          title: `${source.responsibilityType}: ${source.responsibilityTitle}`,
          representativeText: candidate.representativeText,
          decompositionTemplate: candidate.decompositionTemplate as Prisma.InputJsonValue,
          thresholds: CASE_PATTERN_REVISION_THRESHOLDS_SNAPSHOT,
          schemaVersion: CASE_PATTERN_REVISION_SCHEMA_VERSION,
        },
        tx,
      );

      await storeCasePatternEmbedding(tx, {
        workspaceId,
        revisionId: identity.revisionId,
        vectorLiteral: embedOutcome.vectorLiteral,
        model: embedOutcome.model,
        dimensions: embedOutcome.dimensions,
      });

      await tx.casePatternSourceLink.create({
        data: {
          workspaceId,
          patternRevisionId: identity.revisionId,
          contextId: source.contextId,
          sourceEventKind: "MATERIALIZATION_RECEIPT_ITEM",
          sourceEventId: source.itemId,
          responsibilityId: source.responsibilityId,
          formationSessionId: null,
          sourceOccurredAt: source.sourceOccurredAt,
          independenceGroup: source.contextId,
          independenceWeight: 1,
          qualityWeight: 1,
        },
      });

      await writeReceipt(tx, {
        existingReceiptId,
        workspaceId,
        ownerSubjectUserId,
        sourceEventId: source.itemId,
        contextId: source.contextId,
        responsibilityId: source.responsibilityId,
        inputDigest,
        policyVersion: CASE_PATTERN_MATCH_POLICY_VERSION,
        model: embedOutcome.model,
        dimensions: embedOutcome.dimensions,
        sourceVersion: CASE_PATTERN_EMBEDDING_SOURCE_VERSION,
        outcome: "NEW_PATTERN_CREATED",
        createdPatternId: identity.patternId,
      });
    });
    results.push({ sourceEventId: source.itemId, outcome: "NEW_PATTERN_CREATED" });
  }

  return results;
}
