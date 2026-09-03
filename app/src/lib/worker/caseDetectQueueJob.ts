import { debugServer } from "@/lib/debugServer";
import {
  claimCaseDetectJobs,
  completeCaseDetectJob,
  failCaseDetectJob,
  type ClaimedCaseDetectJob,
} from "@/lib/patterns/caseDetectQueue";

/**
 * app/src/lib/worker/caseDetectQueueJob.ts
 *
 * Case Pattern Detect Queue Worker(PATTERN-DETECT-01B新設・2026-09-03)。
 * recomputeQueueJob.tsと同じ「5秒tick内でポーリング関数を1回呼ぶ」構成
 * (worker/index.ts参照)。claim/complete/fail処理はcaseDetectQueue.tsへ委譲する。
 *
 * [scope宣言・想像で先行実装しない] 実際の検出処理(この本人の全PRIMARY
 * occurrenceを横断した集計・クラスタリング)はPATTERN-DETECT-01C
 * (集計・stage projection)・01D(embedding・exact cosine matching)で
 * 実装する。このGateではqueueのlease/generation/retry/dead-letter機構
 * 自体を実証することが目的のため、`runDetection`はno-opプレースホルダと
 * する(常に成功しDONEへ進む)。01C実装時にこの関数の中身を実際の集計呼び出し
 * へ置き換える(このファイル・エクスポート形状自体は変更不要な設計)。
 */

const BATCH_SIZE = 10;
const WORKER_ID = `case-detect-worker-${process.pid}`;

/**
 * PATTERN-DETECT-01C/01Dで実装される実際の検出処理への差し替えポイント。
 * 現時点ではno-op(常に成功)。
 */
async function runDetection(job: ClaimedCaseDetectJob): Promise<void> {
  // [PATTERN-DETECT-01C/01D待ち] ここでjob.ownerSubjectUserId(この本人)の
  // 全PRIMARY occurrenceを再集計し、CasePattern/CasePatternRevisionの
  // 検出・更新を行う予定。現時点では何もしない(jobの参照だけ残し、
  // 01C実装時にそのまま置き換えられるようにする)。
  void job;
}

async function processOneJob(job: ClaimedCaseDetectJob): Promise<"done" | "dead_letter" | "requeued"> {
  try {
    await runDetection(job);
    const result = await completeCaseDetectJob(job.id, job.generation);
    return result.status === "DONE" ? "done" : "requeued";
  } catch (err) {
    debugServer.error("Worker/caseDetectQueue", "Case Pattern検出Job失敗", {
      jobId: job.id,
      ownerSubjectUserId: job.ownerSubjectUserId,
      err,
    });
    const result = await failCaseDetectJob(job.id, err);
    return result.status === "DEAD_LETTER" ? "dead_letter" : "requeued";
  }
}

export async function processCaseDetectQueue(): Promise<{ processed: number; deadLettered: number }> {
  const claimed = await claimCaseDetectJobs(WORKER_ID, BATCH_SIZE);
  if (claimed.length === 0) return { processed: 0, deadLettered: 0 };

  let processed = 0;
  let deadLettered = 0;
  for (const job of claimed) {
    const outcome = await processOneJob(job);
    if (outcome === "done") processed++;
    if (outcome === "dead_letter") deadLettered++;
  }

  if (deadLettered > 0) {
    debugServer.event("Worker/caseDetectQueue", "Case Pattern検出JobがDEAD_LETTERへ到達", { deadLettered });
  }

  return { processed, deadLettered };
}
