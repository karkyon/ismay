import { db } from "@/lib/db";
import { debugServer } from "@/lib/debugServer";
import { downloadImageObject } from "@/lib/storage";
import { getActiveOcrProvider } from "@/lib/ai/config";
import { estimateCostMicros } from "@/lib/ai/pricing";

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

type OcrRunResult = { status: "READY" } | { status: "FAILED"; reason: string } | { status: "SKIPPED"; reason: string };

async function runOcrForCapture(captureId: string): Promise<OcrRunResult> {
  const capture = await db.capture.findUnique({ where: { id: captureId } });
  if (!capture || capture.deletedAt) {
    return { status: "SKIPPED", reason: "Captureが存在しないか削除済みです" };
  }
  if (!capture.imageObjectKey) {
    await markCaptureFailed(capture.id, capture.version, "imageObjectKeyが設定されていません");
    return { status: "FAILED", reason: "imageObjectKeyが設定されていません" };
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
  const imageBuffer = await downloadImageObject(capture.imageObjectKey).catch((err) => {
    debugServer.error("ocrImageJob", "MinIOからのダウンロードに失敗", err);
    return null;
  });
  if (!imageBuffer) {
    await markCaptureFailed(capture.id, processingVersion, "画像ファイルの取得に失敗しました");
    return { status: "FAILED", reason: "画像ファイルの取得に失敗しました" };
  }

  const fileName = capture.imageObjectKey.split("/").pop() ?? "image";
  const outcome = await provider.extractText({
    imageBuffer,
    contentType: guessImageContentType(fileName),
    fileName,
  });

  // AiRun.promptVersion/schemaVersionはschema.prisma上NOT NULL。
  // transcribeAudioJob.tsで実サーバーのtscにより発覚した不備(2026-08-21修正)を
  // 踏まえ、ここでも必ず設定する。
  const aiRun = await db.aiRun.create({
    data: {
      captureId: capture.id,
      provider: provider.providerName,
      model: provider.modelName,
      promptVersion: PROMPT_VERSION,
      schemaVersion: SCHEMA_VERSION,
      status: outcome.ok ? "SUCCEEDED" : "FAILED",
      inputTokens: outcome.ok ? outcome.usage.inputTokens : (outcome.usage?.inputTokens ?? null),
      outputTokens: outcome.ok ? outcome.usage.outputTokens : (outcome.usage?.outputTokens ?? null),
      latencyMs: outcome.ok ? outcome.usage.latencyMs : (outcome.usage?.latencyMs ?? null),
      costMicros: outcome.ok ? estimateCostMicros(provider.modelName, outcome.usage.inputTokens, outcome.usage.outputTokens) : null,
      errorCode: outcome.ok ? null : outcome.message,
      startedAt: new Date(),
      finishedAt: new Date(),
    },
  });
  debugServer.event("ocrImageJob", "AiRun記録", { aiRunId: aiRun.id, ok: outcome.ok });

  if (!outcome.ok) {
    await markCaptureFailed(capture.id, processingVersion, outcome.message);
    return { status: "FAILED", reason: outcome.message };
  }

  // OCR成功: rawTextへ書き込み、QUEUEDへ進めたうえで即AI抽出キューへ自動投入する
  // (transcribeAudioJob.tsと同じ「保存→自動解析」チェーンを画像でも実現する)。
  await db.$transaction(async (tx) => {
    const updated = await tx.capture.update({
      where: { id: capture.id },
      data: { rawText: outcome.text, processingStatus: "QUEUED", version: { increment: 1 } },
    });
    await tx.eventLog.create({
      data: {
        aggregateType: "Capture",
        aggregateId: capture.id,
        eventType: "CAPTURE_OCR_COMPLETED",
        afterJson: { textLength: outcome.text.length },
        actorType: "SYSTEM",
      },
    });
    await tx.outboxEvent.create({
      data: {
        eventName: "CaptureAnalysisRequested.v1",
        eventVersion: "1",
        aggregateId: capture.id,
        aggregateVersion: updated.version,
        payload: { captureId: capture.id, workspaceId: capture.workspaceId, sourceType: "IMAGE" },
      },
    });
  });
  debugServer.event("ocrImageJob", "OCR完了・AI抽出キューへ自動投入", { captureId: capture.id });

  return { status: "READY" };
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
