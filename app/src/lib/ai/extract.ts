import { db } from "@/lib/db";
import { ExtractionResultSchema } from "@/lib/ai/schema";
import { createAnthropicExtractionProvider } from "@/lib/ai/anthropicProvider";
import type { AiExtractionProvider, AiExtractionUsage } from "@/lib/ai/provider";

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
  | { status: "SKIPPED"; reason: string };

function provider(): AiExtractionProvider {
  return createAnthropicExtractionProvider();
}

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

  if (capture.sourceType === "VOICE" || !capture.rawText) {
    const reason = "音声文字起こし(API-CAP-02/PRV-03)は未実装のため、本文なしCaptureは解析できません";
    await markFailed(capture.id, processingVersion, reason);
    return { status: "FAILED", reason };
  }

  // Worker手順3〜5: PromptBuilder→Gateway呼び出し→Schema検証。最大2回まで試行。
  const ai = provider();
  let lastFailureReason = "";
  let lastUsage: AiExtractionUsage | undefined;

  for (let attempt = 1; attempt <= MAX_AI_ATTEMPTS; attempt++) {
    const outcome = await ai.extractCandidates({
      rawText: capture.rawText,
      nowIso: new Date().toISOString(),
      timezone: DEFAULT_TIMEZONE,
    });

    if (!outcome.ok) {
      lastFailureReason = outcome.message;
      lastUsage = outcome.usage;
      if (outcome.kind === "FATAL") break; // 再試行しても解決しないため即終了
      continue; // TRANSIENT/STRUCTURAL: 次のattemptへ
    }

    lastUsage = outcome.usage;
    const parsed = ExtractionResultSchema.safeParse(outcome.rawJson);
    if (!parsed.success) {
      lastFailureReason = `AI_SCHEMA_INVALID: ${parsed.error.issues.map((i) => i.message).join("; ").slice(0, 500)}`;
      continue; // 構造違反は修復可能な失敗として再試行対象
    }

    // Worker手順6〜7: ai_run/ai_inferences保存、Capture=READY、InferenceReadyイベント発行
    const inferenceCount = await persistSuccess(capture.id, processingVersion, ai, parsed.data, outcome.usage);
    return { status: "READY", inferenceCount };
  }

  // 最大試行回数(2回)に到達、またはFATAL: Capture=FAILEDで終端(設計書の明記通り)
  await persistFailure(capture.id, processingVersion, ai, lastFailureReason, lastUsage);
  return { status: "FAILED", reason: lastFailureReason };
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
  result: { candidates: import("@/lib/ai/schema").ResponsibilityCandidate[] },
  usage: AiExtractionUsage,
): Promise<number> {
  return db.$transaction(async (tx) => {
    const run = await tx.aiRun.create({
      data: {
        captureId,
        provider: ai.providerName,
        model: ai.modelName,
        promptVersion: ai.promptVersion,
        schemaVersion: ai.schemaVersion,
        inputTokens: usage.inputTokens,
        outputTokens: usage.outputTokens,
        latencyMs: usage.latencyMs,
        status: "SUCCEEDED",
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
      data: { processingStatus: "READY", version: { increment: 1 } },
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

    return result.candidates.length;
  });
}

async function persistFailure(
  captureId: string,
  processingVersion: number,
  ai: AiExtractionProvider,
  reason: string,
  usage: AiExtractionUsage | undefined,
): Promise<void> {
  await db.$transaction(async (tx) => {
    await tx.aiRun.create({
      data: {
        captureId,
        provider: ai.providerName,
        model: ai.modelName,
        promptVersion: ai.promptVersion,
        schemaVersion: ai.schemaVersion,
        inputTokens: usage?.inputTokens,
        outputTokens: usage?.outputTokens,
        latencyMs: usage?.latencyMs,
        status: "FAILED",
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
  await db.$transaction(async (tx) => {
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
