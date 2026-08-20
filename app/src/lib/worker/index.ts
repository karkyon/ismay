import { relayOutboxToJobs } from "@/lib/worker/relay";
import { processAiExtractJobs } from "@/lib/worker/aiExtractJob";
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
    if (relayResult.relayed > 0 || jobResult.processed > 0) {
      debugServer.event("Worker/tick", "tick完了", { ...relayResult, ...jobResult });
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
