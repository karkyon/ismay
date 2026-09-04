import { debugServer } from "@/lib/debugServer";
import {
  claimCaseDetectJobs,
  completeCaseDetectJob,
  failCaseDetectJob,
  type ClaimedCaseDetectJob,
} from "@/lib/patterns/caseDetectQueue";
import { computeAndPersistCasePatternAggregatesForOwner } from "@/lib/patterns/casePatternAggregation";

/**
 * app/src/lib/worker/caseDetectQueueJob.ts
 *
 * Case Pattern Detect Queue Worker(PATTERN-DETECT-01B新設・2026-09-03、
 * PATTERN-DETECT-01Cで実処理接続・2026-09-03)。
 * recomputeQueueJob.tsと同じ「5秒tick内でポーリング関数を1回呼ぶ」構成
 * (worker/index.ts参照)。claim/complete/fail処理はcaseDetectQueue.tsへ委譲する。
 *
 * [PATTERN-DETECT-01C] この本人(ownerSubjectUserId)が持つ全CasePatternの
 * 集計・stage projectionをcasePatternAggregation.tsへ委譲する。Pattern
 * 検出そのもの(未知のPattern候補を新規に見つけるクラスタリング)は
 * PATTERN-DETECT-01D(embedding・exact cosine matching)のscopeであり、
 * このGateでは「既存Patternの再集計」のみを行う(想像で先行実装しない)。
 */

const BATCH_SIZE = 10;
const WORKER_ID = `case-detect-worker-${process.pid}`;

async function runDetection(job: ClaimedCaseDetectJob): Promise<void> {
  await computeAndPersistCasePatternAggregatesForOwner(job.workspaceId, job.ownerSubjectUserId);
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
