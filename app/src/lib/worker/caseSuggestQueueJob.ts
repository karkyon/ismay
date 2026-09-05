import { debugServer } from "@/lib/debugServer";
import {
  claimCaseSuggestJobs,
  completeCaseSuggestJob,
  failCaseSuggestJob,
  type ClaimedCaseSuggestJob,
} from "@/lib/patterns/caseSuggestQueue";
import { generateCaseSuggestionForCandidate } from "@/lib/patterns/casePatternSuggestionGenerationService";

/**
 * app/src/lib/worker/caseSuggestQueueJob.ts
 *
 * Case Pattern Suggest Job Worker(PATTERN-SUGGEST-01B新設・2026-09-05)。
 * caseDetectQueueJob.tsと同じ「5秒tick内でポーリング関数を1回呼ぶ」構成
 * (worker/index.ts参照)。claim/complete/fail処理はcaseSuggestQueue.tsへ
 * 委譲し、実際の照合・書込みはcasePatternSuggestionGenerationService.tsへ
 * 委譲する。
 *
 * [FAILEDの扱い] generateCaseSuggestionForCandidateの戻り値outcome=
 * "FAILED"(embedding provider失敗等)はjobを失敗として扱い、指数backoffで
 * リトライさせる。それ以外の全outcome(SUGGESTION_CREATED/REVISED/NO_MATCH/
 * AMBIGUOUS_NO_SUGGESTION/SKIPPED)は「照合処理自体は正常に完了した」ことを
 * 意味するため、jobをDONEにする(caseDetectQueueJob.tsのrunDetectionと同じ
 * 「処理を試みて結果が出た」=成功、という判定基準)。
 */

const BATCH_SIZE = 10;
const WORKER_ID = `case-suggest-worker-${process.pid}`;

async function runSuggestionGeneration(job: ClaimedCaseSuggestJob): Promise<void> {
  const result = await generateCaseSuggestionForCandidate({
    workspaceId: job.workspaceId,
    ownerSubjectUserId: job.ownerSubjectUserId,
    candidateId: job.candidateId,
  });
  if (result.outcome === "FAILED") {
    throw new Error(`CASE_PATTERN_SUGGESTION_GENERATION_FAILED: errorKind=${result.errorKind} reason=${result.reason}`);
  }
  debugServer.event("Worker/caseSuggestQueue", "Case Pattern Suggestion照合完了", {
    candidateId: job.candidateId,
    outcome: result.outcome,
  });
}

async function processOneJob(job: ClaimedCaseSuggestJob): Promise<"done" | "dead_letter" | "requeued"> {
  try {
    await runSuggestionGeneration(job);
    const result = await completeCaseSuggestJob(job.id, job.generation);
    return result.status === "DONE" ? "done" : "requeued";
  } catch (err) {
    debugServer.error("Worker/caseSuggestQueue", "Case Pattern Suggestion Job失敗", {
      jobId: job.id,
      candidateId: job.candidateId,
      err,
    });
    const result = await failCaseSuggestJob(job.id, err);
    return result.status === "DEAD_LETTER" ? "dead_letter" : "requeued";
  }
}

export async function processCaseSuggestQueue(): Promise<{ processed: number; deadLettered: number }> {
  const claimed = await claimCaseSuggestJobs(WORKER_ID, BATCH_SIZE);
  if (claimed.length === 0) return { processed: 0, deadLettered: 0 };

  let processed = 0;
  let deadLettered = 0;
  for (const job of claimed) {
    const outcome = await processOneJob(job);
    if (outcome === "done") processed++;
    if (outcome === "dead_letter") deadLettered++;
  }

  if (deadLettered > 0) {
    debugServer.event("Worker/caseSuggestQueue", "Case Pattern Suggestion JobがDEAD_LETTERへ到達", { deadLettered });
  }

  return { processed, deadLettered };
}
