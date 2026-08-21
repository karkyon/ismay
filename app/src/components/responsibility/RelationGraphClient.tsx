"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { apiFetch, debugFetch } from "@/lib/auth/client";
import { debugLog } from "@/lib/debug";

interface GraphNode {
  id: string;
  title: string;
  type: string;
  status: string;
  importance: number | null;
  hardDeadlineAt: string | null;
  layer: number;
  graphX: number | null;
  graphY: number | null;
  version: number;
}

interface GraphEdge {
  id: string;
  fromId: string;
  toId: string;
  relationType: string;
}

const NODE_WIDTH = 200;
const NODE_HEIGHT = 64;
const COL_GAP = 90;
const ROW_GAP = 20;
const PADDING = 24;

const STATUS_COLOR: Record<string, string> = {
  IN_PROGRESS: "#2563eb",
  PLANNED: "#6b7280",
  COMPLETED: "#16a34a",
};

/**
 * /relations: 責任間のBLOCKS依存関係を線形計画図(トポロジカル層構造)として表示する。
 *
 * [2026-08-21追加] カルキョンさんの指摘「それぞれの相関位置関係の編集もグラフィカルに
 * 行えるように」「PERT図でBOXの位置を移動したり重なりを解除できるように」に対応。
 * - ノードをドラッグして自由配置できる(位置はResponsibility.graphX/Yへ保存)
 * - ノードの右端ハンドルから別ノードへドラッグすると前提関係(BLOCKS)を作成する
 * - エッジをクリックすると削除確認バルーンを表示する
 * - ノードをクリック(ドラッグでない場合)すると詳細バルーンを表示する
 *
 * [既知の制約] 表示するのはAI採用時に自動生成/手動作成されたBLOCKS関係のみ。
 * 異なるCapture間の意味的関連(FN-GR-01)はこの図には出ない。
 */
