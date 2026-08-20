import type { NextRequest } from "next/server";
import { db } from "@/lib/db";
import { requireAuth } from "@/lib/auth/guard";
import { ensureDefaultWorkspace } from "@/lib/workspace";
import { apiOk, apiError } from "@/lib/auth/response";
import { findRelatedResponsibilities } from "@/lib/ai/relatedResponsibilities";

/**
 * FN-GR-01(意味照合)の結果をいつでも参照できるようにするエンドポイント。
 * 採用直後だけでなく、後から「今後」画面の詳細を開いたときにも関連候補を
 * 確認できるようにする(埋め込みが未生成の場合は空配列を返す。エラーにはしない
 * — 埋め込みAPIキー未設定等でも他機能が止まらないようにするため)。
 */
export async function GET(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const auth = await requireAuth(req);
  if (!auth.authenticated) {
    return apiError("AUTH_REQUIRED", "ログインが必要です");
  }

  const { id } = await ctx.params;
  const { workspaceId } = await ensureDefaultWorkspace(auth.user.userId, auth.user.email);

  const responsibility = await db.responsibility.findFirst({
    where: { id, workspaceId, deletedAt: null },
    select: { id: true },
  });
  if (!responsibility) {
    return apiError("RESOURCE_NOT_FOUND", "指定された責任が見つかりません");
  }

  const related = await findRelatedResponsibilities({ responsibilityId: id, workspaceId });
  return apiOk({ related });
}
