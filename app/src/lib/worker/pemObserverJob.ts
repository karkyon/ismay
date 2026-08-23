import { debugServer } from "@/lib/debugServer";
import { ingestTransitionEvents, recomputeAggregates } from "@/lib/pem";

/**
 * FN-PEM-02観察更新のtick組み込み(2026-08-23新設)。
 * notificationScanJob.ts/cycleRotationJob.tsと同じ自己スロットリング方式。
 * 取り込み(ingestTransitionEvents)は軽量なので60秒間隔、集計(recomputeAggregates)は
 * ユーザーごとに直近4週分を都度再計算するためコストが高く、1時間間隔にする。
 */
const INGEST_INTERVAL_MS = 60 * 1000;
const AGGREGATE_INTERVAL_MS = 60 * 60 * 1000;
let lastIngestAt = 0;
let lastAggregateAt = 0;

export async function processPemObservation(): Promise<{ processed: number }> {
  const now = Date.now();
  let processed = 0;

  if (now - lastIngestAt >= INGEST_INTERVAL_MS) {
    lastIngestAt = now;
    try {
      const result = await ingestTransitionEvents();
      processed += result.processed;
      if (result.processed > 0) {
        debugServer.event("Worker/pemObservation", "イベント取り込み完了", result);
      }
    } catch (err) {
      debugServer.error("Worker/pemObservation", "イベント取り込み失敗", err);
    }
  }

  if (now - lastAggregateAt >= AGGREGATE_INTERVAL_MS) {
    lastAggregateAt = now;
    try {
      const result = await recomputeAggregates();
      if (result.observationsWritten > 0) {
        debugServer.event("Worker/pemObservation", "集計再計算完了", result);
      }
    } catch (err) {
      debugServer.error("Worker/pemObservation", "集計再計算失敗", err);
    }
  }

  return { processed };
}
