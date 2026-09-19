"use client";

import { useCallback, useEffect, useState, startTransition } from "react";
import { apiFetch } from "@/lib/auth/client";
import { debugLog } from "@/lib/debug";

/**
 * /patterns: Case Pattern管理画面(PATTERN-MANAGEMENT-UI-01新設・
 * 2026-09-19)。
 * 出典: Claude向け_ISMAY_d68e9bf以降_ActionSlot正本準拠・CasePattern実分解
 * 完遂・残工程連続実装指示_2026-09-17.md P1「11. Pattern管理UI」。
 *
 * [一覧+詳細を1ページで] 既存/admin/ai-providersと同じ、単一Client
 * Componentでlist+detail(クリックで展開)を完結させる設計(別ルートへの
 * 遷移を増やさない、想像で新しいpage.tsxを追加発明しない)。
 */

const STAGE_LABEL: Record<string, string> = {
  NONE: "未検出",
  CANDIDATE_DISPLAY: "候補表示",
  ACTIVE: "有効",
  STRONG_SUGGESTION: "強く推奨",
};

const STAGE_DOT: Record<string, string> = {
  NONE: "bg-gray-300",
  CANDIDATE_DISPLAY: "bg-amber-400",
  ACTIVE: "bg-brand-400",
  STRONG_SUGGESTION: "bg-green-500",
};

interface PatternListItem {
  id: string;
  title: string;
  status: string;
  confidence: number;
  observedIntervalDays: number | null;
  currentRevision: number;
  retiredAt: string | null;
  createdAt: string;
  updatedAt: string;
}

interface ActionSlotDto {
  slotKey: string;
  titleExample: string | null;
  suggestedType: string | null;
  occurrenceProbability: number | null;
  typicalOrder: number | null;
  rawSampleSize: number | null;
  durationDistribution: { status: string; sampleSize: number; medianSeconds?: number } | null;
  atomicityDistribution: { sampleSize: number; byAssessment: Record<string, number> } | null;
}

interface SuggestionDto {
  rawSampleSize: number;
  distinctContextCount: number;
  confidence: number;
  adoptionRate: number | null;
  observedIntervalDays: number | null;
}

interface PatternDetail {
  pattern: PatternListItem;
  actionSlots: ActionSlotDto[];
  suggestionDto: SuggestionDto | null;
  linkedSuggestions: { suggestionRevisionId: string; suggestionId: string; candidateId: string; similarity: number; createdAt: string }[];
}

function formatPercent(ratio: number | null): string {
  if (ratio === null) return "—";
  return `${Math.round(ratio * 1000) / 10}%`;
}

function formatSeconds(seconds: number | undefined): string {
  if (seconds === undefined) return "—";
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `約${minutes}分`;
  return `約${Math.round((minutes / 60) * 10) / 10}時間`;
}

function formatRelativeDate(iso: string): string {
  return new Date(iso).toLocaleDateString("ja-JP", { year: "numeric", month: "short", day: "numeric" });
}

