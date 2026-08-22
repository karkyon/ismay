import type { NextRequest } from "next/server";
import { db } from "@/lib/db";
import { debugServer } from "@/lib/debugServer";
import { requireAuth, requireCsrf } from "@/lib/auth/guard";
import { ensureDefaultWorkspace } from "@/lib/workspace";
import { apiOk, apiError } from "@/lib/auth/response";

/**
 * DELETE /responsibilities/{id}/constraints/{constraintId}(2026-08-23新設)。
 * Constraint(TBL-011)には編集用のvalidFrom/validTo等のライフサイクル管理列が
 * schema.prisma上に存在しないため、「編集」はサポートせず削除→再作成で対応する
 * (UI側もこの前提で「削除して追加し直す」導線にする)。
 */
export async function DELETE(
  req: NextRequest,
  ctx: { params: Promise<{ id: string; constraintId: string }> },
) {
  const auth = await requireAuth(req);
  if (!auth.authenticated) {
    return apiError("AUTH_REQUIRED", "ログインが必要です");
  }
  if (!requireCsrf(req)) {
    return apiError("ACCESS_DENIED", "CSRFトークンが不正です");
  }

  const { id, constraintId } = await ctx.params;
  const { workspaceId } = await ensureDefaultWorkspace(auth.user.userId, auth.user.email);

  // IDOR対策: 責任がこのworkspaceに属することを確認したうえで、その責任に従属する
  // constraintIdであることも突き合わせる(他責任のconstraintIdを渡されても削除できない)。
  const constraint = await db.constraint.findFirst({
    where: { id: constraintId, responsibilityId: id, responsibility: { workspaceId, deletedAt: null } },
    select: { id: true },
  });
  if (!constraint) {
    return apiError("RESOURCE_NOT_FOUND", "指定された制約が見つかりません");
  }

  await db.constraint.delete({ where: { id: constraintId } });
  debugServer.event("DELETE /responsibilities/[id]/constraints/[constraintId]", "Constraint削除", {
    responsibilityId: id,
    constraintId,
  });

  return apiOk({ deleted: true });
}
