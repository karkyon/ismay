import { db } from "@/lib/db";
import { debugServer } from "@/lib/debugServer";
import { runExtractionForCapture } from "@/lib/ai/extract";

/**
 * jobs テーブル(TBL-026)の AI_EXTRACT ジョブをポーリング処理する。
 *
 * 重要: extract.ts の runExtractionForCapture は「AI Gateway呼び出し自体の失敗」を
 * 内部で最大2回まで再試行し、それでも失敗すればCapture=FAILEDとして正常returnする
 * (機能別詳細設計書v1.1 3章)。よってここでのJobレベル再試行(指数バックオフ)は、
 * DB接続断など「AI自体とは無関係な想定外の例外」にのみ適用される。
 */

const JOB_BATCH_SIZE = 3;
const BASE_BACKOFF_SECONDS = 30;
/** [2026-08-21追加] Anthropic Batch結果のポーリング間隔。batchPollJob.tsと共通の値。 */
const BATCH_POLL_INTERVAL_MS = 2 * 60 * 1000;

export async function processAiExtractJobs(): Promise<{ processed: number }> {
  const now = new Date();
  const candidates = await db.job.findMany({
    where: {
      jobType: "AI_EXTRACT",
      status: "QUEUED",
      OR: [{ nextRunAt: null }, { nextRunAt: { lte: now } }],
    },
    orderBy: { createdAt: "asc" },
    take: JOB_BATCH_SIZE,
  });

  let processed = 0;
  for (const job of candidates) {
    // CAS: 同時実行(将来複数Worker化した場合)でも二重処理しない
    const claimed = await db.job.updateMany({
      where: { id: job.id, status: "QUEUED" },
      data: { status: "RUNNING" },
    });
    if (claimed.count === 0) continue;
    debugServer.state("Worker/aiExtractJob", "Job.status", { jobId: job.id, status: "RUNNING" });

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
      const result = await runExtractionForCapture(captureId);
      debugServer.event("Worker/aiExtractJob", "runExtractionForCapture", {
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
        debugServer.state("Worker/aiExtractJob", "Job.status", { jobId: job.id, status: "AWAITING_BATCH" });
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
      debugServer.state("Worker/aiExtractJob", "Job.status", { jobId: job.id, status: "SUCCEEDED" });
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
      debugServer.state("Worker/aiExtractJob", "Job.status", {
        jobId: job.id,
        status: isDead ? "DEAD_LETTER" : "QUEUED",
        attempts,
      });
      debugServer.error("Worker/aiExtractJob", "processAiExtractJobs想定外の例外", { jobId: job.id, captureId, err });
    }
  }

  return { processed };
}
