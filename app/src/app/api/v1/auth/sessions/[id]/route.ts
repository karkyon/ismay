import type { NextRequest } from "next/server";
import { db } from "@/lib/db";
import { requireAuth, requireCsrf } from "@/lib/auth/guard";
import { revokeSession } from "@/lib/auth/session";
import { apiOk, apiError } from "@/lib/auth/response";

export async function DELETE(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const auth = await requireAuth(req);
  if (!auth.authenticated) {
    return apiError("AUTH_REQUIRED", "ログインが必要です");
  }
  if (!requireCsrf(req)) {
    return apiError("ACCESS_DENIED", "CSRFトークンが不正です");
  }

  const { id } = await ctx.params;
  const target = await db.userSession.findUnique({ where: { id } });
  if (!target || target.userId !== auth.user.userId) {
    // 他人のセッションIDを推測されても存在有無を漏らさない(IDOR対策)
    return apiError("RESOURCE_NOT_FOUND", "セッションが見つかりません");
  }

  await revokeSession(id, "REVOKED_BY_USER");
  return apiOk({ revoked: true, wasCurrent: id === auth.user.sessionId });
}
