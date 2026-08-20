import type { NextRequest } from "next/server";
import { db } from "@/lib/db";
import { requireAuth } from "@/lib/auth/guard";
import { ensureDefaultWorkspace } from "@/lib/workspace";
import { apiOk, apiError } from "@/lib/auth/response";

/** UI-04向け候補取得(GET /captures/{id}/inferences)。 */
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
      // [2026-08-20追加] Inbox画面でACCEPT/REJECT操作(API-AI-01)を行うために必須。
      // 従来この列を返しておらず、フロント側でexpectedInferenceVersionを渡せないため
      // 候補内容の表示・採否操作が一切実装できていなかった。
      version: true,
    },
  });

  return apiOk({ inferences });
}
