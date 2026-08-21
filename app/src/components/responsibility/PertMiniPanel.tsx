"use client";

import { useMemo, useState } from "react";

interface PertNode {
  id: string;
  title: string;
  status: string;
  type: string;
  importance: number | null;
  layer: number;
}

const NODE_W = 150;
const NODE_H = 52;
const COL_GAP = 46;
const ROW_GAP = 10;
const PAD = 12;

const STATUS_COLOR: Record<string, string> = {
  IN_PROGRESS: "#2563eb",
  PLANNED: "#6b7280",
  COMPLETED: "#16a34a",
};
const STATUS_LABEL_JA: Record<string, string> = { IN_PROGRESS: "実行中", COMPLETED: "完了" };

/**
 * [2026-08-21新設] 「今後」画面の詳細パネルに埋め込む、選択中タスクを中心とした
 * PERTミニ表示。ワイヤーフレームv2で合意した「先行・後続タスクは右側エリアで
 * 視覚的に」「ノードクリックでバルーン詳細」「Obsidianのような動的(別ノードを
 * クリックすると中心が移る)」に対応する。
 *
 * ドラッグでの自由配置・関係の作成/削除といったグラフィカル編集は、この
 * コンパクト表示ではなく専用の「関係図」ページ(/relations)で行う設計とした
 * (同じ編集操作を2箇所に実装すると事故率が上がるため、ここは閲覧・ナビゲーション
 * に徹する)。
 */
export function PertMiniPanel({
  centerId,
  nodes,
  onSelect,
}: {
  centerId: string;
  nodes: PertNode[];
  onSelect: (id: string) => void;
}) {
  const [balloonId, setBalloonId] = useState<string | null>(null);

  const layout = useMemo(() => {
    const byLayer = new Map<number, PertNode[]>();
    for (const n of nodes) {
      const arr = byLayer.get(n.layer) ?? [];
      arr.push(n);
      byLayer.set(n.layer, arr);
    }
    const layers = Array.from(byLayer.keys()).sort((a, b) => a - b);
    const positions = new Map<string, { x: number; y: number }>();
    let maxRows = 0;
    for (const l of layers) maxRows = Math.max(maxRows, (byLayer.get(l) ?? []).length);
    let x = PAD;
    for (const l of layers) {
      const col = byLayer.get(l) ?? [];
      const startY = PAD + ((maxRows - col.length) * (NODE_H + ROW_GAP)) / 2;
      col.forEach((n, i) => {
        positions.set(n.id, { x, y: startY + i * (NODE_H + ROW_GAP) });
      });
      x += NODE_W + COL_GAP;
    }
    return { positions, width: x - COL_GAP + PAD, height: PAD * 2 + maxRows * NODE_H + (maxRows - 1) * ROW_GAP };
  }, [nodes]);

  if (nodes.length <= 1) {
    return (
      <p className="text-xs text-faint px-1 py-3">
        前提・後続関係が設定されていません。「関係図」ページでドラッグして関係を作成できます。
      </p>
    );
  }

  const balloonNode = balloonId ? nodes.find((n) => n.id === balloonId) : null;
  const balloonPos = balloonId ? layout.positions.get(balloonId) : null;

  return (
    <div className="relative overflow-auto bg-canvas/40 rounded-xl border border-line" style={{ maxHeight: 260 }}>
      <div style={{ position: "relative", width: layout.width, height: Math.max(layout.height, 90) }}>
        <svg width={layout.width} height={layout.height} className="absolute inset-0">
          <defs>
            <marker id="mini-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse">
              <path d="M0,0 L10,5 L0,10 z" fill="#b3b8bf" />
            </marker>
          </defs>
          {nodes
            .filter((n) => n.layer < 0)
            .map((n) => {
              const from = layout.positions.get(n.id);
              const targetLayer = n.layer + 1;
              const target = nodes.find((t) => t.layer === targetLayer) ?? nodes.find((t) => t.layer === 0);
              const to = target ? layout.positions.get(target.id) : null;
              if (!from || !to) return null;
              const x1 = from.x + NODE_W,
                y1 = from.y + NODE_H / 2,
                x2 = to.x,
                y2 = to.y + NODE_H / 2,
                mid = (x1 + x2) / 2;
              return (
                <path
                  key={`e-${n.id}`}
                  d={`M ${x1} ${y1} C ${mid} ${y1}, ${mid} ${y2}, ${x2} ${y2}`}
                  fill="none"
                  stroke="#c7cdd4"
                  strokeWidth={1.5}
                  markerEnd="url(#mini-arrow)"
                />
              );
            })}
          {nodes
            .filter((n) => n.layer > 0)
            .map((n) => {
              const to = layout.positions.get(n.id);
              const sourceLayer = n.layer - 1;
              const source = nodes.find((t) => t.layer === sourceLayer) ?? nodes.find((t) => t.layer === 0);
              const from = source ? layout.positions.get(source.id) : null;
              if (!from || !to) return null;
              const x1 = from.x + NODE_W,
                y1 = from.y + NODE_H / 2,
                x2 = to.x,
                y2 = to.y + NODE_H / 2,
                mid = (x1 + x2) / 2;
              return (
                <path
                  key={`e2-${n.id}`}
                  d={`M ${x1} ${y1} C ${mid} ${y1}, ${mid} ${y2}, ${x2} ${y2}`}
                  fill="none"
                  stroke="#c7cdd4"
                  strokeWidth={1.5}
                  markerEnd="url(#mini-arrow)"
                />
              );
            })}
        </svg>

        {nodes.map((n) => {
          const pos = layout.positions.get(n.id);
          if (!pos) return null;
          const isCenter = n.id === centerId;
          return (
            <div
              key={n.id}
              onClick={() => setBalloonId(n.id)}
              style={{ position: "absolute", left: pos.x, top: pos.y, width: NODE_W, height: NODE_H }}
              className={`rounded-md bg-surface border shadow-sm cursor-pointer px-2 py-1 ${isCenter ? "border-brand ring-1 ring-brand" : "border-line"}`}
            >
              <div className="flex items-start gap-1.5 h-full">
                <span
                  className="w-1 self-stretch rounded-full shrink-0"
                  style={{ background: STATUS_COLOR[n.status] ?? "#9ca3af" }}
                />
                <div className="min-w-0">
                  <p className="text-[10.5px] font-semibold text-ink leading-tight line-clamp-2">{n.title}</p>
                  <p className="text-[9px] text-faint mt-0.5">{STATUS_LABEL_JA[n.status] ?? "未整理"}</p>
                </div>
              </div>
            </div>
          );
        })}

        {balloonNode && balloonPos && (
          <div
            className="absolute z-20 w-56 bg-ink text-white rounded-xl p-3 shadow-xl text-xs"
            style={{ left: balloonPos.x, top: balloonPos.y + NODE_H + 6 }}
          >
            <p className="text-sm font-semibold mb-1.5 leading-snug">{balloonNode.title}</p>
            {balloonNode.importance && <p className="text-[10.5px] text-white/70 mb-2">重要度: {balloonNode.importance}/5</p>}
            <div className="flex gap-1.5">
              {balloonNode.id !== centerId && (
                <button
                  onClick={() => {
                    onSelect(balloonNode.id);
                    setBalloonId(null);
                  }}
                  className="flex-1 bg-white text-ink text-[10.5px] font-semibold rounded-lg px-2 py-1.5"
                >
                  これを中心に表示
                </button>
              )}
              <button
                onClick={() => setBalloonId(null)}
                className="bg-white/15 text-white text-[10.5px] font-semibold rounded-lg px-2 py-1.5"
              >
                閉じる
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
