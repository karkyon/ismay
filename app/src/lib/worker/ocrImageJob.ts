import { db } from "@/lib/db";
import type { Prisma } from "@/generated/prisma/client";
import { debugServer } from "@/lib/debugServer";
import { downloadImageObject } from "@/lib/storage";
import { getActiveOcrProvider } from "@/lib/ai/config";
import { estimateCostMicros } from "@/lib/ai/pricing";
import { checkAiJobConsentAllowed } from "@/lib/pem/aiJobConsentGate";
import type { AiOcrOutcome, AiOcrImageInput } from "@/lib/ai/ocrProvider";

/**
 * jobs テーブルの OCR_IMAGE ジョブをポーリング処理する(2026-08-21新設)。
 * FR-CAP-02(画像入力・将来項目の前倒し実装)の一部。処理内容:
 *  1. MinIOから画像ファイルを取得
 *  2. OCRプロバイダー(既定Anthropic Claude Vision)へ送信
 *  3. 成功時: Capture.rawTextへ書き込み、processingStatus=SAVED→AI抽出キューへ自動投入
 *     (CaptureAnalysisRequested.v1を発行。transcribeAudioJob.tsと同じ自動チェーン)
 *  4. 失敗時: Capture.processingStatus=FAILEDとし、AiRunに失敗理由を記録
 *
 * transcribeAudioJob.tsと同じ設計方針を踏襲: プロバイダー呼び出し自体の失敗はJobを
 * 成功扱いで終える(Capture側をFAILEDにするのみ)。Jobレベル再試行はDB接続断など
 * 無関係の例外にのみ適用。AiRun.promptVersion/schemaVersionは必須列(NOT NULL)であるため、
 * transcribeAudioJob.tsで発覚した不備(2026-08-21修正)を踏まえ、最初から両フィールドを
 * schema.prismaと突き合わせたうえで設定する。
 */

const JOB_BATCH_SIZE = 2; // 画像も文字起こしと同様に処理が重いため抽出より少なめのバッチ
const BASE_BACKOFF_SECONDS = 30;
const PROMPT_VERSION = "image-ocr-v1";
const SCHEMA_VERSION = "n/a"; // OCRは構造化出力ではないため、抽出プロンプトと違いスキーマバージョンの概念が無い
/** [2026-08-21追加] Anthropic Batch結果のポーリング間隔。batchPollJob.tsと共通の値。 */
const BATCH_POLL_INTERVAL_MS = 2 * 60 * 1000;

export async function processOcrImageJobs(): Promise<{ processed: number }> {
  const now = new Date();
  const candidates = await db.job.findMany({
    where: {
      jobType: "OCR_IMAGE",
      status: "QUEUED",
      OR: [{ nextRunAt: null }, { nextRunAt: { lte: now } }],
    },
    orderBy: { createdAt: "asc" },
    take: JOB_BATCH_SIZE,
  });

  let processed = 0;
  for (const job of candidates) {
    const claimed = await db.job.updateMany({
      where: { id: job.id, status: "QUEUED" },
      data: { status: "RUNNING" },
    });
    if (claimed.count === 0) continue;
    debugServer.state("Worker/ocrImageJob", "Job.status", { jobId: job.id, status: "RUNNING" });

    const payload = job.payload as { captureId?: string } | null;
    const captureId = payload?.captureId;
    if (!captureId) {
      await db.job.update({
        where: { id: job.id },
        data: { status: "DEAD_LETTER", lastError: "payload.captureIdが不正です" },
      });
      continue;
    }

    try {
      const result = await runOcrForCapture(captureId);
      debugServer.event("Worker/ocrImageJob", "runOcrForCapture", {
        jobId: job.id,
        captureId,
        status: result.status,
      });
      if (result.status === "BATCH_PENDING") {
        // [2026-08-21追加] Anthropic Batchへ投入済み。Jobを完了扱いにせず、
        // AWAITING_BATCHへ遷移させてbatchPollJob.tsのポーリング対象にする。
        await db.job.update({
          where: { id: job.id },
          data: {
            status: "AWAITING_BATCH",
            payload: { captureId, batchId: result.batchId, processingVersion: result.processingVersion },
            nextRunAt: new Date(Date.now() + BATCH_POLL_INTERVAL_MS),
          },
        });
        debugServer.state("Worker/ocrImageJob", "Job.status", { jobId: job.id, status: "AWAITING_BATCH" });
        processed++;
        continue;
      }
      await db.job.update({
        where: { id: job.id },
        data: {
          status: "SUCCEEDED",
          lastError: result.status === "FAILED" ? result.reason.slice(0, 500) : null,
        },
      });
      processed++;
    } catch (err) {
      const attempts = job.attempts + 1;
      const isDead = attempts >= job.maxAttempts;
      const backoffSeconds = BASE_BACKOFF_SECONDS * Math.pow(2, attempts - 1);
      await db.job.update({
        where: { id: job.id },
        data: {
          status: isDead ? "DEAD_LETTER" : "QUEUED",
          attempts,
          lastError: String(err).slice(0, 500),
          nextRunAt: isDead ? null : new Date(Date.now() + backoffSeconds * 1000),
        },
      });
      debugServer.error("Worker/ocrImageJob", "想定外の例外", { jobId: job.id, captureId, err });
    }
  }

  return { processed };
}

