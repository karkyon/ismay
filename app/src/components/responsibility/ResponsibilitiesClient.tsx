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

interface OriginCaptureRef {
  id: string;
  sourceType: string;
  aiSummary: string | null;
  rawText: string | null;
  createdAt: string;
}

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
  /** 新設(2026-08-21): どのInboxメモから生成されたか。手動作成の場合はnull。 */
  originCaptureId: string | null;
  originCapture: OriginCaptureRef | null;
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

/** 新設(2026-08-22): TBL-007〜010種別固有詳細。schema.prismaには存在したが、
 *  API/UIとも一度も配線されていなかった(カルキョンさんの指摘で発覚)。 */
interface TaskDetailRef {
  estimatedMinutesMin: number | null;
  estimatedMinutesMax: number | null;
  location: string | null;
  requiredTools: string[] | null;
}
interface CommitmentDetailRef {
  counterpartyName: string | null;
  counterpartyContact: string | null;
  promiseText: string | null;
}
interface DecisionDetailRef {
  options: string[] | null;
  chosenOption: string | null;
  rationale: string | null;
  decidedAt: string | null;
}
interface WaitingDetailRef {
  waitingOn: string | null;
  expectedReplyBy: string | null;
  followUpAt: string | null;
}

interface ConstraintRef {
  id: string;
  constraintType: string;
  value: { text?: string } | null;
  note: string | null;
  createdAt: string;
}

interface RecurrenceRuleRef {
  id: string;
  frequency: string;
  interval: number;
  weekdays: number[] | null;
  exceptions: string[] | null;
  pausedUntil: string | null;
  carryoverPolicy: string;
  lastGeneratedAt: string | null;
}

interface ResponsibilityDetail extends ResponsibilityListItem {
  description: string | null;
  sourceKind: string;
  originCaptureId: string | null;
  tags: ResponsibilityTagRef[];
  taskDetail: TaskDetailRef | null;
  commitmentDetail: CommitmentDetailRef | null;
  decisionDetail: DecisionDetailRef | null;
  waitingDetail: WaitingDetailRef | null;
  constraints: ConstraintRef[];
  recurrenceRule: RecurrenceRuleRef | null;
}

interface RelatedItem {
  responsibilityId: string;
  title: string;
  type: string;
  status: string;
  similarity: number;
}

/** [2026-08-23追加] FN-CONS-01 制約種別ラベル。schema.prisma Constraint.constraintTypeの値域。 */
const CONSTRAINT_TYPE_LABEL: Record<string, string> = {
  DEADLINE: "期限",
  LOCATION: "場所",
  PERMISSION: "権限",
  RESOURCE: "道具・資源",
  CAPACITY: "体力・認知強度",
};

/** [2026-08-23追加] FN-REC-01 定期責任ラベル。 */
const RECURRENCE_FREQUENCY_LABEL: Record<string, string> = {
  DAILY: "毎日",
  WEEKLY: "毎週",
  MONTHLY: "毎月",
};
const RECURRENCE_CARRYOVER_LABEL: Record<string, string> = {
  CARRY: "そのまま繰越",
  DROP: "破棄して仕切り直す",
  RENOTIFY: "再通知のみ",
};
const WEEKDAY_LABEL = ["日", "月", "火", "水", "木", "金", "土"];

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

