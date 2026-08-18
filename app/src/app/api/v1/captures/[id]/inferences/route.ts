import type { NextRequest } from "next/server";
import { db } from "@/lib/db";
import { requireAuth } from "@/lib/auth/guard";
import { ensureDefaultWorkspace } from "@/lib/workspace";
import { apiOk, apiError } from "@/lib/auth/response";

/**
 * API-CAP-04: GET /captures/{id}/inferences 候補取得(UI-04)
 *
 * [既知の制約] AI Workerが未実装のため、現時点では常に空配列を返す
 * (ai_inferencesへの書き込みはAI Worker実装後に発生する)。
 */
export async function GET(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const auth = await requireAuth(req);
  if (!auth.authenticated) {
    return apiError("AUTH_REQUIRED", "ログインが必要です");
  }

  const { id } = await ctx.params;
  const { workspaceId } = await ensureDefaultWorkspace(auth.user.userId, auth.user.email);

  const capture = await db.capture.findFirst({
    where: { id, workspaceId, deletedAt: null },
    select: { id: true },
  });
  if (!capture) {
    return apiError("RESOURCE_NOT_FOUND", "指定されたCaptureが見つかりません");
  }

  const inferences = await db.aiInference.findMany({
    where: { captureId: id },
    orderBy: { createdAt: "asc" },
    select: {
      id: true,
      inferenceType: true,
      payload: true,
      evidenceSpans: true,
      confidence: true,
      decision: true,
      decidedAt: true,
      createdAt: true,
    },
  });

  return apiOk({ inferences });
}
