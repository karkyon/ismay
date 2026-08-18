"use client";

import { useCallback, useEffect, useState } from "react";
import { apiFetch } from "@/lib/auth/client";
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

const STATUS_STYLE: Record<string, string> = {
  SAVED: "bg-canvas text-muted",
  QUEUED: "bg-decide-50 text-decide",
  PROCESSING: "bg-ai-50 text-ai",
  READY: "bg-safe-50 text-safe",
  FAILED: "bg-warn-50 text-warn",
};

const SOURCE_TYPE_LABEL: Record<string, string> = {
  TEXT: "テキスト",
  VOICE: "音声",
  MEETING: "会議",
  IMPORT: "取込",
};

/** UI-04 Inbox: 原文から責任候補を確認する画面(API-CAP-01〜04と接続)。 */
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
    const res = await fetch("/api/v1/captures");
    if (res.ok) {
      const body = await res.json();
      const items: CaptureListItem[] = body.data.captures;
      setCaptures(items);
      setSelectedId((current) => current ?? items[0]?.id ?? null);
    }
    setLoadingList(false);
  }, []);

  const loadDetail = useCallback(async (id: string) => {
    setLoadingDetail(true);
    setError("");
    const [detailRes, inferRes] = await Promise.all([
      fetch(`/api/v1/captures/${id}`),
      fetch(`/api/v1/captures/${id}/inferences`),
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

  async function requestAnalyze() {
    if (!selectedId) return;
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

      <div className="grid grid-cols-1 lg:grid-cols-5 gap-5">
        <div className="lg:col-span-2 space-y-2">
          {loadingList && <p className="text-sm text-faint">読み込み中...</p>}
          {!loadingList && captures.length === 0 && (
            <div className="bg-surface border border-line rounded-xl p-4 text-sm text-muted">
              まだ何も書き留めていません。上の入力欄から最初のメモを保存してみてください。
            </div>
          )}
          {captures.map((c) => (
            <button
              key={c.id}
              onClick={() => setSelectedId(c.id)}
              className={`w-full text-left bg-surface rounded-xl p-3.5 transition ${
                selectedId === c.id ? "border-2 border-brand shadow-card" : "border border-line hover:border-ink/20"
              }`}
            >
              <div className="flex items-center justify-between mb-1 gap-2">
                <span className="text-[11px] font-mono text-faint truncate">
                  {SOURCE_TYPE_LABEL[c.sourceType] ?? c.sourceType} ・ {new Date(c.createdAt).toLocaleString("ja-JP")}
                </span>
                <span
                  className={`shrink-0 text-[10px] px-1.5 py-0.5 rounded font-mono ${
                    STATUS_STYLE[c.processingStatus] ?? "bg-canvas text-muted"
                  }`}
                >
                  {STATUS_LABEL[c.processingStatus] ?? c.processingStatus}
                </span>
              </div>
              <p className="text-sm line-clamp-2">{c.rawText || "(本文なし・音声のみ)"}</p>
            </button>
          ))}
        </div>

        <div className="lg:col-span-3">
          {!selectedId && <div className="text-sm text-faint">左の一覧から項目を選んでください</div>}
          {selectedId && loadingDetail && <p className="text-sm text-faint">読み込み中...</p>}
          {selectedId && !loadingDetail && detail && (
            <div className="bg-surface border border-line rounded-2xl shadow-card p-5 space-y-4">
              <div className="flex items-center justify-between">
                <span
                  className={`text-[11px] px-2 py-1 rounded font-mono ${
                    STATUS_STYLE[detail.processingStatus] ?? "bg-canvas text-muted"
                  }`}
                >
                  {STATUS_LABEL[detail.processingStatus] ?? detail.processingStatus}
                </span>
                <span className="text-[11px] text-faint font-mono">
                  {SOURCE_TYPE_LABEL[detail.sourceType] ?? detail.sourceType} ・ v{detail.version}
                </span>
              </div>
              <p className="text-sm whitespace-pre-wrap">{detail.rawText || "(本文なし・音声のみ)"}</p>

              <div className="border-t border-line pt-4">
                <div className="flex items-center justify-between mb-2 gap-3">
                  <span className="text-xs font-mono tracking-wide text-faint">AI候補</span>
                  <button
                    onClick={requestAnalyze}
                    disabled={
                      analyzing ||
                      detail.processingStatus === "QUEUED" ||
                      detail.processingStatus === "PROCESSING"
                    }
                    className="text-xs border border-line rounded-lg px-3 py-1.5 hover:bg-canvas disabled:opacity-40 transition"
                  >
                    {analyzing ? "要求中..." : "解析を要求する"}
                  </button>
                </div>
                {inferences.length === 0 ? (
                  <p className="text-xs text-faint">
                    候補はまだありません。AI Workerは未実装のため、解析要求後もこの一覧は空のままです(次回実装予定)。
                  </p>
                ) : (
                  <ul className="space-y-2">
                    {inferences.map((inf) => (
                      <li key={inf.id} className="bg-ai-50 rounded-lg p-3 text-xs">
                        <span className="font-mono text-ai">{inf.inferenceType}</span>
                        <span className="ml-2 text-muted">確度 {inf.confidence}</span>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
              {error && <p className="text-sm text-red-600">{error}</p>}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
