"use client";

import { useCallback, useEffect, useState, startTransition } from "react";
import Link from "next/link";
import { apiFetch, debugFetch } from "@/lib/auth/client";
import { debugLog } from "@/lib/debug";
import { QuickCaptureForm } from "@/components/capture/QuickCaptureForm";
import { PinIcon } from "@/components/icons";
import { isCommonStatusType, isTypeSpecificTerminalStatus } from "@/lib/responsibility";

/** 共通状態側の終端状態(用語・状態・コード定義書v1.1 3章)。バックログ候補から除外する。 */
const COMMON_TERMINAL_STATUS = new Set(["COMPLETED", "NOT_NEEDED", "CANCELLED"]);

/** ピッカー候補として出してよいか(完了・キャンセル等の終端状態を除外)。 */
function isBacklogEligible(type: string, status: string): boolean {
  if (isCommonStatusType(type)) return !COMMON_TERMINAL_STATUS.has(status);
  return !isTypeSpecificTerminalStatus(type, status);
}

interface CaptureListItem {
  id: string;
  processingStatus: string;
}

interface PlanningCandidate {
  id: string;
  type: string;
  title: string;
  status: string;
  reasonCodes: string[];
}

interface PlanningSummaryItem {
  id: string;
  title: string;
  status: string;
}

interface PlanningNowResponse {
  primary: PlanningCandidate | null;
  alternatives: PlanningCandidate[];
  decisions: PlanningSummaryItem[];
  waitings: PlanningSummaryItem[];
  risks: PlanningSummaryItem[];
}

/** GET /today-summary(2026-08-22新設)の1件。Todoist「今日/近日中/今後」・
 * Things 3のセクション分けに相当する階層バケット表示に使う。 */
interface SummaryItem {
  id: string;
  type: string;
  title: string;
  status: string;
  importance: number | null;
  effectiveAt: string;
  isHardDeadline: boolean;
  pinned: boolean;
}

interface TodaySummaryResponse {
  pinned: SummaryItem[];
  today: SummaryItem[];
  next3Days: SummaryItem[];
  thisWeek: SummaryItem[];
}

/** GET /cycles/current(2026-08-22新設)。週次サイクル(参考: note.com/bingo10の
 * Linear「Cycles」記事)のコミット済みアイテム一覧。 */
interface CycleItemView {
  id: string;
  responsibilityId: string;
  carriedOver: boolean;
  type: string;
  title: string;
  status: string;
  importance: number | null;
  hardDeadlineAt: string | null;
  targetAt: string | null;
}

interface CycleResponse {
  cycle: { id: string; startAt: string; endAt: string; status: string };
  items: CycleItemView[];
  doneCount: number;
  totalCount: number;
}

/** サイクルへ追加するバックログ候補(簡易ピッカー用)。 */
interface BacklogCandidate {
  id: string;
  title: string;
  type: string;
}

/** reasonCodes(lib/planning.ts)の表示ラベル。UIはreasonCodesの値そのものを表示しない。 */
const REASON_LABEL: Record<string, string> = {
  HARD_DEADLINE_OVERDUE: "締切超過",
  HARD_DEADLINE_WITHIN_24H: "締切24時間以内",
  HARD_DEADLINE_WITHIN_72H: "締切72時間以内",
  HARD_DEADLINE_UPCOMING: "締切が近づいています",
  FOLLOW_UP_DUE_NOW: "追跡期限到来",
  FOLLOW_UP_DUE_SOON: "追跡期限が近い",
  TARGET_AT_TODAY: "目標日が本日",
  TARGET_AT_SOON: "目標日が近い",
  HIGH_IMPORTANCE: "重要度が高い",
  NO_STRONG_SIGNAL: "強い要因はありません",
};

function reasonLabels(codes: string[]): string {
  return codes.map((c) => REASON_LABEL[c] ?? c).join("・");
}