/** [2026-08-21新設] 元メモバッジ用の短いsourceTypeラベル(aiSummary/rawTextが無い場合のフォールバック)。 */
const SOURCE_TYPE_LABEL_SHORT: Record<string, string> = {
  TEXT: "テキスト",
  VOICE: "音声",
  MEETING: "会議",
  IMPORT: "取込",
  IMAGE: "画像",
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
  // [2026-08-22追加] カルキョンさんの指摘「関連性の無い独立したタスクでもPERT図を編集し
  // 関連性を後から編集できるようにしろ」に対応。従来はpertNodes.length<=1(=関連ゼロ)の
  // 場合、PERT図セクション自体が非表示になり、この画面から一切関係を追加できなかった。
  const [addRelationOpen, setAddRelationOpen] = useState(false);
  const [addingRelation, setAddingRelation] = useState(false);
  const [addRelationError, setAddRelationError] = useState("");
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

  // [2026-08-23追加] FN-WK-04 一括操作(FR-WK-09)。チェックボックス選択+一括操作バー。
  const [selectionMode, setSelectionMode] = useState(false);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [bulkBusy, setBulkBusy] = useState(false);
  const [bulkError, setBulkError] = useState("");
  const [bulkTagPickerOpen, setBulkTagPickerOpen] = useState(false);
  const [bulkTagMode, setBulkTagMode] = useState<"ADD_TAG" | "REMOVE_TAG">("ADD_TAG");
  type BulkUndoState = { label: string; undo: Record<string, unknown> };
  const [bulkUndo, setBulkUndo] = useState<BulkUndoState | null>(null);

  // [2026-08-23追加] FN-CONS-01 制約(TBL-011)。責任詳細に付随する制約の追加・削除。
  const [constraintFormOpen, setConstraintFormOpen] = useState(false);
  const [constraintType, setConstraintType] = useState("LOCATION");
  const [constraintText, setConstraintText] = useState("");
  const [constraintNote, setConstraintNote] = useState("");
  const [savingConstraint, setSavingConstraint] = useState(false);
  const [constraintError, setConstraintError] = useState("");

  // [2026-08-23追加] FN-REC-01 定期責任(TBL-020)。責任詳細でのルール編集用。
  const [recurrenceFormOpen, setRecurrenceFormOpen] = useState(false);
  const [recFrequency, setRecFrequency] = useState<"DAILY" | "WEEKLY" | "MONTHLY">("WEEKLY");
  const [recInterval, setRecInterval] = useState(1);
  const [recWeekdays, setRecWeekdays] = useState<Set<number>>(new Set());
  const [recCarryoverPolicy, setRecCarryoverPolicy] = useState<"CARRY" | "DROP" | "RENOTIFY">("CARRY");
  const [savingRecurrence, setSavingRecurrence] = useState(false);
  const [recurrenceError, setRecurrenceError] = useState("");

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
  // [2026-08-22追加] カルキョンさんの指摘「期日や着手などの日付のことを指示したはず」に
  // 対応。startAfterAt(開始可能日時)はAPI・DBには元々あったが、編集フォームに
  // 入力欄が一つも無く、設定する手段が存在しなかった(実コード確認で発覚)。
  const [editStartAfterAt, setEditStartAfterAt] = useState("");
  const [editImportance, setEditImportance] = useState<number>(0);
  // [2026-08-22新設] 種別固有詳細情報(TBL-007〜010)。schema.prismaにはテーブルが
  // 存在したが、編集するAPI・UIが一つも配線されていなかった(実コード確認で発覚)。
  const [editEstMinMin, setEditEstMinMin] = useState("");
  const [editEstMinMax, setEditEstMinMax] = useState("");
  const [editLocation, setEditLocation] = useState("");
  const [editRequiredTools, setEditRequiredTools] = useState("");
  const [editCounterpartyName, setEditCounterpartyName] = useState("");
  const [editCounterpartyContact, setEditCounterpartyContact] = useState("");
  const [editPromiseText, setEditPromiseText] = useState("");
  const [editOptions, setEditOptions] = useState("");
  const [editChosenOption, setEditChosenOption] = useState("");
  const [editRationale, setEditRationale] = useState("");
  const [editDecidedAt, setEditDecidedAt] = useState("");
  const [editWaitingOn, setEditWaitingOn] = useState("");
  const [editExpectedReplyBy, setEditExpectedReplyBy] = useState("");
  const [editFollowUpAt, setEditFollowUpAt] = useState("");
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

  /** [2026-08-23追加] FN-WK-04 一括操作。選択トグル・一括実行・Undo。 */
  function toggleSelect(id: string) {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function exitSelectionMode() {
    setSelectionMode(false);
    setSelectedIds(new Set());
    setBulkError("");
  }

  async function runBulkAction(action: "COMPLETE" | "DELETE" | "ADD_TAG" | "REMOVE_TAG", tagId?: string) {
    if (selectedIds.size === 0) return;
    const ids = [...selectedIds];
    const label =
      action === "COMPLETE" ? "完了" : action === "DELETE" ? "削除" : action === "ADD_TAG" ? "タグ付与" : "タグ削除";
    if (!confirm(`選択した${ids.length}件を「${label}」します。よろしいですか?`)) return;

    setBulkBusy(true);
    setBulkError("");
    try {
      const res = await apiFetch("/api/v1/responsibilities/bulk", {
        method: "POST",
        body: JSON.stringify({ ids, action, tagId }),
      });
      const body = await res.json().catch(() => null);
      if (!res.ok) {
        setBulkError(body?.error?.message ?? "一括操作に失敗しました");
        return;
      }
      const { affected, skipped, undo } = body.data;
      debugLog.event("ResponsibilitiesClient", "bulk action done", { action, affected, skipped: skipped.length });
      if (undo) {
        setBulkUndo({ label: `${label}(${affected}件)`, undo });
      }
      exitSelectionMode();
      await loadList();
      if (detail && ids.includes(detail.id)) {
        setSelectedId(null);
        setDetail(null);
      }
    } finally {
      setBulkBusy(false);
    }
  }

  async function undoBulkAction() {
    if (!bulkUndo) return;
    setBulkBusy(true);
    setBulkError("");
    try {
      const res = await apiFetch("/api/v1/responsibilities/bulk/undo", {
        method: "POST",
        body: JSON.stringify(bulkUndo.undo),
      });
      const body = await res.json().catch(() => null);
      if (!res.ok) {
        // [2026-08-25是正・外部監査再評価対応] 従来はres.okを確認せず、失敗時
        // (409 IDEMPOTENCY_KEY_REUSED、400 VALIDATION_FAILED等)もbulkUndoを
        // 消してUIから取消操作自体を隠してしまい、ユーザーへ失敗理由が一切
        // 伝わらなかった。失敗時はbulkUndoを保持し(再試行や状況確認ができるよう)、
        // runBulkActionと同じ形でエラーメッセージを表示する。
        setBulkError(body?.error?.message ?? "取り消しに失敗しました");
        return;
      }
      setBulkUndo(null);
      await loadList();
    } finally {
      setBulkBusy(false);
    }
  }

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
    setEditStartAfterAt(toDatetimeLocalValue(detail.startAfterAt));
    setEditImportance(detail.importance ?? 0);
    // [2026-08-22新設] 種別固有詳細情報の初期値をセットする。
    setEditEstMinMin(detail.taskDetail?.estimatedMinutesMin?.toString() ?? "");
    setEditEstMinMax(detail.taskDetail?.estimatedMinutesMax?.toString() ?? "");
    setEditLocation(detail.taskDetail?.location ?? "");
    setEditRequiredTools((detail.taskDetail?.requiredTools ?? []).join("、"));
    setEditCounterpartyName(detail.commitmentDetail?.counterpartyName ?? "");
    setEditCounterpartyContact(detail.commitmentDetail?.counterpartyContact ?? "");
    setEditPromiseText(detail.commitmentDetail?.promiseText ?? "");
    setEditOptions((detail.decisionDetail?.options ?? []).join("、"));
    setEditChosenOption(detail.decisionDetail?.chosenOption ?? "");
    setEditRationale(detail.decisionDetail?.rationale ?? "");
    setEditDecidedAt(toDatetimeLocalValue(detail.decisionDetail?.decidedAt ?? null));
    setEditWaitingOn(detail.waitingDetail?.waitingOn ?? "");
    setEditExpectedReplyBy(toDatetimeLocalValue(detail.waitingDetail?.expectedReplyBy ?? null));
    setEditFollowUpAt(toDatetimeLocalValue(detail.waitingDetail?.followUpAt ?? null));
    setEditing(true);
  }

  async function saveEditing() {
    if (!detail || !editTitle.trim()) return;
    setSavingEdit(true);
    try {
      // [2026-08-22追加] 種別(detail.type)に応じた詳細情報を、対応するキーのみ
      // ペイロードへ含める(他種別のdetailキーは送らない。APIも種別不一致を拒否する)。
      const detailPayload: Record<string, unknown> = {};
      if (detail.type === "TASK") {
        detailPayload.taskDetail = {
          estimatedMinutesMin: editEstMinMin ? Number(editEstMinMin) : null,
          estimatedMinutesMax: editEstMinMax ? Number(editEstMinMax) : null,
          location: editLocation.trim() || null,
          requiredTools: editRequiredTools.trim()
            ? editRequiredTools.split(/[、,]/).map((s) => s.trim()).filter(Boolean)
            : null,
        };
      } else if (detail.type === "COMMITMENT") {
        detailPayload.commitmentDetail = {
          counterpartyName: editCounterpartyName.trim() || null,
          counterpartyContact: editCounterpartyContact.trim() || null,
          promiseText: editPromiseText.trim() || null,
        };
      } else if (detail.type === "DECISION") {
        detailPayload.decisionDetail = {
          options: editOptions.trim() ? editOptions.split(/[、,]/).map((s) => s.trim()).filter(Boolean) : null,
          chosenOption: editChosenOption.trim() || null,
          rationale: editRationale.trim() || null,
          decidedAt: editDecidedAt ? new Date(editDecidedAt).toISOString() : null,
        };
      } else if (detail.type === "WAITING") {
        detailPayload.waitingDetail = {
          waitingOn: editWaitingOn.trim() || null,
          expectedReplyBy: editExpectedReplyBy ? new Date(editExpectedReplyBy).toISOString() : null,
          followUpAt: editFollowUpAt ? new Date(editFollowUpAt).toISOString() : null,
        };
      }

      const res = await apiFetch(`/api/v1/responsibilities/${detail.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          title: editTitle.trim(),
          description: editDescription.trim() || null,
          hardDeadlineAt: editHardDeadline ? new Date(editHardDeadline).toISOString() : null,
          targetAt: editTargetAt ? new Date(editTargetAt).toISOString() : null,
          startAfterAt: editStartAfterAt ? new Date(editStartAfterAt).toISOString() : null,
          importance: editImportance > 0 ? editImportance : null,
          version: detail.version,
          ...detailPayload,
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

  /** [2026-08-23追加] FN-CONS-01 制約の追加。編集用のライフサイクル管理列がschema.prismaに
   * 無いため、編集は「削除して追加し直す」で対応する(deleteConstraint参照)。 */
  async function addConstraint(e: React.FormEvent) {
    e.preventDefault();
    if (!detail || !constraintText.trim()) return;
    setConstraintError("");
    setSavingConstraint(true);
    try {
      const res = await apiFetch(`/api/v1/responsibilities/${detail.id}/constraints`, {
        method: "POST",
        body: JSON.stringify({
          constraintType,
          text: constraintText.trim(),
          note: constraintNote.trim() || null,
        }),
      });
      const body = await res.json().catch(() => null);
      if (!res.ok) {
        setConstraintError(body?.error?.message ?? "制約の追加に失敗しました");
        return;
      }
      setConstraintText("");
      setConstraintNote("");
      setConstraintFormOpen(false);
      await loadDetail(detail.id);
    } finally {
      setSavingConstraint(false);
    }
  }

  async function deleteConstraint(constraintId: string) {
    if (!detail) return;
    const res = await apiFetch(`/api/v1/responsibilities/${detail.id}/constraints/${constraintId}`, {
      method: "DELETE",
    });
    if (res.ok) {
      await loadDetail(detail.id);
    }
  }

  /** [2026-08-23追加] FN-REC-01 定期責任ルールの編集開始。既存ルールがあれば値を復元する。 */
  function openRecurrenceForm() {
    if (detail?.recurrenceRule) {
      const r = detail.recurrenceRule;
      setRecFrequency(r.frequency as "DAILY" | "WEEKLY" | "MONTHLY");
      setRecInterval(r.interval);
      setRecWeekdays(new Set(r.weekdays ?? []));
      setRecCarryoverPolicy(r.carryoverPolicy as "CARRY" | "DROP" | "RENOTIFY");
    } else {
      setRecFrequency("WEEKLY");
      setRecInterval(1);
      setRecWeekdays(new Set());
      setRecCarryoverPolicy("CARRY");
    }
    setRecurrenceError("");
    setRecurrenceFormOpen(true);
  }

  function toggleRecWeekday(day: number) {
    setRecWeekdays((prev) => {
      const next = new Set(prev);
      if (next.has(day)) next.delete(day);
      else next.add(day);
      return next;
    });
  }

  async function saveRecurrence(e: React.FormEvent) {
    e.preventDefault();
    if (!detail) return;
    setRecurrenceError("");
    setSavingRecurrence(true);
    try {
      const res = await apiFetch(`/api/v1/responsibilities/${detail.id}/recurrence`, {
        method: "PUT",
        body: JSON.stringify({
          frequency: recFrequency,
          interval: recInterval,
          weekdays: recFrequency === "WEEKLY" && recWeekdays.size > 0 ? [...recWeekdays] : null,
          carryoverPolicy: recCarryoverPolicy,
        }),
      });
      const body = await res.json().catch(() => null);
      if (!res.ok) {
        setRecurrenceError(body?.error?.message ?? "定期ルールの保存に失敗しました");
        return;
      }
      setRecurrenceFormOpen(false);
      await loadDetail(detail.id);
    } finally {
      setSavingRecurrence(false);
    }
  }

  async function deleteRecurrence() {
    if (!detail) return;
    const res = await apiFetch(`/api/v1/responsibilities/${detail.id}/recurrence`, { method: "DELETE" });
    if (res.ok) {
      await loadDetail(detail.id);
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

  // [2026-08-22新設] フローティング「関連タスクを追加」メニュー用。現在のPERT図に
  // 既に含まれる(=関連済みの)タスクと自分自身を除外し、残りを元メモ(Capture)ごとに
  // グルーピングする。RelationGraphClient.tsxのaddableGroupsと同じ考え方。
  const addableGroups = useMemo(() => {
    if (!detail) return [];
    const excludeIds = new Set<string>([detail.id, ...pertNodes.map((n) => n.id)]);
    const map = new Map<string, { label: string; items: ResponsibilityListItem[] }>();
    for (const it of items) {
      if (excludeIds.has(it.id)) continue;
      const key = it.originCaptureId ?? "__none__";
      const label = it.originCapture
        ? it.originCapture.aiSummary ||
          it.originCapture.rawText?.slice(0, 24) ||
          SOURCE_TYPE_LABEL_SHORT[it.originCapture.sourceType] ||
          "メモ"
        : "手動作成(元メモなし)";
      const existing = map.get(key);
      if (existing) {
        existing.items.push(it);
      } else {
        map.set(key, { label, items: [it] });
      }
    }
    return Array.from(map.entries()).map(([key, v]) => ({ key, ...v }));
  }, [items, pertNodes, detail]);

  async function addRelation(otherId: string, direction: "prerequisite" | "successor") {
    if (!detail) return;
    setAddingRelation(true);
    setAddRelationError("");
    // direction="prerequisite": otherIdがこのタスクの前提(先に完了させる側)。
    // direction="successor": このタスクがotherIdの前提になる(このタスクが先)。
    // fromId=前提側、toId=後続側というAPIの向きに合わせる(responsibility-relations/route.ts参照)。
    const body =
      direction === "prerequisite" ? { fromId: otherId, toId: detail.id } : { fromId: detail.id, toId: otherId };
    try {
      const res = await apiFetch("/api/v1/responsibility-relations", { method: "POST", body: JSON.stringify(body) });
      if (res.ok) {
        await loadDetail(detail.id);
        await loadList();
        setAddRelationOpen(false);
      } else {
        const b = await res.json().catch(() => null);
        setAddRelationError(b?.error?.message ?? "関連付けに失敗しました");
      }
    } catch {
      setAddRelationError("通信に失敗しました。ネットワーク状態を確認してもう一度お試しください");
    } finally {
      setAddingRelation(false);
    }
  }

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
          {view === "list" && (
            <button
              onClick={() => (selectionMode ? exitSelectionMode() : setSelectionMode(true))}
              className={`text-xs px-3 py-2 rounded-lg font-medium border transition ${
                selectionMode ? "border-brand bg-brand-50 text-brand-700" : "border-line text-muted hover:bg-canvas"
              }`}
            >
              {selectionMode ? "選択をやめる" : "選択"}
            </button>
          )}
          <button
            onClick={() => setShowCreate((v) => !v)}
            className="shrink-0 bg-ink text-white text-sm font-medium px-4 py-2 rounded-xl hover:bg-black transition"
          >
            {showCreate ? "閉じる" : "＋ 新しく登録する"}
          </button>
        </div>
      </div>

      {/* [2026-08-23新設] FN-WK-04 一括操作バー。選択中のみ表示。 */}
      {selectionMode && (
        <div className="mb-4 bg-ink text-white rounded-xl px-4 py-3 flex items-center gap-3 flex-wrap sticky top-0 z-10 shadow-pop">
          <span className="text-sm font-medium">{selectedIds.size}件選択中</span>
          <div className="flex items-center gap-2 ml-auto flex-wrap">
            <button
              onClick={() => runBulkAction("COMPLETE")}
              disabled={bulkBusy || selectedIds.size === 0}
              className="text-xs bg-white/15 hover:bg-white/25 rounded-lg px-3 py-1.5 disabled:opacity-40"
            >
              完了にする
            </button>
            <button
              onClick={() => {
                setBulkTagMode("ADD_TAG");
                setBulkTagPickerOpen(true);
              }}
              disabled={bulkBusy || selectedIds.size === 0}
              className="text-xs bg-white/15 hover:bg-white/25 rounded-lg px-3 py-1.5 disabled:opacity-40"
            >
              タグ付与
            </button>
            <button
              onClick={() => {
                setBulkTagMode("REMOVE_TAG");
                setBulkTagPickerOpen(true);
              }}
              disabled={bulkBusy || selectedIds.size === 0}
              className="text-xs bg-white/15 hover:bg-white/25 rounded-lg px-3 py-1.5 disabled:opacity-40"
            >
              タグ削除
            </button>
            <button
              onClick={() => runBulkAction("DELETE")}
              disabled={bulkBusy || selectedIds.size === 0}
              className="text-xs bg-red-500/80 hover:bg-red-500 rounded-lg px-3 py-1.5 disabled:opacity-40"
            >
              削除
            </button>
            <button onClick={exitSelectionMode} className="text-xs text-white/70 hover:text-white px-2">
              閉じる
            </button>
          </div>
          {bulkError && <p className="w-full text-xs text-red-200">{bulkError}</p>}
        </div>
      )}

      {bulkTagPickerOpen && (
        <div
          className="fixed inset-0 bg-black/30 z-40 flex items-center justify-center p-4"
          onClick={() => setBulkTagPickerOpen(false)}
        >
          <div
            onClick={(e) => e.stopPropagation()}
            className="bg-surface rounded-2xl shadow-pop w-full max-w-xs p-4"
          >
            <p className="text-sm font-medium text-ink mb-3">
              {bulkTagMode === "ADD_TAG" ? "付与するタグを選択" : "削除するタグを選択"}
            </p>
            <div className="flex flex-wrap gap-1.5 mb-3">
              {allTags.map((tag) => (
                <button
                  key={tag.id}
                  onClick={() => {
                    setBulkTagPickerOpen(false);
                    void runBulkAction(bulkTagMode, tag.id);
                  }}
                  className="text-xs px-2.5 py-1 rounded-full border border-line hover:border-brand hover:bg-brand-50"
                  style={{ borderColor: tag.color }}
                >
                  {tag.name}
                </button>
              ))}
              {allTags.length === 0 && <p className="text-xs text-faint">タグがまだありません</p>}
            </div>
            <button onClick={() => setBulkTagPickerOpen(false)} className="text-xs text-faint hover:underline">
              キャンセル
            </button>
          </div>
        </div>
      )}

      {bulkUndo && (
        <div className="mb-4 bg-canvas border border-line rounded-xl px-4 py-2.5 flex flex-wrap items-center gap-3 text-sm">
          <span className="text-ink">{bulkUndo.label}を実行しました</span>
          <button onClick={undoBulkAction} disabled={bulkBusy} className="text-brand-700 font-medium hover:underline ml-auto">
            元に戻す
          </button>
          <button onClick={() => setBulkUndo(null)} className="text-faint hover:text-ink">
            ✕
          </button>
          {/* [2026-08-25追加・外部監査再評価対応] selectionModeは既に終了している
              (runBulkActionがexitSelectionMode()を呼ぶ)ため、undoBulkActionの
              失敗理由はここに表示しないとユーザーに一切伝わらない。 */}
          {bulkError && <p className="w-full text-xs text-red-600">{bulkError}</p>}
        </div>
      )}

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
                const checked = selectedIds.has(item.id);
                return (
                  <div key={item.id} id={`resp-row-${item.id}`}>
                    <div
                      className={`group w-full rounded-lg pl-3 pr-2 py-2.5 border-l-[3px] transition flex items-start gap-1 ${
                        selected ? "bg-brand-50 border-l-brand" : "border-l-transparent hover:bg-canvas"
                      }`}
                    >
                      {selectionMode && (
                        <input
                          type="checkbox"
                          checked={checked}
                          onChange={() => toggleSelect(item.id)}
                          className="shrink-0 mt-2.5 mr-1"
                          onClick={(e) => e.stopPropagation()}
                        />
                      )}
                      <button
                        onClick={() => (selectionMode ? toggleSelect(item.id) : selectItem(item.id))}
                        className="min-w-0 flex-1 text-left"
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
                              {/* [2026-08-21新設] カルキョンさんの指摘「どのInboxからの生成タスクか
                                  判別できるようにしろ」に対応。クリックで元メモへ遷移する。 */}
                              {item.originCapture && (
                                <span
                                  onClick={(e) => {
                                    e.stopPropagation();
                                    router.push(`/inbox?focus=${item.originCaptureId}`);
                                  }}
                                  title="元メモを開く"
                                  className="text-[10px] px-1.5 py-0.5 rounded bg-canvas text-faint hover:text-ink hover:bg-line/60 cursor-pointer truncate max-w-[140px]"
                                >
                                  📄{" "}
                                  {item.originCapture.aiSummary ||
                                    item.originCapture.rawText?.slice(0, 20) ||
                                    SOURCE_TYPE_LABEL_SHORT[item.originCapture.sourceType] ||
                                    "元メモ"}
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
                      <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
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
                        {/* [2026-08-22新設] カルキョンさんの指摘「着手などの日付」に対応。
                            API/DBには元々あったが編集フォームに入力欄が存在しなかった。 */}
                        <div>
                          <label className="block text-[10.5px] text-faint mb-1">開始可能日(着手)</label>
                          <input
                            type="datetime-local"
                            value={editStartAfterAt}
                            onChange={(e) => setEditStartAfterAt(e.target.value)}
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

                      {/* [2026-08-22新設] 種別固有詳細情報(TBL-007〜010)。detail.typeに応じて
                          該当セクションのみ表示する。schema.prismaにはテーブルが存在したが、
                          編集するUIが一つも配線されていなかった(カルキョンさんの指摘で発覚)。 */}
                      {detail.type === "TASK" && (
                        <div className="border-t border-line pt-3 mt-1">
                          <p className="text-[10.5px] font-semibold text-faint uppercase tracking-wide mb-2">作業の詳細</p>
                          <div className="grid grid-cols-2 gap-2 mb-2">
                            <div>
                              <label className="block text-[10.5px] text-faint mb-1">所要時間(分・最小)</label>
                              <input
                                type="number"
                                min={0}
                                value={editEstMinMin}
                                onChange={(e) => setEditEstMinMin(e.target.value)}
                                className="w-full text-xs border border-line rounded-lg px-2 py-1.5 focus:outline-none focus:border-brand"
                              />
                            </div>
                            <div>
                              <label className="block text-[10.5px] text-faint mb-1">所要時間(分・最大)</label>
                              <input
                                type="number"
                                min={0}
                                value={editEstMinMax}
                                onChange={(e) => setEditEstMinMax(e.target.value)}
                                className="w-full text-xs border border-line rounded-lg px-2 py-1.5 focus:outline-none focus:border-brand"
                              />
                            </div>
                          </div>
                          <div className="mb-2">
                            <label className="block text-[10.5px] text-faint mb-1">場所</label>
                            <input
                              type="text"
                              value={editLocation}
                              onChange={(e) => setEditLocation(e.target.value)}
                              placeholder="例: 東田工場、事務所"
                              className="w-full text-xs border border-line rounded-lg px-2 py-1.5 focus:outline-none focus:border-brand"
                            />
                          </div>
                          <div>
                            <label className="block text-[10.5px] text-faint mb-1">必要な道具・準備物(読点区切り)</label>
                            <input
                              type="text"
                              value={editRequiredTools}
                              onChange={(e) => setEditRequiredTools(e.target.value)}
                              placeholder="例: 脚立、養生シート"
                              className="w-full text-xs border border-line rounded-lg px-2 py-1.5 focus:outline-none focus:border-brand"
                            />
                          </div>
                        </div>
                      )}

                      {detail.type === "COMMITMENT" && (
                        <div className="border-t border-line pt-3 mt-1">
                          <p className="text-[10.5px] font-semibold text-faint uppercase tracking-wide mb-2">約束の詳細</p>
                          <div className="grid grid-cols-2 gap-2 mb-2">
                            <div>
                              <label className="block text-[10.5px] text-faint mb-1">相手方</label>
                              <input
                                type="text"
                                value={editCounterpartyName}
                                onChange={(e) => setEditCounterpartyName(e.target.value)}
                                placeholder="例: 西田さん(越智製作所)"
                                className="w-full text-xs border border-line rounded-lg px-2 py-1.5 focus:outline-none focus:border-brand"
                              />
                            </div>
                            <div>
                              <label className="block text-[10.5px] text-faint mb-1">連絡先</label>
                              <input
                                type="text"
                                value={editCounterpartyContact}
                                onChange={(e) => setEditCounterpartyContact(e.target.value)}
                                placeholder="電話・メール等"
                                className="w-full text-xs border border-line rounded-lg px-2 py-1.5 focus:outline-none focus:border-brand"
                              />
                            </div>
                          </div>
                          <div>
                            <label className="block text-[10.5px] text-faint mb-1">約束の内容</label>
                            <textarea
                              value={editPromiseText}
                              onChange={(e) => setEditPromiseText(e.target.value)}
                              rows={2}
                              className="w-full text-xs border border-line rounded-lg px-2 py-1.5 focus:outline-none focus:border-brand resize-y"
                            />
                          </div>
                        </div>
                      )}

                      {detail.type === "DECISION" && (
                        <div className="border-t border-line pt-3 mt-1">
                          <p className="text-[10.5px] font-semibold text-faint uppercase tracking-wide mb-2">判断の詳細</p>
                          <div className="mb-2">
                            <label className="block text-[10.5px] text-faint mb-1">選択肢(読点区切り)</label>
                            <input
                              type="text"
                              value={editOptions}
                              onChange={(e) => setEditOptions(e.target.value)}
                              placeholder="例: A社に発注、B社に発注、自社対応"
                              className="w-full text-xs border border-line rounded-lg px-2 py-1.5 focus:outline-none focus:border-brand"
                            />
                          </div>
                          <div className="grid grid-cols-2 gap-2 mb-2">
                            <div>
                              <label className="block text-[10.5px] text-faint mb-1">選んだ選択肢</label>
                              <input
                                type="text"
                                value={editChosenOption}
                                onChange={(e) => setEditChosenOption(e.target.value)}
                                className="w-full text-xs border border-line rounded-lg px-2 py-1.5 focus:outline-none focus:border-brand"
                              />
                            </div>
                            <div>
                              <label className="block text-[10.5px] text-faint mb-1">決定日時</label>
                              <input
                                type="datetime-local"
                                value={editDecidedAt}
                                onChange={(e) => setEditDecidedAt(e.target.value)}
                                className="w-full text-xs border border-line rounded-lg px-2 py-1.5 focus:outline-none focus:border-brand"
                              />
                            </div>
                          </div>
                          <div>
                            <label className="block text-[10.5px] text-faint mb-1">判断理由</label>
                            <textarea
                              value={editRationale}
                              onChange={(e) => setEditRationale(e.target.value)}
                              rows={2}
                              className="w-full text-xs border border-line rounded-lg px-2 py-1.5 focus:outline-none focus:border-brand resize-y"
                            />
                          </div>
                        </div>
                      )}

                      {detail.type === "WAITING" && (
                        <div className="border-t border-line pt-3 mt-1">
                          <p className="text-[10.5px] font-semibold text-faint uppercase tracking-wide mb-2">待ちの詳細</p>
                          <div className="mb-2">
                            <label className="block text-[10.5px] text-faint mb-1">何を待っているか</label>
                            <input
                              type="text"
                              value={editWaitingOn}
                              onChange={(e) => setEditWaitingOn(e.target.value)}
                              placeholder="例: NTTからの見積回答"
                              className="w-full text-xs border border-line rounded-lg px-2 py-1.5 focus:outline-none focus:border-brand"
                            />
                          </div>
                          <div className="grid grid-cols-2 gap-2">
                            <div>
                              <label className="block text-[10.5px] text-faint mb-1">回答予定日</label>
                              <input
                                type="datetime-local"
                                value={editExpectedReplyBy}
                                onChange={(e) => setEditExpectedReplyBy(e.target.value)}
                                className="w-full text-xs border border-line rounded-lg px-2 py-1.5 focus:outline-none focus:border-brand"
                              />
                            </div>
                            <div>
                              <label className="block text-[10.5px] text-faint mb-1">追跡(催促)日</label>
                              <input
                                type="datetime-local"
                                value={editFollowUpAt}
                                onChange={(e) => setEditFollowUpAt(e.target.value)}
                                className="w-full text-xs border border-line rounded-lg px-2 py-1.5 focus:outline-none focus:border-brand"
                              />
                            </div>
                          </div>
                        </div>
                      )}
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
                    // [2026-08-22修正] カルキョンさんの指摘「これらのパラメータはどこで編集するんじゃ」に対応。
                    // 従来は`opacity-0 group-hover:opacity-100`でマウスホバー時のみ編集ボタンが
                    // 現れる実装になっており、ホバーしない限り編集ボタンの存在自体が画面から
                    // 一切見えない(発見不可能な)UIになっていた。常時表示のボタンに変更する。
                    <div className="flex items-start justify-between gap-3">
                      <div className="min-w-0">
                        <p className="text-base font-serif leading-relaxed">{detail.title}</p>
                        {detail.description && (
                          <p className="text-sm text-muted whitespace-pre-wrap mt-1">{detail.description}</p>
                        )}
                      </div>
                      <button
                        onClick={startEditing}
                        className="shrink-0 text-[11px] text-muted border border-line rounded-md px-2.5 py-1.5 hover:text-ink hover:border-ink hover:bg-canvas transition"
                      >
                        ✎ 編集する
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

                  {/* [2026-08-22新設] 種別固有詳細情報(TBL-007〜010)の読み取り専用表示。
                      「編集する」から入力できる。値が一つも無い場合は何も表示しない。 */}
                  {detail.type === "TASK" &&
                    detail.taskDetail &&
                    (detail.taskDetail.estimatedMinutesMin ||
                      detail.taskDetail.estimatedMinutesMax ||
                      detail.taskDetail.location ||
                      (detail.taskDetail.requiredTools?.length ?? 0) > 0) && (
                      <div className="bg-canvas rounded-lg px-3 py-2 text-xs text-ink space-y-0.5">
                        {(detail.taskDetail.estimatedMinutesMin || detail.taskDetail.estimatedMinutesMax) && (
                          <p>
                            所要時間: {detail.taskDetail.estimatedMinutesMin ?? "?"}〜{detail.taskDetail.estimatedMinutesMax ?? "?"}分
                          </p>
                        )}
                        {detail.taskDetail.location && <p>場所: {detail.taskDetail.location}</p>}
                        {(detail.taskDetail.requiredTools?.length ?? 0) > 0 && (
                          <p>準備物: {detail.taskDetail.requiredTools!.join("、")}</p>
                        )}
                      </div>
                    )}
                  {detail.type === "COMMITMENT" &&
                    detail.commitmentDetail &&
                    (detail.commitmentDetail.counterpartyName || detail.commitmentDetail.promiseText) && (
                      <div className="bg-canvas rounded-lg px-3 py-2 text-xs text-ink space-y-0.5">
                        {detail.commitmentDetail.counterpartyName && (
                          <p>
                            相手方: {detail.commitmentDetail.counterpartyName}
                            {detail.commitmentDetail.counterpartyContact ? `(${detail.commitmentDetail.counterpartyContact})` : ""}
                          </p>
                        )}
                        {detail.commitmentDetail.promiseText && <p>約束: {detail.commitmentDetail.promiseText}</p>}
                      </div>
                    )}
                  {detail.type === "DECISION" &&
                    detail.decisionDetail &&
                    ((detail.decisionDetail.options?.length ?? 0) > 0 ||
                      detail.decisionDetail.chosenOption ||
                      detail.decisionDetail.rationale) && (
                      <div className="bg-canvas rounded-lg px-3 py-2 text-xs text-ink space-y-0.5">
                        {(detail.decisionDetail.options?.length ?? 0) > 0 && (
                          <p>選択肢: {detail.decisionDetail.options!.join("、")}</p>
                        )}
                        {detail.decisionDetail.chosenOption && <p>選んだ選択肢: {detail.decisionDetail.chosenOption}</p>}
                        {detail.decisionDetail.decidedAt && (
                          <p>決定日時: {new Date(detail.decisionDetail.decidedAt).toLocaleString("ja-JP")}</p>
                        )}
                        {detail.decisionDetail.rationale && <p>理由: {detail.decisionDetail.rationale}</p>}
                      </div>
                    )}
                  {detail.type === "WAITING" &&
                    detail.waitingDetail &&
                    (detail.waitingDetail.waitingOn || detail.waitingDetail.expectedReplyBy || detail.waitingDetail.followUpAt) && (
                      <div className="bg-canvas rounded-lg px-3 py-2 text-xs text-ink space-y-0.5">
                        {detail.waitingDetail.waitingOn && <p>待っている内容: {detail.waitingDetail.waitingOn}</p>}
                        {detail.waitingDetail.expectedReplyBy && (
                          <p>回答予定日: {new Date(detail.waitingDetail.expectedReplyBy).toLocaleString("ja-JP")}</p>
                        )}
                        {detail.waitingDetail.followUpAt && (
                          <p>追跡(催促)日: {new Date(detail.waitingDetail.followUpAt).toLocaleString("ja-JP")}</p>
                        )}
                      </div>
                    )}

                  {/* [2026-08-21新設] カルキョンさんの指摘「もともとどんな文書、音声、画像で
                      抽出したものか正確に把握できないといけない」に対応。 */}
                  {detail.originCapture ? (
                    <button
                      onClick={() => router.push(`/inbox?focus=${detail.originCapture!.id}`)}
                      className="w-full text-left bg-canvas hover:bg-line/40 border border-line rounded-lg px-3 py-2 transition"
                    >
                      <p className="text-[10px] font-semibold text-faint uppercase tracking-wide mb-0.5">
                        元メモ({SOURCE_TYPE_LABEL_SHORT[detail.originCapture.sourceType] ?? detail.originCapture.sourceType}・
                        {new Date(detail.originCapture.createdAt).toLocaleDateString("ja-JP")})
                      </p>
                      <p className="text-xs text-ink line-clamp-2">
                        {detail.originCapture.aiSummary || detail.originCapture.rawText || "(本文なし)"}
                      </p>
                    </button>
                  ) : (
                    <p className="text-[11px] text-faint">手動で作成された責任です(元メモはありません)</p>
                  )}

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

                  {/* [2026-08-23新設] FN-CONS-01 制約(TBL-011)。期限・場所・権限・道具・体力等、
                      その責任を実行するうえでの制約条件。編集は削除→追加し直す方式。 */}
                  <div className="pt-2 border-t border-line">
                    <div className="flex items-center justify-between mb-1.5">
                      <p className="text-[10.5px] font-semibold text-faint uppercase tracking-wide">制約</p>
                      <button
                        onClick={() => setConstraintFormOpen((v) => !v)}
                        className="text-[10.5px] text-brand-700 hover:underline"
                      >
                        {constraintFormOpen ? "閉じる" : "+ 追加"}
                      </button>
                    </div>
                    {detail.constraints.length > 0 && (
                      <ul className="space-y-1 mb-2">
                        {detail.constraints.map((c) => (
                          <li
                            key={c.id}
                            className="flex items-start justify-between gap-2 bg-canvas rounded-lg px-2.5 py-1.5 text-[11px]"
                          >
                            <div className="min-w-0">
                              <span className="font-medium text-ink">
                                {CONSTRAINT_TYPE_LABEL[c.constraintType] ?? c.constraintType}
                              </span>
                              <span className="text-muted"> — {c.value?.text ?? ""}</span>
                              {c.note && <p className="text-faint mt-0.5">{c.note}</p>}
                            </div>
                            <button
                              onClick={() => deleteConstraint(c.id)}
                              className="shrink-0 text-faint hover:text-red-600"
                              aria-label="制約を削除"
                            >
                              ✕
                            </button>
                          </li>
                        ))}
                      </ul>
                    )}
                    {constraintFormOpen && (
                      <form onSubmit={addConstraint} className="space-y-1.5 bg-canvas rounded-lg p-2.5">
                        <select
                          value={constraintType}
                          onChange={(e) => setConstraintType(e.target.value)}
                          className="w-full text-[11px] border border-line rounded-md px-2 py-1 bg-surface"
                        >
                          {Object.entries(CONSTRAINT_TYPE_LABEL).map(([k, v]) => (
                            <option key={k} value={k}>
                              {v}
                            </option>
                          ))}
                        </select>
                        <input
                          value={constraintText}
                          onChange={(e) => setConstraintText(e.target.value)}
                          placeholder="制約の内容(例: 〇〇オフィスのみ)"
                          required
                          className="w-full text-[11px] border border-line rounded-md px-2 py-1"
                        />
                        <input
                          value={constraintNote}
                          onChange={(e) => setConstraintNote(e.target.value)}
                          placeholder="補足(任意)"
                          className="w-full text-[11px] border border-line rounded-md px-2 py-1"
                        />
                        {constraintError && <p className="text-[11px] text-red-600">{constraintError}</p>}
                        <button
                          type="submit"
                          disabled={savingConstraint || !constraintText.trim()}
                          className="text-[10.5px] bg-ink text-white rounded-full px-2.5 py-1 disabled:opacity-40"
                        >
                          {savingConstraint ? "保存中..." : "追加する"}
                        </button>
                      </form>
                    )}
                  </div>

                  {/* [2026-08-23新設] FN-REC-01 定期責任(TBL-020)。曜日・間隔・繰越方針を設定できる。 */}
                  <div className="pt-2 border-t border-line">
                    <div className="flex items-center justify-between mb-1.5">
                      <p className="text-[10.5px] font-semibold text-faint uppercase tracking-wide">定期責任</p>
                      {!recurrenceFormOpen && (
                        <button onClick={openRecurrenceForm} className="text-[10.5px] text-brand-700 hover:underline">
                          {detail.recurrenceRule ? "編集" : "+ 定期化する"}
                        </button>
                      )}
                    </div>
                    {!recurrenceFormOpen && detail.recurrenceRule && (
                      <div className="bg-canvas rounded-lg px-2.5 py-1.5 text-[11px] text-ink space-y-0.5">
                        <p>
                          {RECURRENCE_FREQUENCY_LABEL[detail.recurrenceRule.frequency] ?? detail.recurrenceRule.frequency}
                          {detail.recurrenceRule.interval > 1 ? `(${detail.recurrenceRule.interval}回に1回)` : ""}
                          {detail.recurrenceRule.frequency === "WEEKLY" && detail.recurrenceRule.weekdays && detail.recurrenceRule.weekdays.length > 0 && (
                            <> ・{detail.recurrenceRule.weekdays.map((d) => WEEKDAY_LABEL[d]).join("")}曜</>
                          )}
                        </p>
                        <p className="text-faint">
                          未完了時: {RECURRENCE_CARRYOVER_LABEL[detail.recurrenceRule.carryoverPolicy] ?? detail.recurrenceRule.carryoverPolicy}
                        </p>
                        <button onClick={deleteRecurrence} className="text-[10.5px] text-red-600 hover:underline mt-1">
                          定期化を解除
                        </button>
                      </div>
                    )}
                    {!recurrenceFormOpen && !detail.recurrenceRule && (
                      <p className="text-[11px] text-faint">この責任は定期化されていません。</p>
                    )}
                    {recurrenceFormOpen && (
                      <form onSubmit={saveRecurrence} className="space-y-1.5 bg-canvas rounded-lg p-2.5">
                        <div className="flex items-center gap-1.5">
                          <select
                            value={recFrequency}
                            onChange={(e) => setRecFrequency(e.target.value as typeof recFrequency)}
                            className="text-[11px] border border-line rounded-md px-2 py-1 bg-surface"
                          >
                            {Object.entries(RECURRENCE_FREQUENCY_LABEL).map(([k, v]) => (
                              <option key={k} value={k}>
                                {v}
                              </option>
                            ))}
                          </select>
                          <input
                            type="number"
                            min={1}
                            max={365}
                            value={recInterval}
                            onChange={(e) => setRecInterval(Number(e.target.value))}
                            className="w-14 text-[11px] border border-line rounded-md px-2 py-1"
                          />
                          <span className="text-[11px] text-faint">回に1回</span>
                        </div>
                        {recFrequency === "WEEKLY" && (
                          <div className="flex gap-1">
                            {WEEKDAY_LABEL.map((label, day) => (
                              <button
                                key={day}
                                type="button"
                                onClick={() => toggleRecWeekday(day)}
                                className={`w-6 h-6 text-[10px] rounded-full border ${
                                  recWeekdays.has(day) ? "bg-ink text-white border-ink" : "border-line text-muted"
                                }`}
                              >
                                {label}
                              </button>
                            ))}
                          </div>
                        )}
                        <div>
                          <label className="text-[10.5px] text-faint block mb-0.5">未完了のまま次回が来たら</label>
                          <select
                            value={recCarryoverPolicy}
                            onChange={(e) => setRecCarryoverPolicy(e.target.value as typeof recCarryoverPolicy)}
                            className="w-full text-[11px] border border-line rounded-md px-2 py-1 bg-surface"
                          >
                            {Object.entries(RECURRENCE_CARRYOVER_LABEL).map(([k, v]) => (
                              <option key={k} value={k}>
                                {v}
                              </option>
                            ))}
                          </select>
                        </div>
                        {recurrenceError && <p className="text-[11px] text-red-600">{recurrenceError}</p>}
                        <div className="flex gap-2">
                          <button
                            type="submit"
                            disabled={savingRecurrence}
                            className="text-[10.5px] bg-ink text-white rounded-full px-2.5 py-1 disabled:opacity-40"
                          >
                            {savingRecurrence ? "保存中..." : "保存する"}
                          </button>
                          <button
                            type="button"
                            onClick={() => setRecurrenceFormOpen(false)}
                            className="text-[10.5px] text-faint hover:underline"
                          >
                            キャンセル
                          </button>
                        </div>
                      </form>
                    )}
                  </div>
                </div>

                {/* [2026-08-21追加] 先行・後続タスクを右側パネル内にPERT図として表示。
                    従来リスト側にテキストで展開していたが「使いづらい」との指摘を受け撤去し、
                    ここへ統合した(ワイヤーフレームv2で合意済みの配置)。
                    [2026-08-22修正] 従来pertNodes.length>1の場合のみこのセクション自体を
                    表示していたため、関連が一件も無い(孤立した)タスクではPERT図欄が
                    画面に一切現れず、この画面から関係を追加する手段が無かった。
                    カルキョンさんの指摘「一つの関連性もないタスクでもPERT図を編集し
                    関連性を後から編集できるようにしろ」に対応し、常時表示に変更した。 */}
                <div className="border-t border-line px-5 py-4">
                  <div className="flex items-center justify-between mb-2">
                    <p className="text-xs font-semibold text-ink">前提・後続関係(PERT図)</p>
                    <div className="flex items-center gap-2">
                      <button
                        onClick={() => {
                          setAddRelationError("");
                          setAddRelationOpen(true);
                        }}
                        className="text-[10.5px] text-ink border border-line rounded-lg px-2.5 py-1 hover:bg-canvas"
                      >
                        + 関連タスクを追加
                      </button>
                      <button
                        onClick={() => router.push(`/relations?focus=${detail.id}`)}
                        className="text-[10.5px] text-brand-700 hover:underline"
                      >
                        全体を編集 →
                      </button>
                    </div>
                  </div>
                  <PertMiniPanel centerId={detail.id} nodes={pertNodes} onSelect={selectItem} />
                </div>

                {/* [2026-08-22新設] フローティング「関連タスクを追加」メニュー。元メモ(Capture)
                    ごとにグルーピングして一覧し、前提/後続のどちらとして追加するか選べる。 */}
                {addRelationOpen && (
                  <div
                    className="fixed inset-0 z-50 bg-black/30 flex items-center justify-center p-6"
                    onClick={() => setAddRelationOpen(false)}
                  >
                    <div
                      className="bg-surface rounded-2xl shadow-2xl w-full max-w-lg max-h-[75vh] flex flex-col p-5"
                      onClick={(e) => e.stopPropagation()}
                    >
                      <div className="flex items-center justify-between mb-3 shrink-0">
                        <p className="text-sm font-semibold text-ink">関連タスクを追加</p>
                        <button
                          onClick={() => setAddRelationOpen(false)}
                          className="text-xs border border-line rounded-lg px-3 py-1.5 hover:bg-canvas"
                        >
                          閉じる ✕
                        </button>
                      </div>
                      <p className="text-[11px] text-faint mb-3">
                        元メモごとに一覧しています。「前提」はこのタスクより先に完了させる作業、「後続」はこのタスクの後に行う作業として関連付けます。
                      </p>
                      <div className="flex-1 min-h-0 overflow-y-auto space-y-4">
                        {addableGroups.length === 0 && <p className="text-xs text-faint">追加できるタスクがありません。</p>}
                        {addableGroups.map((g) => (
                          <div key={g.key}>
                            <p className="text-[10px] text-faint font-mono uppercase tracking-wide mb-1">{g.label}</p>
                            <div className="space-y-1">
                              {g.items.map((item) => (
                                <div key={item.id} className="flex items-center gap-1.5">
                                  <span className="flex-1 text-xs px-2.5 py-1.5 rounded-lg border border-line truncate">
                                    {item.title}
                                  </span>
                                  <button
                                    onClick={() => addRelation(item.id, "prerequisite")}
                                    disabled={addingRelation}
                                    className="text-[10px] border border-line rounded-lg px-2 py-1.5 hover:bg-canvas shrink-0 disabled:opacity-40"
                                  >
                                    前提にする
                                  </button>
                                  <button
                                    onClick={() => addRelation(item.id, "successor")}
                                    disabled={addingRelation}
                                    className="text-[10px] border border-line rounded-lg px-2 py-1.5 hover:bg-canvas shrink-0 disabled:opacity-40"
                                  >
                                    後続にする
                                  </button>
                                </div>
                              ))}
                            </div>
                          </div>
                        ))}
                      </div>
                      {addRelationError && <p className="text-xs text-red-600 mt-2 shrink-0">{addRelationError}</p>}
                    </div>
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
