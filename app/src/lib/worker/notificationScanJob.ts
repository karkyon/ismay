import { debugServer } from "@/lib/debugServer";
import { planNotifications, dispatchDueNotifications } from "@/lib/notifications/notificationPlanner";

/**
 * FN-NTF-01通知スキャンのtick組み込み(2026-08-22新設)。
 *
 * worker/index.tsのtickは5秒間隔だが、通知スキャンはDEADLINE/FOLLOW_UP走査で
 * Responsibility全件相当をクエリするため、batchPollJob.ts(2分間隔)と同様に
 * モジュール内の最終実行時刻でスロットリングする(専用のJobレコードを持たない
 * 軽量な仕組みで十分なため、Job.nextRunAtパターンではなくインメモリ変数を使う。
 * サーバー再起動時は次回tickで即座に再実行される=許容できる)。
 */
const SCAN_INTERVAL_MS = 60 * 1000;
let lastScanAt = 0;

export async function processNotificationScan(): Promise<{ processed: number }> {
  const now = Date.now();
  if (now - lastScanAt < SCAN_INTERVAL_MS) return { processed: 0 };
  lastScanAt = now;

  try {
    const planResult = await planNotifications();
    const dispatchResult = await dispatchDueNotifications();
    const processed = planResult.created + dispatchResult.dispatched;
    if (processed > 0) {
      debugServer.event("Worker/notificationScan", "スキャン完了", {
        created: planResult.created,
        skipped: planResult.skipped,
        dispatched: dispatchResult.dispatched,
      });
    }
    return { processed };
  } catch (err) {
    // このジョブの失敗でtick全体を止めない(fail-open)。次回スキャンで再試行される。
    debugServer.error("Worker/notificationScan", "スキャン失敗", err);
    return { processed: 0 };
  }
}
