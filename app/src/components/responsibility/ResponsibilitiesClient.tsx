"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { apiFetch, debugFetch } from "@/lib/auth/client";
import { debugLog } from "@/lib/debug";
import { formatRelativeTime } from "@/lib/format";
import {
  RESPONSIBILITY_TYPES,
  isCommonStatusType,
  COMMON_TRANSITIONS,
  type TransitionAction,
} from "@/lib/responsibility";

interface ResponsibilityListItem {
  id: string;
  type: string;
  title: string;
  status: string;
  importance: number | null;
  domainId: string | null;
  hardDeadlineAt: string | null;
  targetAt: string | null;
  startAfterAt: string | null;
  completedAt: string | null;
  version: number;
  createdAt: string;
  updatedAt: string;
}

interface ResponsibilityDetail extends ResponsibilityListItem {
  description: string | null;
  sourceKind: string;
  originCaptureId: string | null;
}

const TYPE_LABEL: Record<string, string> = {
  TASK: "作業",
  COMMITMENT: "約束",
  DECISION: "判断",
  WAITING: "待ち",
  EVENT: "予定",
  RISK: "リスク",
  CONCERN: "懸念",
  HABIT: "習慣",
  IDEA: "アイデア",
};

const TYPE_CHIP_STYLE: Record<string, string> = {
  TASK: "bg-brand-50 text-brand-700",
  COMMITMENT: "bg-decide-50 text-decide",
  DECISION: "bg-ai-50 text-ai",
  WAITING: "bg-canvas text-muted",
  EVENT: "bg-safe-50 text-safe",
  RISK: "bg-warn-50 text-warn",
  CONCERN: "bg-warn-50 text-warn",
  HABIT: "bg-brand-50 text-brand-700",
  IDEA: "bg-ai-50 text-ai",
};

const STATUS_LABEL: Record<string, string> = {
  INBOX: "未整理",
  PLANNED: "計画済み",
  IN_PROGRESS: "実行中",
  DEFERRED: "延期",
  COMPLETED: "完了",
  NOT_NEEDED: "不要",
  CANCELLED: "取消",
  ACTIVE: "進行中",
  AT_RISK: "危険",
  FULFILLED: "履行済み",
  BROKEN: "不履行",
  OPEN: "未対応",
  EVIDENCE_GATHERING: "検討中",
  DECIDED: "決定済み",
  REOPENED: "再検討",
  WAITING: "待機中",
  FOLLOW_UP_DUE: "追跡期限到来",
  RESOLVED: "解決済み",
  MONITORING: "監視中",
  MITIGATED: "軽減済み",
  OCCURRED: "発生",
  CLOSED: "終了",
};

const TERMINAL_STATUSES = new Set([
  "COMPLETED",
  "NOT_NEEDED",
  "CANCELLED",
  "FULFILLED",
  "BROKEN",
  "RESOLVED",
  "MITIGATED",
  "OCCURRED",
  "CLOSED",
]);

const ACTION_LABEL: Record<TransitionAction, string> = {
  START: "開始する",
  COMPLETE: "完了する",
  PARTIAL_COMPLETE: "部分完了にする",
  DEFER: "延期する",
  INTERRUPT: "中断する",
  RESUME: "再開する",
  MARK_NOT_NEEDED: "不要にする",
  REOPEN: "取消を解除する",
};

const STATUS_DOT_STYLE: Record<string, string> = {
  COMPLETED: "bg-safe",
  FULFILLED: "bg-safe",
  RESOLVED: "bg-safe",
  DECIDED: "bg-safe",
  MITIGATED: "bg-safe",
  CLOSED: "bg-safe",
  NOT_NEEDED: "bg-faint",
  CANCELLED: "bg-faint",
  BROKEN: "bg-warn",
  AT_RISK: "bg-warn",
  OCCURRED: "bg-warn",
  IN_PROGRESS: "bg-ai",
  ACTIVE: "bg-ai",
  MONITORING: "bg-ai",
  EVIDENCE_GATHERING: "bg-ai",
};

/**
 * UI-05 今後: 期限・依存の確認、責任種別、フィルター(Webシステム要件定義書v2.1 9章)。
 *
 * [スコープ] 「容量警告」「依存」はPlanning/関係確認API未実装のため今回は含まない。
 * 状態遷移ボタンは共通状態種別(TASK/EVENT/CONCERN/HABIT/IDEA)のみ表示する。
 */
