import { db } from "@/lib/db";
import type { Prisma } from "@/generated/prisma/client";
import { debugServer } from "@/lib/debugServer";
import { parseExtractionResultLenient } from "@/lib/ai/schema";
import { getActiveExtractionProvider } from "@/lib/ai/config";
import { estimateCostMicros } from "@/lib/ai/pricing";
import type { AiExtractionProvider, AiExtractionOutcome, AiExtractionUsage } from "@/lib/ai/provider";
import type { ShadowSourceCaptureContext } from "@/lib/formation/shadowWrite";
import { checkAiPolicyAndConsent } from "@/lib/ai/consentPolicy";
import { createShadowCheckpoint, attemptShadowCheckpointInline } from "@/lib/formation/shadowCheckpoint";

/**
 * FN-AI-01 責任候補抽出(機能別詳細設計書v1.1 3章「Worker手順」1〜7に対応)。
 *
 * 呼び出し元(worker/aiExtractJob.ts)は、本関数が正常return（READYでもFAILEDでも）した場合は
 * Jobを完了扱いにする。本関数内で「最大2回」のAI Gateway再試行と、最終失敗時のCapture=FAILED
 * 更新まで完結させるため(設計書の「失敗：最大2回。最終失敗はCaptureをFAILED」に対応)。
 * 本関数から例外がthrowされた場合(DB接続断等、AI自体とは無関係の障害)のみ、
 * 呼び出し元がJobレベルの再試行(指数バックオフ)を行う。
 */

const MAX_AI_ATTEMPTS = 2;
const DEFAULT_TIMEZONE = "Asia/Tokyo"; // TBD-10(日本初期提供前提)に対応。将来ロケール別対応時に見直す

export type ExtractionRunResult =
  | { status: "READY"; inferenceCount: number }
  | { status: "FAILED"; reason: string }
  | { status: "SKIPPED"; reason: string }
  /** [2026-08-21追加] processingPriority=BATCHのCapture。Anthropic Batchへ投入済みで、
   *  結果はまだ届いていない。呼び出し元(aiExtractJob.ts)はJobをAWAITING_BATCHへ遷移させる。 */
  | { status: "BATCH_PENDING"; batchId: string; processingVersion: number };

