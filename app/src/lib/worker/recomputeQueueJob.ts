import { db } from "@/lib/db";
import type { Prisma } from "@/generated/prisma/client";
import { debugServer } from "@/lib/debugServer";
import { projectAndPersistExecutionSessions } from "@/lib/pem/sessionPersistence";
import type { PemAuthorizationContext } from "@/lib/pem/authorizationBoundary";
import {
  claimRecomputeJobs,
  completeRecomputeJob,
  failRecomputeJob,
  type ClaimedRecomputeJob,
} from "@/lib/pem/recomputeQueue";

/**
 * app/src/lib/worker/recomputeQueueJob.ts
 *
 * PEM-RECOMPUTE-QUEUE Worker(2026-09-03新設)。
 * 出典: 統合正本仕様書v5.0 §22.2 CHG-035「Worker: projection
 * checkpoint/dead-letter/rebuild command追加」。
 *
 * shadowReconciliationJob.ts等と同じ「5秒tick内でポーリング関数を1回呼ぶ」構成
 * (worker/index.ts参照)。実際のclaim/complete/fail処理はrecomputeQueue.tsへ委譲する。
 */

const BATCH_SIZE = 10;
const WORKER_ID = `recompute-worker-${process.pid}`;

type RecomputeHandler = (ctx: PemAuthorizationContext, responsibilityId: string) => Promise<number | null>;

/**
 * projectionType→再計算処理のマッピング。現時点ではEXECUTION_SESSIONのみ
 * (recomputeQueue.ts RECOMPUTE_PROJECTION_TYPES参照)。戻り値は
 * lastCheckpointSequence用の参考値(現行の完全再計算実装では常にnull)。
 */
const RECOMPUTE_HANDLERS: Record<string, RecomputeHandler> = {
  EXECUTION_SESSION: async (ctx, responsibilityId) => {
    await db.$transaction(async (tx: Prisma.TransactionClient) => {
      await projectAndPersistExecutionSessions(tx, ctx, responsibilityId);
    });
    return null;
  },
};

async function processOneJob(job: ClaimedRecomputeJob): Promise<"done" | "dead_letter" | "requeued"> {
  const handler = RECOMPUTE_HANDLERS[job.projectionType];
  if (!handler) {
    const result = await failRecomputeJob(job.id, new Error(`UNKNOWN_PROJECTION_TYPE:${job.projectionType}`));
    return result.status === "DEAD_LETTER" ? "dead_letter" : "requeued";
  }

  try {
    const ctx: PemAuthorizationContext = {
      tenantId: job.workspaceId,
      subjectUserId: job.subjectUserId,
      // [設計判断] Workerはsystem主体であり、代理操作の実行者(actorUserId)を
      // subjectUserId自身とする(authorizationBoundary.ts「MVPではactorUserId
      // ===subjectUserIdが常に成立」という既存前提を踏襲)。
      actorUserId: job.subjectUserId,
      workspaceRole: "MEMBER",
      authenticationContextId: `worker:${WORKER_ID}`,
    };
    const checkpointSequence = await handler(ctx, job.responsibilityId);
    const result = await completeRecomputeJob(job.id, job.generation, checkpointSequence);
    return result.status === "DONE" ? "done" : "requeued";
  } catch (err) {
    debugServer.error("Worker/recomputeQueue", "再計算Job失敗", {
      jobId: job.id,
      responsibilityId: job.responsibilityId,
      projectionType: job.projectionType,
      err,
    });
    const result = await failRecomputeJob(job.id, err);
    return result.status === "DEAD_LETTER" ? "dead_letter" : "requeued";
  }
}

export async function processRecomputeQueue(): Promise<{ processed: number; deadLettered: number }> {
  const claimed = await claimRecomputeJobs(WORKER_ID, BATCH_SIZE);
  if (claimed.length === 0) return { processed: 0, deadLettered: 0 };

  let processed = 0;
  let deadLettered = 0;
  for (const job of claimed) {
    const outcome = await processOneJob(job);
    if (outcome === "done") processed++;
    if (outcome === "dead_letter") deadLettered++;
  }

  if (deadLettered > 0) {
    debugServer.event("Worker/recomputeQueue", "Recompute JobがDEAD_LETTERへ到達", { deadLettered });
  }

  return { processed, deadLettered };
}
