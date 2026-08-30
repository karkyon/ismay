"use client";

import { useCallback, useEffect, useMemo, useRef, useState, startTransition } from "react";
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
  originCaptureId: string | null;
  external: boolean;
}

interface GraphEdge {
  id: string;
  fromId: string;
  toId: string;
  relationType: string;
}

interface OriginCaptureRef {
  id: string;
  sourceType: string;
  aiSummary: string | null;
  rawText: string | null;
  createdAt: string;
}

interface ResponsibilityListItem {
  id: string;
  title: string;
  status: string;
  originCaptureId: string | null;
  originCapture: OriginCaptureRef | null;
}

interface CaptureGroup {
  captureId: string;
  capture: OriginCaptureRef;
  responsibilityIds: string[];
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

const SOURCE_TYPE_LABEL_SHORT: Record<string, string> = {
  TEXT: "テキスト",
  VOICE: "音声",
  MEETING: "会議",
  IMPORT: "取込",
  IMAGE: "画像",
};

function captureLabel(c: OriginCaptureRef): string {
  return c.aiSummary || c.rawText?.slice(0, 24) || SOURCE_TYPE_LABEL_SHORT[c.sourceType] || "メモ";
}

export function RelationGraphClient() {
  const router = useRouter();
  const [allResponsibilities, setAllResponsibilities] = useState<ResponsibilityListItem[]>([]);
  const [selectedCaptureId, setSelectedCaptureId] = useState<string | null>(null);
  const [extraNodeIds, setExtraNodeIds] = useState<string[]>([]);
  const [nodes, setNodes] = useState<GraphNode[]>([]);
  const [edges, setEdges] = useState<GraphEdge[]>([]);
  const [loadingGroups, setLoadingGroups] = useState(true);
  const [loadingGraph, setLoadingGraph] = useState(true);
  const [positions, setPositions] = useState<Map<string, { x: number; y: number }>>(new Map());
  const [dragState, setDragState] = useState<{ id: string; dx: number; dy: number } | null>(null);
  const [connectState, setConnectState] = useState<{ fromId: string; x: number; y: number } | null>(null);
  const [balloon, setBalloon] = useState<
    | { kind: "node"; id: string; x: number; y: number }
    | { kind: "edge"; id: string; x: number; y: number }
    | null
  >(null);
  const [addMenuOpen, setAddMenuOpen] = useState(false);
  const [editingCapture, setEditingCapture] = useState(false);
  const [captureTitleDraft, setCaptureTitleDraft] = useState("");
  const [captureTitleSaving, setCaptureTitleSaving] = useState(false);
  const svgWrapRef = useRef<HTMLDivElement>(null);
  const movedRef = useRef(false);

  const loadGroups = useCallback(async () => {
    setLoadingGroups(true);
    const res = await debugFetch("/api/v1/responsibilities?limit=200&status=PLANNED,IN_PROGRESS,INBOX,DEFERRED");
    if (res.ok) {
      const body = await res.json();
      setAllResponsibilities(body.data.responsibilities);
    }
    setLoadingGroups(false);
  }, []);

  const loadGraph = useCallback(async (captureId: string | null) => {
    setLoadingGraph(true);
    const qs = captureId ? `?captureId=${captureId}` : "";
    const res = await debugFetch(`/api/v1/responsibilities/graph${qs}`);
    if (res.ok) {
      const body = await res.json();
      debugLog.state("RelationGraphClient", "graph", { nodeCount: body.data.nodes.length, captureId });
      setNodes(body.data.nodes);
      setEdges(body.data.edges);
    }
    setLoadingGraph(false);
  }, []);

  // [Gate Q0是正] react-hooks/set-state-in-effect対応(既存パターンを踏襲)。
  useEffect(() => {
    startTransition(() => {
      loadGroups();
    });
  }, [loadGroups]);

  // [Gate Q0是正] react-hooks/set-state-in-effect対応(既存パターンを踏襲)。
  useEffect(() => {
    startTransition(() => {
      setExtraNodeIds([]);
      loadGraph(selectedCaptureId);
    });
  }, [selectedCaptureId, loadGraph]);

  const [extraNodes, setExtraNodes] = useState<GraphNode[]>([]);
  useEffect(() => {
    if (extraNodeIds.length === 0) {
      // [Gate Q0是正] react-hooks/set-state-in-effect対応。フラグされた同期setStateだけを
      // 最小範囲でstartTransitionへ包む(この分岐にcleanup returnは無い)。
      startTransition(() => {
        setExtraNodes([]);
      });
      return;
    }
    (async () => {
      const res = await debugFetch(`/api/v1/responsibilities/graph`);
      if (!res.ok) return;
      const body = await res.json();
      const fromGlobal = new Map<string, GraphNode>((body.data.nodes as GraphNode[]).map((n) => [n.id, n]));
      const built: GraphNode[] = extraNodeIds.map((id) => {
        const g = fromGlobal.get(id);
        if (g) return { ...g, external: true };
        const r = allResponsibilities.find((x) => x.id === id);
        return {
          id,
          title: r?.title ?? "(不明)",
          type: "TASK",
          status: r?.status ?? "PLANNED",
          importance: null,
          hardDeadlineAt: null,
          layer: 0,
          graphX: null,
          graphY: null,
          version: 0,
          originCaptureId: r?.originCaptureId ?? null,
          external: true,
        };
      });
      setExtraNodes(built);
    })();
  }, [extraNodeIds, allResponsibilities]);

  const displayNodes = useMemo(() => {
    const ids = new Set(nodes.map((n) => n.id));
    return [...nodes, ...extraNodes.filter((n) => !ids.has(n.id))];
  }, [nodes, extraNodes]);

  const captureGroups = useMemo(() => {
    const map = new Map<string, CaptureGroup>();
    for (const r of allResponsibilities) {
      if (!r.originCaptureId || !r.originCapture) continue;
      const existing = map.get(r.originCaptureId);
      if (existing) {
        existing.responsibilityIds.push(r.id);
      } else {
        map.set(r.originCaptureId, { captureId: r.originCaptureId, capture: r.originCapture, responsibilityIds: [r.id] });
      }
    }
    return Array.from(map.values()).sort(
      (a, b) => new Date(b.capture.createdAt).getTime() - new Date(a.capture.createdAt).getTime(),
    );
  }, [allResponsibilities]);

  const selectedCapture = captureGroups.find((g) => g.captureId === selectedCaptureId)?.capture ?? null;

  const addableGroups = useMemo(() => {
    const shownIds = new Set(displayNodes.map((n) => n.id));
    const map = new Map<string, { capture: OriginCaptureRef; items: ResponsibilityListItem[] }>();
    for (const r of allResponsibilities) {
      if (shownIds.has(r.id)) continue;
      const key = r.originCaptureId ?? "__none__";
      const capture = r.originCapture ?? { id: "__none__", sourceType: "TEXT", aiSummary: "手動作成", rawText: null, createdAt: new Date().toISOString() };
      const existing = map.get(key);
      if (existing) {
        existing.items.push(r);
      } else {
        map.set(key, { capture, items: [r] });
      }
    }
    return Array.from(map.values()).sort(
      (a, b) => new Date(b.capture.createdAt).getTime() - new Date(a.capture.createdAt).getTime(),
    );
  }, [allResponsibilities, displayNodes]);

  const autoLayout = useMemo(() => {
    const byLayer = new Map<number, GraphNode[]>();
    for (const n of displayNodes) {
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
  }, [displayNodes]);

  // [Gate Q0是正] react-hooks/set-state-in-effect対応(既存パターンを踏襲)。
  useEffect(() => {
    const next = new Map<string, { x: number; y: number }>();
    for (const n of displayNodes) {
      if (n.graphX !== null && n.graphY !== null) {
        next.set(n.id, { x: n.graphX, y: n.graphY });
      } else {
        next.set(n.id, autoLayout.get(n.id) ?? { x: PADDING, y: PADDING });
      }
    }
    startTransition(() => {
      setPositions(next);
    });
  }, [displayNodes, autoLayout]);

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
    return displayNodes.find((n) => n.id === id);
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
          await loadGraph(selectedCaptureId);
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
          await loadGraph(selectedCaptureId);
        } else {
          const body = await res.json().catch(() => null);
          window.alert(body?.error?.message ?? "関係の作成に失敗しました");
        }
      }
    }
  }

  function handleNodeClick(e: React.PointerEvent, id: string) {
    if (movedRef.current) return;
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
      await loadGraph(selectedCaptureId);
    }
  }

  async function saveCaptureTitle() {
    if (!selectedCapture || !selectedCaptureId) return;
    setCaptureTitleSaving(true);
    try {
      const cur = await debugFetch(`/api/v1/captures/${selectedCaptureId}`);
      if (!cur.ok) throw new Error("version取得に失敗");
      const curBody = await cur.json();
      const res = await apiFetch(`/api/v1/captures/${selectedCaptureId}`, {
        method: "PATCH",
        body: JSON.stringify({ aiSummary: captureTitleDraft.trim() || null, version: curBody.data.capture.version }),
      });
      if (res.ok) {
        setEditingCapture(false);
        await loadGroups();
      } else {
        const body = await res.json().catch(() => null);
        window.alert(body?.error?.message ?? "保存に失敗しました");
      }
    } catch {
      window.alert("通信に失敗しました");
    } finally {
      setCaptureTitleSaving(false);
    }
  }

  const balloonNode = balloon?.kind === "node" ? nodeById(balloon.id) : null;

  return (
    <div className="space-y-6">
      <div>
        <p className="text-xs text-faint font-mono mb-1">今後</p>
        <h1 className="font-serif text-3xl">関係図</h1>
        <p className="text-sm text-muted mt-1">
          左のメモ単位で切り替えて表示します。ノードはドラッグして自由に配置、右端の◯から別ノードへドラッグすると前提関係を作成できます。
        </p>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-4 gap-5">
        <div className="lg:col-span-1 space-y-1">
          <button
            onClick={() => setSelectedCaptureId(null)}
            className={`w-full text-left px-3 py-2 rounded-lg text-sm transition ${
              selectedCaptureId === null ? "bg-brand-50 text-brand-700 font-semibold" : "hover:bg-canvas text-ink"
            }`}
          >
            すべて(全体俯瞰)
          </button>
          {loadingGroups ? (
            <p className="text-xs text-faint px-3 py-2">読み込み中...</p>
          ) : captureGroups.length === 0 ? (
            <p className="text-xs text-faint px-3 py-2">メモから生成された責任がまだありません。</p>
          ) : (
            captureGroups.map((g) => (
              <button
                key={g.captureId}
                onClick={() => setSelectedCaptureId(g.captureId)}
                className={`w-full text-left px-3 py-2 rounded-lg transition ${
                  selectedCaptureId === g.captureId ? "bg-brand-50 text-brand-700" : "hover:bg-canvas text-ink"
                }`}
              >
                <p className="text-xs font-medium line-clamp-2 leading-snug">{captureLabel(g.capture)}</p>
                <p className="text-[10px] text-faint mt-0.5">
                  {SOURCE_TYPE_LABEL_SHORT[g.capture.sourceType] ?? g.capture.sourceType} ・{" "}
                  {new Date(g.capture.createdAt).toLocaleDateString("ja-JP", { month: "short", day: "numeric" })} ・{" "}
                  {g.responsibilityIds.length}件
                </p>
              </button>
            ))
          )}
        </div>

        <div className="lg:col-span-3 space-y-3">
          {selectedCapture && (
            <div className="bg-surface border border-line rounded-xl px-4 py-3">
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0 flex-1">
                  <p className="text-[10px] text-faint font-mono uppercase tracking-wide">
                    {SOURCE_TYPE_LABEL_SHORT[selectedCapture.sourceType] ?? selectedCapture.sourceType} ・{" "}
                    {new Date(selectedCapture.createdAt).toLocaleString("ja-JP")}
                  </p>
                  {editingCapture ? (
                    <div className="mt-1 space-y-1.5">
                      <input
                        type="text"
                        value={captureTitleDraft}
                        onChange={(e) => setCaptureTitleDraft(e.target.value)}
                        maxLength={120}
                        autoFocus
                        className="w-full text-sm border border-line rounded-md px-2 py-1.5 focus:outline-none focus:border-brand"
                      />
                      <div className="flex gap-1.5">
                        <button
                          onClick={saveCaptureTitle}
                          disabled={captureTitleSaving}
                          className="text-[11px] bg-ink text-white rounded-md px-2.5 py-1 disabled:opacity-50"
                        >
                          {captureTitleSaving ? "保存中..." : "保存"}
                        </button>
                        <button
                          onClick={() => setEditingCapture(false)}
                          className="text-[11px] border border-line rounded-md px-2.5 py-1"
                        >
                          キャンセル
                        </button>
                      </div>
                    </div>
                  ) : (
                    <p className="text-sm font-medium text-ink mt-0.5">{captureLabel(selectedCapture)}</p>
                  )}
                </div>
                <div className="flex gap-1.5 shrink-0">
                  {!editingCapture && (
                    <button
                      onClick={() => {
                        setCaptureTitleDraft(selectedCapture.aiSummary ?? "");
                        setEditingCapture(true);
                      }}
                      className="text-[11px] border border-line rounded-lg px-2.5 py-1.5 hover:bg-canvas"
                    >
                      タイトル編集
                    </button>
                  )}
                  <button
                    onClick={() => router.push(`/inbox?focus=${selectedCapture.id}`)}
                    className="text-[11px] border border-line rounded-lg px-2.5 py-1.5 hover:bg-canvas"
                  >
                    元メモを開く
                  </button>
                </div>
              </div>
            </div>
          )}

          {loadingGraph ? (
            <p className="text-sm text-faint">読み込み中...</p>
          ) : displayNodes.length === 0 ? (
            <div className="bg-surface border border-line rounded-2xl shadow-card p-8 text-center">
              <p className="text-sm text-muted mb-3">
                {selectedCaptureId ? "このメモから生成された責任がまだありません。" : "前提関係が設定されている責任がまだありません。"}
              </p>
              <button onClick={() => setAddMenuOpen(true)} className="text-xs bg-ink text-white rounded-lg px-3 py-1.5">
                + タスクを追加
              </button>
            </div>
          ) : (
            <div
              ref={svgWrapRef}
              className="relative bg-surface border border-line rounded-2xl shadow-card overflow-auto"
              style={{ maxHeight: "65vh" }}
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

                {displayNodes.map((n) => {
                  const pos = positions.get(n.id);
                  if (!pos) return null;
                  return (
                    <div
                      key={n.id}
                      style={{ position: "absolute", left: pos.x, top: pos.y, width: NODE_WIDTH, height: NODE_HEIGHT }}
                      className={`rounded-lg bg-surface border-2 shadow-sm select-none ${n.external ? "border-dashed border-ai" : "border-line"}`}
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
                          {n.external ? " ・他メモ" : ""}
                        </p>
                      </div>
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

          {displayNodes.length > 0 && (
            <div className="flex justify-end">
              <button
                onClick={() => setAddMenuOpen(true)}
                className="text-xs bg-ink text-white rounded-full px-4 py-2 shadow-lg hover:bg-black"
              >
                + タスクを追加
              </button>
            </div>
          )}
        </div>
      </div>

      {addMenuOpen && (
        <div className="fixed inset-0 z-40 bg-black/30 flex items-center justify-center p-6" onClick={() => setAddMenuOpen(false)}>
          <div
            className="bg-surface rounded-2xl shadow-2xl w-full max-w-lg max-h-[75vh] flex flex-col p-5"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between mb-3 shrink-0">
              <p className="text-sm font-semibold text-ink">タスクを追加</p>
              <button onClick={() => setAddMenuOpen(false)} className="text-xs border border-line rounded-lg px-3 py-1.5 hover:bg-canvas">
                閉じる ✕
              </button>
            </div>
            <p className="text-[11px] text-faint mb-3">
              現在このグラフに表示されていないタスクを、元メモごとに一覧しています。クリックで追加すると、右端の◯からドラッグして関係を作成できます。
            </p>
            <div className="flex-1 min-h-0 overflow-y-auto space-y-4">
              {addableGroups.length === 0 && <p className="text-xs text-faint">追加できるタスクはありません。</p>}
              {addableGroups.map((g) => (
                <div key={g.capture.id}>
                  <p className="text-[10px] text-faint font-mono uppercase tracking-wide mb-1">{captureLabel(g.capture)}</p>
                  <div className="space-y-1">
                    {g.items.map((item) => (
                      <button
                        key={item.id}
                        onClick={() => {
                          setExtraNodeIds((prev) => Array.from(new Set([...prev, item.id])));
                          setAddMenuOpen(false);
                        }}
                        className="w-full text-left text-xs px-2.5 py-1.5 rounded-lg border border-line hover:bg-canvas"
                      >
                        {item.title}
                      </button>
                    ))}
                  </div>
                </div>
              ))}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
