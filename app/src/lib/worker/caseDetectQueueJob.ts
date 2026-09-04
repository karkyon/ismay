import { debugServer } from "@/lib/debugServer";
import {
  claimCaseDetectJobs,
  completeCaseDetectJob,
  failCaseDetectJob,
  type ClaimedCaseDetectJob,
} from "@/lib/patterns/caseDetectQueue";
import { computeAndPersistCasePatternAggregatesForOwner } from "@/lib/patterns/casePatternAggregation";
import { runCasePatternDetectionForOwner } from "@/lib/patterns/casePatternDetectionService";

/**
 * app/src/lib/worker/caseDetectQueueJob.ts
 *
 * Case Pattern Detect Queue Worker(PATTERN-DETECT-01B新設・2026-09-03、
 * PATTERN-DETECT-01Cで集計接続・2026-09-03、PATTERN-DETECT-02Aで検出本体接続・
 * 2026-09-04)。recomputeQueueJob.tsと同じ「5秒tick内でポーリング関数を1回
 * 呼ぶ」構成(worker/index.ts参照)。claim/complete/fail処理はcaseDetectQueue.ts
 * へ委譲する。
 *
 * [完了報告の誤り是正・2026-09-04] 2026-09-03時点のrunDetection()は
 * computeAndPersistCasePatternAggregatesForOwner()(既存Patternの再集計)しか
 * 呼んでおらず、「Pattern検出」を名乗りながら実際には未知Pattern候補を一切
 * 検出していなかった(Claude向け_ISMAY_3b695d9以降_再監査是正・CasePattern
 * 実機能完遂指示_2026-09-04.md §1「01A〜01Eの完了報告は誤り」、P0-1)。
 * casePatternDetectionService.ts(PATTERN-DETECT-02A)がeligible source列挙・
 * embedding・exact cosine matching・SourceLink作成/新規Pattern作成・
 * Detection Receipt記録までを実際に行う。集計(既存casePatternAggregation.ts)は
 * 検出処理の後に、検出結果を反映するため引き続き呼ぶ。
 */

const BATCH_SIZE = 10;
const WORKER_ID = `case-detect-worker-${process.pid}`;

async function runDetection(job: ClaimedCaseDetectJob): Promise<void> {
  await runCasePatternDetectionForOwner(job.workspaceId, job.ownerSubjectUserId);
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