export function RelationGraphClient() {
  const router = useRouter();
  const [nodes, setNodes] = useState<GraphNode[]>([]);
  const [edges, setEdges] = useState<GraphEdge[]>([]);
  const [loading, setLoading] = useState(true);
  const [positions, setPositions] = useState<Map<string, { x: number; y: number }>>(new Map());
  const [dragState, setDragState] = useState<{ id: string; dx: number; dy: number } | null>(null);
  const [connectState, setConnectState] = useState<{ fromId: string; x: number; y: number } | null>(null);
  const [balloon, setBalloon] = useState<
    | { kind: "node"; id: string; x: number; y: number }
    | { kind: "edge"; id: string; x: number; y: number }
    | null
  >(null);
  const svgWrapRef = useRef<HTMLDivElement>(null);
  const movedRef = useRef(false);

  const load = useCallback(async () => {
    setLoading(true);
    const res = await debugFetch("/api/v1/responsibilities/graph");
    if (res.ok) {
      const body = await res.json();
      debugLog.state("RelationGraphClient", "graph", { nodeCount: body.data.nodes.length });
      setNodes(body.data.nodes);
      setEdges(body.data.edges);
    }
    setLoading(false);
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  // 自動レイアウト(層×行)を計算し、保存済みgraphX/Yがあればそちらを優先する。
  const autoLayout = useMemo(() => {
    const byLayer = new Map<number, GraphNode[]>();
    for (const n of nodes) {
      const arr = byLayer.get(n.layer) ?? [];
      arr.push(n);
      byLayer.set(n.layer, arr);
    }
    const map = new Map<string, { x: number; y: number }>();
    const maxLayer = Math.max(0, ...Array.from(byLayer.keys()));
    for (let l = 0; l <= maxLayer; l++) {
      const col = byLayer.get(l) ?? [];
      col.forEach((n, idx) => {
        map.set(n.id, {
          x: PADDING + l * (NODE_WIDTH + COL_GAP),
          y: PADDING + idx * (NODE_HEIGHT + ROW_GAP),
        });
      });
    }
    return map;
  }, [nodes]);

  useEffect(() => {
    const next = new Map<string, { x: number; y: number }>();
    for (const n of nodes) {
      if (n.graphX !== null && n.graphY !== null) {
        next.set(n.id, { x: n.graphX, y: n.graphY });
      } else {
        next.set(n.id, autoLayout.get(n.id) ?? { x: PADDING, y: PADDING });
      }
    }
    setPositions(next);
  }, [nodes, autoLayout]);

  const canvasSize = useMemo(() => {
    let maxX = 400;
    let maxY = 300;
    positions.forEach((p) => {
      maxX = Math.max(maxX, p.x + NODE_WIDTH + PADDING);
      maxY = Math.max(maxY, p.y + NODE_HEIGHT + PADDING);
    });
    return { width: maxX, height: maxY };
  }, [positions]);

  function nodeById(id: string) {
    return nodes.find((n) => n.id === id);
  }

  function getPointerPos(e: React.PointerEvent): { x: number; y: number } {
    const rect = svgWrapRef.current?.getBoundingClientRect();
    return {
      x: e.clientX - (rect?.left ?? 0) + (svgWrapRef.current?.scrollLeft ?? 0),
      y: e.clientY - (rect?.top ?? 0) + (svgWrapRef.current?.scrollTop ?? 0),
    };
  }

  function handleNodePointerDown(e: React.PointerEvent, id: string) {
    e.stopPropagation();
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
    const pos = positions.get(id);
    if (!pos) return;
    const start = getPointerPos(e);
    movedRef.current = false;
    setDragState({ id, dx: start.x - pos.x, dy: start.y - pos.y });
    setBalloon(null);
  }

  function handleHandlePointerDown(e: React.PointerEvent, id: string) {
    e.stopPropagation();
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
    const p = getPointerPos(e);
    setConnectState({ fromId: id, x: p.x, y: p.y });
    setBalloon(null);
  }

  function handlePointerMove(e: React.PointerEvent) {
    if (dragState) {
      movedRef.current = true;
      const p = getPointerPos(e);
      setPositions((prev) => {
        const next = new Map(prev);
        next.set(dragState.id, { x: p.x - dragState.dx, y: p.y - dragState.dy });
        return next;
      });
    } else if (connectState) {
      const p = getPointerPos(e);
      setConnectState((prev) => (prev ? { ...prev, x: p.x, y: p.y } : prev));
    }
  }

  async function handlePointerUp(e: React.PointerEvent) {
    if (dragState) {
      const id = dragState.id;
      const pos = positions.get(id);
      const node = nodeById(id);
      setDragState(null);
      if (pos && node && movedRef.current) {
        const res = await apiFetch(`/api/v1/responsibilities/${id}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ graphX: pos.x, graphY: pos.y, version: node.version }),
        });
        if (res.ok) {
          await load();
        }
      }
      return;
    }
    if (connectState) {
      const p = getPointerPos(e);
      const targetEntry = Array.from(positions.entries()).find(([nid, pos]) => {
        if (nid === connectState.fromId) return false;
        return p.x >= pos.x && p.x <= pos.x + NODE_WIDTH && p.y >= pos.y && p.y <= pos.y + NODE_HEIGHT;
      });
      const targetId = targetEntry?.[0];
      setConnectState(null);
      if (targetId) {
        const res = await apiFetch("/api/v1/responsibility-relations", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ fromId: connectState.fromId, toId: targetId }),
        });
        if (res.ok) {
          await load();
        } else {
          const body = await res.json().catch(() => null);
          window.alert(body?.error?.message ?? "関係の作成に失敗しました");
        }
      }
    }
  }

  function handleNodeClick(e: React.PointerEvent, id: string) {
    if (movedRef.current) return; // ドラッグ後のクリックは無視
    const p = getPointerPos(e);
    setBalloon({ kind: "node", id, x: p.x + 16, y: p.y });
  }

  function handleEdgeClick(e: React.MouseEvent, id: string) {
    e.stopPropagation();
    const rect = svgWrapRef.current?.getBoundingClientRect();
    setBalloon({
      kind: "edge",
      id,
      x: e.clientX - (rect?.left ?? 0),
      y: e.clientY - (rect?.top ?? 0),
    });
  }

  async function deleteEdge(id: string) {
    const res = await apiFetch(`/api/v1/responsibility-relations/${id}`, { method: "DELETE" });
    if (res.ok) {
      setBalloon(null);
      await load();
    }
  }

  const balloonNode = balloon?.kind === "node" ? nodeById(balloon.id) : null;

  return (
    <div className="space-y-6">
      <div>
        <p className="text-xs text-faint font-mono mb-1">今後</p>
        <h1 className="font-serif text-3xl">関係図</h1>
        <p className="text-sm text-muted mt-1">
          ノードはドラッグして自由に配置できます。ノード右端の◯から別ノードへドラッグすると前提関係を作成、矢印線をクリックすると削除できます。
        </p>
      </div>

      {loading ? (
        <p className="text-sm text-faint">読み込み中...</p>
      ) : nodes.length === 0 ? (
        <div className="bg-surface border border-line rounded-2xl shadow-card p-8 text-center">
          <p className="text-sm text-muted">
            前提関係が設定されている責任がまだありません。ノード右端の◯から別ノードへドラッグすると、ここで関係を作成できます。
          </p>
        </div>
      ) : (
        <div
          ref={svgWrapRef}
          className="relative bg-surface border border-line rounded-2xl shadow-card overflow-auto"
          style={{ maxHeight: "70vh" }}
          onPointerMove={handlePointerMove}
          onPointerUp={handlePointerUp}
          onClick={() => setBalloon(null)}
        >
          <div style={{ position: "relative", width: canvasSize.width, height: canvasSize.height }}>
            <svg width={canvasSize.width} height={canvasSize.height} className="absolute inset-0">
              <defs>
                <marker id="arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
                  <path d="M0,0 L10,5 L0,10 z" fill="#9ca3af" />
                </marker>
              </defs>
              {edges.map((e) => {
                const from = positions.get(e.fromId);
                const to = positions.get(e.toId);
                if (!from || !to) return null;
                const x1 = from.x + NODE_WIDTH;
                const y1 = from.y + NODE_HEIGHT / 2;
                const x2 = to.x;
                const y2 = to.y + NODE_HEIGHT / 2;
                const midX = (x1 + x2) / 2;
                return (
                  <path
                    key={e.id}
                    d={`M ${x1} ${y1} C ${midX} ${y1}, ${midX} ${y2}, ${x2} ${y2}`}
                    fill="none"
                    stroke="#9ca3af"
                    strokeWidth={2}
                    markerEnd="url(#arrow)"
                    style={{ cursor: "pointer", pointerEvents: "stroke" }}
                    onClick={(ev) => handleEdgeClick(ev, e.id)}
                  />
                );
              })}
              {connectState && positions.get(connectState.fromId) && (
                <line
                  x1={positions.get(connectState.fromId)!.x + NODE_WIDTH}
                  y1={positions.get(connectState.fromId)!.y + NODE_HEIGHT / 2}
                  x2={connectState.x}
                  y2={connectState.y}
                  stroke="#1f6f68"
                  strokeWidth={2}
                  strokeDasharray="4 3"
                />
              )}
            </svg>

            {nodes.map((n) => {
              const pos = positions.get(n.id);
              if (!pos) return null;
              return (
                <div
                  key={n.id}
                  style={{ position: "absolute", left: pos.x, top: pos.y, width: NODE_WIDTH, height: NODE_HEIGHT }}
                  className="rounded-lg bg-surface border-2 border-line shadow-sm select-none"
                  onPointerDown={(e) => handleNodePointerDown(e, n.id)}
                  onPointerUp={(e) => handleNodeClick(e, n.id)}
                >
                  <div
                    className="w-full h-full rounded-md px-3 py-1.5 cursor-grab active:cursor-grabbing"
                    style={{ borderLeft: `5px solid ${STATUS_COLOR[n.status] ?? "#9ca3af"}` }}
                  >
                    <p className="text-[11.5px] font-semibold text-ink leading-tight line-clamp-2">{n.title}</p>
                    <p className="text-[10px] text-muted mt-0.5">
                      {n.status === "IN_PROGRESS" ? "実行中" : n.status === "COMPLETED" ? "完了" : "未整理"}
                      {n.importance ? ` ・重要度${n.importance}` : ""}
                    </p>
                  </div>
                  {/* 関係作成用ハンドル(右端の丸)。ここからドラッグすると別ノードへの前提関係を作れる。 */}
                  <div
                    onPointerDown={(e) => handleHandlePointerDown(e, n.id)}
                    title="ドラッグして別のタスクへの前提関係を作成"
                    className="absolute -right-2 top-1/2 -translate-y-1/2 w-4 h-4 rounded-full bg-brand border-2 border-white shadow cursor-crosshair"
                  />
                </div>
              );
            })}

            {balloon?.kind === "node" && balloonNode && (
              <div
                className="absolute z-20 w-64 bg-ink text-white rounded-xl p-3.5 shadow-xl text-xs"
                style={{ left: balloon.x, top: balloon.y }}
                onClick={(e) => e.stopPropagation()}
              >
                <p className="text-[10px] uppercase tracking-wide text-brand-100 font-bold">
                  {balloonNode.status === "IN_PROGRESS" ? "実行中" : balloonNode.status === "COMPLETED" ? "完了" : "未整理"}
                </p>
                <p className="text-sm font-semibold mt-1 mb-2 leading-snug">{balloonNode.title}</p>
                {balloonNode.importance && (
                  <p className="text-[10.5px] text-white/70 mb-1">重要度: {balloonNode.importance}/5</p>
                )}
                {balloonNode.hardDeadlineAt && (
                  <p className="text-[10.5px] text-white/70 mb-2">
                    締切: {new Date(balloonNode.hardDeadlineAt).toLocaleDateString("ja-JP")}
                  </p>
                )}
                <div className="flex gap-1.5 mt-2">
                  <button
                    onClick={() => router.push(`/responsibilities?focus=${balloonNode.id}`)}
                    className="flex-1 bg-white text-ink text-[10.5px] font-semibold rounded-lg px-2 py-1.5"
                  >
                    詳細を編集
                  </button>
                  <button
                    onClick={() => setBalloon(null)}
                    className="bg-white/15 text-white text-[10.5px] font-semibold rounded-lg px-2 py-1.5"
                  >
                    閉じる
                  </button>
                </div>
              </div>
            )}

            {balloon?.kind === "edge" && (
              <div
                className="absolute z-20 bg-ink text-white rounded-xl p-3 shadow-xl text-xs"
                style={{ left: balloon.x, top: balloon.y }}
                onClick={(e) => e.stopPropagation()}
              >
                <p className="mb-2">この前提関係を削除しますか？</p>
                <div className="flex gap-1.5">
                  <button
                    onClick={() => deleteEdge(balloon.id)}
                    className="flex-1 bg-red-500 text-white text-[10.5px] font-semibold rounded-lg px-2 py-1.5"
                  >
                    削除する
                  </button>
                  <button
                    onClick={() => setBalloon(null)}
                    className="bg-white/15 text-white text-[10.5px] font-semibold rounded-lg px-2 py-1.5"
                  >
                    キャンセル
                  </button>
                </div>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
