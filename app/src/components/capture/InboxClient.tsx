"use client";

import { useCallback, useEffect, useMemo, useState, startTransition } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { isTypingTarget } from "@/lib/keyboard";
import { apiFetch, debugFetch } from "@/lib/auth/client";
import { debugLog } from "@/lib/debug";
import { formatRelativeTime } from "@/lib/format";
import { QuickCaptureForm } from "@/components/capture/QuickCaptureForm";
import { FormationSessionPanel } from "@/components/capture/FormationSessionPanel";

interface CaptureListItem {
  id: string;
  sourceType: string;
  rawText: string | null;
  aiSummary: string | null;
  processingStatus: string;
  /** [2026-08-21追加] REALTIME/BATCH。バッチ待ち中のInbox表示に使う。 */
  processingPriority: string;
  domainId: string | null;
  sourceCapturedAt: string | null;
  version: number;
  createdAt: string;
}

interface CaptureDetail extends CaptureListItem {
  audioObjectKey: string | null;
  imageObjectKey: string | null;
  consentId: string | null;
  updatedAt: string;
  /** 新設(2026-08-21): 画像複数ページ結合の枚数。 */
  imagePageCount: number;
  /** 新設(2026-08-21): 音声話題自動分割で生成された場合、分割元CaptureのID。 */
  splitFromCaptureId: string | null;
}

/** [B4.2新設・2026-08-29] Session-backed Captureかどうかの判定に使う。 */
interface CaptureDetailMeta {
  formationSessionId: string | null;
  cutoverEnabled: boolean;
}

interface CandidateDateMention {
  rawExpression: string;
  normalizedAt?: string;
  meaning: string;
  timezone: string;
  confidence: number;
}

/** lib/ai/schema.ts ResponsibilityCandidateSchemaと同型(フロント側の表示用)。 */
interface CandidatePayload {
  candidateId: string;
  type: string;
  title: string;
  description?: string;
  actor?: string;
  counterparty?: string;
  dateMentions: CandidateDateMention[];
  completionCondition?: string;
  negationOrChange?: string;
  unknowns: string[];
  importance?: number;
  blockedByCandidateIds: string[];
}

interface InferenceItem {
  id: string;
  inferenceType: string;
  payload: CandidatePayload;
  confidence: string;
  decision: string;
  createdAt: string;
  version: number;
  literalDuplicateOf?: string[];
  similarExisting?: { responsibilityId: string; title: string; similarity: number }[];
}

interface LatestAiRun {
  id: string;
  provider: string;
  model: string;
  status: string;
  errorCode: string | null;
  inputTokens: number | null;
  outputTokens: number | null;
  latencyMs: number | null;
  startedAt: string;
  finishedAt: string | null;
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
  IMAGE: "画像",
};

/** AI候補の種別ラベル(用語・状態・コード定義書v1.1 2章の9種別に対応)。 */
const CANDIDATE_TYPE_LABEL: Record<string, string> = {
  TASK: "作業",
  COMMITMENT: "約束",
  DECISION: "判断",
  WAITING: "待ち",
  EVENT: "予定",
  RISK: "危険",
  CONCERN: "気がかり",
  HABIT: "習慣",
  IDEA: "アイデア",
};

const CANDIDATE_TYPE_CHIP_STYLE: Record<string, string> = {
  TASK: "bg-brand-50 text-brand-700",
  COMMITMENT: "bg-decide-50 text-decide",
  DECISION: "bg-decide-50 text-decide",
  WAITING: "bg-ai-50 text-ai",
  EVENT: "bg-safe-50 text-safe",
  RISK: "bg-warn-50 text-warn",
};

const DATE_MEANING_LABEL: Record<string, string> = {
  HARD_DEADLINE: "締切",
  SOFT_TARGET: "目標",
  FOLLOW_UP: "追跡",
  EVENT: "予定",
  UNKNOWN: "不明",
};

