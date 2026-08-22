"use client";

import { useCallback, useState } from "react";
import Link from "next/link";
import { apiFetch } from "@/lib/auth/client";
import { debugLog } from "@/lib/debug";

interface ResponsibilityHit {
  id: string;
  type: string;
  title: string;
  status: string;
  importance: number | null;
  hardDeadlineAt: string | null;
  updatedAt: string;
}

interface CaptureHit {
  id: string;
  sourceType: string;
  rawText: string | null;
  aiSummary: string | null;
  processingStatus: string;
  createdAt: string;
}

interface SemanticHit {
  responsibilityId: string;
  title: string;
  type: string;
  status: string;
  similarity: number;
}

interface SearchResponse {
  responsibilities: ResponsibilityHit[];
  captures: CaptureHit[];
  semantic: SemanticHit[];
}

type Mode = "keyword" | "semantic" | "both";

const TYPE_LABEL: Record<string, string> = {
  TASK: "タスク",
  COMMITMENT: "約束",
  DECISION: "判断",
  WAITING: "待ち",
  EVENT: "予定",
  RISK: "リスク",
  CONCERN: "懸念",
  HABIT: "習慣",
  IDEA: "アイデア",
};

/** 検索語の出現箇所を含む短い抜粋を作る(前後クリップ)。 */
function excerpt(text: string, query: string, radius = 40): string {
  const idx = text.toLowerCase().indexOf(query.toLowerCase());
  if (idx === -1) return text.slice(0, radius * 2);
  const start = Math.max(0, idx - radius);
  const end = Math.min(text.length, idx + query.length + radius);
  return `${start > 0 ? "…" : ""}${text.slice(start, end)}${end < text.length ? "…" : ""}`;
}

/**
 * UI-11 横断検索(2026-08-22新設)。
 * FR-SRCH-01「キーワードと意味の双方で検索できる」「原文と責任を区別する」、
 * FR-SRCH-02「相手、状態、期間、責任種別で絞り込める」に対応。
 */
