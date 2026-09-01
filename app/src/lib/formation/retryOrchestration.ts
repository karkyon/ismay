import { db } from "@/lib/db";
import type { Prisma } from "@/generated/prisma/client";
import { debugServer } from "@/lib/debugServer";

/**
 * app/src/lib/formation/retryOrchestration.ts
 *
 * V5-M1-B6C-4 §6.3 retry orchestration。
 * 出典: Claude向け ISMAY c503e72以降 M1-B6C・全残件連続実装指示(2026-08-31) §6.3。
 *
 * [設計方針] `retryFormationSession`(sessionLifecycle.ts)自体はFAILED→ANALYZINGの
 * 状態遷移とEvent記録だけを行い、実際のAI再抽出を起動しない(既存方針・
 * 課金を伴うProvider呼出しをtx内に混在させない)。この module は、その
 * lifecycle transactionが確定した"後"に、既存のOutbox/Job基盤(relay.ts→
 * aiExtractJob.ts)へ新しい抽出Jobを冪等投入する橋渡し役を担う
 * (指示書§6.3「lifecycle transaction確定後にOutbox/Jobを冪等投入する」)。
 *
 * [冪等性] `Job`の`(jobType, aggregateId, sourceVersion)`一意制約をそのまま
 * 使う。Capture.versionをCASでインクリメントしてからJobを作るため、同じ
 * versionへの二重投入はDB制約で自然に弾かれる(P2002)。
 *
 * [reconciliation] Job投入自体がここで失敗しても(DB接続断等)、Session側は
 * 既にANALYZINGへ確定済みであり、Capture.processingStatusはFAILEDのまま
 * 変化しない。「Session.state=ANALYZINGだがCaptureはFAILEDのまま」という
 * 組合せ自体が「retry Job投入がまだ完了していない」ことを示す観測可能な
 * 状態であり、これを`reconcileStuckRetryOrchestrations`が定期的に検出して
 * 再試行する(M1-B6C-1のFormationShadowCheckpointと同じ「新しいtableを作らず、
 * 既存状態の不整合自体をqueueとして扱う」設計)。
 */

export type OrchestrateRetryAnalysisResult =
  | { ok: true; queued: boolean; jobId?: string }
  | { ok: false; error: "SESSION_NOT_FOUND" | "CAPTURE_NOT_FOUND" }
  | { ok: false; error: "UNEXPECTED_EXCEPTION"; message: string };

/**
 * 指定Sessionに紐づくCaptureを、AI_EXTRACT Jobへ冪等に再投入する。
 * Capture.processingStatusが既にFAILED以外(QUEUED/PROCESSING/READY等)の場合は
 * 「既に他経路(前回のorchestration成功・reconciliation・並行操作)で再キュー
 * 済み」とみなし、何もせず`queued:false`で成功を返す(二重投入しない)。
 */
export async function orchestrateRetryAnalysis(params: { sessionId: string; workspaceId: string }): Promise<OrchestrateRetryAnalysisResult> {
  const { sessionId, workspaceId } = params;
  try {
    const session = await db.formationSession.findFirst({
      where: { id: sessionId, workspaceId },
      select: { captureId: true },
    });
    if (!session) {
      return { ok: false, error: "SESSION_NOT_FOUND" };
    }

    const capture = await db.capture.findUnique({ where: { id: session.captureId } });
    if (!capture) {
      return { ok: false, error: "CAPTURE_NOT_FOUND" };
    }
    if (capture.processingStatus !== "FAILED") {
      return { ok: true, queued: false };
    }

    const result = await db.$transaction(async (tx: Prisma.TransactionClient) => {
      // Capture: FAILED --CAS--> QUEUED(通常のCapture解析flowと同じ入口状態へ戻す)。
      const claimed = await tx.capture.updateMany({
        where: { id: capture.id, version: capture.version, processingStatus: "FAILED" },
        data: { processingStatus: "QUEUED", version: { increment: 1 } },
      });
      if (claimed.count === 0) {
        // 競合(既に他経路が同時に再キュー済み)。二重投入しない。
        return { queued: false as const, jobId: undefined };
      }
      const newVersion = capture.version + 1;
      const job = await tx.job.create({
        data: {
          jobType: "AI_EXTRACT",
          aggregateId: capture.id,
          sourceVersion: newVersion,
          payload: { captureId: capture.id, attachToSessionId: sessionId },
        },
      });
      return { queued: true as const, jobId: job.id };
    });

    if (result.queued) {
      debugServer.event("formation/retryOrchestration", "RETRY_ANALYSIS_QUEUED", {
        sessionId,
        captureId: capture.id,
        jobId: result.jobId,
      });
    }
    return { ok: true, queued: result.queued, jobId: result.jobId };
  } catch (err) {
    const code = (err as { code?: string } | null)?.code;
    if (code === "P2002") {
      // 既にこのsourceVersionのJobが存在する(競合実行等)。冪等に成功扱い。
      return { ok: true, queued: false };
    }
    debugServer.error("formation/retryOrchestration", "RETRY_ANALYSIS_QUEUE_FAILED", { sessionId, err });
    return { ok: false, error: "UNEXPECTED_EXCEPTION", message: String(err) };
  }
}

const RECONCILE_BATCH_SIZE = 10;

/**
 * Worker tick(worker/index.ts)から定期的に呼ばれる。「直近のRETRY lifecycle
 * eventを持つSessionがANALYZING状態のままなのに、対応するCaptureがFAILEDの
 * ままJob投入されていない」ものを検出し、再試行する。
 */
export async function reconcileStuckRetryOrchestrations(): Promise<{ reconciled: number }> {
  const stuck = await db.formationSessionLifecycleEvent.findMany({
    where: {
      action: "RETRY",
      session: { state: "ANALYZING", capture: { processingStatus: "FAILED" } },
    },
    orderBy: { occurredAt: "desc" },
    distinct: ["sessionId"],
    take: RECONCILE_BATCH_SIZE,
    select: { sessionId: true, workspaceId: true },
  });

  let reconciled = 0;
  for (const row of stuck) {
    const result = await orchestrateRetryAnalysis({ sessionId: row.sessionId, workspaceId: row.workspaceId });
    if (result.ok && result.queued) reconciled++;
  }
  return { reconciled };
}