export async function runExtractionForCapture(captureId: string): Promise<ExtractionRunResult> {
  const capture = await db.capture.findUnique({
    where: { id: captureId },
    include: { domain: true },
  });
  if (!capture || capture.deletedAt) {
    return { status: "SKIPPED", reason: "Captureが存在しないか削除済みです" };
  }

  // Worker手順1: Job冪等キー確認(呼び出し元で実施済み)、Capture状態をPROCESSINGへCAS更新
  const claimed = await db.capture.updateMany({
    where: { id: capture.id, version: capture.version, processingStatus: "QUEUED" },
    data: { processingStatus: "PROCESSING", version: { increment: 1 } },
  });
  if (claimed.count === 0) {
    // 既に他のWorker実行が処理中/完了済み。二重処理しない(NFR-AVL-05 冪等)。
    return { status: "SKIPPED", reason: "既にPROCESSING/READY等へ遷移済みのためスキップしました" };
  }
  const processingVersion = capture.version + 1;

  // Worker手順2: Domain AI policyと同意を評価
  const policyCheck = await checkAiPolicyAndConsent(capture.id);
  if (!policyCheck.allowed) {
    await markFailed(capture.id, processingVersion, policyCheck.reason);
    return { status: "FAILED", reason: policyCheck.reason };
  }

  if (!capture.rawText) {
    // [2026-08-21修正] 従来sourceType==="VOICE"を無条件でブロックしていたが、
    // 音声文字起こし(transcribeAudioJob.ts)が実装されたことで、VOICE Captureも
    // 文字起こし完了後はrawTextが埋まった状態でここに到達するようになった。
    // 画像OCR(ocrImageJob.ts、2026-08-21追加)も同様の理由でIMAGE Captureをブロックしない。
    // rawTextが空の場合(文字起こし/OCR未実行・失敗)のみブロックする。
    const reason = "本文がありません(音声・画像の場合は文字起こし/OCRが完了していない可能性があります)";
    await markFailed(capture.id, processingVersion, reason);
    return { status: "FAILED", reason };
  }

  // Worker手順3〜5: PromptBuilder→Gateway呼び出し→Schema検証。最大2回まで試行。
  // 使用するプロバイダーはWorkspace設定(管理画面/admin/ai-providersで切替可能)から解決する。
  const ai = await getActiveExtractionProvider(capture.workspaceId);
  debugServer.event("extract/runExtractionForCapture", "PROVIDER_RESOLVED", {
    captureId: capture.id,
    providerName: ai.providerName,
    modelName: ai.modelName,
  });

  // [2026-08-21追加] カルキョンさんの指示「緊急性が高いのかバッチでいいのか選択させる」に対応。
  // processingPriority=BATCHかつプロバイダーがBatch APIに対応している場合のみバッチ投入する。
  // 対応していない場合(プロバイダー未対応)は、想定外の課金体系にならないよう黙って
  // 通常フローへフォールバックせず、REALTIME同様に即時実行する(現状Anthropicのみ登録されて
  // おり常に対応しているため、実運用でこの分岐に来ることは無い想定)。
  if (capture.processingPriority === "BATCH" && ai.submitExtractionBatch) {
    const existingTagsForBatch = await db.tag.findMany({
      where: { workspaceId: capture.workspaceId, deletedAt: null },
      select: { name: true },
      take: 50,
    });
    const submitResult = await ai.submitExtractionBatch({
      rawText: capture.rawText,
      nowIso: new Date().toISOString(),
      timezone: DEFAULT_TIMEZONE,
      existingTagNames: (existingTagsForBatch as { name: string }[]).map((t) => t.name),
    });
    if (!submitResult.ok) {
      await persistFailure(capture.id, processingVersion, ai, `Batch投入失敗: ${submitResult.message}`, undefined, true);
      return { status: "FAILED", reason: `Batch投入失敗: ${submitResult.message}` };
    }
    debugServer.event("extract/runExtractionForCapture", "BATCH_SUBMITTED", { captureId: capture.id, batchId: submitResult.batchId });
    return { status: "BATCH_PENDING", batchId: submitResult.batchId, processingVersion };
  }

  let lastFailureReason = "";
  let lastUsage: AiExtractionUsage | undefined;

  // [2026-08-21追加] AI提案タグ(suggestedTags)が既存タグの表記ゆれを増やさないよう、
  // このWorkspaceの既存タグ名一覧をプロンプトへ渡す。
  const existingTags = await db.tag.findMany({
    where: { workspaceId: capture.workspaceId, deletedAt: null },
    select: { name: true },
    take: 50,
  });
  const existingTagNames = (existingTags as { name: string }[]).map((t) => t.name);

  for (let attempt = 1; attempt <= MAX_AI_ATTEMPTS; attempt++) {
    const outcome = await ai.extractCandidates({
      rawText: capture.rawText,
      nowIso: new Date().toISOString(),
      timezone: DEFAULT_TIMEZONE,
      existingTagNames,
    });

    if (!outcome.ok) {
      lastFailureReason = outcome.message;
      lastUsage = outcome.usage;
      if (outcome.kind === "FATAL") break; // 再試行しても解決しないため即終了
      continue; // TRANSIENT/STRUCTURAL: 次のattemptへ
    }

    lastUsage = outcome.usage;
    const parsed = parseExtractionResultLenient(outcome.rawJson);
    if (!parsed.ok) {
      lastFailureReason = `AI_SCHEMA_INVALID: ${parsed.reason}`;
      continue; // 構造違反(または全候補が個別検証に失敗)は修復可能な失敗として再試行対象
    }
    if (parsed.droppedCount > 0) {
      // [2026-08-28追加] 一部候補のみ構造異常だった場合、その候補だけを捨てて残りを
      // 採用する(道連れ全滅を防ぐ)。何が・なぜ落ちたかは観測できるようログする。
      debugServer.event("extract/runExtractionForCapture", "PARTIAL_CANDIDATES_DROPPED", {
        captureId: capture.id,
        droppedCount: parsed.droppedCount,
        keptCount: parsed.candidates.length,
        dropReasons: parsed.dropReasons,
      });
    }

    // Worker手順6〜7: ai_run/ai_inferences保存、Capture=READY、InferenceReadyイベント発行
    const inferenceCount = await persistSuccess(capture.id, processingVersion, ai, parsed, outcome.usage, false, {
      id: capture.id,
      workspaceId: capture.workspaceId,
      domainId: capture.domainId,
      createdById: capture.createdById,
      rawText: capture.rawText,
      sourceType: capture.sourceType,
    });
    return { status: "READY", inferenceCount };
  }

  // 最大試行回数(2回)に到達、またはFATAL: Capture=FAILEDで終端(設計書の明記通り)
  await persistFailure(capture.id, processingVersion, ai, lastFailureReason, lastUsage);
  return { status: "FAILED", reason: lastFailureReason };
}