export function SearchClient() {
  const [query, setQuery] = useState("");
  const [mode, setMode] = useState<Mode>("keyword");
  const [type, setType] = useState("");
  const [status, setStatus] = useState("");
  const [counterparty, setCounterparty] = useState("");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [result, setResult] = useState<SearchResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [searched, setSearched] = useState(false);

  const runSearch = useCallback(
    async (e?: React.FormEvent) => {
      e?.preventDefault();
      if (!query.trim()) return;
      setLoading(true);
      setSearched(true);
      const params = new URLSearchParams({ q: query, mode });
      if (type) params.set("type", type);
      if (status) params.set("status", status);
      if (counterparty) params.set("counterparty", counterparty);
      if (from) params.set("from", new Date(from).toISOString());
      if (to) params.set("to", new Date(to).toISOString());
      try {
        const res = await apiFetch(`/api/v1/search?${params.toString()}`);
        if (res.ok) {
          const body = await res.json();
          setResult(body.data);
        } else {
          debugLog.error("SearchClient", "search failed", await res.json().catch(() => null));
        }
      } finally {
        setLoading(false);
      }
    },
    [query, mode, type, status, counterparty, from, to],
  );

  const hasResults =
    result && (result.responsibilities.length > 0 || result.captures.length > 0 || result.semantic.length > 0);

  return (
    <div className="max-w-3xl mx-auto px-4 py-6 space-y-5">
      <form onSubmit={runSearch} className="space-y-3">
        <div className="flex gap-2">
          <input
            autoFocus
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="キーワードで検索..."
            className="flex-1 border border-line rounded-xl px-4 py-2.5 text-sm focus:outline-none focus:border-brand"
          />
          <button
            type="submit"
            disabled={loading || !query.trim()}
            className="bg-slate-900 hover:bg-black text-white text-sm rounded-xl px-5 py-2.5 disabled:opacity-40"
          >
            {loading ? "検索中..." : "検索"}
          </button>
        </div>

        <div className="flex flex-wrap items-center gap-2 text-xs">
          <div className="flex bg-canvas rounded-lg p-0.5">
            {([
              { key: "keyword", label: "キーワード" },
              { key: "semantic", label: "意味検索" },
              { key: "both", label: "両方" },
            ] as const).map((m) => (
              <button
                key={m.key}
                type="button"
                onClick={() => setMode(m.key)}
                className={`px-3 py-1.5 rounded-md ${mode === m.key ? "bg-white shadow-sm text-ink" : "text-faint"}`}
              >
                {m.label}
              </button>
            ))}
          </div>
          <select value={type} onChange={(e) => setType(e.target.value)} className="border border-line rounded-lg px-2 py-1.5">
            <option value="">種別すべて</option>
            {Object.entries(TYPE_LABEL).map(([k, v]) => (
              <option key={k} value={k}>
                {v}
              </option>
            ))}
          </select>
          <input
            type="text"
            value={counterparty}
            onChange={(e) => setCounterparty(e.target.value)}
            placeholder="相手方"
            className="border border-line rounded-lg px-2 py-1.5 w-24"
          />
          <input
            type="text"
            value={status}
            onChange={(e) => setStatus(e.target.value)}
            placeholder="状態コード"
            title="例: IN_PROGRESS, WAITING など"
            className="border border-line rounded-lg px-2 py-1.5 w-28"
          />
          <input type="date" value={from} onChange={(e) => setFrom(e.target.value)} className="border border-line rounded-lg px-2 py-1.5" />
          <span className="text-faint">〜</span>
          <input type="date" value={to} onChange={(e) => setTo(e.target.value)} className="border border-line rounded-lg px-2 py-1.5" />
        </div>
      </form>

      {searched && !loading && !hasResults && (
        <p className="text-sm text-muted text-center py-8">「{query}」に一致する結果はありませんでした。</p>
      )}

      {result && result.responsibilities.length > 0 && (
        <section>
          <h2 className="text-xs font-mono tracking-wide text-faint mb-2">責任({result.responsibilities.length}件)</h2>
          <ul className="space-y-1.5">
            {result.responsibilities.map((r) => (
              <li key={r.id} className="bg-surface border border-line rounded-xl px-4 py-2.5">
                <Link href={`/responsibilities?focus=${r.id}`} className="text-sm text-ink hover:underline flex items-center gap-2">
                  <span className="text-[10px] text-brand-700 border border-brand-200 rounded px-1.5 py-0.5 shrink-0">
                    {TYPE_LABEL[r.type] ?? r.type}
                  </span>
                  <span className="truncate">{r.title}</span>
                </Link>
              </li>
            ))}
          </ul>
        </section>
      )}

      {result && result.semantic.length > 0 && (
        <section>
          <h2 className="text-xs font-mono tracking-wide text-faint mb-2">意味的に近い責任({result.semantic.length}件)</h2>
          <ul className="space-y-1.5">
            {result.semantic.map((r) => (
              <li key={r.responsibilityId} className="bg-surface border border-line rounded-xl px-4 py-2.5">
                <Link
                  href={`/responsibilities?focus=${r.responsibilityId}`}
                  className="text-sm text-ink hover:underline flex items-center gap-2"
                >
                  <span className="text-[10px] text-brand-700 border border-brand-200 rounded px-1.5 py-0.5 shrink-0">
                    {TYPE_LABEL[r.type] ?? r.type}
                  </span>
                  <span className="truncate">{r.title}</span>
                  <span className="ml-auto text-[11px] text-faint shrink-0">類似度{Math.round(r.similarity * 100)}%</span>
                </Link>
              </li>
            ))}
          </ul>
        </section>
      )}

      {result && result.captures.length > 0 && (
        <section>
          <h2 className="text-xs font-mono tracking-wide text-faint mb-2">原文({result.captures.length}件)</h2>
          <ul className="space-y-1.5">
            {result.captures.map((c) => (
              <li key={c.id} className="bg-canvas border border-line rounded-xl px-4 py-2.5">
                <p className="text-[10px] text-faint mb-1">{new Date(c.createdAt).toLocaleString("ja-JP")}</p>
                <p className="text-sm text-muted">
                  {excerpt(c.rawText ?? c.aiSummary ?? "", query)}
                </p>
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}
