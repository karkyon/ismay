import type { NextRequest } from "next/server";
import { db } from "@/lib/db";
import { debugServer } from "@/lib/debugServer";
import { requireAuth, requireCsrf } from "@/lib/auth/guard";
import { apiOk, apiError } from "@/lib/auth/response";

/** API-NTF-02: POST /notifications/{id}/read(2026-08-22新設)。単一通知を既読化する。 */
export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const auth = await requireAuth(req);
  if (!auth.authenticated) {
    return apiError("AUTH_REQUIRED", "ログインが必要です");
  }
  if (!requireCsrf(req)) {
    return apiError("ACCESS_DENIED", "CSRFトークンが不正です");
  }

  const { id } = await ctx.params;
  const existing = await db.notification.findFirst({
    where: { id, userId: auth.user.userId },
    select: { id: true, status: true },
  });
  if (!existing) {
    return apiError("RESOURCE_NOT_FOUND", "指定された通知が見つかりません");
  }
  if (existing.status !== "READ") {
    await db.notification.update({
      where: { id },
      data: { status: "READ", readAt: new Date() },
    });
    debugServer.state("POST /notifications/[id]/read", "Notification.status", { id, status: "READ" });
  }

  return apiOk({ id, status: "READ" });
}
