"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { isTypingTarget } from "@/lib/keyboard";
import { apiFetch, debugFetch } from "@/lib/auth/client";
import { debugLog } from "@/lib/debug";
import { formatRelativeTime } from "@/lib/format";
import { QuickCaptureForm } from "@/components/capture/QuickCaptureForm";

interface CaptureListItem {
  id: string;
  sourceType: string;
  rawText: string | null;
  processingStatus: string;
  domainId: string | null;
  sourceCapturedAt: string | null;
  version: number;
  createdAt: string;
}

interface CaptureDetail extends CaptureListItem {
  audioObjectKey: string | null;
  consentId: string | null;
  updatedAt: string;
}

interface InferenceItem {
  id: string;
  inferenceType: string;
  confidence: string;
  decision: string;
  createdAt: string;
}

const STATUS_LABEL: Record<string, string> = {
  SAVED: "保存済み",
  QUEUED: "解析待ち",
  PROCESSING: "解析中",
  READY: "候補あり",
  FAILED: "解析失敗",
};

const STATUS_BADGE_STYLE: Record<string, string> = {
  SAVED: "bg-canvas text-muted",
  QUEUED: "bg-decide-50 text-decide",
  PROCESSING: "bg-ai-50 text-ai",
  READY: "bg-safe-50 text-safe",
  FAILED: "bg-warn-50 text-warn",
};

const STATUS_DOT_STYLE: Record<string, string> = {
  SAVED: "bg-faint",
  QUEUED: "bg-decide",
  PROCESSING: "bg-ai",
  READY: "bg-safe",
  FAILED: "bg-warn",
};

const SOURCE_TYPE_LABEL: Record<string, string> = {
  TEXT: "テキスト",
  VOICE: "音声",
  MEETING: "会議",
  IMPORT: "取込",
};

// TickTick/Craftのパステルカラーブロックを参考に、種類ごとに淡色を割り当てる。
// 新しい色を増やさず既存デザイントークン(brand/ai/decide/safe)を再利用する。
const SOURCE_TYPE_CHIP_STYLE: Record<string, string> = {
  TEXT: "bg-brand-50 text-brand-700",
  VOICE: "bg-ai-50 text-ai",
  MEETING: "bg-decide-50 text-decide",
  IMPORT: "bg-safe-50 text-safe",
};

const SOURCE_TYPE_ORDER = ["TEXT", "VOICE", "MEETING", "IMPORT"] as const;

/**
 * UI-04 Inbox: 原文から責任候補を確認する画面(API-CAP-01〜04と接続)。
 *
 * デザイン方針(2026-08-18改訂):
 * - 一覧(左)と詳細(右)は明確に異なる表現に分離(行 vs 開いている文書)。
 * - TickTickのピル型ビュー切替タブ・Craftのパステルカラーブロックを参考に、
 *   種類フィルターのピルタブと種類別カラーチップを追加(2026-08-18再改訂)。
 *   カレンダー/カンバン等のビュー自体は転用していない
 *   (Responsibility/Planning API未実装のため、動かないタブになるのを避けた)。
 */
