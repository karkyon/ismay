import type { NextRequest } from "next/server";
import { db } from "@/lib/db";
import type { Prisma } from "@/generated/prisma/client";
import { debugServer } from "@/lib/debugServer";
import { requireAuth, requireCsrf } from "@/lib/auth/guard";
import { ensureDefaultWorkspace } from "@/lib/workspace";
import { apiOk, apiError } from "@/lib/auth/response";

/**
 * API-CAP-03: POST /captures/{id}/analyze 解析再要求
 *
 * [スコープ] AI Workerは本パッチでは未実装。本APIはprocessingStatusを
 * QUEUEDへ遷移させ、CaptureAnalysisRequested.v1をOutboxへ積むところまでを担う。
 * 実際の推論実行・InferenceReadyへの遷移は次回セッションのAI Worker実装で行う。
 */
export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const auth = await requireAuth(req);
  if (!auth.authenticated) {
    return apiError("AUTH_REQUIRED", "ログインが必要です");
  }
  if (!requireCsrf(req)) {
    return apiError("ACCESS_DENIED", "CSRFトークンが不正です");
  }

  const { id } = await ctx.params;
  const { workspaceId } = await ensureDefaultWorkspace(auth.user.userId, auth.user.email);

  const capture = await db.capture.findFirst({ where: { id, workspaceId, deletedAt: null } });
  if (!capture) {
    return apiError("RESOURCE_NOT_FOUND", "指定されたCaptureが見つかりません");
  }

  // FN-PRV-02: source_type=MEETINGは同意登録(consent_id確定)まで解析キューへ投入しない
  if (capture.sourceType === "MEETING" && !capture.consentId) {
    return apiError("STATE_TRANSITION_INVALID", "会議録音は同意登録が完了するまで解析できません");
  }
  if (capture.sourceType !== "VOICE" && !capture.rawText) {
    return apiError("STATE_TRANSITION_INVALID", "本文が未保存のため解析できません");
  }
  if (capture.processingStatus === "PROCESSING" || capture.processingStatus === "QUEUED") {
    // 既に解析待ち・解析中: 二重投入せず現在状態を返す(冪等)
    return apiOk({ id: capture.id, processingStatus: capture.processingStatus, version: capture.version });
  }

  const result = await db.$transaction(async (tx: Prisma.TransactionClient) => {
    const updateResult = await tx.capture.updateMany({
      where: { id: capture.id, version: capture.version },
      data: { processingStatus: "QUEUED", version: { increment: 1 } },
    });
    if (updateResult.count === 0) {
      return null;
    }
    const next = await tx.capture.findUniqueOrThrow({ where: { id: capture.id } });
    debugServer.state("POST /captures/[id]/analyze", "Capture.processingStatus", {
      id: capture.id,
      from: capture.processingStatus,
      to: next.processingStatus,
    });

    await tx.eventLog.create({
      data: {
        aggregateType: "Capture",
        aggregateId: capture.id,
        eventType: "CAPTURE_ANALYSIS_REQUESTED",
        beforeJson: { processingStatus: capture.processingStatus },
        afterJson: { processingStatus: next.processingStatus },
        actorType: "USER",
        actorId: auth.user.userId,
        correlationId: req.headers.get("x-correlation-id") ?? undefined,
      },
    });
    debugServer.event("POST /captures/[id]/analyze", "CAPTURE_ANALYSIS_REQUESTED", { aggregateId: capture.id });

    await tx.outboxEvent.create({
      data: {
        eventName: "CaptureAnalysisRequested.v1",
        eventVersion: "1",
        aggregateId: capture.id,
        aggregateVersion: next.version,
        correlationId: req.headers.get("x-correlation-id") ?? undefined,
        payload: { captureId: capture.id, workspaceId, sourceType: capture.sourceType },
      },
    });
    debugServer.event("POST /captures/[id]/analyze", "CaptureAnalysisRequested.v1", { aggregateId: capture.id });

    return next;
  });

  if (!result) {
    // 機能別詳細設計書v1.1 18章「競合制御」: 409応答にlatestVersionを含める
    const latest = await db.capture.findUnique({
      where: { id: capture.id },
      select: { version: true, processingStatus: true },
    });
    return apiError("VERSION_CONFLICT", "他の更新と競合しました。最新の状態を取得してください", {
      retryable: true,
      extra: { latestVersion: latest?.version, processingStatus: latest?.processingStatus },
    });
  }

  return apiOk({ id: result.id, processingStatus: result.processingStatus, version: result.version });
}
