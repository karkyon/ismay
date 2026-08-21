import type { NextRequest } from "next/server";
import { db } from "@/lib/db";
import { requireAuth } from "@/lib/auth/guard";
import { ensureDefaultWorkspace } from "@/lib/workspace";
import { apiOk, apiError } from "@/lib/auth/response";

/**
 * GET /api/v1/responsibilities/{id}/dependencies: この責任を中心とした前提・後続関係を
 * 「今後」画面の右側detail panel内に埋め込むPERT表示専用に返す。
 *
 * [2026-08-21修正] 従来はparents/children(直接の前提・後続のみ、1階層)を返し、
 * それを一覧の各行下にテキストで展開していた。カルキョンさんの指摘
 * 「先行・後続タスクはその右のエリアで展開し視覚的にわかりやすく」「PERT図」
 * 「Obsidianのような動的」に対応するため、ワイヤーフレームv2で合意した通り
 * 前提・後続を2階層先までBFSで辿り、ノード・エッジ形式(layer付き)で返すように
 * 変更した。フロント側(PertMiniPanel)がこれをレイアウトしてSVG描画する。
 * parents/childrenは後方互換のため残す(直接の前提・後続のみ、1階層分)。
 */

interface NodeShape {
  id: string;
  title: string;
  status: string;
  type: string;
  importance: number | null;
}

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

  // --- 後方互換: 直接の前提・後続(1階層) ---
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

  // --- 新規: 2階層BFSでnode/edge形式(PertMiniPanel用) ---
  const DEPTH = 2;
  const layerOf = new Map<string, number>([[id, 0]]);
  const edgeSet = new Map<string, { fromId: string; toId: string; id: string }>();

  let frontier = [id];
  for (let d = 1; d <= DEPTH; d++) {
    if (frontier.length === 0) break;
    const rels = await db.responsibilityRelation.findMany({
      where: { toId: { in: frontier }, relationType: "BLOCKS", status: "CONFIRMED", deletedAt: null },
      select: { id: true, fromId: true, toId: true },
    });
    const next: string[] = [];
    for (const r of rels as { id: string; fromId: string; toId: string }[]) {
      edgeSet.set(r.id, r);
      if (!layerOf.has(r.fromId)) {
        layerOf.set(r.fromId, -d);
        next.push(r.fromId);
      }
    }
    frontier = next;
  }
  frontier = [id];
  for (let d = 1; d <= DEPTH; d++) {
    if (frontier.length === 0) break;
    const rels = await db.responsibilityRelation.findMany({
      where: { fromId: { in: frontier }, relationType: "BLOCKS", status: "CONFIRMED", deletedAt: null },
      select: { id: true, fromId: true, toId: true },
    });
    const next: string[] = [];
    for (const r of rels as { id: string; fromId: string; toId: string }[]) {
      edgeSet.set(r.id, r);
      if (!layerOf.has(r.toId)) {
        layerOf.set(r.toId, d);
        next.push(r.toId);
      }
    }
    frontier = next;
  }

  const nodeIds = Array.from(layerOf.keys());
  const nodeRows = await db.responsibility.findMany({
    where: { id: { in: nodeIds } },
    select: { id: true, title: true, status: true, type: true, importance: true },
  });
  const nodes = (nodeRows as NodeShape[]).map((n) => ({ ...n, layer: layerOf.get(n.id) ?? 0 }));
  const edges = Array.from(edgeSet.values());

  return apiOk({ parents, children, nodes, edges });
}
