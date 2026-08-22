import { debugServer } from "@/lib/debugServer";
import { rotateCycles } from "@/lib/cycle";

/**
 * 週次サイクル自動繰越のtick組み込み(2026-08-22新設)。
 * 週境界(月曜0:00)を跨いだかどうかの判定はDB問い合わせで行うため、
 * notificationScanJob.tsと同様に自己スロットリングする(1時間間隔で十分。
 * 週の切り替わりは1回/週しか起きないため、5秒tick毎に律儀にDBを叩く必要はない)。
 */
const SCAN_INTERVAL_MS = 60 * 60 * 1000;
let lastScanAt = 0;

export async function processCycleRotation(): Promise<{ processed: number }> {
  const now = Date.now();
  if (now - lastScanAt < SCAN_INTERVAL_MS) return { processed: 0 };
  lastScanAt = now;

  try {
    const result = await rotateCycles();
    if (result.rotated > 0) {
      debugServer.event("Worker/cycleRotation", "サイクル繰越完了", result);
    }
    return { processed: result.rotated };
  } catch (err) {
    debugServer.error("Worker/cycleRotation", "サイクル繰越失敗", err);
    return { processed: 0 };
  }
}
