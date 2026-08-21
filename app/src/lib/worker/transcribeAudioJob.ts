import { db } from "@/lib/db";
import { debugServer } from "@/lib/debugServer";
import { downloadAudioObject } from "@/lib/storage";
import { getActiveTranscriptionProvider } from "@/lib/ai/config";
import { estimateTranscriptionCostMicros } from "@/lib/ai/openaiTranscriptionProvider";

/**
 * jobs テーブルの TRANSCRIBE_AUDIO ジョブをポーリング処理する(2026-08-21新設)。
 * API-CAP-02(音声入力)実装の一部。処理内容:
 *  1. MinIOから音声ファイルを取得
 *  2. 文字起こしプロバイダー(既定OpenAI gpt-transcribe)へ送信
 *  3. 成功時: Capture.rawTextへ書き込み、processingStatus=SAVED→AI抽出キューへ自動投入
 *     (CaptureAnalysisRequested.v1を発行。POST /captures同様の自動チェーン)
 *  4. 失敗時: Capture.processingStatus=FAILEDとし、AiRunに失敗理由を記録
 *
 * [2026-08-21再修正] AiRun.promptVersion/schemaVersionは必須列(NOT NULL)であるにも
 * かかわらず、前回パッチでは渡し忘れており、実サーバーのtsc(型情報が完全な状態)で
 * 初めて発覚した。本サンドボックスはPrisma Client生成がネットワーク制約で行えず、
 * 簡易スタブでの検証では検出できなかった不備であり、schema.prismaを直接再確認した
 * うえで両フィールドを追加した。
 *
 * aiExtractJob.tsと同じ設計方針: プロバイダー呼び出し自体の失敗はJobを成功扱いで終える
 * (Capture側をFAILEDにするのみ)。Jobレベル再試行はDB接続断など無関係の例外にのみ適用。
 */

const JOB_BATCH_SIZE = 2; // 音声ファイルは処理が重いため抽出より少なめのバッチ
const BASE_BACKOFF_SECONDS = 30;
const PROMPT_VERSION = "voice-transcribe-v1";
const SCHEMA_VERSION = "n/a"; // 文字起こしは構造化出力ではないため、抽出プロンプトと違いスキーマバージョンの概念が無い

export async function processTranscribeAudioJobs(): Promise<{ processed: number }> {
  const now = new Date();
  const candidates = await db.job.findMany({
    where: {
      jobType: "TRANSCRIBE_AUDIO",
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
    debugServer.state("Worker/transcribeAudioJob", "Job.status", { jobId: job.id, status: "RUNNING" });

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
      const result = await runTranscriptionForCapture(captureId);
      debugServer.event("Worker/transcribeAudioJob", "runTranscriptionForCapture", {
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
      debugServer.error("Worker/transcribeAudioJob", "想定外の例外", { jobId: job.id, captureId, err });
    }
  }

  return { processed };
}

type TranscriptionRunResult = { status: "READY" } | { status: "FAILED"; reason: string } | { status: "SKIPPED"; reason: string };

async function runTranscriptionForCapture(captureId: string): Promise<TranscriptionRunResult> {
  const capture = await db.capture.findUnique({ where: { id: captureId } });
  if (!capture || capture.deletedAt) {
    return { status: "SKIPPED", reason: "Captureが存在しないか削除済みです" };
  }
  if (!capture.audioObjectKey) {
    await markCaptureFailed(capture.id, capture.version, "audioObjectKeyが設定されていません");
    return { status: "FAILED", reason: "audioObjectKeyが設定されていません" };
  }

  const claimed = await db.capture.updateMany({
    where: { id: capture.id, version: capture.version, processingStatus: "QUEUED" },
    data: { processingStatus: "PROCESSING", version: { increment: 1 } },
  });
  if (claimed.count === 0) {
    return { status: "SKIPPED", reason: "既にPROCESSING/READY等へ遷移済みのためスキップしました" };
  }
  const processingVersion = capture.version + 1;

  const provider = await getActiveTranscriptionProvider(capture.workspaceId);
  const audioBuffer = await downloadAudioObject(capture.audioObjectKey).catch((err) => {
    debugServer.error("transcribeAudioJob", "MinIOからのダウンロードに失敗", err);
    return null;
  });
  if (!audioBuffer) {
    await markCaptureFailed(capture.id, processingVersion, "音声ファイルの取得に失敗しました");
    return { status: "FAILED", reason: "音声ファイルの取得に失敗しました" };
  }

  const fileName = capture.audioObjectKey.split("/").pop() ?? "audio";
  const outcome = await provider.transcribe({
    audioBuffer,
    contentType: guessContentType(fileName),
    fileName,
  });

  // AiRun.promptVersion/schemaVersionはschema.prisma上NOT NULL(String、String?ではない)。
  // 抽出(extract.ts)と違い文字起こしにはプロンプト/スキーマの概念が薄いが、
  // 必須列であるため固定文字列を設定する。
  const aiRun = await db.aiRun.create({
    data: {
      captureId: capture.id,
      provider: provider.providerName,
      model: provider.modelName,
      promptVersion: PROMPT_VERSION,
      schemaVersion: SCHEMA_VERSION,
      status: outcome.ok ? "SUCCEEDED" : "FAILED",
      latencyMs: outcome.usage?.latencyMs ?? null,
      costMicros: outcome.ok ? estimateTranscriptionCostMicros(outcome.durationSeconds) : null,
      errorCode: outcome.ok ? null : outcome.message,
      startedAt: new Date(),
      finishedAt: new Date(),
    },
  });
  debugServer.event("transcribeAudioJob", "AiRun記録", { aiRunId: aiRun.id, ok: outcome.ok });

  if (!outcome.ok) {
    await markCaptureFailed(capture.id, processingVersion, outcome.message);
    return { status: "FAILED", reason: outcome.message };
  }

  // 文字起こし成功: rawTextへ書き込み、QUEUEDへ進めたうえで即AI抽出キューへ自動投入する
  // (POST /captures同様の「保存→自動解析」チェーンを、音声でも実現する)。
  await db.$transaction(async (tx) => {
    const updated = await tx.capture.update({
      where: { id: capture.id },
      data: { rawText: outcome.text, processingStatus: "QUEUED", version: { increment: 1 } },
    });
    await tx.eventLog.create({
      data: {
        aggregateType: "Capture",
        aggregateId: capture.id,
        eventType: "CAPTURE_TRANSCRIBED",
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
        payload: { captureId: capture.id, workspaceId: capture.workspaceId, sourceType: "VOICE" },
      },
    });
  });
  debugServer.event("transcribeAudioJob", "文字起こし完了・AI抽出キューへ自動投入", { captureId: capture.id });

  return { status: "READY" };
}

async function markCaptureFailed(captureId: string, expectedVersion: number, reason: string): Promise<void> {
  await db.capture.updateMany({
    where: { id: captureId, version: expectedVersion },
    data: { processingStatus: "FAILED", version: { increment: 1 } },
  });
  debugServer.error("transcribeAudioJob", "文字起こし失敗", { captureId, reason });
}

function guessContentType(fileName: string): string {
  const ext = fileName.split(".").pop()?.toLowerCase();
  const map: Record<string, string> = {
    mp3: "audio/mpeg",
    mp4: "audio/mp4",
    m4a: "audio/mp4",
    wav: "audio/wav",
    webm: "audio/webm",
    ogg: "audio/ogg",
  };
  return map[ext ?? ""] ?? "application/octet-stream";
}
