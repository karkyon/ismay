import { relayOutboxToJobs } from "@/lib/worker/relay";
import { processAiExtractJobs } from "@/lib/worker/aiExtractJob";
import { processTranscribeAudioJobs } from "@/lib/worker/transcribeAudioJob";
import { processOcrImageJobs } from "@/lib/worker/ocrImageJob";
import { processAwaitingBatchJobs } from "@/lib/worker/batchPollJob";
import { processShadowReconciliation } from "@/lib/worker/shadowReconciliationJob";
import { reconcileStuckRetryOrchestrations } from "@/lib/formation/retryOrchestration";
import { processNotificationScan } from "@/lib/worker/notificationScanJob";
import { processCycleRotation } from "@/lib/worker/cycleRotationJob";
import { processRecurrenceGeneration } from "@/lib/worker/recurrenceGenerationJob";
import { processPemObservation } from "@/lib/worker/pemObserverJob";
import { processSessionTimeouts } from "@/lib/worker/sessionTimeoutJob";
import { processRecomputeQueue } from "@/lib/worker/recomputeQueueJob";
import { processCaseDetectQueue } from "@/lib/worker/caseDetectQueueJob";
import { debugServer } from "@/lib/debugServer";

/**
 * AI Workerのインプロセス実行ループ。
 *
 * [アーキテクチャ判断・2026-08-18] 別プロセス(systemdユニット分離)ではなく、
 * Next.jsのinstrumentation.ts(register()フック)に埋め込む方式をカルキョンさんと
 * 合意した(小規模・単一インスタンス運用のため新規インフラ不要な方を優先)。
 * 複数インスタンス運用に拡張する場合、Job.attemptsのCAS更新自体は安全だが、
 * ポーリング間隔の調整やリーダー選出の検討が別途必要になる。
 */

const TICK_INTERVAL_MS = 5_000;

declare global {
  var __ismayWorkerStarted: boolean | undefined;
}

let tickInFlight = false;

