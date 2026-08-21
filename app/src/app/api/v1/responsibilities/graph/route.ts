import type { NextRequest } from "next/server";
import { db } from "@/lib/db";
import { requireAuth } from "@/lib/auth/guard";
import { ensureDefaultWorkspace } from "@/lib/workspace";
import { apiOk, apiError } from "@/lib/auth/response";

/**
 * GET /api/v1/responsibilities/graph: 責任間の依存関係グラフ(FR-GR-06相当)。
 * 2026-08-20新設。カルキョンさんの指摘「前後関係・親子関係・線形計画図が
 * 一切できていない」に対応。ResponsibilityRelation(BLOCKS)を、未完了の
 * 責任に限定してノード・エッジとして返す(完了済みの責任まで含めると
 * グラフが肥大化し、今何が止まっているかが見えにくくなるため)。
 *
 * 描画はフロント側(React+SVG)で行う。バックエンドはトポロジカルな層(layer)を
 * 事前計算して返し、フロント側での配置計算を簡略化する。
 */

interface NodeRow {
  id: string;
  title: string;
  type: string;
  status: string;
  importance: number | null;
  hardDeadlineAt: Date | null;
  graphX: number | null;
  graphY: number | null;
  version: number;
}

interface EdgeRow {
  id: string;
  fromId: string;
  toId: string;
  relationType: string;
}

export async function GET(req: NextRequest) {
  const auth = await requireAuth(req);
  if (!auth.authenticated) {
    return apiError("AUTH_REQUIRED", "ログインが必要です");
  }
  const { workspaceId } = await ensureDefaultWorkspace(auth.user.userId, auth.user.email);

  const relations = await db.responsibilityRelation.findMany({
    where: {
      status: "CONFIRMED",
      deletedAt: null,
      from: { workspaceId, deletedAt: null },
      to: { workspaceId, deletedAt: null },
    },
    select: { id: true, fromId: true, toId: true, relationType: true },
  });

  const nodeIds = new Set<string>();
  for (const r of relations as EdgeRow[]) {
    nodeIds.add(r.fromId);
    nodeIds.add(r.toId);
  }

  if (nodeIds.size === 0) {
    return apiOk({ nodes: [], edges: [] });
  }

  const nodes = await db.responsibility.findMany({
    where: { id: { in: Array.from(nodeIds) } },
    select: {
      id: true,
      title: true,
      type: true,
      status: true,
      importance: true,
      hardDeadlineAt: true,
      graphX: true,
      graphY: true,
      version: true,
    },
  });

  // トポロジカル層(layer)を計算する: BLOCKS(from=ブロック元, to=ブロックされる側)を
  // 前提として、fromが完了する層より1つ後にtoを配置する。循環がある場合は
  // (AI/ユーザーの入力誤りで理論上あり得る)そこで層計算を打ち切り、layer=0にする。
  const outgoing = new Map<string, string[]>(); // fromId -> [toId]
  for (const r of relations as EdgeRow[]) {
    const arr = outgoing.get(r.fromId) ?? [];
    arr.push(r.toId);
    outgoing.set(r.fromId, arr);
  }
  const inDegree = new Map<string, number>();
  for (const id of nodeIds) inDegree.set(id, 0);
  for (const r of relations as EdgeRow[]) {
    inDegree.set(r.toId, (inDegree.get(r.toId) ?? 0) + 1);
  }

  const layer = new Map<string, number>();
  const queue: string[] = [];
  for (const [id, deg] of inDegree) {
    if (deg === 0) {
      layer.set(id, 0);
      queue.push(id);
    }
  }
  const visited = new Set<string>(queue);
  let guard = 0;
  while (queue.length > 0 && guard < 10000) {
    guard++;
    const current = queue.shift()!;
    const currentLayer = layer.get(current) ?? 0;
    for (const next of outgoing.get(current) ?? []) {
      const candidateLayer = currentLayer + 1;
      if (!layer.has(next) || candidateLayer > (layer.get(next) ?? 0)) {
        layer.set(next, candidateLayer);
      }
      if (!visited.has(next)) {
        visited.add(next);
        queue.push(next);
      }
    }
  }
  // 循環等でlayerが付かなかったノードは0扱い
  for (const id of nodeIds) {
    if (!layer.has(id)) layer.set(id, 0);
  }

  type RespNode = NodeRow;
  const nodesOut = (nodes as RespNode[]).map((n) => ({
    id: n.id,
    title: n.title,
    type: n.type,
    status: n.status,
    importance: n.importance,
    hardDeadlineAt: n.hardDeadlineAt,
    layer: layer.get(n.id) ?? 0,
    graphX: n.graphX,
    graphY: n.graphY,
    version: n.version,
  }));

  const edgesOut = (relations as EdgeRow[]).map((r) => ({
    id: r.id,
    fromId: r.fromId,
    toId: r.toId,
    relationType: r.relationType,
  }));

  return apiOk({ nodes: nodesOut, edges: edgesOut });
}
