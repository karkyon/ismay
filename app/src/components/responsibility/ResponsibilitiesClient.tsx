"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { apiFetch, debugFetch } from "@/lib/auth/client";
import { debugLog } from "@/lib/debug";
import { formatRelativeTime } from "@/lib/format";
import { PertMiniPanel } from "@/components/responsibility/PertMiniPanel";
import {
  RESPONSIBILITY_TYPES,
  transitionsForType,
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
  blockedByCount: number;
  childrenCount: number;
}

interface DependencyItem {
  id: string;
  title: string;
  status: string;
  type: string;
}

interface PertNodeItem {
  id: string;
  title: string;
  status: string;
  type: string;
  importance: number | null;
  layer: number;
}

interface ResponsibilityTagRef {
  id: string;
  name: string;
  color: string;
}

interface ResponsibilityDetail extends ResponsibilityListItem {
  description: string | null;
  sourceKind: string;
  originCaptureId: string | null;
  tags: ResponsibilityTagRef[];
}

interface RelatedItem {
  responsibilityId: string;
  title: string;
  type: string;
  status: string;
  similarity: number;
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
  // COMMITMENT
  MARK_AT_RISK: "危険な状態にする",
  MARK_ACTIVE: "リスク解消",
  FULFILL: "履行済みにする",
  BREAK: "不履行にする",
  // DECISION
  START_GATHERING: "検討を開始する",
  DECIDE: "決定する",
  // WAITING
  MARK_FOLLOW_UP_DUE: "追跡期限にする",
  RESOLVE: "解決済みにする",
  // RISK
  START_MONITORING: "監視を開始する",
  MITIGATE: "軽減済みにする",
  OCCUR: "発生扱いにする",
  CLOSE: "終了する",
};

/**
 * [2026-08-21追加] ワイヤーフレームv2で承認済みのボタン色体系を実装へ反映。
 * 従来は全ボタンが黒塗り(bg-ink)で「どれも同じで見分けづらい」との指摘があった。
 * 操作の意味(開始=前進/完了=ゴール/中断・延期=一時停止/不要=否定)ごとに色を変える。
 */