type OcrRunResult =
  | { status: "READY" }
  | { status: "FAILED"; reason: string }
  | { status: "SKIPPED"; reason: string }
  /** [2026-08-21追加] processingPriority=BATCHのCapture。Anthropic Batchへ投入済み。 */
  | { status: "BATCH_PENDING"; batchId: string; processingVersion: number };

async function runOcrForCapture(captureId: string): Promise<OcrRunResult> {
  const capture = await db.capture.findUnique({ where: { id: captureId } });
  if (!capture || capture.deletedAt) {
    return { status: "SKIPPED", reason: "Captureが存在しないか削除済みです" };
  }

  // [2026-08-21修正] 複数ページ対応。CaptureImage(新方式)を優先し、無ければ
  // imageObjectKey単体列(旧方式・移行前データ互換)にフォールバックする。
  const pages = await db.captureImage.findMany({
    where: { captureId: capture.id },
    orderBy: { pageIndex: "asc" },
  });
  const pageKeys: string[] =
    pages.length > 0 ? pages.map((p: { objectKey: string }) => p.objectKey) : capture.imageObjectKey ? [capture.imageObjectKey] : [];
  if (pageKeys.length === 0) {
    await markCaptureFailed(capture.id, capture.version, "画像が1件も紐づいていません");
    return { status: "FAILED", reason: "画像が1件も紐づいていません" };
  }

  const claimed = await db.capture.updateMany({
    where: { id: capture.id, version: capture.version, processingStatus: "QUEUED" },
    data: { processingStatus: "PROCESSING", version: { increment: 1 } },
  });
  if (claimed.count === 0) {
    return { status: "SKIPPED", reason: "既にPROCESSING/READY等へ遷移済みのためスキップしました" };
  }
  const processingVersion = capture.version + 1;

  const provider = await getActiveOcrProvider(capture.workspaceId);

  const images = await downloadAllPages(pageKeys);
  if (!images) {
    await markCaptureFailed(capture.id, processingVersion, "画像ファイルの取得に失敗しました");
    return { status: "FAILED", reason: "画像ファイルの取得に失敗しました" };
  }

  // [2026-08-21追加] カルキョンさんの指示「緊急性が高いのかバッチでいいのか選択させる」に対応。
  // extract.ts側の同種の分岐と同じ方針(プロバイダー未対応時は即時実行にフォールバック)。
  if (capture.processingPriority === "BATCH" && provider.submitOcrBatch) {
    const submitResult = await provider.submitOcrBatch({ images });
    if (!submitResult.ok) {
      await persistOcrFailure(capture.id, processingVersion, provider, `Batch投入失敗: ${submitResult.message}`, undefined, true);
      return { status: "FAILED", reason: `Batch投入失敗: ${submitResult.message}` };
    }
    debugServer.event("ocrImageJob", "BATCH_SUBMITTED", { captureId: capture.id, batchId: submitResult.batchId, pageCount: images.length });
    return { status: "BATCH_PENDING", batchId: submitResult.batchId, processingVersion };
  }

  const outcome = await provider.extractText({ images });

  return applyOcrOutcome(capture.id, capture.workspaceId, processingVersion, provider, outcome, false);
}

