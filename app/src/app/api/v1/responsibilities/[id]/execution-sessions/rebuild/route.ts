import type { NextRequest } from "next/server";
import { db } from "@/lib/db";
import { debugServer } from "@/lib/debugServer";
import { requireAuth, requireCsrf } from "@/lib/auth/guard";
import { apiOk, apiError } from "@/lib/auth/response";
import { buildPemAuthorizationContext, assertSelfOnlyAccess } from "@/lib/pem/authorizationBoundary";
import { SESSION_DERIVATION_VERSION } from "@/lib/pem/sessionPersistence";
import { enqueueRecompute, getProjectionStatus } from "@/lib/pem/recomputeQueue";

/**
 * V5 API: POST /responsibilities/{id}/execution-sessions/rebuild
 * 出典: 統合正本仕様書v5.0 §22.2 CHG-035「Worker: projection
 * checkpoint/dead-letter/rebuild command追加」。
 *
 * 本人が明示的に「Session Projectionを再計算してほしい」と要求できる操作用API。
 * DOC-05 8章のRecompute Queueへreason=MANUAL_REBUILDでenqueueするだけで、
 * 実際の再計算はWorker(recomputeQueueJob.ts)が非同期に処理する
 * (このAPI自体は同期的に再計算を実行しない)。
 */
export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const auth = await requireAuth(req);
  if (!auth.authenticated) {
    return apiError("AUTH_REQUIRED", "ログインが必要です");
  }
  if (!requireCsrf(req)) {
    return apiError("ACCESS_DENIED", "CSRFトークンが不正です");
  }

  const { id: responsibilityId } = await ctx.params;
  const pemCtx = await buildPemAuthorizationContext(auth.user.userId, auth.user.userId);
  assertSelfOnlyAccess(pemCtx);

  const responsibility = await db.responsibility.findFirst({
    where: { id: responsibilityId, workspaceId: pemCtx.tenantId, deletedAt: null },
    select: { id: true },
  });
  if (!responsibility) {
    return apiError("RESOURCE_NOT_FOUND", "指定された責任が見つかりません");
  }

  const enqueueResult = await enqueueRecompute(db, {
    workspaceId: pemCtx.tenantId,
    responsibilityId,
    subjectUserId: pemCtx.subjectUserId,
    derivationVersion: SESSION_DERIVATION_VERSION,
    projectionType: "EXECUTION_SESSION",
    reasonCode: "MANUAL_REBUILD",
  });

  debugServer.event("POST /responsibilities/[id]/execution-sessions/rebuild", "手動再計算Job投入", {
    responsibilityId,
    jobId: enqueueResult.id,
    generation: enqueueResult.generation,
    coalesced: enqueueResult.coalesced,
  });

  const projectionStatus = await getProjectionStatus(pemCtx.tenantId, responsibilityId, "EXECUTION_SESSION");
  return apiOk({ jobId: enqueueResult.id, generation: enqueueResult.generation, projectionStatus }, { status: 202 });
}
