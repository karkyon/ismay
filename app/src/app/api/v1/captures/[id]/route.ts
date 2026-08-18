import type { NextRequest } from "next/server";
import { db } from "@/lib/db";
import { requireAuth } from "@/lib/auth/guard";
import { ensureDefaultWorkspace } from "@/lib/workspace";
import { apiOk, apiError } from "@/lib/auth/response";

/** UI-04向け詳細取得。 */
export async function GET(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const auth = await requireAuth(req);
  if (!auth.authenticated) {
    return apiError("AUTH_REQUIRED", "ログインが必要です");
  }

  const { id } = await ctx.params;
  const { workspaceId } = await ensureDefaultWorkspace(auth.user.userId, auth.user.email);

  const capture = await db.capture.findFirst({
    where: { id, workspaceId, deletedAt: null },
    select: {
      id: true,
      sourceType: true,
      rawText: true,
      audioObjectKey: true,
      processingStatus: true,
      domainId: true,
      consentId: true,
      sourceCapturedAt: true,
      version: true,
      createdAt: true,
      updatedAt: true,
    },
  });

  if (!capture) {
    // 他Workspaceのcapture IDを推測されても存在有無を漏らさない(IDOR対策。sessions/[id]と同じ方針)
    return apiError("RESOURCE_NOT_FOUND", "指定されたCaptureが見つかりません");
  }

  return apiOk({ capture });
}
