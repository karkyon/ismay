import { debugServer } from "@/lib/debugServer";
import { generateRecurrences } from "@/lib/recurrence";

/**
 * FN-REC-01定期責任生成のtick組み込み(2026-08-23新設)。
 * 設計書は「日次Batch」と明記しているが、5秒tickへ組み込む都合上、
 * cycleRotationJob.ts(1時間間隔)と同様の自己スロットリングで代替する
 * (実質的な生成判定はcomputeNextOccurrenceが日単位で行うため、
 * 1時間間隔で確認しても発生日の判定精度に影響しない)。
 */
const SCAN_INTERVAL_MS = 60 * 60 * 1000;
let lastScanAt = 0;

export async function processRecurrenceGeneration(): Promise<{ processed: number }> {
  const now = Date.now();
  if (now - lastScanAt < SCAN_INTERVAL_MS) return { processed: 0 };
  lastScanAt = now;

  try {
    const result = await generateRecurrences();
    if (result.processed > 0) {
      debugServer.event("Worker/recurrenceGeneration", "定期責任生成完了", result);
    }
    return { processed: result.processed };
  } catch (err) {
    debugServer.error("Worker/recurrenceGeneration", "定期責任生成失敗", err);
    return { processed: 0 };
  }
}