export function InboxClient() {
  const [captures, setCaptures] = useState<CaptureListItem[]>([]);
  const [loadingList, setLoadingList] = useState(true);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [detail, setDetail] = useState<CaptureDetail | null>(null);
  const [inferences, setInferences] = useState<InferenceItem[]>([]);
  const [loadingDetail, setLoadingDetail] = useState(false);
  const [analyzing, setAnalyzing] = useState(false);
  const [error, setError] = useState("");
  const [filterType, setFilterType] = useState<string | null>(null);

  const loadList = useCallback(async () => {
    setLoadingList(true);
    const res = await debugFetch("/api/v1/captures");
    if (res.ok) {
      const body = await res.json();
      const items: CaptureListItem[] = body.data.captures;
      debugLog.state("InboxClient", "captures", { count: items.length });
      setCaptures(items);
      setSelectedId((current) => current ?? items[0]?.id ?? null);
    }
    setLoadingList(false);
  }, []);

  const loadDetail = useCallback(async (id: string) => {
    setLoadingDetail(true);
    setError("");
    const [detailRes, inferRes] = await Promise.all([
      debugFetch(`/api/v1/captures/${id}`),
      debugFetch(`/api/v1/captures/${id}/inferences`),
    ]);
    if (detailRes.ok) {
      const body = await detailRes.json();
      setDetail(body.data.capture);
    }
    if (inferRes.ok) {
      const body = await inferRes.json();
      setInferences(body.data.inferences);
    }
    setLoadingDetail(false);
  }, []);

  useEffect(() => {
    loadList();
  }, [loadList]);

  useEffect(() => {
    if (selectedId) loadDetail(selectedId);
  }, [selectedId, loadDetail]);

  function selectCapture(id: string) {
    debugLog.event("InboxClient", "select capture", { id });
    setSelectedId(id);
  }

  // 存在する種類のみ動的にタブ表示する(TickTick風ピルタブのデザイン言語を
  // 転用。件数はGmailのラベル数のような形で添える)。
  const typeCounts = useMemo(() => {
    const counts: Record<string, number> = {};
    for (const c of captures) counts[c.sourceType] = (counts[c.sourceType] ?? 0) + 1;
    return counts;
  }, [captures]);

  const availableTypes = SOURCE_TYPE_ORDER.filter((t) => (typeCounts[t] ?? 0) > 0);

  const visibleCaptures = useMemo(
    () => (filterType ? captures.filter((c) => c.sourceType === filterType) : captures),
    [captures, filterType],
  );

  function selectFilter(type: string | null) {
    debugLog.event("InboxClient", "filter type changed", { type });
    setFilterType(type);
    setSelectedId(visibleCapturesAfterFilter(type)[0]?.id ?? null);
  }

  function visibleCapturesAfterFilter(type: string | null) {
    return type ? captures.filter((c) => c.sourceType === type) : captures;
  }

  // Superhumanの一覧移動(J/K・矢印キー)を踏襲。テキスト入力中は発火しない。
  // フィルター適用後の一覧(visibleCaptures)を対象に移動する。
  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if (isTypingTarget(e.target)) return;
      if (visibleCaptures.length === 0) return;
      const key = e.key.toLowerCase();
      const isDown = key === "j" || e.key === "ArrowDown";
      const isUp = key === "k" || e.key === "ArrowUp";
      if (!isDown && !isUp) return;
      e.preventDefault();
      const idx = visibleCaptures.findIndex((c) => c.id === selectedId);
      const nextIdx = isDown
        ? Math.min(idx < 0 ? 0 : idx + 1, visibleCaptures.length - 1)
        : Math.max(idx < 0 ? 0 : idx - 1, 0);
      const next = visibleCaptures[nextIdx];
      if (next) selectCapture(next.id);
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visibleCaptures, selectedId]);

  async function requestAnalyze() {
    if (!selectedId) return;
    debugLog.event("InboxClient", "request analyze", { id: selectedId });
    setAnalyzing(true);
    setError("");
    try {
      const res = await apiFetch(`/api/v1/captures/${selectedId}/analyze`, { method: "POST" });
      const body = await res.json();
      if (!res.ok) {
        setError(body.error?.message ?? "解析要求に失敗しました");
        return;
      }
      await Promise.all([loadDetail(selectedId), loadList()]);
    } finally {
      setAnalyzing(false);
    }
  }

  return (
    <div>
      <div className="mb-6">
        <h1 className="font-serif text-3xl">Inbox</h1>
        <p className="text-sm text-muted mt-1">原文を書き留め、責任として整理する前段の置き場です</p>
      </div>

      <div className="mb-6">
        <QuickCaptureForm onCreated={loadList} />
      </div>

      {!loadingList && captures.length === 0 ? (
        <div className="bg-surface border border-line rounded-2xl p-10 text-center">
          <p className="text-sm text-muted">まだ何も書き留めていません。</p>
          <p className="text-sm text-muted mt-1">上の入力欄から最初のメモを保存してみてください。</p>
        </div>
      ) : (
        <div className="grid grid-cols-1 lg:grid-cols-5 gap-5 items-start">
          <div className="lg:col-span-2 space-y-3">
            {availableTypes.length > 1 && (
              <div className="flex flex-wrap gap-1.5">
                <button
                  onClick={() => selectFilter(null)}
                  className={`text-xs px-3 py-1.5 rounded-full font-medium transition ${
                    filterType === null
                      ? "bg-ink text-white"
                      : "bg-surface border border-line text-muted hover:bg-canvas"
                  }`}
                >
                  すべて <span className="opacity-60">{captures.length}</span>
                </button>
                {availableTypes.map((type) => (
                  <button
                    key={type}
                    onClick={() => selectFilter(type)}
                    className={`text-xs px-3 py-1.5 rounded-full font-medium transition ${
                      filterType === type
                        ? "bg-ink text-white"
                        : `${SOURCE_TYPE_CHIP_STYLE[type] ?? "bg-canvas text-muted"} hover:opacity-80`
                    }`}
                  >
                    {SOURCE_TYPE_LABEL[type] ?? type} <span className="opacity-60">{typeCounts[type]}</span>
                  </button>
                ))}
              </div>
            )}

            <div className="space-y-1">
              {loadingList &&
                [0, 1, 2].map((i) => (
                  <div key={i} className="px-3 py-2.5 animate-pulse">
                    <div className="h-3.5 bg-line rounded w-3/4 mb-2" />
                    <div className="h-2.5 bg-line/70 rounded w-1/3" />
                  </div>
                ))}
              {visibleCaptures.map((c) => {
                const selected = selectedId === c.id;
                return (
                  <button
                    key={c.id}
                    onClick={() => selectCapture(c.id)}
                    className={`w-full text-left rounded-lg pl-3 pr-3 py-2.5 border-l-[3px] transition ${
                      selected ? "bg-brand-50 border-l-brand" : "border-l-transparent hover:bg-canvas"
                    }`}
                  >
                    <div className="flex items-start gap-2">
                      <span
                        className={`shrink-0 mt-1.5 w-1.5 h-1.5 rounded-full ${
                          STATUS_DOT_STYLE[c.processingStatus] ?? "bg-faint"
                        }`}
                      />
                      <div className="min-w-0 flex-1">
                        <p
                          className={`text-sm leading-snug line-clamp-1 ${
                            selected ? "font-semibold text-brand-700" : "text-ink"
                          }`}
                        >
                          {c.rawText || "(本文なし・音声のみ)"}
                        </p>
                        <div className="flex items-center gap-1.5 mt-1">
                          <span
                            className={`text-[10px] px-1.5 py-0.5 rounded font-medium ${
                              SOURCE_TYPE_CHIP_STYLE[c.sourceType] ?? "bg-canvas text-muted"
                            }`}
                          >
                            {SOURCE_TYPE_LABEL[c.sourceType] ?? c.sourceType}
                          </span>
                          <span className="text-[11px] text-faint">{formatRelativeTime(c.createdAt)}</span>
                        </div>
                      </div>
                    </div>
                  </button>
                );
              })}
              {!loadingList && visibleCaptures.length === 0 && (
                <p className="text-xs text-faint px-1 py-2">この種類のメモはまだありません。</p>
              )}
            </div>
          </div>

          <div className="lg:col-span-3 lg:sticky lg:top-8">
            {selectedId && loadingDetail && (
              <div className="bg-surface border border-line rounded-2xl overflow-hidden animate-pulse">
                <div className="h-16 border-b border-line bg-canvas/60" />
                <div className="p-5 space-y-2.5">
                  <div className="h-4 bg-line rounded w-full" />
                  <div className="h-4 bg-line rounded w-5/6" />
                  <div className="h-4 bg-line rounded w-2/3" />
                </div>
              </div>
            )}
            {selectedId && !loadingDetail && detail && (
              <div className="bg-surface border border-line rounded-2xl shadow-card overflow-hidden">
                <div className="flex items-start justify-between gap-3 px-5 py-4 border-b border-line bg-canvas/60">
                  <div>
                    <p className="text-[10px] text-faint font-mono uppercase tracking-wider">選択中のメモ</p>
                    <div className="flex items-center gap-1.5 mt-1">
                      <span
                        className={`text-[10px] px-1.5 py-0.5 rounded font-medium ${
                          SOURCE_TYPE_CHIP_STYLE[detail.sourceType] ?? "bg-canvas text-muted"
                        }`}
                      >
                        {SOURCE_TYPE_LABEL[detail.sourceType] ?? detail.sourceType}
                      </span>
                      <span className="text-xs text-muted">{new Date(detail.createdAt).toLocaleString("ja-JP")}</span>
                    </div>
                  </div>
                  <span
                    className={`shrink-0 text-[11px] px-2.5 py-1 rounded-full font-medium ${
                      STATUS_BADGE_STYLE[detail.processingStatus] ?? "bg-canvas text-muted"
                    }`}
                  >
                    {STATUS_LABEL[detail.processingStatus] ?? detail.processingStatus}
                  </span>
                </div>

                <div className="px-5 py-5">
                  <p className="text-base font-serif leading-relaxed whitespace-pre-wrap">
                    {detail.rawText || "(本文なし・音声のみ)"}
                  </p>
                </div>

                <div className="border-t border-line bg-canvas/60 px-5 py-4">
                  <div className="flex items-center justify-between gap-3">
                    <div>
                      <p className="text-xs font-semibold text-ink">AI候補</p>
                      <p className="text-[11px] text-faint mt-0.5 max-w-md">
                        {inferences.length === 0
                          ? "「解析を要求する」を押すと、AIが約束・作業・判断・待ち等の候補を抽出します"
                          : `${inferences.length}件の候補があります`}
                      </p>
                    </div>
                    <button
                      onClick={requestAnalyze}
                      disabled={
                        analyzing ||
                        detail.processingStatus === "QUEUED" ||
                        detail.processingStatus === "PROCESSING"
                      }
                      className="shrink-0 text-xs bg-ink text-white rounded-lg px-3 py-2 disabled:opacity-40 hover:bg-black transition"
                    >
                      {analyzing ? "要求中..." : "解析を要求する"}
                    </button>
                  </div>
                  {inferences.length > 0 && (
                    <ul className="space-y-2 mt-3">
                      {inferences.map((inf) => (
                        <li key={inf.id} className="bg-ai-50 rounded-lg p-3 text-xs">
                          <span className="font-mono text-ai">{inf.inferenceType}</span>
                          <span className="ml-2 text-muted">確度 {inf.confidence}</span>
                        </li>
                      ))}
                    </ul>
                  )}
                  {error && <p className="text-sm text-red-600 mt-3">{error}</p>}
                </div>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
