import { db } from "@/lib/db";
import type { Prisma } from "@/generated/prisma/client";
import { debugServer } from "@/lib/debugServer";
import { parseExtractionResultLenient } from "@/lib/ai/schema";
import { getActiveExtractionProvider } from "@/lib/ai/config";
import { estimateCostMicros } from "@/lib/ai/pricing";
import type { AiExtractionProvider, AiExtractionOutcome, AiExtractionUsage } from "@/lib/ai/provider";
import { writeShadowFormationSession, type ShadowSourceCaptureContext } from "@/lib/formation/shadowWrite";

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
      // [2026-08-28診断追加・一時的] AI_SCHEMA_INVALIDがcandidatesの型不一致
      // (JSON化された文字列で返る等)で繰り返し発生しているため、原因特定用に
      // AIの生レスポンス(outcome.rawJson)をそのままログへ出す。ai_runs.error_codeは
      // 500文字に切り詰められ、かつcandidatesの実際の中身(型・値)が見えないため。
      // 個人情報を含みうる原文由来のデータだが、既存のdebugServer.input/state等でも
      // 同様にCapture本文やAI出力をログしている(このリポジトリの既存運用方針)ため、
      // 一時的な調査用途としてこの粒度で出力する。原因特定後に削除する。
      debugServer.error("extract/runExtractionForCapture", "AI_SCHEMA_INVALID_RAW_RESPONSE(診断用・一時)", {
        captureId: capture.id,
        attempt,
        rawJsonType: typeof outcome.rawJson,
        rawJson: outcome.rawJson,
      });
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

  // [DEC-009] Batch経路はこのGate(M1-B2)ではFormation shadow書込みの対象外のため、
  // shadowContext(第7引数)は渡さない(persistSuccess側でundefinedなら自動スキップされる)。
  const inferenceCount = await persistSuccess(capture.id, processingVersion, ai, parsed, outcome.usage, true);
  return { status: "READY", inferenceCount };
}

interface PolicyCheckResult {
  allowed: boolean;
  reason: string;
}

async function checkAiPolicyAndConsent(captureId: string): Promise<PolicyCheckResult> {
  const capture = await db.capture.findUniqueOrThrow({
    where: { id: captureId },
    include: { domain: true, consent: true },
  });

  // Domain AI policy: [推論・MVP暫定] aiPolicy.aiReferenceAllowed===false のみ明示的に拒否。
  // 未設定(null)は許可扱い(ensureDefaultWorkspaceが作る既定Domainはaipolicy未設定のため)。
  const policy = capture.domain?.aiPolicy as { aiReferenceAllowed?: boolean } | null | undefined;
  if (policy?.aiReferenceAllowed === false) {
    return { allowed: false, reason: "このDomainはAI参照が許可されていません(Domain AI policy)" };
  }

  // FN-PRV-02: MEETINGは同意必須。撤回済み・期限切れも再解析を拒否する(4.8節の例外規定)。
  if (capture.sourceType === "MEETING") {
    if (!capture.consent) {
      return { allowed: false, reason: "会議録音の同意が未登録です" };
    }
    if (capture.consent.withdrawnAt) {
      return { allowed: false, reason: "会議録音の同意が撤回されています" };
    }
    if (capture.consent.expiresAt && capture.consent.expiresAt.getTime() < Date.now()) {
      return { allowed: false, reason: "会議録音の同意保持期限が切れています" };
    }
  }

  return { allowed: true, reason: "" };
}

async function persistSuccess(
  captureId: string,
  processingVersion: number,
  ai: AiExtractionProvider,
  result: { candidates: import("@/lib/ai/schema").ResponsibilityCandidate[]; captureSummary?: string },
  usage: AiExtractionUsage,
  batch = false,
  /**
   * [V5-M1-B2・DEC-009] REALTIME経路(runExtractionForCapture)のみ渡される。
   * Batch経路(finalizeBatchExtraction)はこのGateではshadow書込み対象外のため
   * undefinedのまま呼ばれ、その場合は下記でshadow書込み自体をスキップする。
   */
  shadowContext?: ShadowSourceCaptureContext,
): Promise<number> {
  const { count, aiRunId } = await db.$transaction(async (tx: Prisma.TransactionClient) => {
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

    return { count: result.candidates.length, aiRunId: run.id };
  });

  // [V5-M1-B2] 本体のtransactionが確定した後に、best-effortでFormation Session
  // shadow構造を書く(DOC-03 10章「M1-B1はshadow Session生成のみ」の実配線)。
  // writeShadowFormationSession自身が内部で例外を握りつぶすため、ここでの失敗が
  // 本関数の戻り値(count)やCapture=READY確定へ影響することは無い。
  if (shadowContext) {
    await writeShadowFormationSession({
      capture: shadowContext,
      aiRunId,
      schemaVersion: ai.schemaVersion,
      candidates: result.candidates,
      captureSummary: result.captureSummary,
    });
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