const ACTION_BUTTON_STYLE: Record<TransitionAction, string> = {
  START: "bg-blue-600 text-white hover:bg-blue-700",
  RESUME: "bg-blue-600 text-white hover:bg-blue-700",
  START_GATHERING: "bg-blue-600 text-white hover:bg-blue-700",
  START_MONITORING: "bg-blue-600 text-white hover:bg-blue-700",
  COMPLETE: "bg-safe text-white hover:opacity-90",
  FULFILL: "bg-safe text-white hover:opacity-90",
  RESOLVE: "bg-safe text-white hover:opacity-90",
  DECIDE: "bg-safe text-white hover:opacity-90",
  MITIGATE: "bg-safe text-white hover:opacity-90",
  CLOSE: "bg-safe text-white hover:opacity-90",
  MARK_ACTIVE: "bg-safe text-white hover:opacity-90",
  PARTIAL_COMPLETE: "bg-brand-50 text-brand-700 border border-brand hover:bg-brand-100",
  DEFER: "bg-warn-50 text-warn border border-warn/40 hover:bg-warn-50/70",
  MARK_FOLLOW_UP_DUE: "bg-warn-50 text-warn border border-warn/40 hover:bg-warn-50/70",
  INTERRUPT: "bg-canvas text-muted border border-line hover:bg-line/40",
  MARK_AT_RISK: "bg-red-50 text-red-700 border border-red-200 hover:bg-red-100",
  OCCUR: "bg-red-50 text-red-700 border border-red-200 hover:bg-red-100",
  BREAK: "bg-red-50 text-red-700 border border-red-200 hover:bg-red-100",
  MARK_NOT_NEEDED: "bg-transparent text-muted border border-line hover:bg-canvas",
  REOPEN: "bg-transparent text-muted border border-line hover:bg-canvas",
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
  const router = useRouter();
  const searchParams = useSearchParams();
  const [items, setItems] = useState<ResponsibilityListItem[]>([]);
  const [loadingList, setLoadingList] = useState(true);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [detail, setDetail] = useState<ResponsibilityDetail | null>(null);
  const [related, setRelated] = useState<RelatedItem[]>([]);
  // parents/childrenはPertMiniPanel導入により画面には出さなくなったが、APIは後方互換で
  // 返し続けるため受け皿として残す(将来の別用途やデバッグ確認用)。
  const [, setParents] = useState<DependencyItem[]>([]);
  const [, setChildren] = useState<DependencyItem[]>([]);
  const [pertNodes, setPertNodes] = useState<PertNodeItem[]>([]);
  const [loadingDetail, setLoadingDetail] = useState(false);
  const [transitioning, setTransitioning] = useState(false);
  const [quickActingId, setQuickActingId] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [filterType, setFilterType] = useState<string | null>(null);
  const [hideDone, setHideDone] = useState(true);
  const [minImportance, setMinImportance] = useState(0);
  const [blockedOnly, setBlockedOnly] = useState(false);
  const [sortBy, setSortBy] = useState<"targetAt" | "importance" | "related">("targetAt");
  const [view, setView] = useState<"list" | "calendar">("list");

  // [2026-08-21追加] タイトル/詳細のインライン編集、タグ管理
  const [allTags, setAllTags] = useState<ResponsibilityTagRef[]>([]);
  const [editing, setEditing] = useState(false);
  const [editTitle, setEditTitle] = useState("");
  const [editDescription, setEditDescription] = useState("");
  // [2026-08-21追加] 「期日など一般的なタスク管理ツールの要素がない」との指摘に対応。
  // hardDeadlineAt(固定期限)・targetAt(目標日時)・importance(重要度)は元々API・
  // カレンダービュー(hardDeadlineAt優先)は対応済みだったが、編集するUIが一つも
  // 無かったため設定できなかった。datetime-local入力は秒未満を持たないため、
  // 保存時にISO文字列へ変換する。
  const [editHardDeadline, setEditHardDeadline] = useState("");
  const [editTargetAt, setEditTargetAt] = useState("");
  const [editImportance, setEditImportance] = useState<number>(0);
  const [savingEdit, setSavingEdit] = useState(false);
  const [newTagName, setNewTagName] = useState("");
  const [savingTag, setSavingTag] = useState(false);

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
    const [detailRes, relatedRes, depsRes] = await Promise.all([
      debugFetch(`/api/v1/responsibilities/${id}`),
      debugFetch(`/api/v1/responsibilities/${id}/related`),
      debugFetch(`/api/v1/responsibilities/${id}/dependencies`),
    ]);
    if (detailRes.ok) {
      const body = await detailRes.json();
      setDetail(body.data.responsibility);
    }
    if (relatedRes.ok) {
      const body = await relatedRes.json();
      setRelated(body.data.related);
    } else {
      setRelated([]);
    }
    if (depsRes.ok) {
      const body = await depsRes.json();
      setParents(body.data.parents);
      setChildren(body.data.children);
      setPertNodes(body.data.nodes ?? []);
    } else {
      setParents([]);
      setChildren([]);
      setPertNodes([]);
    }
    setLoadingDetail(false);
  }, []);

  const loadTags = useCallback(async () => {
    const res = await debugFetch("/api/v1/tags");
    if (res.ok) {
      const body = await res.json();
      setAllTags(body.data.tags);
    }
  }, []);

  useEffect(() => {
    loadList();
    loadTags();
  }, [loadList, loadTags]);

  useEffect(() => {
    if (selectedId) loadDetail(selectedId);
    setEditing(false);
  }, [selectedId, loadDetail]);

  // [2026-08-20追加] /relationsの関係図からノードをクリックした際、「今後TOPに
  // 移動するだけで該当項目が分からない」という不備を修正する。?focus=IDを見て
  // 自動選択し、該当行までスクロールする。
  useEffect(() => {
    const focus = searchParams.get("focus");
    if (focus) {
      setSelectedId(focus);
      requestAnimationFrame(() => {
        document.getElementById(`resp-row-${focus}`)?.scrollIntoView({ block: "center", behavior: "smooth" });
      });
    }
  }, [searchParams]);

  /** ISO文字列 → <input type="datetime-local">の値(タイムゾーンはブラウザのローカル)。 */
  function toDatetimeLocalValue(iso: string | null): string {
    if (!iso) return "";
    const d = new Date(iso);
    const pad = (n: number) => String(n).padStart(2, "0");
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
  }

  function startEditing() {
    if (!detail) return;
    setEditTitle(detail.title);
    setEditDescription(detail.description ?? "");
    setEditHardDeadline(toDatetimeLocalValue(detail.hardDeadlineAt));
    setEditTargetAt(toDatetimeLocalValue(detail.targetAt));
    setEditImportance(detail.importance ?? 0);
    setEditing(true);
  }

  async function saveEditing() {
    if (!detail || !editTitle.trim()) return;
    setSavingEdit(true);
    try {
      const res = await apiFetch(`/api/v1/responsibilities/${detail.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          title: editTitle.trim(),
          description: editDescription.trim() || null,
          hardDeadlineAt: editHardDeadline ? new Date(editHardDeadline).toISOString() : null,
          targetAt: editTargetAt ? new Date(editTargetAt).toISOString() : null,
          importance: editImportance > 0 ? editImportance : null,
          version: detail.version,
        }),
      });
      if (res.ok) {
        setEditing(false);
        await Promise.all([loadDetail(detail.id), loadList()]);
      } else {
        const body = await res.json().catch(() => null);
        setError(body?.error?.message ?? "更新に失敗しました");
      }
    } finally {
      setSavingEdit(false);
    }
  }

  /** タグの付け外し。押した瞬間に即PATCHで反映する(保存ボタンを別途設けない)。 */
  async function toggleTag(tagId: string) {
    if (!detail) return;
    const current = detail.tags.map((t) => t.id);
    const nextTagIds = current.includes(tagId) ? current.filter((id) => id !== tagId) : [...current, tagId];
    const res = await apiFetch(`/api/v1/responsibilities/${detail.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ tagIds: nextTagIds, version: detail.version }),
    });
    if (res.ok) {
      await Promise.all([loadDetail(detail.id), loadList()]);
    }
  }

  async function createAndAttachTag() {
    if (!detail || !newTagName.trim()) return;
    setSavingTag(true);
    try {
      const createRes = await apiFetch("/api/v1/tags", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: newTagName.trim() }),
      });
      if (!createRes.ok) return;
      const createBody = await createRes.json();
      const tagId = createBody.data.tag.id as string;
      setNewTagName("");
      await loadTags();
      await toggleTag(tagId);
    } finally {
      setSavingTag(false);
    }
  }

  function selectItem(id: string) {
    debugLog.event("ResponsibilitiesClient", "select item", { id });
    setSelectedId(id);
    router.replace(`/responsibilities?focus=${id}`, { scroll: false });
  }

  const typeCounts = useMemo(() => {
    const counts: Record<string, number> = {};
    for (const i of items) counts[i.type] = (counts[i.type] ?? 0) + 1;
    return counts;
  }, [items]);
  const availableTypes = RESPONSIBILITY_TYPES.filter((t) => (typeCounts[t] ?? 0) > 0);

  const visibleItems = useMemo(() => {
    const filtered = items.filter((i) => {
      if (filterType && i.type !== filterType) return false;
      if (hideDone && TERMINAL_STATUSES.has(i.status)) return false;
      if ((i.importance ?? 0) < minImportance) return false;
      if (blockedOnly && i.blockedByCount === 0) return false;
      return true;
    });
    const sorted = [...filtered];
    if (sortBy === "importance") {
      sorted.sort((a, b) => (b.importance ?? 0) - (a.importance ?? 0));
    } else if (sortBy === "related") {
      sorted.sort((a, b) => b.blockedByCount + b.childrenCount - (a.blockedByCount + a.childrenCount));
    } else {
      sorted.sort((a, b) => {
        if (!a.targetAt && !b.targetAt) return 0;
        if (!a.targetAt) return 1;
        if (!b.targetAt) return -1;
        return new Date(a.targetAt).getTime() - new Date(b.targetAt).getTime();
      });
    }
    return sorted;
  }, [items, filterType, hideDone, minImportance, blockedOnly, sortBy]);

  /** この責任状態から一番自然な「次の一歩」を1つだけ選ぶ(一覧のホバー操作ボタン用)。 */
  function quickActionFor(item: ResponsibilityListItem): TransitionAction | null {
    const actions = transitionsForType(item.type)
      .filter((r) => (r.from as readonly string[]).includes(item.status))
      .map((r) => r.action);
    if (actions.includes("COMPLETE")) return "COMPLETE";
    if (actions.includes("START")) return "START";
    if (actions.includes("DECIDE")) return null; // 理由入力が必須のため一覧からの即時実行はしない
    if (actions.includes("RESOLVE")) return "RESOLVE";
    if (actions.includes("FULFILL")) return "FULFILL";
    return actions[0] ?? null;
  }

  /** 一覧行のホバーボタンから直接遷移を実行する(詳細パネルを開かずに完結させる)。 */
  async function quickTransition(item: ResponsibilityListItem, action: TransitionAction) {
    setQuickActingId(item.id);
    try {
      const res = await apiFetch(`/api/v1/responsibilities/${item.id}/transitions`, {
        method: "POST",
        body: JSON.stringify({ action, occurredAt: new Date().toISOString(), version: item.version }),
      });
      if (res.ok) {
        await loadList();
        if (selectedId === item.id) await loadDetail(item.id);
      }
    } finally {
      setQuickActingId(null);
    }
  }

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

    // API・イベント設計書v1.1 4.3節: PARTIAL_COMPLETEはcompletedScope/remainingWorkの
    // いずれかが必須。専用モーダルはまだ無いため、window.promptで残作業を確認する(MVP簡易対応)。
    let remainingWork: string | undefined;
    if (action === "PARTIAL_COMPLETE") {
      const input = window.prompt("残っている作業を入力してください(空欄でキャンセル)");
      if (!input || !input.trim()) return;
      remainingWork = input.trim();
    }

    // DECISION完了条件(Webシステム要件定義書v2.1 7.1節「選択と理由が記録」): DECIDEはreason必須。
    let reason: string | undefined;
    if (action === "DECIDE") {
      const input = window.prompt("決定理由を入力してください(空欄でキャンセル)");
      if (!input || !input.trim()) return;
      reason = input.trim();
    }

    debugLog.event("ResponsibilitiesClient", "transition", { id: detail.id, action });
    setTransitioning(true);
    setError("");
    try {
      const res = await apiFetch(`/api/v1/responsibilities/${detail.id}/transitions`, {
        method: "POST",
        body: JSON.stringify({
          action,
          occurredAt: new Date().toISOString(),
          version: detail.version,
          ...(remainingWork ? { remainingWork } : {}),
          ...(reason ? { reason } : {}),
        }),
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
    if (!detail) return [];
    return transitionsForType(detail.type)
      .filter((r) => (r.from as readonly string[]).includes(detail.status))
      .map((r) => r.action);
  }, [detail]);

  return (
    <div>
      <div className="mb-6 flex items-start justify-between gap-3">
        <div>
          <h1 className="font-serif text-3xl">今後</h1>
          <p className="text-sm text-muted mt-1">タスク・約束・判断・待ちを期限順に確認します</p>
        </div>
        <div className="flex items-center gap-2">
          <div className="flex gap-0.5 bg-canvas border border-line rounded-lg p-0.5">
            <button
              onClick={() => setView("list")}
              className={`text-xs px-3 py-1.5 rounded-md font-medium transition ${
                view === "list" ? "bg-surface shadow-sm text-ink" : "text-muted"
              }`}
            >
              リスト
            </button>
            <button
              onClick={() => setView("calendar")}
              className={`text-xs px-3 py-1.5 rounded-md font-medium transition ${
                view === "calendar" ? "bg-surface shadow-sm text-ink" : "text-muted"
              }`}
            >
              カレンダー
            </button>
          </div>
          <button
            onClick={() => setShowCreate((v) => !v)}
            className="shrink-0 bg-ink text-white text-sm font-medium px-4 py-2 rounded-xl hover:bg-black transition"
          >
            {showCreate ? "閉じる" : "＋ 新しく登録する"}
          </button>
        </div>
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
      ) : view === "calendar" ? (
        <CalendarView items={visibleItems} onSelect={selectItem} />
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
            </div>
            <div className="flex flex-wrap items-center gap-2 text-[11px] text-muted">
              <label className="flex items-center gap-1.5">
                <input type="checkbox" checked={hideDone} onChange={(e) => setHideDone(e.target.checked)} />
                完了を隠す
              </label>
              <label className="flex items-center gap-1.5">
                <input type="checkbox" checked={blockedOnly} onChange={(e) => setBlockedOnly(e.target.checked)} />
                前提ありのみ
              </label>
              <select
                value={minImportance}
                onChange={(e) => setMinImportance(Number(e.target.value))}
                className="border border-line rounded-md px-1.5 py-1 bg-surface text-[11px]"
              >
                <option value={0}>重要度: すべて</option>
                <option value={3}>重要度3以上</option>
                <option value={4}>重要度4以上</option>
                <option value={5}>重要度5のみ</option>
              </select>
              <select
                value={sortBy}
                onChange={(e) => setSortBy(e.target.value as typeof sortBy)}
                className="border border-line rounded-md px-1.5 py-1 bg-surface text-[11px] ml-auto"
              >
                <option value="targetAt">並び替え: 期限順</option>
                <option value="importance">並び替え: 重要度順</option>
                <option value="related">並び替え: 関連数順</option>
              </select>
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
                const qa = quickActionFor(item);
                const busy = quickActingId === item.id;
                return (
                  <div key={item.id} id={`resp-row-${item.id}`}>
                    <div
                      className={`group w-full rounded-lg pl-3 pr-2 py-2.5 border-l-[3px] transition flex items-start gap-1 ${
                        selected ? "bg-brand-50 border-l-brand" : "border-l-transparent hover:bg-canvas"
                      }`}
                    >
                      <button onClick={() => selectItem(item.id)} className="min-w-0 flex-1 text-left">
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
                              {item.importance ? (
                                <span className="text-[10px] text-amber-600" title={`重要度${item.importance}/5`}>
                                  {"★".repeat(item.importance)}
                                  <span className="text-line">{"★".repeat(5 - item.importance)}</span>
                                </span>
                              ) : null}
                              {item.hardDeadlineAt && (
                                <span className="text-[11px] text-warn font-mono">
                                  期限 {new Date(item.hardDeadlineAt).toLocaleDateString("ja-JP", { month: "short", day: "numeric" })}
                                </span>
                              )}
                              {item.blockedByCount > 0 && (
                                <span className="text-[10px] px-1.5 py-0.5 rounded bg-decide-50 text-decide" title="この完了に必要な前提の件数">
                                  🔗前提{item.blockedByCount}
                                </span>
                              )}
                              {item.childrenCount > 0 && (
                                <span className="text-[10px] px-1.5 py-0.5 rounded bg-ai-50 text-ai" title="これの完了を待っている後続の件数">
                                  ⛓️後続{item.childrenCount}
                                </span>
                              )}
                            </div>
                          </div>
                        </div>
                      </button>
                      {qa && (
                        <button
                          onClick={() => quickTransition(item, qa)}
                          disabled={busy}
                          title={ACTION_LABEL[qa]}
                          className="shrink-0 hidden group-hover:flex items-center justify-center w-6 h-6 rounded-md border border-line bg-surface text-muted hover:border-brand hover:text-brand disabled:opacity-40 mt-1"
                        >
                          {qa === "COMPLETE" || qa === "RESOLVE" || qa === "FULFILL" ? "✓" : "▶"}
                        </button>
                      )}
                    </div>
                  </div>
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
                  {editing ? (
                    <div className="space-y-2">
                      <input
                        value={editTitle}
                        onChange={(e) => setEditTitle(e.target.value)}
                        className="w-full text-base font-serif border border-line rounded-lg px-3 py-2 focus:outline-none focus:border-brand"
                        autoFocus
                      />
                      <textarea
                        value={editDescription}
                        onChange={(e) => setEditDescription(e.target.value)}
                        placeholder="詳細・備考メモ(任意)"
                        rows={4}
                        className="w-full text-sm border border-line rounded-lg px-3 py-2 focus:outline-none focus:border-brand resize-y"
                      />
                      <div className="grid grid-cols-3 gap-2">
                        <div>
                          <label className="block text-[10.5px] text-faint mb-1">固定期限</label>
                          <input
                            type="datetime-local"
                            value={editHardDeadline}
                            onChange={(e) => setEditHardDeadline(e.target.value)}
                            className="w-full text-xs border border-line rounded-lg px-2 py-1.5 focus:outline-none focus:border-brand"
                          />
                        </div>
                        <div>
                          <label className="block text-[10.5px] text-faint mb-1">目標日時</label>
                          <input
                            type="datetime-local"
                            value={editTargetAt}
                            onChange={(e) => setEditTargetAt(e.target.value)}
                            className="w-full text-xs border border-line rounded-lg px-2 py-1.5 focus:outline-none focus:border-brand"
                          />
                        </div>
                        <div>
                          <label className="block text-[10.5px] text-faint mb-1">重要度</label>
                          <select
                            value={editImportance}
                            onChange={(e) => setEditImportance(Number(e.target.value))}
                            className="w-full text-xs border border-line rounded-lg px-2 py-1.5 focus:outline-none focus:border-brand"
                          >
                            <option value={0}>未設定</option>
                            {[1, 2, 3, 4, 5].map((n) => (
                              <option key={n} value={n}>
                                {n}
                              </option>
                            ))}
                          </select>
                        </div>
                      </div>
                      <div className="flex gap-2">
                        <button
                          onClick={saveEditing}
                          disabled={savingEdit || !editTitle.trim()}
                          className="text-xs bg-ink text-white rounded-lg px-3 py-1.5 disabled:opacity-40"
                        >
                          {savingEdit ? "保存中..." : "保存する"}
                        </button>
                        <button
                          onClick={() => setEditing(false)}
                          className="text-xs border border-line rounded-lg px-3 py-1.5 text-muted"
                        >
                          キャンセル
                        </button>
                      </div>
                    </div>
                  ) : (
                    <div className="group relative">
                      <p className="text-base font-serif leading-relaxed">{detail.title}</p>
                      {detail.description && (
                        <p className="text-sm text-muted whitespace-pre-wrap mt-1">{detail.description}</p>
                      )}
                      <button
                        onClick={startEditing}
                        className="absolute top-0 right-0 text-[11px] text-faint opacity-0 group-hover:opacity-100 border border-line rounded-md px-2 py-1 hover:text-ink hover:border-ink transition"
                      >
                        編集する
                      </button>
                    </div>
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

                  {/* [2026-08-21追加] タグ管理。既存タグはクリックで付け外し、新規はその場で作成できる。 */}
                  <div className="pt-2 border-t border-line">
                    <p className="text-[10.5px] font-semibold text-faint uppercase tracking-wide mb-1.5">タグ</p>
                    <div className="flex flex-wrap items-center gap-1.5">
                      {allTags.map((tag) => {
                        const attached = detail.tags.some((t) => t.id === tag.id);
                        return (
                          <button
                            key={tag.id}
                            onClick={() => toggleTag(tag.id)}
                            className="text-[10.5px] px-2 py-1 rounded-full font-medium border transition"
                            style={
                              attached
                                ? { background: tag.color, color: "#fff", borderColor: tag.color }
                                : { background: "transparent", color: tag.color, borderColor: tag.color }
                            }
                          >
                            {tag.name}
                          </button>
                        );
                      })}
                      <input
                        value={newTagName}
                        onChange={(e) => setNewTagName(e.target.value)}
                        onKeyDown={(e) => e.key === "Enter" && createAndAttachTag()}
                        placeholder="+ 新規タグ"
                        className="text-[11px] border border-dashed border-line rounded-full px-2.5 py-1 w-24 focus:outline-none focus:border-brand"
                      />
                      {newTagName.trim() && (
                        <button
                          onClick={createAndAttachTag}
                          disabled={savingTag}
                          className="text-[10.5px] bg-ink text-white rounded-full px-2.5 py-1 disabled:opacity-40"
                        >
                          追加
                        </button>
                      )}
                    </div>
                  </div>
                </div>

                {/* [2026-08-21追加] 先行・後続タスクを右側パネル内にPERT図として表示。
                    従来リスト側にテキストで展開していたが「使いづらい」との指摘を受け撤去し、
                    ここへ統合した(ワイヤーフレームv2で合意済みの配置)。 */}
                {pertNodes.length > 1 && (
                  <div className="border-t border-line px-5 py-4">
                    <div className="flex items-center justify-between mb-2">
                      <p className="text-xs font-semibold text-ink">前提・後続関係(PERT図)</p>
                      <button
                        onClick={() => router.push(`/relations?focus=${detail.id}`)}
                        className="text-[10.5px] text-brand-700 hover:underline"
                      >
                        全体を編集 →
                      </button>
                    </div>
                    <PertMiniPanel centerId={detail.id} nodes={pertNodes} onSelect={selectItem} />
                  </div>
                )}

                {related.length > 0 && (
                  <div className="border-t border-line bg-ai-50/60 px-5 py-4">
                    <p className="text-xs font-semibold text-ink mb-2">関連する可能性がある責任</p>
                    <ul className="space-y-1.5">
                      {related.map((r) => (
                        <li key={r.responsibilityId} className="flex items-center justify-between gap-2 text-xs">
                          <button
                            onClick={() => selectItem(r.responsibilityId)}
                            className="text-ink hover:underline text-left truncate"
                          >
                            {r.title}
                          </button>
                          <span className="shrink-0 text-faint">
                            類似度 {Math.round(r.similarity * 100)}%
                          </span>
                        </li>
                      ))}
                    </ul>
                    <p className="text-[10px] text-faint mt-2">
                      意味的な近さのみを示しています(重複・関連の種別判定は未実装です)。
                    </p>
                  </div>
                )}

                <div className="border-t border-line bg-canvas/60 px-5 py-4">
                  <div className="flex flex-wrap items-center gap-2">
                    {availableActions.length === 0 && (
                      <p className="text-[11px] text-faint">この状態から遷移できる操作はありません。</p>
                    )}
                    {availableActions.map((action) => (
                      <button
                        key={action}
                        onClick={() => runTransition(action)}
                        disabled={transitioning}
                        className={`text-xs font-semibold rounded-lg px-3 py-2 disabled:opacity-40 transition ${ACTION_BUTTON_STYLE[action] ?? "bg-ink text-white hover:bg-black"}`}
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

/**
 * カレンダービュー(2026-08-20新設)。hardDeadlineAt優先、無ければtargetAtで日付に配置する。
 * 「今後」画面内のタブ切替で表示する簡易月表示(ガントチャートではない)。
 */
function CalendarView({
  items,
  onSelect,
}: {
  items: ResponsibilityListItem[];
  onSelect: (id: string) => void;
}) {
  const [cursor, setCursor] = useState(() => {
    const now = new Date();
    return new Date(now.getFullYear(), now.getMonth(), 1);
  });

  const year = cursor.getFullYear();
  const month = cursor.getMonth();
  const firstDow = new Date(year, month, 1).getDay();
  const daysInMonth = new Date(year, month + 1, 0).getDate();
  const todayStr = new Date().toDateString();

  const byDate = useMemo(() => {
    const map = new Map<string, ResponsibilityListItem[]>();
    for (const item of items) {
      const dateStr = item.hardDeadlineAt ?? item.targetAt;
      if (!dateStr) continue;
      const d = new Date(dateStr);
      if (d.getFullYear() !== year || d.getMonth() !== month) continue;
      const key = d.getDate();
      const arr = map.get(String(key)) ?? [];
      arr.push(item);
      map.set(String(key), arr);
    }
    return map;
    // eslint-disable-next-line react-hooks/exhaustive-deps -- year/monthはcursorから毎回導出される値のため、
    // cursorのみを依存に含めれば十分(year/monthを含めるとReact CompilerがpreserveManualMemoizationで
    // 誤検知するため、意図的にcursorのみとする)。
  }, [items, cursor]);

  const cells: (number | null)[] = [...Array(firstDow).fill(null), ...Array.from({ length: daysInMonth }, (_, i) => i + 1)];

  return (
    <div className="bg-surface border border-line rounded-2xl shadow-card p-5">
      <div className="flex items-center justify-between mb-4">
        <button
          onClick={() => setCursor(new Date(year, month - 1, 1))}
          className="text-xs border border-line rounded-md px-2 py-1 hover:bg-canvas"
        >
          ← 前月
        </button>
        <p className="text-sm font-semibold">
          {year}年{month + 1}月
        </p>
        <button
          onClick={() => setCursor(new Date(year, month + 1, 1))}
          className="text-xs border border-line rounded-md px-2 py-1 hover:bg-canvas"
        >
          翌月 →
        </button>
      </div>
      <div className="grid grid-cols-7 gap-1.5">
        {["日", "月", "火", "水", "木", "金", "土"].map((d) => (
          <div key={d} className="text-[10px] text-faint text-center pb-1">
            {d}
          </div>
        ))}
        {cells.map((day, idx) => {
          if (day === null) return <div key={`empty-${idx}`} />;
          const dateObj = new Date(year, month, day);
          const isToday = dateObj.toDateString() === todayStr;
          const dayItems = byDate.get(String(day)) ?? [];
          return (
            <div key={day} className="border border-line rounded-lg min-h-[74px] p-1.5 bg-canvas/40">
              <span
                className={`text-[10px] inline-flex items-center justify-center ${
                  isToday ? "w-4 h-4 rounded-full bg-ink text-white" : "text-faint"
                }`}
              >
                {day}
              </span>
              <div className="mt-1 space-y-0.5">
                {dayItems.slice(0, 3).map((it) => (
                  <button
                    key={it.id}
                    onClick={() => onSelect(it.id)}
                    className={`block w-full text-left text-[9.5px] px-1 py-0.5 rounded truncate ${
                      TYPE_CHIP_STYLE[it.type] ?? "bg-canvas text-muted"
                    }`}
                    title={it.title}
                  >
                    {it.title}
                  </button>
                ))}
                {dayItems.length > 3 && <p className="text-[9px] text-faint px-1">+{dayItems.length - 3}件</p>}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