/** ページ画像キー一覧を全てMinIOから取得し、AiOcrImageInput配列を組み立てる。1件でも失敗すればnull。 */
async function downloadAllPages(objectKeys: string[]): Promise<AiOcrImageInput[] | null> {
  const results: AiOcrImageInput[] = [];
  for (const objectKey of objectKeys) {
    const buffer = await downloadImageObject(objectKey).catch((err) => {
      debugServer.error("ocrImageJob", "MinIOからのダウンロードに失敗", { objectKey, err });
      return null;
    });
    if (!buffer) return null;
    const fileName = objectKey.split("/").pop() ?? "image";
    results.push({ buffer, contentType: guessImageContentType(fileName), fileName });
  }
  return results;
}

/**
 * [2026-08-21追加] processingPriority=BATCHのCaptureについて、Anthropic Batchが
 * 完了した後に呼ばれる。extract.tsのfinalizeBatchExtractionと対称的な設計。
 */
export async function finalizeOcrBatchResult(
  captureId: string,
  workspaceId: string,
  processingVersion: number,
  resultsUrl: string,
): Promise<OcrRunResult> {
  const provider = await getActiveOcrProvider(workspaceId);
  if (!provider.fetchOcrBatchResult) {
    await persistOcrFailure(captureId, processingVersion, provider, "プロバイダーがBatch結果取得に対応していません", undefined, true);
    return { status: "FAILED", reason: "プロバイダーがBatch結果取得に対応していません" };
  }
  const outcome = await provider.fetchOcrBatchResult(resultsUrl);
  return applyOcrOutcome(captureId, workspaceId, processingVersion, provider, outcome, true);
}

