import { db } from "@/lib/db";
import { debugServer } from "@/lib/debugServer";
import { getActiveExtractionProvider, getActiveOcrProvider } from "@/lib/ai/config";
import { finalizeBatchExtraction } from "@/lib/ai/extract";
import { finalizeOcrBatchResult } from "@/lib/worker/ocrImageJob";

/**
 * jobs テーブルの AWAITING_BATCH ジョブ(AI_EXTRACT / OCR_IMAGE の両方)をポーリングする
 * (2026-08-21新設)。カルキョンさんの指示「緊急性が高いのかバッチでいいのか選択させる」に
 * 対応するBatch API機能の共通ポーリング窓口。
 *
 * [設計方針] AI_EXTRACT/OCR_IMAGE それぞれのJob処理関数(aiExtractJob.ts/ocrImageJob.ts)は
 * Batch投入までを担い、投入後はJob.status=AWAITING_BATCHへ遷移させてこのモジュールへ
 * 引き継ぐ。本モジュールはjobTypeで分岐し、対応するfinalize関数(extract.ts/ocrImageJob.tsが
 * それぞれ公開)を呼ぶだけで、Capture更新やAiRun記録などの実処理は行わない
 * (実処理は各finalize関数に委譲し、本モジュールはポーリング制御に専念する)。
 *
 * ポーリング間隔は固定2分(aiExtractJob.ts/ocrImageJob.tsのBATCH_POLL_INTERVAL_MSと
 * 同じ値)。Anthropic公式SLAが「最大24時間」であるため、Job.createdAtから23時間を
 * 超えてもENDEDにならない場合はタイムアウト扱いでCaptureをFAILEDにする
 * (Anthropicが呼び忘れて反応が無いまま無限にポーリングし続けることを防ぐ)。
 */

const JOB_BATCH_SIZE = 5;
const POLL_INTERVAL_MS = 2 * 60 * 1000;
const TIMEOUT_MS = 23 * 60 * 60 * 1000; // Anthropic公式SLA「最大24時間」に対する安全マージン

export async function processAwaitingBatchJobs(): Promise<{ processed: number }> {
  const now = new Date();
  const candidates = await db.job.findMany({
    where: {
      jobType: { in: ["AI_EXTRACT", "OCR_IMAGE"] },
      status: "AWAITING_BATCH",
      OR: [{ nextRunAt: null }, { nextRunAt: { lte: now } }],
    },
    orderBy: { createdAt: "asc" },
    take: JOB_BATCH_SIZE,
  });

  let processed = 0;
  for (const job of candidates) {
    const payload = job.payload as { captureId?: string; batchId?: string; processingVersion?: number } | null;
    const { captureId, batchId, processingVersion } = payload ?? {};
    if (!captureId || !batchId || processingVersion === undefined) {
      await db.job.update({
        where: { id: job.id },
        data: { status: "DEAD_LETTER", lastError: "payload.captureId/batchId/processingVersionが不正です" },
      });
      continue;
    }

    if (Date.now() - job.createdAt.getTime() > TIMEOUT_MS) {
      debugServer.error("Worker/batchPollJob", "Batchタイムアウト(23時間超過)", { jobId: job.id, captureId, batchId });
      await db.capture.updateMany({
        where: { id: captureId, version: processingVersion },
        data: { processingStatus: "FAILED", version: { increment: 1 } },
      });
      await db.job.update({
        where: { id: job.id },
        data: { status: "DEAD_LETTER", lastError: "Anthropic Batchが23時間以内に完了しませんでした(タイムアウト)" },
      });
      continue;
    }

    try {
      const capture = await db.capture.findUnique({ where: { id: captureId }, select: { workspaceId: true } });
      if (!capture) {
        await db.job.update({
          where: { id: job.id },
          data: { status: "DEAD_LETTER", lastError: "Captureが見つかりません" },
        });
        continue;
      }

      const provider =
        job.jobType === "AI_EXTRACT"
          ? await getActiveExtractionProvider(capture.workspaceId)
          : await getActiveOcrProvider(capture.workspaceId);
      if (!provider.checkBatch) {
        await db.job.update({
          where: { id: job.id },
          data: { status: "DEAD_LETTER", lastError: "プロバイダーがBatch状態確認に対応していません" },
        });
        continue;
      }

      const statusResult = await provider.checkBatch(batchId);
      if (!statusResult.ok) {
        // TRANSIENT/FATALいずれもポーリング自体は継続する(Anthropic側が復旧すれば
        // 次回tickで再確認できる)。ただし無限リトライを避けるため既存のJob.attempts上限は
        // 別枠(catchブロック側)で管理する。ここでは単にnextRunAtを延ばすのみ。
        debugServer.error("Worker/batchPollJob", "checkBatch失敗", { jobId: job.id, batchId, message: statusResult.message });
        await db.job.update({
          where: { id: job.id },
          data: { nextRunAt: new Date(Date.now() + POLL_INTERVAL_MS), lastError: statusResult.message.slice(0, 500) },
        });
        continue;
      }

      if (statusResult.status !== "ENDED") {
        await db.job.update({
          where: { id: job.id },
          data: { nextRunAt: new Date(Date.now() + POLL_INTERVAL_MS) },
        });
        continue;
      }

      if (!statusResult.resultsUrl) {
        await db.capture.updateMany({
          where: { id: captureId, version: processingVersion },
          data: { processingStatus: "FAILED", version: { increment: 1 } },
        });
        await db.job.update({
          where: { id: job.id },
          data: { status: "SUCCEEDED", lastError: "Batch終了したがresults_urlが空でした" },
        });
        continue;
      }

      const finalizeResult =
        job.jobType === "AI_EXTRACT"
          ? await finalizeBatchExtraction(captureId, processingVersion, statusResult.resultsUrl)
          : await finalizeOcrBatchResult(captureId, capture.workspaceId, processingVersion, statusResult.resultsUrl);

      debugServer.event("Worker/batchPollJob", "Batch完了・finalize", {
        jobId: job.id,
        jobType: job.jobType,
        captureId,
        status: finalizeResult.status,
      });
      await db.job.update({
        where: { id: job.id },
        data: {
          status: "SUCCEEDED",
          lastError: finalizeResult.status === "FAILED" ? finalizeResult.reason.slice(0, 500) : null,
        },
      });
      processed++;
    } catch (err) {
      const attempts = job.attempts + 1;
      const isDead = attempts >= job.maxAttempts;
      await db.job.update({
        where: { id: job.id },
        data: {
          status: isDead ? "DEAD_LETTER" : "AWAITING_BATCH",
          attempts,
          lastError: String(err).slice(0, 500),
          nextRunAt: isDead ? null : new Date(Date.now() + POLL_INTERVAL_MS),
        },
      });
      debugServer.error("Worker/batchPollJob", "想定外の例外", { jobId: job.id, captureId, err });
    }
  }

  return { processed };
}