function formatEffectiveAt(iso: string): string {
  return new Date(iso).toLocaleString("ja-JP", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" });
}

function formatCycleRange(startAtIso: string, endAtIso: string): string {
  const start = new Date(startAtIso);
  const end = new Date(new Date(endAtIso).getTime() - 1); // endAtは排他的な次週月曜0:00のため表示上は-1ms
  const fmt = (d: Date) => d.toLocaleDateString("ja-JP", { month: "numeric", day: "numeric" });
  return `${fmt(start)} 〜 ${fmt(end)}`;
}

/**
 * UI-03 ホーム／今日。
 * API-PLAN-01(GET /planning/now)による「今やる一つ」(FN-WK-02、依存関係・PEM補正なしの
 * 決定論版)を表示する。ブロック解消・最低ライン・切替コスト・場所権限・スヌーズは
 * lib/planning.tsに明記の理由により今回未対応(assumptionsとしてAPIから返る)。
 */
export function TodayClient() {
  const [captures, setCaptures] = useState<CaptureListItem[]>([]);
  const [planning, setPlanning] = useState<PlanningNowResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [planningLoading, setPlanningLoading] = useState(true);
  // [2026-08-22追加] FN-WK-03「今日の最低ライン」+ Todoist/Things 3的な階層バケット表示。
  const [summary, setSummary] = useState<TodaySummaryResponse | null>(null);
  const [summaryLoading, setSummaryLoading] = useState(true);
  const [pinBusy, setPinBusy] = useState<string | null>(null);
  // [2026-08-22追加] 週次サイクル(参考: note.com/bingo10「個人のタスク管理こそLinear」の
  // Cycles機能)。今週コミットしたタスクの一覧と、バックログからの追加ピッカー。
  const [cycle, setCycle] = useState<CycleResponse | null>(null);
  const [cycleLoading, setCycleLoading] = useState(true);
  const [cycleItemBusy, setCycleItemBusy] = useState<string | null>(null);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [pickerQuery, setPickerQuery] = useState("");
  const [backlog, setBacklog] = useState<BacklogCandidate[]>([]);
  const [backlogLoading, setBacklogLoading] = useState(false);
  // [2026-08-23修正] 検索API(/api/v1/search、d9c31a7で実装済み)を使った絞り込み結果。
  // nullの間はクエリ未入力とみなし、openPicker取得時の直近100件(backlog)を表示する。
  const [searchResults, setSearchResults] = useState<BacklogCandidate[] | null>(null);
  const [searching, setSearching] = useState(false);
  // [2026-08-23新設] FN-PEM-01初回対話の未完了バナー(設計方針: プッシュ通知等での
  // 催促はせず、UI-03に常設の目立たない帯として表示するのみ)。
  const [pemOnboardingIncomplete, setPemOnboardingIncomplete] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    const res = await debugFetch("/api/v1/captures?limit=100");
    if (res.ok) {
      const body = await res.json();
      debugLog.state("TodayClient", "captures", { count: body.data.captures.length });
      setCaptures(body.data.captures);
    }
    setLoading(false);
  }, []);

  const loadPlanning = useCallback(async () => {
    setPlanningLoading(true);
    const res = await debugFetch("/api/v1/planning/now");
    if (res.ok) {
      const body = await res.json();
      debugLog.state("TodayClient", "planning", { hasPrimary: Boolean(body.data.primary) });
      setPlanning(body.data);
    }
    setPlanningLoading(false);
  }, []);

  const loadSummary = useCallback(async () => {
    setSummaryLoading(true);
    const res = await debugFetch("/api/v1/today-summary");
    if (res.ok) {
      const body = await res.json();
      setSummary(body.data);
    }
    setSummaryLoading(false);
  }, []);

  const loadCycle = useCallback(async () => {
    setCycleLoading(true);
    const res = await debugFetch("/api/v1/cycles/current");
    if (res.ok) {
      const body = await res.json();
      setCycle(body.data);
    }
    setCycleLoading(false);
  }, []);

  // [2026-08-23新設] FN-PEM-01対話の未完了確認。読み込み失敗時は「未完了」を誤って
  // 出さないよう、成功時のみ状態を反映する(fail-open: バナーを出さない方向へ倒す)。
  const loadPemOnboardingStatus = useCallback(async () => {
    const res = await debugFetch("/api/v1/pem/onboarding/messages");
    if (res.ok) {
      const body = await res.json();
      setPemOnboardingIncomplete(!body.data.completed);
    }
  }, []);

  const reload = useCallback(() => {
    load();
    loadPlanning();
    loadSummary();
    loadCycle();
    loadPemOnboardingStatus();
  }, [load, loadPlanning, loadSummary, loadCycle, loadPemOnboardingStatus]);

  // [Gate Q0是正] react-hooks/set-state-in-effect対応(既存パターンを踏襲)。
  useEffect(() => {
    startTransition(() => {
      load();
      loadPlanning();
      loadSummary();
      loadCycle();
      loadPemOnboardingStatus();
    });
  }, [load, loadPlanning, loadSummary, loadCycle, loadPemOnboardingStatus]);

  /** ピン留め切替(FN-WK-03、最大3件はAPI側で強制)。versionを都度取得してから送る。 */
  async function togglePin(item: SummaryItem, nextPinned: boolean) {
    setPinBusy(item.id);
    try {
      const detailRes = await apiFetch(`/api/v1/responsibilities/${item.id}`);
      const detailBody = await detailRes.json().catch(() => null);
      const version: number | undefined = detailBody?.data?.responsibility?.version;
      if (!detailRes.ok || version === undefined) {
        debugLog.error("TodayClient", "pin: failed to load version", { id: item.id });
        return;
      }
      const res = await apiFetch(`/api/v1/responsibilities/${item.id}`, {
        method: "PATCH",
        body: JSON.stringify({ pinned: nextPinned, version }),
      });
      if (res.ok) {
        await loadSummary();
      } else {
        const body = await res.json().catch(() => null);
        debugLog.error("TodayClient", "pin failed", body?.error);
      }
    } finally {
      setPinBusy(null);
    }
  }

  /** サイクルからアイテムを外す(バックログへ戻すだけで責任自体は削除しない)。 */
  async function removeFromCycle(responsibilityId: string) {
    setCycleItemBusy(responsibilityId);
    try {
      const res = await apiFetch(`/api/v1/cycles/current/items/${responsibilityId}`, { method: "DELETE" });
      if (res.ok) await loadCycle();
    } finally {
      setCycleItemBusy(null);
    }
  }

  /** バックログ選択ピッカーを開く。クエリ未入力時に表示する直近100件を取得する
   * (全件ブラウズ用。101件を超える候補の検索は下のuseEffectで検索APIを使う)。 */
  async function openPicker() {
    setPickerOpen(true);
    setPickerQuery("");
    setSearchResults(null);
    setBacklogLoading(true);
    const res = await apiFetch("/api/v1/responsibilities?limit=100&sort=updatedAt");
    if (res.ok) {
      const body = await res.json();
      const existingIds = new Set((cycle?.items ?? []).map((i) => i.responsibilityId));
      type RespRow = { id: string; title: string; type: string; status: string; completedAt: string | null };
      const candidates: BacklogCandidate[] = (body.data.responsibilities as RespRow[])
        .filter((r) => !r.completedAt && !existingIds.has(r.id))
        .map((r) => ({ id: r.id, title: r.title, type: r.type }));
      setBacklog(candidates);
    }
    setBacklogLoading(false);
  }

  /** [2026-08-23修正] ピッカーの検索欄への入力を検索API(/api/v1/search、mode=keyword)へ
   * 委譲する(300msデバウンス)。修正前はopenPicker取得時の直近100件のみをクライアント側で
   * タイトル絞り込みしていたため、101件目以降の責任がヒットしなかった(FN-SRCH-01実装
   * (d9c31a7)後に取り残されていたバグ)。クエリが空の間はbacklog(直近100件の全件ブラウズ)を
   * そのまま使い、検索APIは呼ばない(空クエリは検索APIが空配列を返す仕様のため)。 */
  useEffect(() => {
    if (!pickerOpen) return;
    const q = pickerQuery.trim();
    if (!q) {
      // [Gate Q0是正] react-hooks/set-state-in-effect対応。このeffectは
      // `return () => clearTimeout(timer)` というcleanup契約を持つため、effect全体を
      // startTransitionで包むことはできない(cleanup関数はReactへ直接returnする必要が
      // あるため)。フラグされた同期setStateの2件だけを最小範囲で包む。
      startTransition(() => {
        setSearchResults(null);
        setSearching(false);
      });
      return;
    }
    startTransition(() => {
      setSearching(true);
    });
    const timer = setTimeout(async () => {
      const res = await apiFetch(`/api/v1/search?q=${encodeURIComponent(q)}&mode=keyword`);
      if (res.ok) {
        const body = await res.json();
        const existingIds = new Set((cycle?.items ?? []).map((i) => i.responsibilityId));
        type SearchRespRow = { id: string; title: string; type: string; status: string };
        const candidates: BacklogCandidate[] = (body.data.responsibilities as SearchRespRow[])
          .filter((r) => isBacklogEligible(r.type, r.status) && !existingIds.has(r.id))
          .map((r) => ({ id: r.id, title: r.title, type: r.type }));
        setSearchResults(candidates);
      }
      setSearching(false);
    }, 300);
    return () => clearTimeout(timer);
  }, [pickerQuery, pickerOpen, cycle]);

  async function addToCycle(responsibilityId: string) {
    setCycleItemBusy(responsibilityId);
    try {
      const res = await apiFetch("/api/v1/cycles/current/items", {
        method: "POST",
        body: JSON.stringify({ responsibilityId }),
      });
      if (res.ok) {
        setBacklog((prev) => prev.filter((b) => b.id !== responsibilityId));
        await loadCycle();
      }
    } finally {
      setCycleItemBusy(null);
    }
  }

  const unprocessedCount = captures.filter((c) => c.processingStatus === "SAVED").length;
  const relatedCount = planning
    ? planning.decisions.length + planning.waitings.length + planning.risks.length
    : 0;

  return (
    <div className="space-y-6">
      <div>
        <p className="text-xs text-faint font-mono mb-1">
          {new Date().toLocaleDateString("ja-JP", {
            year: "numeric",
            month: "long",
            day: "numeric",
            weekday: "short",
          })}
        </p>
        <h1 className="font-serif text-3xl">今日</h1>
      </div>

      {/* [2026-08-23新設] FN-PEM-01初回対話の未完了バナー。通知(FN-NTF-01)とは別枠の
          常設帯とし、プッシュ通知やポップアップでの催促はしない(押しつけない設計方針)。
          対話完了で自動的に消える(pemOnboardingIncompleteがfalseになる)。 */}
      {pemOnboardingIncomplete && (
        <Link
          href="/pem/onboarding"
          className="flex items-center gap-2 bg-brand-50 border border-brand/20 rounded-xl px-4 py-2.5 text-xs text-brand-700 hover:bg-brand-100 transition"
        >
          実行モデルの初回対話が途中です・続ける →
        </Link>
      )}

      <QuickCaptureForm onCreated={reload} />

      <div className="bg-surface border border-line rounded-2xl shadow-card overflow-hidden">
        <div className="px-5 pt-4 pb-3 border-b border-line">
          <span className="text-xs font-mono tracking-wide text-faint">今やる一つ</span>
        </div>
        <div className="p-5">
          {planningLoading ? (
            <p className="text-sm text-faint">読み込み中...</p>
          ) : planning?.primary ? (
            <div className="space-y-4">
              <div>
                <p className="font-serif text-xl text-ink">{planning.primary.title}</p>
                <p className="text-xs text-muted mt-1">{reasonLabels(planning.primary.reasonCodes)}</p>
              </div>
              {planning.alternatives.length > 0 && (
                <div>
                  <span className="text-xs font-mono tracking-wide text-faint">代わりに</span>
                  <ul className="mt-1 space-y-1">
                    {planning.alternatives.map((a) => (
                      <li key={a.id} className="text-sm text-muted">
                        {a.title}
                        <span className="text-xs text-faint ml-2">{reasonLabels(a.reasonCodes)}</span>
                      </li>
                    ))}
                  </ul>
                </div>
              )}
            </div>
          ) : (
            <div>
              <p className="text-sm text-muted">
                今実行できる責任(タスク・約束・待ちの追跡)が見つかりませんでした。
                Inboxで整理されていない入力があるか確認してください。
              </p>
              <Link href="/inbox" className="inline-block mt-3 text-sm text-brand-700 font-medium hover:underline">
                Inboxで整理する →
              </Link>
            </div>
          )}
        </div>
      </div>

      {/* [2026-08-22新設] 週次サイクル(参考: note.com/bingo10「個人のタスク管理こそLinear」)。
          月曜〜日曜の固定週で自動生成され、未完了アイテムは自動で翌週へ持ち越される
          ("罪悪感を感じる間もなくシステムが繋いでくれる"という記事の知見を踏襲)。 */}
      <div className="bg-surface border border-line rounded-2xl shadow-card overflow-hidden">
        <div className="px-5 pt-4 pb-3 border-b border-line flex items-center justify-between">
          <div>
            <span className="text-xs font-mono tracking-wide text-faint">今週のサイクル</span>
            {cycle && (
              <p className="text-[11px] text-faint mt-0.5">{formatCycleRange(cycle.cycle.startAt, cycle.cycle.endAt)}</p>
            )}
          </div>
          {cycle && cycle.totalCount > 0 && (
            <span className="text-xs text-muted">
              {cycle.doneCount}/{cycle.totalCount}完了
            </span>
          )}
        </div>
        <div className="p-5">
          {cycleLoading ? (
            <p className="text-sm text-faint">読み込み中...</p>
          ) : (
            <div className="space-y-3">
              {cycle && cycle.totalCount > 0 && (
                <div className="w-full h-1.5 bg-canvas rounded-full overflow-hidden">
                  <div
                    className="h-full bg-brand-600 transition-all"
                    style={{ width: `${Math.round((cycle.doneCount / cycle.totalCount) * 100)}%` }}
                  />
                </div>
              )}
              {cycle && cycle.items.length === 0 ? (
                <p className="text-sm text-muted">
                  今週コミットしたタスクはまだありません。バックログから今週やることを選びましょう。
                </p>
              ) : (
                <ul className="space-y-1.5">
                  {cycle?.items.map((item) => (
                    <li key={item.id} className="flex items-center justify-between text-sm gap-2">
                      <Link
                        href={`/responsibilities?focus=${item.responsibilityId}`}
                        className="text-ink hover:underline truncate flex items-center gap-1.5"
                      >
                        {item.carriedOver && (
                          <span
                            className="text-[10px] text-amber-700 bg-amber-50 border border-amber-200 rounded px-1 py-0.5 shrink-0"
                            title="先週から持ち越し"
                          >
                            持ち越し
                          </span>
                        )}
                        <span className="truncate">{item.title}</span>
                      </Link>
                      <button
                        onClick={() => removeFromCycle(item.responsibilityId)}
                        disabled={cycleItemBusy === item.responsibilityId}
                        className="shrink-0 text-[11px] text-faint hover:text-red-600 disabled:opacity-40"
                      >
                        外す
                      </button>
                    </li>
                  ))}
                </ul>
              )}
              <button
                onClick={openPicker}
                className="text-sm text-brand-700 font-medium hover:underline"
              >
                ＋ バックログから今週に追加
              </button>
            </div>
          )}
        </div>
      </div>

      {pickerOpen && (
        <div
          className="fixed inset-0 bg-black/30 z-40 flex items-center justify-center p-4"
          onClick={() => setPickerOpen(false)}
        >
          <div
            onClick={(e) => e.stopPropagation()}
            className="bg-surface rounded-2xl shadow-pop w-full max-w-md max-h-[70vh] flex flex-col overflow-hidden"
          >
            <div className="px-4 py-3 border-b border-line">
              <input
                autoFocus
                type="text"
                value={pickerQuery}
                onChange={(e) => setPickerQuery(e.target.value)}
                placeholder="タイトル・詳細で検索..."
                className="w-full text-sm border border-line rounded-lg px-3 py-2 focus:outline-none focus:border-brand"
              />
            </div>
            <div className="flex-1 overflow-y-auto">
              {(() => {
                const isQuerying = pickerQuery.trim().length > 0;
                const loading = isQuerying ? searching : backlogLoading;
                const list = (isQuerying ? (searchResults ?? []) : backlog).slice(0, 30);
                if (loading) {
                  return <p className="px-4 py-6 text-center text-xs text-faint">読み込み中...</p>;
                }
                if (list.length === 0) {
                  return <p className="px-4 py-6 text-center text-xs text-faint">該当する候補がありません</p>;
                }
                return list.map((b) => (
                  <button
                    key={b.id}
                    onClick={() => addToCycle(b.id)}
                    disabled={cycleItemBusy === b.id}
                    className="w-full text-left px-4 py-2.5 hover:bg-canvas transition text-sm border-b border-line/60 last:border-b-0 disabled:opacity-40"
                  >
                    {b.title}
                  </button>
                ));
              })()}
            </div>
            <div className="px-4 py-2.5 border-t border-line text-right">
              <button onClick={() => setPickerOpen(false)} className="text-xs text-faint hover:underline">
                閉じる
              </button>
            </div>
          </div>
        </div>
      )}

      {/* [2026-08-22追加] Todoist「今日/近日中/今後」・Things 3のセクション分けに相当する
          階層バケット表示。pinnedはFN-WK-03「今日の最低ライン」(最大3件)。 */}
      {summaryLoading ? (
        <div className="bg-surface border border-line rounded-2xl shadow-card p-5">
          <p className="text-sm text-faint">読み込み中...</p>
        </div>
      ) : summary ? (
        <div className="space-y-4">
          {summary.pinned.length > 0 && (
            <div className="bg-amber-50 border border-amber-200 rounded-2xl shadow-card p-5">
              <span className="text-xs font-mono tracking-wide text-amber-700">
                今日の最低ライン({summary.pinned.length}/3)
              </span>
              <ul className="mt-2 space-y-1.5">
                {summary.pinned.map((item) => (
                  <li key={item.id} className="flex items-center justify-between text-sm">
                    <Link href={`/responsibilities?focus=${item.id}`} className="text-ink hover:underline truncate">
                      {item.title}
                    </Link>
                    <button
                      onClick={() => togglePin(item, false)}
                      disabled={pinBusy === item.id}
                      aria-label="固定を解除"
                      className="shrink-0 ml-2 text-amber-600 hover:text-amber-800 disabled:opacity-40"
                    >
                      <PinIcon width={14} height={14} className="fill-current" />
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          )}

          {([
            { key: "today", label: "今日", items: summary.today },
            { key: "next3Days", label: "3日以内", items: summary.next3Days },
            { key: "thisWeek", label: "今週", items: summary.thisWeek },
          ] as const).map(
            (section) =>
              section.items.length > 0 && (
                <div key={section.key} className="bg-surface border border-line rounded-2xl shadow-card p-5">
                  <span className="text-xs font-mono tracking-wide text-faint">
                    {section.label}({section.items.length}件)
                  </span>
                  <ul className="mt-2 space-y-1.5">
                    {section.items.slice(0, 8).map((item) => (
                      <li key={item.id} className="flex items-center justify-between text-sm gap-2">
                        <Link href={`/responsibilities?focus=${item.id}`} className="text-ink hover:underline truncate">
                          {item.title}
                        </Link>
                        <span className="flex items-center gap-2 shrink-0">
                          <span className="text-[11px] text-faint">{formatEffectiveAt(item.effectiveAt)}</span>
                          {!item.pinned && (
                            <button
                              onClick={() => togglePin(item, true)}
                              disabled={pinBusy === item.id || summary.pinned.length >= 3}
                              aria-label="今日の最低ラインに固定"
                              title={summary.pinned.length >= 3 ? "最大3件までです" : "固定する"}
                              className="text-faint hover:text-amber-600 disabled:opacity-30"
                            >
                              <PinIcon width={13} height={13} />
                            </button>
                          )}
                        </span>
                      </li>
                    ))}
                  </ul>
                </div>
              ),
          )}

          {summary.pinned.length === 0 &&
            summary.today.length === 0 &&
            summary.next3Days.length === 0 &&
            summary.thisWeek.length === 0 && (
              <div className="bg-surface border border-line rounded-2xl shadow-card p-5">
                <p className="text-sm text-muted">今週中に期限・目標日が設定された責任はありません。</p>
              </div>
            )}
        </div>
      ) : null}

      {planning && relatedCount > 0 && (
        <div className="bg-surface border border-line rounded-2xl shadow-card p-5 space-y-2">
          <span className="text-xs font-mono tracking-wide text-faint">判断・待ち・危険</span>
          {planning.decisions.length > 0 && (
            <p className="text-sm text-ink">
              判断待ち: <span className="font-semibold">{planning.decisions.length}</span>件
            </p>
          )}
          {planning.waitings.length > 0 && (
            <p className="text-sm text-ink">
              追跡中の待ち: <span className="font-semibold">{planning.waitings.length}</span>件
            </p>
          )}
          {planning.risks.length > 0 && (
            <p className="text-sm text-ink">
              監視中の危険: <span className="font-semibold">{planning.risks.length}</span>件
            </p>
          )}
          <Link href="/responsibilities" className="inline-block text-sm text-brand-700 font-medium hover:underline">
            今後で詳細を見る →
          </Link>
        </div>
      )}

      <div className="bg-surface border border-line rounded-2xl shadow-card p-5">
        <span className="text-xs font-mono tracking-wide text-faint">Inbox状況</span>
        {loading ? (
          <p className="text-sm text-faint mt-2">読み込み中...</p>
        ) : (
          <p className="text-sm text-ink mt-2">
            未整理の入力が <span className="font-semibold">{unprocessedCount}</span> 件、合計{" "}
            <span className="font-semibold">{captures.length}</span> 件を保存済みです。
          </p>
        )}
      </div>
    </div>
  );
}