/** OCR結果(同期・Batch共通)をAiRunへ記録し、成功時はCapture更新+AI抽出キューへの自動投入まで行う。 */
async function applyOcrOutcome(
  captureId: string,
  workspaceId: string,
  processingVersion: number,
  provider: { providerName: string; modelName: string },
  outcome: AiOcrOutcome,
  batch: boolean,
): Promise<OcrRunResult> {
  // AiRun.promptVersion/schemaVersionはschema.prisma上NOT NULL。
  // transcribeAudioJob.tsで実サーバーのtscにより発覚した不備(2026-08-21修正)を
  // 踏まえ、ここでも必ず設定する。
  const aiRun = await db.aiRun.create({
    data: {
      captureId,
      provider: provider.providerName,
      model: provider.modelName,
      promptVersion: PROMPT_VERSION,
      schemaVersion: SCHEMA_VERSION,
      status: outcome.ok ? "SUCCEEDED" : "FAILED",
      inputTokens: outcome.ok ? outcome.usage.inputTokens : (outcome.usage?.inputTokens ?? null),
      outputTokens: outcome.ok ? outcome.usage.outputTokens : (outcome.usage?.outputTokens ?? null),
      latencyMs: outcome.ok ? outcome.usage.latencyMs : (outcome.usage?.latencyMs ?? null),
      costMicros: outcome.ok
        ? estimateCostMicros(provider.modelName, outcome.usage.inputTokens, outcome.usage.outputTokens, batch)
        : null,
      errorCode: outcome.ok ? null : outcome.message,
      batch,
      startedAt: new Date(),
      finishedAt: new Date(),
    },
  });
  debugServer.event("ocrImageJob", "AiRun記録", { aiRunId: aiRun.id, ok: outcome.ok, batch });

  if (!outcome.ok) {
    await markCaptureFailed(captureId, processingVersion, outcome.message);
    return { status: "FAILED", reason: outcome.message };
  }

  // OCR成功: rawTextへ書き込み、QUEUEDへ進めたうえで即AI抽出キューへ自動投入する
  // (transcribeAudioJob.tsと同じ「保存→自動解析」チェーンを画像でも実現する)。
  // [PEM-CONSENT-ENQUEUE-GATE新設・2026-09-02] DOC-09 9章「撤回と同時に新規
  // Job enqueue不可」。OCR自体(画像→テキスト変換)はPEM_AI_PROCESSING対象外
  // (Formation解析ではない別処理)として実行するが、その後の自動連鎖
  // (CaptureAnalysisRequested.v1発行)だけをここでゲートする。
  const consentCheck = await checkAiJobConsentAllowed(captureId);
  const aiProcessingConsentGranted = consentCheck.allowed;

  await db.$transaction(async (tx: Prisma.TransactionClient) => {
    const updated = await tx.capture.update({
      where: { id: captureId },
      data: { rawText: outcome.text, processingStatus: aiProcessingConsentGranted ? "QUEUED" : "SAVED", version: { increment: 1 } },
    });
    await tx.eventLog.create({
      data: {
        aggregateType: "Capture",
        aggregateId: captureId,
        eventType: "CAPTURE_OCR_COMPLETED",
        afterJson: { textLength: outcome.text.length, batch },
        actorType: "SYSTEM",
      },
    });
    if (aiProcessingConsentGranted) {
      await tx.outboxEvent.create({
        data: {
          eventName: "CaptureAnalysisRequested.v1",
          eventVersion: "1",
          aggregateId: captureId,
          aggregateVersion: updated.version,
          payload: { captureId, workspaceId, sourceType: "IMAGE" },
        },
      });
    }
  });
  debugServer.event("ocrImageJob", "OCR完了・AI抽出キューへ自動投入", { captureId, aiProcessingConsentGranted });

  return { status: "READY" };
}

/** Batch投入自体が失敗した場合など、outcomeを経由しない失敗をAiRunへ記録しCaptureをFAILEDにする。 */
async function persistOcrFailure(
  captureId: string,
  processingVersion: number,
  provider: { providerName: string; modelName: string },
  reason: string,
  usage: { inputTokens: number; outputTokens: number; latencyMs: number } | undefined,
  batch: boolean,
): Promise<void> {
  await db.aiRun.create({
    data: {
      captureId,
      provider: provider.providerName,
      model: provider.modelName,
      promptVersion: PROMPT_VERSION,
      schemaVersion: SCHEMA_VERSION,
      status: "FAILED",
      inputTokens: usage?.inputTokens ?? null,
      outputTokens: usage?.outputTokens ?? null,
      latencyMs: usage?.latencyMs ?? null,
      costMicros: usage ? estimateCostMicros(provider.modelName, usage.inputTokens, usage.outputTokens, batch) : null,
      errorCode: reason.slice(0, 200),
      batch,
      startedAt: new Date(),
      finishedAt: new Date(),
    },
  });
  await markCaptureFailed(captureId, processingVersion, reason);
}

async function markCaptureFailed(captureId: string, expectedVersion: number, reason: string): Promise<void> {
  await db.capture.updateMany({
    where: { id: captureId, version: expectedVersion },
    data: { processingStatus: "FAILED", version: { increment: 1 } },
  });
  debugServer.error("ocrImageJob", "OCR失敗", { captureId, reason });
}

function guessImageContentType(fileName: string): string {
  const ext = fileName.split(".").pop()?.toLowerCase();
  const map: Record<string, string> = {
    jpg: "image/jpeg",
    jpeg: "image/jpeg",
    png: "image/png",
    gif: "image/gif",
    webp: "image/webp",
  };
  return map[ext ?? ""] ?? "image/jpeg";
}