export function ResponsibilitiesClient() {
  const [items, setItems] = useState<ResponsibilityListItem[]>([]);
  const [loadingList, setLoadingList] = useState(true);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [detail, setDetail] = useState<ResponsibilityDetail | null>(null);
  const [loadingDetail, setLoadingDetail] = useState(false);
  const [transitioning, setTransitioning] = useState(false);
  const [error, setError] = useState("");
  const [filterType, setFilterType] = useState<string | null>(null);
  const [hideDone, setHideDone] = useState(true);

  const [showCreate, setShowCreate] = useState(false);
  const [newType, setNewType] = useState<string>("TASK");
  const [newTitle, setNewTitle] = useState("");
  const [newTargetAt, setNewTargetAt] = useState("");
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState("");

  const loadList = useCallback(async () => {
    setLoadingList(true);
    const res = await debugFetch("/api/v1/responsibilities?limit=100&sort=targetAt");
    if (res.ok) {
      const body = await res.json();
      const rows: ResponsibilityListItem[] = body.data.responsibilities;
      debugLog.state("ResponsibilitiesClient", "items", { count: rows.length });
      setItems(rows);
    }
    setLoadingList(false);
  }, []);

  const loadDetail = useCallback(async (id: string) => {
    setLoadingDetail(true);
    setError("");
    const res = await debugFetch(`/api/v1/responsibilities/${id}`);
    if (res.ok) {
      const body = await res.json();
      setDetail(body.data.responsibility);
    }
    setLoadingDetail(false);
  }, []);

  useEffect(() => {
    loadList();
  }, [loadList]);

  useEffect(() => {
    if (selectedId) loadDetail(selectedId);
  }, [selectedId, loadDetail]);

  function selectItem(id: string) {
    debugLog.event("ResponsibilitiesClient", "select item", { id });
    setSelectedId(id);
  }

  const typeCounts = useMemo(() => {
    const counts: Record<string, number> = {};
    for (const i of items) counts[i.type] = (counts[i.type] ?? 0) + 1;
    return counts;
  }, [items]);
  const availableTypes = RESPONSIBILITY_TYPES.filter((t) => (typeCounts[t] ?? 0) > 0);

  const visibleItems = useMemo(() => {
    return items.filter((i) => {
      if (filterType && i.type !== filterType) return false;
      if (hideDone && TERMINAL_STATUSES.has(i.status)) return false;
      return true;
    });
  }, [items, filterType, hideDone]);

  async function submitCreate(e: React.FormEvent) {
    e.preventDefault();
    if (!newTitle.trim() || creating) return;
    debugLog.event("ResponsibilitiesClient", "create start", { type: newType });
    setCreating(true);
    setCreateError("");
    try {
      const res = await apiFetch("/api/v1/responsibilities", {
        method: "POST",
        body: JSON.stringify({
          type: newType,
          title: newTitle.trim(),
          ...(newTargetAt ? { targetAt: new Date(newTargetAt).toISOString() } : {}),
        }),
      });
      const body = await res.json().catch(() => null);
      if (!res.ok) {
        debugLog.event("ResponsibilitiesClient", "create failed", body?.error);
        setCreateError(body?.error?.message ?? "作成に失敗しました");
        return;
      }
      debugLog.event("ResponsibilitiesClient", "create succeeded", body?.data);
      setNewTitle("");
      setNewTargetAt("");
      setShowCreate(false);
      await loadList();
      setSelectedId(body.data.id);
    } catch (err) {
      debugLog.error("ResponsibilitiesClient", "create", err);
      setCreateError("通信に失敗しました。ネットワーク状態を確認してもう一度お試しください");
    } finally {
      setCreating(false);
    }
  }

  async function runTransition(action: TransitionAction) {
    if (!detail) return;
    debugLog.event("ResponsibilitiesClient", "transition", { id: detail.id, action });
    setTransitioning(true);
    setError("");
    try {
      const res = await apiFetch(`/api/v1/responsibilities/${detail.id}/transitions`, {
        method: "POST",
        body: JSON.stringify({ action, occurredAt: new Date().toISOString(), version: detail.version }),
      });
      const body = await res.json();
      if (!res.ok) {
        setError(body.error?.message ?? "状態変更に失敗しました");
        return;
      }
      await Promise.all([loadDetail(detail.id), loadList()]);
    } finally {
      setTransitioning(false);
    }
  }

  async function deleteResponsibility() {
    if (!detail) return;
    debugLog.event("ResponsibilitiesClient", "delete", { id: detail.id });
    const res = await apiFetch(`/api/v1/responsibilities/${detail.id}`, { method: "DELETE" });
    if (res.ok) {
      setSelectedId(null);
      setDetail(null);
      await loadList();
    }
  }

  const availableActions = useMemo(() => {
    if (!detail || !isCommonStatusType(detail.type)) return [];
    return COMMON_TRANSITIONS.filter((r) => (r.from as readonly string[]).includes(detail.status)).map(
      (r) => r.action,
    );
  }, [detail]);

  return (
    <div>
      <div className="mb-6 flex items-start justify-between gap-3">
        <div>
          <h1 className="font-serif text-3xl">今後</h1>
          <p className="text-sm text-muted mt-1">タスク・約束・判断・待ちを期限順に確認します</p>
        </div>
        <button
          onClick={() => setShowCreate((v) => !v)}
          className="shrink-0 bg-ink text-white text-sm font-medium px-4 py-2 rounded-xl hover:bg-black transition"
        >
          {showCreate ? "閉じる" : "＋ 新しく登録する"}
        </button>
      </div>

      {showCreate && (
        <form onSubmit={submitCreate} className="mb-6 bg-surface border border-line rounded-2xl shadow-card p-4 space-y-3">
          <div className="flex flex-wrap gap-2">
            {RESPONSIBILITY_TYPES.map((t) => (
              <button
                key={t}
                type="button"
                onClick={() => setNewType(t)}
                className={`text-xs px-3 py-1.5 rounded-full font-medium transition ${
                  newType === t ? "bg-ink text-white" : `${TYPE_CHIP_STYLE[t]} hover:opacity-80`
                }`}
              >
                {TYPE_LABEL[t]}
              </button>
            ))}
          </div>
          <input
            value={newTitle}
            onChange={(e) => setNewTitle(e.target.value)}
            placeholder="タイトル(例: A社への見積書を送る)"
            className="w-full text-sm border border-line rounded-lg px-3 py-2 focus:outline-none focus:border-brand"
            autoFocus
          />
          <div className="flex items-center gap-3">
            <label className="text-xs text-muted">目標日時(任意)</label>
            <input
              type="datetime-local"
              value={newTargetAt}
              onChange={(e) => setNewTargetAt(e.target.value)}
              className="text-sm border border-line rounded-lg px-2 py-1.5"
            />
          </div>
          <div className="flex items-center justify-between">
            {createError && <p className="text-sm text-red-600">{createError}</p>}
            <button
              type="submit"
              disabled={creating || !newTitle.trim()}
              className="ml-auto bg-ink text-white text-sm font-medium px-4 py-2 rounded-xl disabled:opacity-40 hover:bg-black transition"
            >
              {creating ? "登録中..." : "登録する"}
            </button>
          </div>
        </form>
      )}

      {!loadingList && items.length === 0 ? (
        <div className="bg-surface border border-line rounded-2xl p-10 text-center">
          <p className="text-sm text-muted">まだ何も登録されていません。</p>
          <p className="text-sm text-muted mt-1">「＋ 新しく登録する」から最初の項目を作ってみてください。</p>
        </div>
      ) : (
        <div className="grid grid-cols-1 lg:grid-cols-5 gap-5 items-start">
          <div className="lg:col-span-2 space-y-3">
            <div className="flex flex-wrap items-center gap-1.5">
              <button
                onClick={() => setFilterType(null)}
                className={`text-xs px-3 py-1.5 rounded-full font-medium transition ${
                  filterType === null ? "bg-ink text-white" : "bg-surface border border-line text-muted hover:bg-canvas"
                }`}
              >
                すべて <span className="opacity-60">{items.length}</span>
              </button>
              {availableTypes.map((t) => (
                <button
                  key={t}
                  onClick={() => setFilterType(t)}
                  className={`text-xs px-3 py-1.5 rounded-full font-medium transition ${
                    filterType === t ? "bg-ink text-white" : `${TYPE_CHIP_STYLE[t]} hover:opacity-80`
                  }`}
                >
                  {TYPE_LABEL[t]} <span className="opacity-60">{typeCounts[t]}</span>
                </button>
              ))}
              <label className="ml-auto flex items-center gap-1.5 text-[11px] text-muted">
                <input type="checkbox" checked={hideDone} onChange={(e) => setHideDone(e.target.checked)} />
                完了を隠す
              </label>
            </div>

            <div className="space-y-1">
              {loadingList &&
                [0, 1, 2].map((i) => (
                  <div key={i} className="px-3 py-2.5 animate-pulse">
                    <div className="h-3.5 bg-line rounded w-3/4 mb-2" />
                    <div className="h-2.5 bg-line/70 rounded w-1/3" />
                  </div>
                ))}
              {visibleItems.map((item) => {
                const selected = selectedId === item.id;
                return (
                  <button
                    key={item.id}
                    onClick={() => selectItem(item.id)}
                    className={`w-full text-left rounded-lg pl-3 pr-3 py-2.5 border-l-[3px] transition ${
                      selected ? "bg-brand-50 border-l-brand" : "border-l-transparent hover:bg-canvas"
                    }`}
                  >
                    <div className="flex items-start gap-2">
                      <span
                        className={`shrink-0 mt-1.5 w-1.5 h-1.5 rounded-full ${
                          STATUS_DOT_STYLE[item.status] ?? "bg-faint"
                        }`}
                      />
                      <div className="min-w-0 flex-1">
                        <p
                          className={`text-sm leading-snug line-clamp-1 ${
                            selected ? "font-semibold text-brand-700" : "text-ink"
                          }`}
                        >
                          {item.title}
                        </p>
                        <div className="flex items-center gap-1.5 mt-1 flex-wrap">
                          <span className={`text-[10px] px-1.5 py-0.5 rounded font-medium ${TYPE_CHIP_STYLE[item.type] ?? "bg-canvas text-muted"}`}>
                            {TYPE_LABEL[item.type] ?? item.type}
                          </span>
                          <span className="text-[11px] text-faint">{STATUS_LABEL[item.status] ?? item.status}</span>
                          {item.hardDeadlineAt && (
                            <span className="text-[11px] text-warn font-mono">
                              期限 {new Date(item.hardDeadlineAt).toLocaleDateString("ja-JP", { month: "short", day: "numeric" })}
                            </span>
                          )}
                        </div>
                      </div>
                    </div>
                  </button>
                );
              })}
              {!loadingList && visibleItems.length === 0 && (
                <p className="text-xs text-faint px-1 py-2">該当する項目はありません。</p>
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
                </div>
              </div>
            )}
            {selectedId && !loadingDetail && detail && (
              <div className="bg-surface border border-line rounded-2xl shadow-card overflow-hidden">
                <div className="flex items-start justify-between gap-3 px-5 py-4 border-b border-line bg-canvas/60">
                  <div>
                    <span className={`text-[10px] px-1.5 py-0.5 rounded font-medium ${TYPE_CHIP_STYLE[detail.type] ?? "bg-canvas text-muted"}`}>
                      {TYPE_LABEL[detail.type] ?? detail.type}
                    </span>
                    <p className="text-xs text-muted mt-1.5">更新 {formatRelativeTime(detail.updatedAt)}</p>
                  </div>
                  <span className="shrink-0 text-[11px] px-2.5 py-1 rounded-full font-medium bg-canvas text-ink">
                    {STATUS_LABEL[detail.status] ?? detail.status}
                  </span>
                </div>

                <div className="px-5 py-5 space-y-3">
                  <p className="text-base font-serif leading-relaxed">{detail.title}</p>
                  {detail.description && (
                    <p className="text-sm text-muted whitespace-pre-wrap">{detail.description}</p>
                  )}
                  <div className="flex flex-wrap gap-x-6 gap-y-1 text-xs text-muted">
                    {detail.hardDeadlineAt && (
                      <span>固定期限: {new Date(detail.hardDeadlineAt).toLocaleString("ja-JP")}</span>
                    )}
                    {detail.targetAt && <span>目標日時: {new Date(detail.targetAt).toLocaleString("ja-JP")}</span>}
                    {detail.startAfterAt && (
                      <span>開始可能: {new Date(detail.startAfterAt).toLocaleString("ja-JP")}</span>
                    )}
                    {detail.importance && <span>重要度: {detail.importance}/5</span>}
                  </div>
                </div>

                <div className="border-t border-line bg-canvas/60 px-5 py-4">
                  {isCommonStatusType(detail.type) ? (
                    <div className="flex flex-wrap items-center gap-2">
                      {availableActions.length === 0 && (
                        <p className="text-[11px] text-faint">この状態から遷移できる操作はありません。</p>
                      )}
                      {availableActions.map((action) => (
                        <button
                          key={action}
                          onClick={() => runTransition(action)}
                          disabled={transitioning}
                          className="text-xs bg-ink text-white rounded-lg px-3 py-2 disabled:opacity-40 hover:bg-black transition"
                        >
                          {ACTION_LABEL[action]}
                        </button>
                      ))}
                      <button
                        onClick={deleteResponsibility}
                        className="ml-auto text-xs text-red-600 hover:underline"
                      >
                        削除する
                      </button>
                    </div>
                  ) : (
                    <div className="flex items-center justify-between">
                      <p className="text-[11px] text-faint max-w-md">
                        {TYPE_LABEL[detail.type]}の状態遷移は現在未対応です(次回実装予定)。
                      </p>
                      <button
                        onClick={deleteResponsibility}
                        className="text-xs text-red-600 hover:underline"
                      >
                        削除する
                      </button>
                    </div>
                  )}
                  {error && <p className="text-sm text-red-600 mt-3">{error}</p>}
                </div>
              </div>
            )}
            {!selectedId && (
              <div className="bg-surface border border-line rounded-2xl p-10 text-center text-sm text-faint">
                左の一覧から項目を選んでください
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
