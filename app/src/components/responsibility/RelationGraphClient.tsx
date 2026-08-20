"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { debugFetch } from "@/lib/auth/client";
import { debugLog } from "@/lib/debug";

interface GraphNode {
  id: string;
  title: string;
  type: string;
  status: string;
  importance: number | null;
  hardDeadlineAt: string | null;
  layer: number;
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
 * /relations: 責任間のBLOCKS依存関係を線形計画図(左→右の層構造)として表示する。
 * 2026-08-20新設。カルキョンさんの指摘「前後関係・親子関係・線形計画図・
 * チャート・スケジューリングが一切できていない」に対応した第一段階。
 *
 * [既知の制約・正直な適用範囲]
 * - 表示するのはAI採用時に自動生成された同一Capture内BLOCKS関係のみ
 *   (FN-GR-01の異なるCapture間の意味的関連は、まだResponsibilityRelationとして
 *   確定されていないため、この図には出ない。「今後」画面の詳細で個別に確認する形)
 * - ガントチャートのような日付軸でのスケジューリング表示ではなく、
 *   前提条件の順序(トポロジカル層)のみを表す図
 */
export function RelationGraphClient() {
  const router = useRouter();
  const [nodes, setNodes] = useState<GraphNode[]>([]);
  const [edges, setEdges] = useState<GraphEdge[]>([]);
  const [loading, setLoading] = useState(true);
  const [hoveredId, setHoveredId] = useState<string | null>(null);

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

  const layout = useMemo(() => {
    const byLayer = new Map<number, GraphNode[]>();
    for (const n of nodes) {
      const arr = byLayer.get(n.layer) ?? [];
      arr.push(n);
      byLayer.set(n.layer, arr);
    }
    const positions = new Map<string, { x: number; y: number }>();
    const maxLayer = Math.max(0, ...Array.from(byLayer.keys()));
    let maxRows = 0;
    for (let l = 0; l <= maxLayer; l++) {
      const col = byLayer.get(l) ?? [];
      maxRows = Math.max(maxRows, col.length);
      col.forEach((n, idx) => {
        positions.set(n.id, {
          x: PADDING + l * (NODE_WIDTH + COL_GAP),
          y: PADDING + idx * (NODE_HEIGHT + ROW_GAP),
        });
      });
    }
    const width = PADDING * 2 + (maxLayer + 1) * NODE_WIDTH + maxLayer * COL_GAP;
    const height = PADDING * 2 + Math.max(1, maxRows) * NODE_HEIGHT + Math.max(0, maxRows - 1) * ROW_GAP;
    return { positions, width, height };
  }, [nodes]);

  function truncate(text: string, max = 18): string {
    return text.length > max ? `${text.slice(0, max)}…` : text;
  }

  return (
    <div className="space-y-6">
      <div>
        <p className="text-xs text-faint font-mono mb-1">今後</p>
        <h1 className="font-serif text-3xl">関係図</h1>
        <p className="text-sm text-muted mt-1">
          「これが終わらないと次に進めない」という前提条件の順序を表示します。左から右へ、完了の前提となる責任→それに続く責任の順です。
        </p>
      </div>

      {loading ? (
        <p className="text-sm text-faint">読み込み中...</p>
      ) : nodes.length === 0 ? (
        <div className="bg-surface border border-line rounded-2xl shadow-card p-8 text-center">
          <p className="text-sm text-muted">
            前提関係が設定されている責任がまだありません。AIが同一メモ内で「これが終わらないと次に進めない」と判断した候補を採用すると、ここに表示されます。
          </p>
        </div>
      ) : (
        <div className="bg-surface border border-line rounded-2xl shadow-card p-5 overflow-auto">
          <svg width={layout.width} height={layout.height} className="min-w-full">
            <defs>
              <marker id="arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
                <path d="M0,0 L10,5 L0,10 z" fill="#9ca3af" />
              </marker>
            </defs>
            {edges.map((e) => {
              const from = layout.positions.get(e.fromId);
              const to = layout.positions.get(e.toId);
              if (!from || !to) return null;
              const x1 = from.x + NODE_WIDTH;
              const y1 = from.y + NODE_HEIGHT / 2;
              const x2 = to.x;
              const y2 = to.y + NODE_HEIGHT / 2;
              const midX = (x1 + x2) / 2;
              const highlighted = hoveredId === e.fromId || hoveredId === e.toId;
              return (
                <path
                  key={e.id}
                  d={`M ${x1} ${y1} C ${midX} ${y1}, ${midX} ${y2}, ${x2} ${y2}`}
                  fill="none"
                  stroke={highlighted ? "#4f46e5" : "#d1d5db"}
                  strokeWidth={highlighted ? 2 : 1.5}
                  markerEnd="url(#arrow)"
                />
              );
            })}
            {nodes.map((n) => {
              const pos = layout.positions.get(n.id);
              if (!pos) return null;
              const isHovered = hoveredId === n.id;
              return (
                <g
                  key={n.id}
                  transform={`translate(${pos.x}, ${pos.y})`}
                  onMouseEnter={() => setHoveredId(n.id)}
                  onMouseLeave={() => setHoveredId(null)}
                  onClick={() => router.push(`/responsibilities?focus=${n.id}`)}
                  className="cursor-pointer"
                >
                  <rect
                    width={NODE_WIDTH}
                    height={NODE_HEIGHT}
                    rx={10}
                    fill={isHovered ? "#eef2ff" : "white"}
                    stroke={STATUS_COLOR[n.status] ?? "#9ca3af"}
                    strokeWidth={isHovered ? 2 : 1.5}
                  />
                  <text x={12} y={22} fontSize={12} fontWeight={600} fill="#111827">
                    {truncate(n.title)}
                  </text>
                  <text x={12} y={40} fontSize={10} fill="#6b7280">
                    {n.status === "IN_PROGRESS" ? "実行中" : n.status === "COMPLETED" ? "完了" : "未整理"}
                    {n.importance ? ` ・重要度${n.importance}` : ""}
                  </text>
                  {n.hardDeadlineAt && (
                    <text x={12} y={54} fontSize={9} fill="#dc2626">
                      締切: {new Date(n.hardDeadlineAt).toLocaleDateString("ja-JP", { month: "short", day: "numeric" })}
                    </text>
                  )}
                </g>
              );
            })}
          </svg>
        </div>
      )}
    </div>
  );
}