/**
 * [2026-08-21追加] processingPriority=BATCHのCaptureについて、Anthropic Batchが
 * 完了した(processing_status=ended)後に呼ばれる。runExtractionForCaptureの
 * ループ内で行っていたschema検証〜永続化を、Batch結果1件に対して1回だけ行う
 * (Batchは再送コストが高いため、同期パスのような複数回リトライは行わない)。
 *
 * 呼び出し元(worker/batchPollJob.ts)は、Job.payloadに保存しておいたcaptureIdと
 * resultsUrlを渡す。Capture.versionのCAS等はrunExtractionForCapture側で既に
 * PROCESSINGへ遷移済みのため、ここでは行わない(processingVersionを直接渡してもらう)。
 *
 * [2026-08-30更新・M1-B5a §4.2] DEC-009「Batch経路はshadow書込み対象外」は解消した。
 * REALTIME経路(runExtractionForCapture)と同じ`persistSuccess`のshadowContext引数を
 * 渡すようにし、Batch完了時もFormation Session shadow構造(→Question Policy評価→
 * CLARIFYING/REVIEW_READY)が作られるようにした。
 */
export async function finalizeBatchExtraction(
  captureId: string,
  processingVersion: number,
  resultsUrl: string,
): Promise<ExtractionRunResult> {
  const capture = await db.capture.findUnique({ where: { id: captureId } });
  if (!capture || capture.deletedAt) {
    return { status: "SKIPPED", reason: "Captureが存在しないか削除済みです" };
  }

  const ai = await getActiveExtractionProvider(capture.workspaceId);
  if (!ai.fetchExtractionBatchResult) {
    await persistFailure(capture.id, processingVersion, ai, "プロバイダーがBatch結果取得に対応していません", undefined, true);
    return { status: "FAILED", reason: "プロバイダーがBatch結果取得に対応していません" };
  }

  const outcome: AiExtractionOutcome = await ai.fetchExtractionBatchResult(resultsUrl);
  if (!outcome.ok) {
    await persistFailure(capture.id, processingVersion, ai, outcome.message, outcome.usage, true);
    return { status: "FAILED", reason: outcome.message };
  }

  const parsed = parseExtractionResultLenient(outcome.rawJson);
  if (!parsed.ok) {
    const reason = `AI_SCHEMA_INVALID: ${parsed.reason}`;
    await persistFailure(capture.id, processingVersion, ai, reason, outcome.usage, true);
    return { status: "FAILED", reason };
  }
  if (parsed.droppedCount > 0) {
    debugServer.event("extract/finalizeBatchExtraction", "PARTIAL_CANDIDATES_DROPPED", {
      captureId: capture.id,
      droppedCount: parsed.droppedCount,
      keptCount: parsed.candidates.length,
      dropReasons: parsed.dropReasons,
    });
  }

  // [DEC-009解消・2026-08-30 M1-B5a §4.2] Batch経路もshadow書込み対象とする。
  // 対象captureは`runExtractionForCapture`側で既にrawText有無チェック済みで
  // Batch投入されているため、通常はrawTextが存在するはずだが、投入からここに
  // 至るまでの間にCaptureが変更される可能性を排除できないため、念のため
  // rawText有無を再確認し、無ければ(shadowWrite自体がdomainId欠落時と同じ
  // 「静かにスキップ」方針を取っているのに合わせ)shadowContextを渡さず
  // shadow書込み自体をスキップする(想像で本体のBatch結果確定処理を止めない)。
  const inferenceCount = await persistSuccess(
    capture.id,
    processingVersion,
    ai,
    parsed,
    outcome.usage,
    true,
    capture.rawText
      ? {
          id: capture.id,
          workspaceId: capture.workspaceId,
          domainId: capture.domainId,
          createdById: capture.createdById,
          rawText: capture.rawText,
          sourceType: capture.sourceType,
        }
      : undefined,
  );
  return { status: "READY", inferenceCount };
}

