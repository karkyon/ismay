import type { NextRequest } from "next/server";
import { db } from "@/lib/db";
import { requireAuth } from "@/lib/auth/guard";
import { ensureDefaultWorkspace } from "@/lib/workspace";
import { apiOk, apiError } from "@/lib/auth/response";

/**
 * GET /api/v1/responsibilities/{id}/dependencies: この責任の前提(parents)・後続(children)を返す。
 * 2026-08-20新設。カルキョンさんの指摘「一覧で選択時に親子関係の関連性が明確に
 * 視覚的に判別できるようにしろ」に対応。/relationsページの全体グラフとは別に、
 * 1件だけの前提・後続を軽量に取得できるようにして「今後」一覧の選択時インライン
 * 展開で使う。
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

  const [parentRelations, childRelations] = await Promise.all([
    db.responsibilityRelation.findMany({
      where: { toId: id, relationType: "BLOCKS", status: "CONFIRMED", deletedAt: null },
      select: { from: { select: { id: true, title: true, status: true, type: true } } },
    }),
    db.responsibilityRelation.findMany({
      where: { fromId: id, relationType: "BLOCKS", status: "CONFIRMED", deletedAt: null },
      select: { to: { select: { id: true, title: true, status: true, type: true } } },
    }),
  ]);

  type Rel = { id: string; title: string; status: string; type: string };
  const parents = (parentRelations as { from: Rel }[]).map((r) => r.from);
  const children = (childRelations as { to: Rel }[]).map((r) => r.to);

  return apiOk({ parents, children });
}
