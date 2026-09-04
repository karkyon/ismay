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

/** CasePatternRevision.thresholdsへ保存するスナップショット(casePatternMath.tsの現行定数)。 */
const CASE_PATTERN_REVISION_THRESHOLDS_SNAPSHOT = {
  windowCycles: CASE_PATTERN_WINDOW_CYCLES,
  nullIntervalConfidenceCap: CASE_PATTERN_NULL_INTERVAL_CONFIDENCE_CAP,
};
/** 既存verify script群と同じ慣行(casePatternRevisionService.ts利用箇所参照)。 */
const CASE_PATTERN_REVISION_SCHEMA_VERSION = "1.0";

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
      where: { workspaceId, responsibilityId: link.responsibilityId },
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
 * 引く。存在すれば「この入力・policy・model・sourceVersionでは処理済み」
 * (PE2E-02)。
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
    select: { id: true },
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
}

async function writeReceipt(txOrDb: typeof db | Prisma.TransactionClient, p: WriteReceiptParams): Promise<void> {
  try {
    await txOrDb.casePatternDetectionReceipt.create({
      data: {
        workspaceId: p.workspaceId,
        ownerSubjectUserId: p.ownerSubjectUserId,
        sourceEventKind: "MATERIALIZATION_RECEIPT_ITEM",
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
      },
    });
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
 * する(§3.2手順1〜9)。generationの古さ検出(手順10)はcaseDetectQueueJob.ts側の
 * 既存completeCaseDetectJobが担う(全書込みが冪等のため、二重実行しても
 * 副作用は増えない)。
 */
export async function runCasePatternDetectionForOwner(
  workspaceId: string,
  ownerSubjectUserId: string,
  overrides: CasePatternEmbeddingOverrides = {},
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
    if (existingReceipt) {
      // [PE2E-02] 同一input/policy/model/sourceVersionは既に処理済み。
      // embed() API呼出し自体を行わずスキップする。
      results.push({ sourceEventId: source.itemId, outcome: "SKIPPED", reasonCode: "ALREADY_PROCESSED" });
      continue;
    }

    const embedOutcome = await embedCasePatternCandidate(workspaceId, candidate, overrides, provider);
    if (!embedOutcome.ok) {
      const reasonCode = embedOutcome.errorKind === "TRANSIENT" ? "EMBEDDING_TRANSIENT_FAILURE" : "EMBEDDING_FATAL_FAILURE";
      // [model不明時] provider解決自体に失敗した場合、modelは不明("UNKNOWN")として
      // 記録する(受入試験可視化のため、秘密情報は含めない)。
      await writeReceipt(db, {
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
      try {
        await linkPatternSourceEvent({
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
          await writeReceipt(db, {
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
          results.push({ sourceEventId: source.itemId, outcome: "SKIPPED", reasonCode: "NOT_ELIGIBLE_NO_PRIMARY_LINK" });
          continue;
        }
        throw err;
      }

      await writeReceipt(db, {
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
      results.push({ sourceEventId: source.itemId, outcome: "MATCHED" });
      continue;
    }

    if (matchResult.kind === "AMBIGUOUS") {
      const best = matchResult.candidates[0]!;
      const second = matchResult.candidates[1];
      await writeReceipt(db, {
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
      results.push({ sourceEventId: source.itemId, outcome: "AMBIGUOUS" });
      continue;
    }

    if (matchResult.kind === "EMBEDDING_FAILED") {
      // classifyCasePatternVectorはEmbedding生成後のDB照会のみなので通常
      // 到達しないが、型契約上の網羅性のためFAILEDとして扱う。
      await writeReceipt(db, {
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
      results.push({ sourceEventId: source.itemId, outcome: "FAILED", reasonCode: "EMBEDDING_FATAL_FAILURE" });
      continue;
    }

    // NO_MATCH: 新規CasePattern identity + revision 1 + embedding + SourceLinkを
    // 単一transactionで作成する(§3.2手順7)。title/representativeTextは
    // 入力根拠(Responsibility.type/title)から決定論的に構築する(AIに
    // 捏造させない)。
    const createdPatternId = await db.$transaction(async (tx: Prisma.TransactionClient): Promise<string> => {
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

      return identity.patternId;
    });

    await writeReceipt(db, {
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
      createdPatternId,
    });
    results.push({ sourceEventId: source.itemId, outcome: "NEW_PATTERN_CREATED" });
  }

  return results;
}