async function persistSuccess(
  captureId: string,
  processingVersion: number,
  ai: AiExtractionProvider,
  result: { candidates: import("@/lib/ai/schema").ResponsibilityCandidate[]; captureSummary?: string },
  usage: AiExtractionUsage,
  batch = false,
  /**
   * [V5-M1-B2] REALTIME経路(runExtractionForCapture)、および
   * [2026-08-30更新・M1-B5a §4.2] Batch経路(finalizeBatchExtraction)の両方から
   * 渡される。rawTextが取得できない稀なケース(Batch完了までの間にCaptureが
   * 変更された等)のみundefinedで呼ばれ、その場合は下記でshadow書込み自体を
   * スキップする。
   */
  shadowContext?: ShadowSourceCaptureContext,
): Promise<number> {
  const { count, checkpointId } = await db.$transaction(async (tx: Prisma.TransactionClient) => {
    const run = await tx.aiRun.create({
      data: {
        captureId,
        provider: ai.providerName,
        model: ai.modelName,
        promptVersion: ai.promptVersion,
        schemaVersion: ai.schemaVersion,
        inputTokens: usage.inputTokens,
        outputTokens: usage.outputTokens,
        costMicros: estimateCostMicros(ai.modelName, usage.inputTokens, usage.outputTokens, batch),
        latencyMs: usage.latencyMs,
        status: "SUCCEEDED",
        batch,
        finishedAt: new Date(),
      },
    });

    for (const candidate of result.candidates) {
      await tx.aiInference.create({
        data: {
          captureId,
          aiRunId: run.id,
          inferenceType: "RESPONSIBILITY",
          payload: candidate as unknown as object,
          evidenceSpans: candidate.evidenceSpans as unknown as object,
          confidence: candidate.confidence,
          decision: "PENDING",
        },
      });
    }

    const updated = await tx.capture.updateMany({
      where: { id: captureId, version: processingVersion, processingStatus: "PROCESSING" },
      data: {
        processingStatus: "READY",
        version: { increment: 1 },
        ...(result.captureSummary ? { aiSummary: result.captureSummary } : {}),
      },
    });

    await tx.eventLog.create({
      data: {
        aggregateType: "Capture",
        aggregateId: captureId,
        eventType: "INFERENCE_READY",
        afterJson: { candidateCount: result.candidates.length, aiRunId: run.id },
        actorType: "AI",
      },
    });

    if (updated.count > 0) {
      await tx.outboxEvent.create({
        data: {
          eventName: "InferenceReady.v1",
          eventVersion: "1",
          aggregateId: captureId,
          aggregateVersion: processingVersion + 1,
          payload: { captureId, candidateCount: result.candidates.length },
        },
      });
    }

    // [M1-B6C-1新設・2026-08-31指示書§3.2]
    // 「Capture/AiInference本体transaction内でcheckpointをPENDING登録する」。
    // shadowContextが無い(rawText欠落等でshadow対象外)場合はcheckpoint自体を
    // 作らない(従来のwriteShadowFormationSession呼出し省略と同じ判断基準)。
    let checkpointId: string | null = null;
    if (shadowContext) {
      const checkpoint = await createShadowCheckpoint(tx, {
        workspaceId: shadowContext.workspaceId,
        captureId: shadowContext.id,
        aiRunId: run.id,
        schemaVersion: ai.schemaVersion,
        candidateCount: result.candidates.length,
      });
      checkpointId = checkpoint.id;
    }

    return { count: result.candidates.length, aiRunId: run.id, checkpointId };
  });

  // [2026-08-31是正 M1-B6C-1] 本体transactionが確定した後、durableなcheckpoint行
  // (PENDINGで既にDBへ記録済み)に対して即時実行を1回試みる(応答性を保つ
  // best-effort inline attempt)。失敗してもcheckpoint行はRETRY_WAIT/DEAD_LETTERへ
  // 遷移して残るため、shadowReconciliationJob.ts(Worker)が確実に再試行する。
  // 従来のように失敗が完全に握り潰されて観測不能になることはない
  // (checkpoint行が「shadow projectionがまだ完了していない」事実を永続的に示す)。
  if (checkpointId) {
    await attemptShadowCheckpointInline(checkpointId);
  }

  return count;
}

