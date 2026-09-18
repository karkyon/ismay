import { debugServer } from "@/lib/debugServer";
import {
  claimCaseActionSlotLearnJobs,
  completeCaseActionSlotLearnJob,
  failCaseActionSlotLearnJob,
  requeueCaseActionSlotLearnJobForStaleGeneration,
  CaseActionSlotLearnJobGenerationStaleError,
  type ClaimedCaseActionSlotLearnJob,
} from "@/lib/patterns/caseActionSlotLearnQueue";
import { runActionSlotLearningForPattern } from "@/lib/patterns/casePatternActionSlotLearnService";

/**
 * app/src/lib/worker/caseActionSlotLearnQueueJob.ts
 *
 * Case Pattern ActionSlot Learn Queue Worker(PATTERN-ACTIONSLOT-LEARN-01
 * 新設・2026-09-17)。caseDetectQueueJob.tsと同じ「5秒tick内でポーリング
 * 関数を1回呼ぶ」構成(worker/index.ts参照)。claim/complete/fail処理は
 * caseActionSlotLearnQueue.tsへ委譲する。
 */

const BATCH_SIZE = 10;
const WORKER_ID = `case-actionslot-learn-worker-${process.pid}`;

async function processOneJob(job: ClaimedCaseActionSlotLearnJob): Promise<"done" | "dead_letter" | "requeued"> {
  const jobContext = { jobId: job.id, generation: job.generation };
  try {
    await runActionSlotLearningForPattern(job.workspaceId, job.patternId, jobContext);
    const result = await completeCaseActionSlotLearnJob(job.id, job.generation);
    return result.status === "DONE" ? "done" : "requeued";
  } catch (err) {
    if (err instanceof CaseActionSlotLearnJobGenerationStaleError) {
      // [03Cと同じ区別] 通常失敗とは区別し、backoff・attempt増加なしに
      // 即座にPENDINGへ戻す(generation lockがtransaction内で不一致を検出
      // した時点でtransaction全体がrollback済み)。
      debugServer.event("Worker/caseActionSlotLearnQueue", "ActionSlot学習Jobのgenerationが処理中に更新されたため即時PENDING化", {
        jobId: job.id,
        patternId: job.patternId,
        claimedGeneration: job.generation,
      });
      await requeueCaseActionSlotLearnJobForStaleGeneration(job.id);
      return "requeued";
    }
    debugServer.error("Worker/caseActionSlotLearnQueue", "ActionSlot学習Job失敗", {
      jobId: job.id,
      patternId: job.patternId,
      err,
    });
    const result = await failCaseActionSlotLearnJob(job.id, err);
    return result.status === "DEAD_LETTER" ? "dead_letter" : "requeued";
  }
}

export async function processCaseActionSlotLearnQueue(): Promise<{ processed: number; deadLettered: number }> {
  const claimed = await claimCaseActionSlotLearnJobs(WORKER_ID, BATCH_SIZE);
  if (claimed.length === 0) return { processed: 0, deadLettered: 0 };

  let processed = 0;
  let deadLettered = 0;
  for (const job of claimed) {
    const outcome = await processOneJob(job);
    if (outcome === "done") processed++;
    if (outcome === "dead_letter") deadLettered++;
  }

  if (deadLettered > 0) {
    debugServer.event("Worker/caseActionSlotLearnQueue", "ActionSlot学習JobがDEAD_LETTERへ到達", { deadLettered });
  }

  return { processed, deadLettered };
}
