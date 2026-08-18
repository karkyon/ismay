"use client";

import { useCallback, useEffect, useState } from "react";
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

/**
 * UI-04 Inbox: 原文から責任候補を確認する画面(API-CAP-01〜04と接続)。
 *
 * デザイン方針(2026-08-18改訂): 一覧行と詳細パネルの見た目がほぼ同一で
 * 「連関がわかりにくい」という指摘への対応として、
 * - 一覧(左): 装飾を最小限にした「行」。選択時のみ左アクセントバー+淡色背景+ドットで示す。
 * - 詳細(右): ヘッダー/本文/AI候補の3領域を持つ「開いている文書」。
 * という明確に異なる表現に分離した。この一覧/詳細パターンは今後追加する
 * 画面(Responsibility一覧等)にも踏襲する想定。
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

  // Superhumanの一覧移動(J/K・矢印キー)を踏襲。テキスト入力中は発火しない。
  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if (isTypingTarget(e.target)) return;
      if (captures.length === 0) return;
      const key = e.key.toLowerCase();
      const isDown = key === "j" || e.key === "ArrowDown";
      const isUp = key === "k" || e.key === "ArrowUp";
      if (!isDown && !isUp) return;
      e.preventDefault();
      const idx = captures.findIndex((c) => c.id === selectedId);
      const nextIdx = isDown
        ? Math.min(idx < 0 ? 0 : idx + 1, captures.length - 1)
        : Math.max(idx < 0 ? 0 : idx - 1, 0);
      const next = captures[nextIdx];
      if (next) selectCapture(next.id);
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [captures, selectedId]);

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
          <div className="lg:col-span-2 space-y-1">
            {loadingList &&
              [0, 1, 2].map((i) => (
                <div key={i} className="px-3 py-2.5 animate-pulse">
                  <div className="h-3.5 bg-line rounded w-3/4 mb-2" />
                  <div className="h-2.5 bg-line/70 rounded w-1/3" />
                </div>
              ))}
            {captures.map((c) => {
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
                    <div className="min-w-0">
                      <p
                        className={`text-sm leading-snug line-clamp-1 ${
                          selected ? "font-semibold text-brand-700" : "text-ink"
                        }`}
                      >
                        {c.rawText || "(本文なし・音声のみ)"}
                      </p>
                      <p className="text-[11px] text-faint mt-0.5">
                        {SOURCE_TYPE_LABEL[c.sourceType] ?? c.sourceType} ・ {formatRelativeTime(c.createdAt)}
                      </p>
                    </div>
                  </div>
                </button>
              );
            })}
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
                    <p className="text-xs text-muted mt-0.5">
                      {SOURCE_TYPE_LABEL[detail.sourceType] ?? detail.sourceType} ・{" "}
                      {new Date(detail.createdAt).toLocaleString("ja-JP")}
                    </p>
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
                          ? "AI Workerは未実装のため、解析要求後もこの一覧は空のままです(次回実装予定)"
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
