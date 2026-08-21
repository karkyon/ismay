import type { NextRequest } from "next/server";
import { db } from "@/lib/db";
import { debugServer } from "@/lib/debugServer";
import { requireAuth, requireCsrf } from "@/lib/auth/guard";
import { ensureDefaultWorkspace } from "@/lib/workspace";
import { apiOk, apiError } from "@/lib/auth/response";

/** DELETE /api/v1/responsibility-relations/{id}: PERT図上で辺(エッジ)をクリックして削除するためのAPI。 */
export async function DELETE(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const auth = await requireAuth(req);
  if (!auth.authenticated) {
    return apiError("AUTH_REQUIRED", "ログインが必要です");
  }
  if (!requireCsrf(req)) {
    return apiError("ACCESS_DENIED", "CSRFトークンが不正です");
  }

  const { id } = await ctx.params;
  const { workspaceId } = await ensureDefaultWorkspace(auth.user.userId, auth.user.email);

  const relation = await db.responsibilityRelation.findFirst({
    where: { id, deletedAt: null, from: { workspaceId } },
    select: { id: true },
  });
  if (!relation) {
    return apiError("RESOURCE_NOT_FOUND", "指定された関係が見つかりません");
  }

  await db.responsibilityRelation.update({ where: { id }, data: { deletedAt: new Date() } });
  debugServer.event("DELETE /responsibility-relations/[id]", "RESPONSIBILITY_RELATION_DELETED", { id });

  return apiOk({ deleted: true });
}