// TickTick/Craftのパステルカラーブロックを参考に、種類ごとに淡色を割り当てる。
// 新しい色を増やさず既存デザイントークン(brand/ai/decide/safe)を再利用する。
const SOURCE_TYPE_CHIP_STYLE: Record<string, string> = {
  TEXT: "bg-brand-50 text-brand-700",
  VOICE: "bg-ai-50 text-ai",
  MEETING: "bg-decide-50 text-decide",
  IMPORT: "bg-safe-50 text-safe",
  IMAGE: "bg-warn-50 text-warn",
};

const SOURCE_TYPE_ORDER = ["TEXT", "VOICE", "MEETING", "IMPORT", "IMAGE"] as const;

/** rawText/aiSummaryが未確定(文字起こし/OCR待ち)の間の一覧・詳細プレースホルダー文言。 */
function emptyBodyPlaceholder(sourceType: string): string {
  if (sourceType === "VOICE") return "🎧 音声(文字起こし待ち)";
  if (sourceType === "IMAGE") return "🖼️ 画像(文字認識待ち)";
  return "(本文なし)";
}

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
  const searchParams = useSearchParams();
  const [captures, setCaptures] = useState<CaptureListItem[]>([]);
  const [loadingList, setLoadingList] = useState(true);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [detail, setDetail] = useState<CaptureDetail | null>(null);
  const [detailMeta, setDetailMeta] = useState<CaptureDetailMeta>({ formationSessionId: null, cutoverEnabled: false });
  const [latestAiRun, setLatestAiRun] = useState<LatestAiRun | null>(null);
  const [inferences, setInferences] = useState<InferenceItem[]>([]);
  const [loadingDetail, setLoadingDetail] = useState(false);
  // [2026-08-21追加] カルキョンさんの指摘「クリックしても何も表示されない」に対応。
  // 従来はdetailRes.ok===falseの場合に何もエラーを出さず沈黙していたため、
  // 500等のAPI障害時に画面が完全に無反応に見える不備があった。
  const [detailError, setDetailError] = useState("");
  const [analyzing, setAnalyzing] = useState(false);
  const [decidingId, setDecidingId] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [filterType, setFilterType] = useState<string | null>(null);
  // [2026-08-21追加] カルキョンさんの指示「タイトル、概要は編集できるようにしろ」に対応。
  const [editingTitle, setEditingTitle] = useState(false);
  const [titleDraft, setTitleDraft] = useState("");
  const [titleSaving, setTitleSaving] = useState(false);
  // [2026-08-20追加] AI候補の一括採用。カルキョンさんの指摘「AIでの分析候補を一括登録
  // できるようにしろ、チェックボックスや一括登録」に対応。
  const [selectedInferenceIds, setSelectedInferenceIds] = useState<Set<string>>(new Set());
  const [bulkProcessing, setBulkProcessing] = useState(false);

  const loadList = useCallback(async () => {
    setLoadingList(true);
    const res = await debugFetch("/api/v1/captures");
    if (res.ok) {
      const body = await res.json();
      const items: CaptureListItem[] = body.data.captures;
      debugLog.state("InboxClient", "captures", { count: items.length });
      setCaptures(items);
      // [2026-08-21追加] /inbox?focus=<captureId> で特定のメモを直接開けるようにする
      // (「今後」画面の?focus=パターンと同じ。責任詳細から元メモへ辿れるようにするため)。
      const focus = searchParams.get("focus");
      setSelectedId((current) => current ?? focus ?? items[0]?.id ?? null);
    }
    setLoadingList(false);
  }, [searchParams]);

  const loadDetail = useCallback(async (id: string, silent = false) => {
    // [2026-08-20修正] 採用/却下後の再読込でsetLoadingDetail(true)を経由すると、
    // 詳細パネル(候補一覧含む)が一瞬アンマウントされ、スクロール位置が失われ
    // ページ先頭に戻ってしまう不備があった。silent=trueの場合はローディング表示を
    // 経由せず、取得完了時に既存DOMへ差分反映するだけにする。
    if (!silent) setLoadingDetail(true);
    setError("");
    setDetailError("");
    const [detailRes, inferRes] = await Promise.all([
      debugFetch(`/api/v1/captures/${id}`),
      debugFetch(`/api/v1/captures/${id}/inferences`),
    ]);
    if (detailRes.ok) {
      const body = await detailRes.json();
      setDetail(body.data.capture);
      setLatestAiRun(body.data.latestAiRun ?? null);
      // [B4.2新設・2026-08-29] Session-backed Captureかどうかを記録し、
      // cutover flag ON時はAI候補欄をFormationSessionPanelへ切り替える。
      setDetailMeta({
        formationSessionId: body.data.formationSessionId ?? null,
        cutoverEnabled: body.data.cutoverEnabled ?? false,
      });
    } else {
      // [2026-08-21追加] 失敗時はdetailを消してエラーメッセージを表示する(古いメモの
      // 詳細を誤表示したまま放置しない)。500の場合はJSONで返らないことがあるためcatchする。
      const body = await detailRes.json().catch(() => null);
      debugLog.event("InboxClient", "loadDetail failed", body?.error);
      setDetail(null);
      setLatestAiRun(null);
      setDetailMeta({ formationSessionId: null, cutoverEnabled: false });
      setDetailError(body?.error?.message ?? `メモの詳細取得に失敗しました(サーバーエラー ${detailRes.status})`);
    }
    if (inferRes.ok) {
      const body = await inferRes.json();
      setInferences(body.data.inferences);
    } else {
      setInferences([]);
    }
    if (!silent) setLoadingDetail(false);
  }, []);

  // [B4.2b是正・2026-08-29] react-hooks/set-state-in-effect対応(既存の
  // pre-existing違反。eslint-config-next 16のcore-web-vitalsに含まれる
  // ルールで、effect本体からsetStateを同期的に呼ぶ関数を直接呼ぶことを禁止する。
  // startTransitionで包むことで、Reactへ「この更新は緊急ではない」と伝える
  // 標準的な回避策(挙動自体は変えない、mount時fetchのタイミングも不変)。
  useEffect(() => {
    startTransition(() => {
      loadList();
    });
  }, [loadList]);

  async function saveTitle() {
    if (!detail) return;
    setTitleSaving(true);
    try {
      const res = await apiFetch(`/api/v1/captures/${detail.id}`, {
        method: "PATCH",
        body: JSON.stringify({ aiSummary: titleDraft.trim() || null, version: detail.version }),
      });
      const body = await res.json().catch(() => null);
      if (!res.ok) {
        setError(body?.error?.message ?? "タイトルの保存に失敗しました");
        return;
      }
      setDetail({ ...detail, aiSummary: titleDraft.trim() || null, version: body.data.version });
      setCaptures((prev) => prev.map((c) => (c.id === detail.id ? { ...c, aiSummary: titleDraft.trim() || null } : c)));
      setEditingTitle(false);
    } catch {
      setError("通信に失敗しました。ネットワーク状態を確認してもう一度お試しください");
    } finally {
      setTitleSaving(false);
    }
  }

  useEffect(() => {
    if (selectedId) {
      startTransition(() => {
        loadDetail(selectedId);
      });
    }
  }, [selectedId, loadDetail]);

  // [2026-08-20追加] QUEUED/PROCESSING中は結果を見るために手動リロードが必要だった。
  // AI Workerのポーリング間隔(5秒)に合わせて自動でポーリングし、READY/FAILEDに
  // 遷移したら自動的に停止する(無駄なポーリングを続けない)。
  useEffect(() => {
    if (!selectedId || !detail) return;
    if (detail.processingStatus !== "QUEUED" && detail.processingStatus !== "PROCESSING") return;
    const interval = setInterval(() => {
      loadDetail(selectedId, true);
      loadList();
    }, 4000);
    return () => clearInterval(interval);
  }, [selectedId, detail, loadDetail, loadList]);

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
      await Promise.all([loadDetail(selectedId, true), loadList()]);
    } finally {
      setAnalyzing(false);
    }
  }

  /**
   * API-AI-01: AI候補の採否(ACCEPT/REJECT)。ACCEPTは新規Responsibilityとして
   * その場で作成される(POST /inferences/{id}/decision側の実装)。
   * [2026-08-20追加] 従来この操作自体がUIから一切呼べず、AIが候補を抽出しても
   * 実タスク化する手段がなかった(候補が画面に表示すらされていなかった)。
   */
  async function decideInference(inf: InferenceItem, decision: "ACCEPT" | "REJECT") {
    setDecidingId(inf.id);
    setError("");
    debugLog.event("InboxClient", "decide inference", { id: inf.id, decision });
    try {
      const res = await apiFetch(`/api/v1/inferences/${inf.id}/decision`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ decision, expectedInferenceVersion: inf.version }),
      });
      const body = await res.json();
      if (!res.ok) {
        setError(body.error?.message ?? "候補の採否処理に失敗しました");
        return;
      }
      // [2026-08-20修正] スクロール位置維持のため、サーバー全体を再取得する代わりに
      // このinferenceだけをローカルで書き換える(楽観的更新)。他の候補の重複警告
      // (literalDuplicateOf)は再計算が必要なため、そこだけ静かに(silent)再取得する。
      setInferences((prev) =>
        prev.map((i) => (i.id === inf.id ? { ...i, decision: decision === "ACCEPT" ? "ACCEPTED" : "REJECTED" } : i)),
      );
      if (selectedId) await loadDetail(selectedId, true);
    } finally {
      setDecidingId(null);
    }
  }

  function toggleInferenceSelection(id: string) {
    setSelectedInferenceIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      return next;
    });
  }

  /**
   * [2026-08-21新設] 選択済み候補を一括で採用/却下する。決定APIは1件ずつしか処理
   * できない(バージョン競合検知のため)ため、直列に呼び出す。重複扱いの候補は
   * 一括採用の対象から除外し、誤って両方登録してしまう事故を防ぐ。
   */
  async function bulkDecide(decision: "ACCEPT" | "REJECT") {
    const targets = inferences.filter(
      (i) => selectedInferenceIds.has(i.id) && i.decision === "PENDING" && (decision === "REJECT" || !i.literalDuplicateOf?.length),
    );
    if (targets.length === 0) return;
    setBulkProcessing(true);
    setError("");
    let failCount = 0;
    for (const inf of targets) {
      const res = await apiFetch(`/api/v1/inferences/${inf.id}/decision`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ decision, expectedInferenceVersion: inf.version }),
      });
      if (res.ok) {
        setInferences((prev) =>
          prev.map((i) => (i.id === inf.id ? { ...i, decision: decision === "ACCEPT" ? "ACCEPTED" : "REJECTED" } : i)),
        );
      } else {
        failCount++;
      }
    }
    setSelectedInferenceIds(new Set());
    if (selectedId) await loadDetail(selectedId, true);
    if (failCount > 0) setError(`${failCount}件の一括処理に失敗しました(重複や競合の可能性)`);
    setBulkProcessing(false);
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
                          {c.aiSummary || c.rawText || emptyBodyPlaceholder(c.sourceType)}
                        </p>
                        <div className="flex items-center gap-1.5 mt-1">
                          <span
                            className={`text-[10px] px-1.5 py-0.5 rounded font-medium ${
                              SOURCE_TYPE_CHIP_STYLE[c.sourceType] ?? "bg-canvas text-muted"
                            }`}
                          >
                            {SOURCE_TYPE_LABEL[c.sourceType] ?? c.sourceType}
                          </span>
                          {/* [2026-08-21追加] バッチ選択・未完了時のみ表示。完了(READY/FAILED)後は
                              通常表示に戻る(バッチだったことを恒久的に主張する情報ではないため)。 */}
                          {c.processingPriority === "BATCH" && (c.processingStatus === "QUEUED" || c.processingStatus === "PROCESSING") && (
                            <span className="text-[10px] px-1.5 py-0.5 rounded font-medium bg-canvas text-faint">💤 バッチ待ち</span>
                          )}
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
            {/* [2026-08-21追加] 詳細取得失敗時に何も表示されない不備を修正。 */}
            {selectedId && !loadingDetail && !detail && detailError && (
              <div className="bg-surface border border-warn/40 rounded-2xl p-5">
                <p className="text-sm font-semibold text-warn">詳細の取得に失敗しました</p>
                <p className="text-xs text-muted mt-1">{detailError}</p>
                <button
                  onClick={() => loadDetail(selectedId)}
                  className="mt-3 text-xs border border-line rounded-lg px-3 py-1.5 hover:bg-canvas"
                >
                  再試行
                </button>
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
                      {/* [2026-08-21追加] 音声話題自動分割で生成されたCaptureであることを示す。 */}
                      {detail.splitFromCaptureId && (
                        <span className="text-[10px] px-1.5 py-0.5 rounded font-medium bg-canvas text-faint">🔀 話題分割で生成</span>
                      )}
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
                  {/* [2026-08-21新設] タイトル/概要(aiSummary)の手動編集。AI生成のまま
                      放置せず、的外れな場合に修正できるようにする。 */}
                  <div className="mb-3 bg-ai-50 rounded-lg px-3 py-2">
                    <div className="flex items-center justify-between mb-0.5">
                      <p className="text-[10px] font-semibold text-ai uppercase tracking-wide">タイトル・概要</p>
                      {!editingTitle && (
                        <button
                          onClick={() => {
                            setTitleDraft(detail.aiSummary ?? "");
                            setEditingTitle(true);
                          }}
                          className="text-[10px] text-ai hover:underline"
                        >
                          編集
                        </button>
                      )}
                    </div>
                    {editingTitle ? (
                      <div className="space-y-1.5">
                        <input
                          type="text"
                          value={titleDraft}
                          onChange={(e) => setTitleDraft(e.target.value)}
                          maxLength={120}
                          autoFocus
                          className="w-full text-xs border border-line rounded-md px-2 py-1.5 focus:outline-none focus:border-brand"
                        />
                        <div className="flex gap-1.5">
                          <button
                            onClick={saveTitle}
                            disabled={titleSaving}
                            className="text-[10.5px] bg-ink text-white rounded-md px-2 py-1 disabled:opacity-50"
                          >
                            {titleSaving ? "保存中..." : "保存"}
                          </button>
                          <button
                            onClick={() => setEditingTitle(false)}
                            className="text-[10.5px] border border-line rounded-md px-2 py-1"
                          >
                            キャンセル
                          </button>
                        </div>
                      </div>
                    ) : (
                      <p className="text-xs text-ink">{detail.aiSummary || "(未設定。「編集」から入力できます)"}</p>
                    )}
                  </div>
                  <p className="text-base font-serif leading-relaxed whitespace-pre-wrap">
                    {detail.rawText ||
                      (detail.sourceType === "VOICE"
                        ? "🎧 音声ファイル(文字起こし待ち、または本文なし)"
                        : detail.sourceType === "IMAGE"
                          ? `🖼️ 画像ファイル${detail.imagePageCount > 1 ? `${detail.imagePageCount}枚` : ""}(文字認識待ち、または本文なし)`
                          : "(本文なし)")}
                  </p>
                </div>

                {/* [2026-08-20追加] processingStatus=FAILEDの場合、ターミナル(journalctl)を
                    見なくても失敗理由が分かるよう、直近のAiRunエラー内容をそのまま表示する。 */}
                {detail.processingStatus === "FAILED" && latestAiRun && (
                  <div className="border-t border-line bg-warn-50 px-5 py-3">
                    <p className="text-xs font-semibold text-warn">AI解析に失敗しました</p>
                    <p className="text-[11px] text-warn/80 mt-1 font-mono break-all">
                      {latestAiRun.provider}/{latestAiRun.model}: {latestAiRun.errorCode ?? "(エラー詳細なし)"}
                    </p>
                    <p className="text-[10px] text-faint mt-1">
                      {new Date(latestAiRun.startedAt).toLocaleString("ja-JP")}に実行
                      {latestAiRun.latencyMs !== null ? `(${latestAiRun.latencyMs}ms)` : ""}
                    </p>
                  </div>
                )}
                {(detail.processingStatus === "QUEUED" || detail.processingStatus === "PROCESSING") && (
                  <div className="border-t border-line bg-decide-50 px-5 py-3">
                    <p className="text-[11px] text-decide">
                      AI Workerの処理を待っています(自動的に数秒おきに確認します)。
                    </p>
                  </div>
                )}

                {detailMeta.cutoverEnabled && detailMeta.formationSessionId ? (
                  // [B4.2新設・2026-08-29] Session-backed Captureはこちらへ切り替わる。
                  // 旧AI候補UI(下のelse節)とは二重表示にならない(受入項目2・3)。
                  <FormationSessionPanel
                    sessionId={detailMeta.formationSessionId}
                    onChanged={() => selectedId && loadDetail(selectedId, true)}
                  />
                ) : (
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
                    <div className="flex items-center gap-2 mt-3 pb-2 border-b border-line">
                      <label className="flex items-center gap-1.5 text-[11px] text-muted">
                        <input
                          type="checkbox"
                          checked={
                            inferences.filter((i) => i.decision === "PENDING").length > 0 &&
                            inferences
                              .filter((i) => i.decision === "PENDING")
                              .every((i) => selectedInferenceIds.has(i.id))
                          }
                          onChange={(e) => {
                            const pendingIds = inferences.filter((i) => i.decision === "PENDING").map((i) => i.id);
                            setSelectedInferenceIds(e.target.checked ? new Set(pendingIds) : new Set());
                          }}
                        />
                        すべて選択
                      </label>
                      {selectedInferenceIds.size > 0 && (
                        <>
                          <span className="text-[11px] text-faint">{selectedInferenceIds.size}件選択中</span>
                          <button
                            onClick={() => bulkDecide("ACCEPT")}
                            disabled={bulkProcessing}
                            className="ml-auto text-[11px] bg-safe text-white rounded-md px-2.5 py-1 disabled:opacity-40"
                          >
                            {bulkProcessing ? "処理中..." : "選択項目を一括採用"}
                          </button>
                          <button
                            onClick={() => bulkDecide("REJECT")}
                            disabled={bulkProcessing}
                            className="text-[11px] bg-canvas border border-line text-muted rounded-md px-2.5 py-1 disabled:opacity-40"
                          >
                            一括却下
                          </button>
                        </>
                      )}
                    </div>
                  )}
                  {inferences.length > 0 && (
                    <ul className="space-y-2 mt-3">
                      {inferences.map((inf) => {
                        const p = inf.payload;
                        const isPending = inf.decision === "PENDING";
                        const isBusy = decidingId === inf.id;
                        const hasLiteralDup = (inf.literalDuplicateOf?.length ?? 0) > 0;
                        const hasSimilarExisting = (inf.similarExisting?.length ?? 0) > 0;
                        return (
                          <li
                            key={inf.id}
                            className={`rounded-lg p-3 ${hasLiteralDup ? "bg-warn-50 border border-warn-200" : "bg-ai-50"}`}
                          >
                            <div className="flex items-start justify-between gap-2">
                              {isPending && (
                                <input
                                  type="checkbox"
                                  checked={selectedInferenceIds.has(inf.id)}
                                  onChange={() => toggleInferenceSelection(inf.id)}
                                  className="mt-1 shrink-0"
                                />
                              )}
                              <div className="min-w-0">
                                <div className="flex items-center gap-1.5 flex-wrap">
                                  <span
                                    className={`text-[10px] px-1.5 py-0.5 rounded font-medium ${
                                      CANDIDATE_TYPE_CHIP_STYLE[p?.type] ?? "bg-canvas text-muted"
                                    }`}
                                  >
                                    {CANDIDATE_TYPE_LABEL[p?.type] ?? p?.type ?? inf.inferenceType}
                                  </span>
                                  <span className="text-[10px] text-faint">確度 {inf.confidence}</span>
                                  {!isPending && (
                                    <span className="text-[10px] text-faint">
                                      ({inf.decision === "ACCEPTED" ? "採用済み" : inf.decision === "REJECTED" ? "却下済み" : inf.decision})
                                    </span>
                                  )}
                                </div>
                                <p className="text-sm text-ink font-medium mt-1 break-words">
                                  {p?.title ?? "(タイトルなし)"}
                                </p>
                                {(p?.actor || p?.counterparty) && (
                                  <p className="text-[11px] text-muted mt-0.5">
                                    {p?.actor && <>担当: {p.actor}</>}
                                    {p?.actor && p?.counterparty && " / "}
                                    {p?.counterparty && <>相手: {p.counterparty}</>}
                                  </p>
                                )}
                                {p?.dateMentions?.length > 0 && (
                                  <p className="text-[11px] text-muted mt-0.5">
                                    {p.dateMentions
                                      .map((d) => `${DATE_MEANING_LABEL[d.meaning] ?? d.meaning}: ${d.rawExpression}`)
                                      .join("、")}
                                  </p>
                                )}
                                {(p?.importance || p?.blockedByCandidateIds?.length > 0) && (
                                  <p className="text-[11px] text-muted mt-0.5">
                                    {p.importance && <>重要度: {"★".repeat(p.importance)}{"☆".repeat(5 - p.importance)}</>}
                                    {p.importance && p.blockedByCandidateIds?.length > 0 && " / "}
                                    {p.blockedByCandidateIds?.length > 0 && (
                                      <>他{p.blockedByCandidateIds.length}件の完了が前提</>
                                    )}
                                  </p>
                                )}
                                {hasLiteralDup && (
                                  <p className="text-[11px] text-warn mt-1 font-medium">
                                    ⚠ 同じ内容の候補が他に{inf.literalDuplicateOf!.length}件あります(同じメモを複数回保存した可能性)。片方のみ採用してください
                                  </p>
                                )}
                                {hasSimilarExisting && (
                                  <p className="text-[11px] text-warn mt-1">
                                    ⚠ 既存の類似責任: {inf.similarExisting![0].title}(
                                    {Math.round(inf.similarExisting![0].similarity * 100)}%)
                                  </p>
                                )}
                              </div>
                              {isPending && (
                                <div className="shrink-0 flex gap-1.5">
                                  <button
                                    onClick={() => decideInference(inf, "ACCEPT")}
                                    disabled={isBusy}
                                    className="text-[11px] bg-ink text-white rounded px-2.5 py-1.5 disabled:opacity-40 hover:bg-black transition"
                                  >
                                    採用
                                  </button>
                                  <button
                                    onClick={() => decideInference(inf, "REJECT")}
                                    disabled={isBusy}
                                    className="text-[11px] bg-canvas border border-line text-muted rounded px-2.5 py-1.5 disabled:opacity-40 hover:bg-line/40 transition"
                                  >
                                    却下
                                  </button>
                                </div>
                              )}
                            </div>
                          </li>
                        );
                      })}
                    </ul>
                  )}
                  {error && <p className="text-sm text-red-600 mt-3">{error}</p>}
                </div>
                )}
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
