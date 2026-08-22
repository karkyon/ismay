import type { NextRequest } from "next/server";
import { db } from "@/lib/db";
import { debugServer } from "@/lib/debugServer";
import { requireAuth, requireCsrf } from "@/lib/auth/guard";
import { ensureDefaultWorkspace } from "@/lib/workspace";
import { apiOk, apiError } from "@/lib/auth/response";
import { getOrCreateCurrentCycle } from "@/lib/cycle";

/**
 * API-CYCLE-03: DELETE /cycles/current/items/{responsibilityId}(2026-08-22新設)。
 * 今週のコミットから外す(責任自体は削除しない。バックログへ戻すだけ)。
 */
export async function DELETE(req: NextRequest, ctx: { params: Promise<{ responsibilityId: string }> }) {
  const auth = await requireAuth(req);
  if (!auth.authenticated) {
    return apiError("AUTH_REQUIRED", "ログインが必要です");
  }
  if (!requireCsrf(req)) {
    return apiError("ACCESS_DENIED", "CSRFトークンが不正です");
  }

  const { responsibilityId } = await ctx.params;
  const { workspaceId } = await ensureDefaultWorkspace(auth.user.userId, auth.user.email);
  const cycle = await getOrCreateCurrentCycle(workspaceId);

  const result = await db.cycleItem.deleteMany({
    where: { cycleId: cycle.id, responsibilityId },
  });
  debugServer.event("DELETE /cycles/current/items/[responsibilityId]", "CycleItem削除", {
    cycleId: cycle.id,
    responsibilityId,
    deleted: result.count,
  });

  return apiOk({ deleted: result.count > 0 });
}
