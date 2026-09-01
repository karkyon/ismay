import { reconcileShadowCheckpoints } from "@/lib/formation/shadowCheckpoint";

/**
 * app/src/lib/worker/shadowReconciliationJob.ts
 *
 * V5-M1-B6C-1 Shadow Reconciliation Worker。
 * 出典: Claude向け ISMAY c503e72以降 M1-B6C・全残件連続実装指示(2026-08-31)
 *       §3 Gate M1-B6C-1。
 *
 * batchPollJob.ts等と同じ「5秒tick内でポーリング関数を1回呼ぶ」構成
 * (worker/index.ts参照)。stale RUNNING checkpointの回収と、PENDING/RETRY_WAIT
 * (nextRunAt到来分)の処理を`reconcileShadowCheckpoints`へ委譲するだけの薄い窓口。
 */
export async function processShadowReconciliation(): Promise<{ processed: number; reclaimed: number }> {
  return reconcileShadowCheckpoints();
}