async function persistFailure(
  captureId: string,
  processingVersion: number,
  ai: AiExtractionProvider,
  reason: string,
  usage: AiExtractionUsage | undefined,
  batch = false,
): Promise<void> {
  await db.$transaction(async (tx: Prisma.TransactionClient) => {
    await tx.aiRun.create({
      data: {
        captureId,
        provider: ai.providerName,
        model: ai.modelName,
        promptVersion: ai.promptVersion,
        schemaVersion: ai.schemaVersion,
        inputTokens: usage?.inputTokens,
        outputTokens: usage?.outputTokens,
        costMicros: usage ? estimateCostMicros(ai.modelName, usage.inputTokens, usage.outputTokens, batch) : null,
        latencyMs: usage?.latencyMs,
        status: "FAILED",
        batch,
        errorCode: reason.slice(0, 200),
        finishedAt: new Date(),
      },
    });

    await tx.capture.updateMany({
      where: { id: captureId, version: processingVersion, processingStatus: "PROCESSING" },
      data: { processingStatus: "FAILED", version: { increment: 1 } },
    });

    await tx.eventLog.create({
      data: {
        aggregateType: "Capture",
        aggregateId: captureId,
        eventType: "CAPTURE_ANALYSIS_FAILED",
        afterJson: { reason: reason.slice(0, 500) },
        actorType: "AI",
      },
    });
  });
}

/** ai_runすら作れない(Domain policy/consent拒否)場合の失敗記録。aiRunは残さない。 */
async function markFailed(captureId: string, processingVersion: number, reason: string): Promise<void> {
  await db.$transaction(async (tx: Prisma.TransactionClient) => {
    await tx.capture.updateMany({
      where: { id: captureId, version: processingVersion, processingStatus: "PROCESSING" },
      data: { processingStatus: "FAILED", version: { increment: 1 } },
    });
    await tx.eventLog.create({
      data: {
        aggregateType: "Capture",
        aggregateId: captureId,
        eventType: "CAPTURE_ANALYSIS_FAILED",
        afterJson: { reason: reason.slice(0, 500) },
        actorType: "SYSTEM",
      },
    });
  });
}