export function PatternsClient() {
  const [patterns, setPatterns] = useState<PatternListItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [showRetired, setShowRetired] = useState(false);

  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [detail, setDetail] = useState<PatternDetail | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [retireBusy, setRetireBusy] = useState(false);

  const loadList = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const res = await apiFetch("/api/v1/case-patterns");
      const body = await res.json().catch(() => null);
      if (!res.ok) {
        setError(body?.error?.message ?? "Pattern一覧の取得に失敗しました");
        return;
      }
      setPatterns(body.data.patterns as PatternListItem[]);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    startTransition(() => {
      void loadList();
    });
  }, [loadList]);

  const loadDetail = useCallback(async (id: string) => {
    setDetailLoading(true);
    setDetail(null);
    try {
      const res = await apiFetch(`/api/v1/case-patterns/${id}`);
      const body = await res.json().catch(() => null);
      if (!res.ok) {
        setError(body?.error?.message ?? "Pattern詳細の取得に失敗しました");
        return;
      }
      setDetail(body.data as PatternDetail);
    } finally {
      setDetailLoading(false);
    }
  }, []);

  function selectPattern(id: string) {
    if (selectedId === id) {
      setSelectedId(null);
      setDetail(null);
      return;
    }
    setSelectedId(id);
    void loadDetail(id);
  }

  async function toggleRetire(id: string, currentlyRetired: boolean) {
    setRetireBusy(true);
    setError("");
    debugLog.event("PatternsClient", "toggleRetire", { id, currentlyRetired });
    try {
      const res = await apiFetch(`/api/v1/case-patterns/${id}`, {
        method: "PATCH",
        body: JSON.stringify({ action: currentlyRetired ? "REACTIVATE" : "RETIRE" }),
      });
      const body = await res.json().catch(() => null);
      if (!res.ok) {
        setError(body?.error?.message ?? "操作に失敗しました");
        return;
      }
      await loadList();
      if (selectedId === id) await loadDetail(id);
    } finally {
      setRetireBusy(false);
    }
  }

  const visiblePatterns = patterns.filter((p) => showRetired || p.retiredAt === null);

  return (
    <div className="max-w-4xl mx-auto p-4 space-y-4">
      <div className="flex items-center justify-between">
        <h1 className="text-lg font-serif text-ink">パターン</h1>
        <label className="flex items-center gap-1.5 text-xs text-muted">
          <input type="checkbox" checked={showRetired} onChange={(e) => setShowRetired(e.target.checked)} />
          退避済みも表示
        </label>
      </div>

      <p className="text-xs text-faint">
        繰り返し行っている作業のパターンを学習し、次回以降の分解を提案します。不要なパターンは「退避」できます
        (退避しても既存の学習データは残り、新しい提案の照合対象から外れるだけです)。
      </p>

      {error && <div className="text-sm text-red-600 bg-red-50 border border-red-200 rounded-lg px-3 py-2">{error}</div>}

      {loading ? (
        <div className="text-sm text-faint">読み込み中...</div>
      ) : visiblePatterns.length === 0 ? (
        <div className="text-sm text-faint bg-surface border border-line rounded-2xl p-6 text-center">
          {patterns.length === 0 ? "まだ学習されたパターンがありません" : "退避済みのパターンのみです"}
        </div>
      ) : (
        <div className="space-y-2">
          {visiblePatterns.map((p) => (
            <div key={p.id} className="bg-surface border border-line rounded-2xl shadow-card overflow-hidden">
              <button
                type="button"
                onClick={() => selectPattern(p.id)}
                className="w-full flex items-center gap-3 px-4 py-3 text-left hover:bg-canvas transition"
              >
                <span className={`w-2 h-2 rounded-full shrink-0 ${STAGE_DOT[p.status] ?? "bg-gray-300"}`} />
                <span className="flex-1 min-w-0">
                  <span className="text-sm font-medium text-ink truncate block">{p.title}</span>
                  <span className="text-[11px] text-faint">
                    {STAGE_LABEL[p.status] ?? p.status} ・ 確信度{formatPercent(p.confidence)}
                    {p.retiredAt && <span className="text-amber-600 ml-1.5">・退避済み</span>}
                  </span>
                </span>
                <span className="text-[11px] text-faint shrink-0">{formatRelativeDate(p.updatedAt)}</span>
              </button>

              {selectedId === p.id && (
                <div className="border-t border-line px-4 py-3 bg-canvas/50 space-y-3">
                  {detailLoading ? (
                    <div className="text-xs text-faint">詳細を読み込み中...</div>
                  ) : detail && detail.pattern.id === p.id ? (
                    <>
                      {detail.suggestionDto && (
                        <div className="grid grid-cols-2 md:grid-cols-4 gap-2">
                          <div className="bg-surface border border-line rounded-xl px-3 py-2">
                            <p className="text-[10px] text-faint">実績件数</p>
                            <p className="text-sm text-ink">{detail.suggestionDto.rawSampleSize}件</p>
                          </div>
                          <div className="bg-surface border border-line rounded-xl px-3 py-2">
                            <p className="text-[10px] text-faint">文脈数</p>
                            <p className="text-sm text-ink">{detail.suggestionDto.distinctContextCount}件</p>
                          </div>
                          <div className="bg-surface border border-line rounded-xl px-3 py-2">
                            <p className="text-[10px] text-faint">採用率</p>
                            <p className="text-sm text-ink">{formatPercent(detail.suggestionDto.adoptionRate)}</p>
                          </div>
                          <div className="bg-surface border border-line rounded-xl px-3 py-2">
                            <p className="text-[10px] text-faint">発生間隔</p>
                            <p className="text-sm text-ink">
                              {detail.suggestionDto.observedIntervalDays !== null ? `約${Math.round(detail.suggestionDto.observedIntervalDays)}日` : "—"}
                            </p>
                          </div>
                        </div>
                      )}

                      {detail.actionSlots.length > 0 && (
                        <div>
                          <p className="text-xs font-medium text-ink mb-1.5">学習済みの分解パーツ(出現率順)</p>
                          <div className="space-y-1">
                            {[...detail.actionSlots]
                              .sort((a, b) => (b.occurrenceProbability ?? 0) - (a.occurrenceProbability ?? 0))
                              .map((slot) => (
                                <div key={slot.slotKey} className="bg-surface border border-line rounded-lg px-3 py-2 text-xs flex items-center gap-2">
                                  <span className="flex-1 min-w-0 truncate">{slot.titleExample ?? "(不明)"}</span>
                                  <span className="text-faint shrink-0">出現率 {formatPercent(slot.occurrenceProbability)}</span>
                                  <span className="text-faint shrink-0">{slot.rawSampleSize ?? 0}件</span>
                                  <span className="text-faint shrink-0">
                                    所要時間 {slot.durationDistribution?.status === "COMPUTED" ? formatSeconds(slot.durationDistribution.medianSeconds) : "未計測"}
                                  </span>
                                </div>
                              ))}
                          </div>
                        </div>
                      )}

                      {detail.actionSlots.length === 0 && (
                        <p className="text-xs text-faint">まだ実績に基づく分解案の学習データがありません。</p>
                      )}

                      <div className="flex items-center justify-between pt-1">
                        {detail.pattern.retiredAt && (
                          <p className="text-[11px] text-amber-600">{formatRelativeDate(detail.pattern.retiredAt)}に退避</p>
                        )}
                        <button
                          type="button"
                          disabled={retireBusy}
                          onClick={() => toggleRetire(p.id, detail.pattern.retiredAt !== null)}
                          className={`ml-auto text-xs rounded-lg px-3 py-1.5 disabled:opacity-40 transition ${
                            detail.pattern.retiredAt
                              ? "bg-ink text-white hover:bg-black"
                              : "bg-white border border-line text-muted hover:bg-canvas"
                          }`}
                        >
                          {detail.pattern.retiredAt ? "再有効化する" : "このパターンを退避する"}
                        </button>
                      </div>
                    </>
                  ) : (
                    <div className="text-xs text-red-600">詳細の取得に失敗しました</div>
                  )}
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