async function tick(): Promise<void> {
  if (tickInFlight) return; // 前回tickが長引いている場合は重複実行しない
  tickInFlight = true;
  try {
    const relayResult = await relayOutboxToJobs();
    const jobResult = await processAiExtractJobs();
    const transcribeResult = await processTranscribeAudioJobs();
    const ocrResult = await processOcrImageJobs();
    const batchResult = await processAwaitingBatchJobs();
    // M1-B6C-1(2026-08-31新設): Formation shadow checkpointのreconciliation。
    // stale RUNNING回収+PENDING/RETRY_WAITのbatch処理を5秒tickの中で行う
    // (batchPollJob等と同じ自己スロットリング不要な軽量ポーリング)。
    const shadowReconciliationResult = await processShadowReconciliation();
    // M1-B6C-4(2026-09-02新設・§6.3): 「Session=ANALYZINGだがretry Job投入が
    // まだ完了していない」ものを検出し再試行する(新tableを作らず既存状態の
    // 不整合自体をqueueとして扱う、shadow checkpointと同じ設計思想)。
    const retryOrchestrationResult = await reconcileStuckRetryOrchestrations();
    // FN-NTF-01(2026-08-22新設): 通知スキャンは60秒間隔の自己スロットリングを
    // 内部で持つため、5秒tickの中で毎回呼び出しても実処理は間引かれる。
    const notificationResult = await processNotificationScan();
    // 週次サイクル(2026-08-22新設): 1時間間隔の自己スロットリング(cycleRotationJob.ts参照)。
    const cycleResult = await processCycleRotation();
    // 定期責任(2026-08-23新設): 1時間間隔の自己スロットリング(recurrenceGenerationJob.ts参照)。
    const recurrenceResult = await processRecurrenceGeneration();
    // FN-PEM-02(2026-08-23新設): 観察イベント取り込み60秒間隔・集計再計算1時間間隔の
    // 自己スロットリング(pemObserverJob.ts参照)。
    const pemResult = await processPemObservation();
    // PEM-SESSION-TIMEOUT(2026-09-02新設): 開いたままのExecution Sessionを
    // 1時間間隔の自己スロットリングでタイムアウトクローズする(sessionTimeoutJob.ts参照)。
    const sessionTimeoutResult = await processSessionTimeouts();
    // PEM-RECOMPUTE-QUEUE(2026-09-03新設): Correction等でmark staleされた
    // Projection再計算Jobを、FOR UPDATE SKIP LOCKEDでバッチclaimし処理する
    // (recomputeQueueJob.ts参照)。shadowReconciliation同様、自己スロットリング
    // 不要な軽量ポーリングのため5秒tickの中で毎回呼ぶ。
    const recomputeQueueResult = await processRecomputeQueue();
    // PATTERN-DETECT-01B(2026-09-03新設): PRIMARY link作成/解除でmark stale
    // されたCase Pattern検出Jobを、FOR UPDATE SKIP LOCKEDでバッチclaimし
    // 処理する(caseDetectQueueJob.ts参照)。recomputeQueue同様、自己スロット
    // リング不要な軽量ポーリングのため5秒tickの中で毎回呼ぶ。
    const caseDetectQueueResult = await processCaseDetectQueue();
    if (
      relayResult.relayed > 0 ||
      jobResult.processed > 0 ||
      transcribeResult.processed > 0 ||
      ocrResult.processed > 0 ||
      batchResult.processed > 0 ||
      shadowReconciliationResult.processed > 0 ||
      shadowReconciliationResult.reclaimed > 0 ||
      retryOrchestrationResult.reconciled > 0 ||
      notificationResult.processed > 0 ||
      cycleResult.processed > 0 ||
      recurrenceResult.processed > 0 ||
      pemResult.processed > 0 ||
      sessionTimeoutResult.processed > 0 ||
      recomputeQueueResult.processed > 0 ||
      recomputeQueueResult.deadLettered > 0 ||
      caseDetectQueueResult.processed > 0 ||
      caseDetectQueueResult.deadLettered > 0
    ) {
      debugServer.event("Worker/tick", "tick完了", {
        ...relayResult,
        ...jobResult,
        transcribed: transcribeResult.processed,
        ocrProcessed: ocrResult.processed,
        batchProcessed: batchResult.processed,
        shadowCheckpointProcessed: shadowReconciliationResult.processed,
        shadowCheckpointReclaimed: shadowReconciliationResult.reclaimed,
        retryOrchestrationReconciled: retryOrchestrationResult.reconciled,
        notificationProcessed: notificationResult.processed,
        cycleProcessed: cycleResult.processed,
        recurrenceProcessed: recurrenceResult.processed,
        pemProcessed: pemResult.processed,
        sessionTimeoutProcessed: sessionTimeoutResult.processed,
        recomputeQueueProcessed: recomputeQueueResult.processed,
        recomputeQueueDeadLettered: recomputeQueueResult.deadLettered,
        caseDetectQueueProcessed: caseDetectQueueResult.processed,
        caseDetectQueueDeadLettered: caseDetectQueueResult.deadLettered,
      });
    }
  } catch (err) {
    // tick自体の例外でループを止めない(fail-open)。次回tickで再試行される。
    debugServer.error("Worker/tick", "tick失敗", err);
  } finally {
    tickInFlight = false;
  }
}

export function startBackgroundWorker(): void {
  if (globalThis.__ismayWorkerStarted) return; // Next.js dev再読込等での多重起動防止
  globalThis.__ismayWorkerStarted = true;

  console.log(`[ismay-worker] AI Worker開始(${TICK_INTERVAL_MS}ms間隔でOutbox/Jobをポーリング)`);
  const interval = setInterval(() => {
    void tick();
  }, TICK_INTERVAL_MS);
  // プロセス終了時にタイマーが再起動をブロックしないようにする
  interval.unref?.();

  // 起動直後にも1回実行しておく(初回tickまで最大5秒待たせない)
  void tick();
}
