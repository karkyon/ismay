"use client";

import { useCallback, useEffect, useState, startTransition } from "react";
import { apiFetch, debugFetch } from "@/lib/auth/client";
import { debugLog } from "@/lib/debug";

/**
 * [B4.2新設・2026-08-29] Session Review UI(Inbox埋め込み版)。
 * 出典: 監査「Gate M1-B4.1即時完了・B4.2連続実装指示」B4.2受入項目1〜6・9。
 *
 * `GET /formation-sessions/:id`(B4.1で新設したProjection API)を使い、
 * candidate単位でACCEPT/REJECT・全体のMaterialize/Finalizeを行う。
 * InboxClientからは、cutover flag ON かつ 対象Captureに対応する
 * FormationSessionが存在する場合にのみこのpanelへ切り替わる(旧候補UIとの
 * 二重表示にはならない、受入項目2・3・10)。
 *
 * [スコープの明示的な境界] 独立したフルページのSession Review画面
 * (`/formation-sessions/[id]`route等)ではなく、Inbox詳細パネル内への埋め込みで
 * 実装した。既存Inboxの「一覧(左)/詳細(右)」という画面構成にそのまま乗せる方が、
 * ユーザーの導線を変えず(項目9「Bulk操作の実質的な入口はInbox」)、B4.2で
 * 新設が必要な画面遷移・URLルーティングを増やさずに済むため。
 *
 * [B4.3追加・2026-08-29] HANDOFF_2026-08-29_B4.1_B4.2.md §4の残課題1〜3への対応。
 *   - 項目9(Bulk ACCEPT/REJECT): pending候補にチェックボックスを追加し、
 *     選択した候補をまとめてACCEPTED/REJECTEDにする導線を追加した
 *     (`POST /:id/candidates/bulk-decisions`、B4.3新設)。1件ずつのボタンは
 *     従来通り残す(既存導線を壊さない)。
 *   - 項目6(legacy/Formation競合表示): 従来はconflictCode有無で警告バッジを
 *     出すだけだったが、`conflictCode`の種別(LEGACY_PROJECTION_CONFLICT /
 *     DECISION_MISMATCH)ごとに文言を分け、旧経路のinferenceId・決定内容・
 *     決定日時を表示するdetail行を追加した。
 */

interface ProjectionCandidate {
  identityId: string;
  candidateKey: string;
  currentRevision: {
    revision: number;
    type: string;
    title: string;
    description: string | null;
    confidence: number;
  } | null;
  atomicityAssessment: {
    assessment: string;
    reasonCode: string;
    evidence: unknown;
    confidence: number;
    algorithmVersion: string;
  } | null;
  formationDecision: { decision: string; occurredAt: string } | null;
  materialization: { responsibilityId: string; committedAt: string } | null;
  legacyProjection: {
    inferenceId: string;
    decision: string;
    decidedAt: string | null;
    conflictCode: "LEGACY_PROJECTION_CONFLICT" | "DECISION_MISMATCH" | null;
  } | null;
}

interface ProjectionQuestion {
  id: string;
  ordinal: number;
  candidateId: string | null;
  questionCode: string;
  priority: string;
  reasonCode: string;
  promptText: string;
  promptVersion: string;
  scoreValue: number;
  answerKind: "SELECTED" | "FREE_TEXT";
  options: Array<{ id: string; label: string }> | null;
  latestAnswer: { id: string; answerKind: string; value: unknown; occurredAt: string; revisionOfId: string | null } | null;
}

interface ProjectionResponse {
  session: { id: string; state: string; version: number };
  candidates: ProjectionCandidate[];
  questions: ProjectionQuestion[];
  allowedActions: { decide: boolean; materialize: boolean; finalize: boolean; answer: boolean };
}

const SESSION_STATE_LABEL: Record<string, string> = {
  DRAFT: "下書き",
  ANALYZING: "解析中",
  CLARIFYING: "確認中",
  REVIEW_READY: "確認待ち",
  PARTIALLY_CONFIRMED: "一部確定済み",
  CONFIRMED: "確定済み",
  FAILED: "失敗",
  DEFERRED: "保留",
  DISMISSED: "却下",
};

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

/** [B4.3新設] 旧経路(AiInference.decision)の表示ラベル。 */
const LEGACY_DECISION_LABEL: Record<string, string> = {
  PENDING: "未決定",
  ACCEPTED: "採用済み",
  EDITED: "編集の上採用済み",
  REJECTED: "却下済み",
  HELD: "保留",
};

/** [2026-08-30新設・M1-C] Atomicity Assessmentの表示ラベル。 */
const ATOMICITY_ASSESSMENT_LABEL: Record<string, string> = {
  ATOMIC: "単一処理可能",
  PROBABLY_ATOMIC: "おそらく単一処理可能",
  NEEDS_CLARIFICATION: "要確認",
  SHOULD_DECOMPOSE: "分解を推奨",
  CONTEXT_LIKE: "プロジェクト的",
};
const QUESTION_PRIORITY_LABEL: Record<string, string> = {
  P0: "重要",
  P1: "確認",
  P2: "任意",
};

export function FormationSessionPanel({ sessionId, onChanged }: { sessionId: string; onChanged?: () => void }) {
  const [data, setData] = useState<ProjectionResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [decidingId, setDecidingId] = useState<string | null>(null);
  const [materializing, setMaterializing] = useState(false);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [bulkBusy, setBulkBusy] = useState(false);
  // [2026-08-30新設・M1-B5a CLARIFYING UI]
  const [answeringId, setAnsweringId] = useState<string | null>(null);
  const [answerDrafts, setAnswerDrafts] = useState<Record<string, string>>({});
  // [2026-08-30新設・M1-C Split Correction]
  const [splittingId, setSplittingId] = useState<string | null>(null);
  const [splitParts, setSplitParts] = useState<Array<{ type: string; title: string }>>([
    { type: "TASK", title: "" },
    { type: "TASK", title: "" },
  ]);
  const [splitBusy, setSplitBusy] = useState(false);
  // [2026-08-30新設・M1-C2B Merge Correction]
  const [mergingOpen, setMergingOpen] = useState(false);
  const [mergeDraft, setMergeDraft] = useState({ type: "TASK", title: "", description: "", completionCondition: "" });
  const [mergeBusy, setMergeBusy] = useState(false);
  // [M1-B6C-4新設・2026-09-01指示書§6.2] Session Lifecycle(defer/dismiss/resume/retry)UI。
  const [lifecycleBusy, setLifecycleBusy] = useState<"defer" | "dismiss" | "resume" | "retry" | null>(null);
  const [deferReasonOpen, setDeferReasonOpen] = useState(false);
  const [deferReasonDraft, setDeferReasonDraft] = useState("");

  const load = useCallback(async (silent = false) => {
    if (!silent) setLoading(true);
    setError("");
    const res = await debugFetch(`/api/v1/formation-sessions/${sessionId}`);
    if (res.ok) {
      const body = await res.json();
      setData(body.data);
    } else {
      const body = await res.json().catch(() => null);
      setError(body?.error?.message ?? `Session取得に失敗しました(${res.status})`);
      setData(null);
    }
    if (!silent) setLoading(false);
  }, [sessionId]);

  // [react-hooks/set-state-in-effect対応] InboxClient.tsxと同じ理由・同じ
  // 標準的な回避策(startTransition)。挙動は変えない。
  useEffect(() => {
    startTransition(() => {
      load();
    });
  }, [load]);

  async function decide(candidate: ProjectionCandidate, decision: "ACCEPTED" | "REJECTED") {
    if (!candidate.currentRevision) return;
    setDecidingId(candidate.identityId);
    setError("");
    debugLog.event("FormationSessionPanel", "decide", { candidateId: candidate.identityId, decision });
    try {
      const res = await apiFetch(
        `/api/v1/formation-sessions/${sessionId}/candidates/${candidate.identityId}/decisions`,
        {
          method: "POST",
          body: JSON.stringify({ revision: candidate.currentRevision.revision, decision }),
        },
      );
      const body = await res.json().catch(() => null);
      if (!res.ok) {
        setError(body?.error?.message ?? "候補の採否処理に失敗しました");
        return;
      }
      setSelectedIds((prev) => {
        if (!prev.has(candidate.identityId)) return prev;
        const next = new Set(prev);
        next.delete(candidate.identityId);
        return next;
      });
      await load(true);
      onChanged?.();
    } finally {
      setDecidingId(null);
    }
  }

  function toggleSelected(identityId: string) {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(identityId)) {
        next.delete(identityId);
      } else {
        next.add(identityId);
      }
      return next;
    });
  }

  /** [B4.3新設・受入項目9] 選択済みpending候補を`bulk-decisions`へ一括送信する。
   *  1件でも失敗した場合、成功分は反映しつつerrorへ失敗件数を表示する
   *  (bulk-decisions/route.tsはall-or-nothingではなく候補単位の部分成功を返す
   *  設計のため、UI側もそれに合わせて部分失敗を明示する)。 */
  async function bulkDecide(decision: "ACCEPTED" | "REJECTED") {
    if (!data) return;
    const targets = data.candidates.filter(
      (c) => selectedIds.has(c.identityId) && !c.formationDecision && c.currentRevision,
    );
    if (targets.length === 0) return;
    // [B4.3追加是正・誤操作防止] 既存`ResponsibilitiesClient.tsx`の一括操作と同じ
    // 確認ダイアログパターンをそのまま踏襲する(想像で新しいUIパターンを作らない)。
    const label = decision === "ACCEPTED" ? "採用" : "却下";
    if (!confirm(`選択した${targets.length}件を「${label}」します。よろしいですか?`)) return;
    setBulkBusy(true);
    setError("");
    debugLog.event("FormationSessionPanel", "bulkDecide", { count: targets.length, decision });
    try {
      const res = await apiFetch(`/api/v1/formation-sessions/${sessionId}/candidates/bulk-decisions`, {
        method: "POST",
        body: JSON.stringify({
          items: targets.map((c) => ({
            candidateId: c.identityId,
            revision: c.currentRevision!.revision,
            decision,
          })),
        }),
      });
      const body = await res.json().catch(() => null);
      if (!res.ok) {
        setError(body?.error?.message ?? "一括処理に失敗しました");
        return;
      }
      const failedCount: number = body?.data?.failed ?? 0;
      if (failedCount > 0) {
        setError(
          `選択した${targets.length}件のうち${failedCount}件は一括処理に失敗しました(既に他経路で決定済み・revisionの更新等が考えられます)。失敗分は個別に確認してください。`,
        );
      }
      setSelectedIds(new Set());
      await load(true);
      onChanged?.();
    } finally {
      setBulkBusy(false);
    }
  }

  async function materialize() {
    if (!data) return;
    setMaterializing(true);
    setError("");
    try {
      const operationId = `ui-${sessionId}-${Date.now()}`;
      const res = await apiFetch(`/api/v1/formation-sessions/${sessionId}/materialize`, {
        method: "POST",
        body: JSON.stringify({ operationId, version: data.session.version }),
      });
      const body = await res.json().catch(() => null);
      if (!res.ok) {
        setError(body?.error?.message ?? "確定処理に失敗しました");
        return;
      }
      await load(true);
      onChanged?.();
    } finally {
      setMaterializing(false);
    }
  }

  /** [2026-08-30新設・M1-B5a §4.4] CLARIFYING質問への回答を送信する。
   *  clientEventIdはボタン押下ごとに新規生成する(既存decide/bulkDecideと同じく
   *  `busy`フラグでの二重送信防止に統一し、より複雑なDraft単位の再送保持は
   *  次Gateの課題とする)。 */
  async function submitAnswer(
    question: ProjectionQuestion,
    answerKind: "SELECTED" | "FREE_TEXT" | "UNKNOWN" | "DEFERRED" | "DO_NOT_MATERIALIZE",
    value?: string,
  ) {
    setAnsweringId(question.id);
    setError("");
    debugLog.event("FormationSessionPanel", "submitAnswer", { questionId: question.id, answerKind });
    try {
      const res = await apiFetch(`/api/v1/formation-sessions/${sessionId}/answers`, {
        method: "POST",
        body: JSON.stringify({
          questionId: question.id,
          clientEventId: `ui-answer-${question.id}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
          answerKind,
          ...(value !== undefined ? { value } : {}),
        }),
      });
      const body = await res.json().catch(() => null);
      if (!res.ok) {
        setError(body?.error?.message ?? "回答の送信に失敗しました");
        return;
      }
      setAnswerDrafts((prev) => {
        if (!(question.id in prev)) return prev;
        const next = { ...prev };
        delete next[question.id];
        return next;
      });
      await load(true);
      onChanged?.();
    } finally {
      setAnsweringId(null);
    }
  }

  /** [2026-08-30新設・M1-C §11.4] 分解フォームを開始する(初期2行)。 */
  function startSplit(candidateId: string) {
    setSplittingId(candidateId);
    setSplitParts([
      { type: "TASK", title: "" },
      { type: "TASK", title: "" },
    ]);
    setError("");
  }

  function cancelSplit() {
    setSplittingId(null);
  }

  async function submitSplit(candidate: ProjectionCandidate) {
    if (!candidate.currentRevision) return;
    const trimmedParts = splitParts.map((p) => ({ type: p.type, title: p.title.trim() }));
    if (trimmedParts.length < 2 || trimmedParts.some((p) => !p.title)) {
      setError("分解には2件以上、すべてtitleを入力した部分が必要です");
      return;
    }
    setSplitBusy(true);
    setError("");
    debugLog.event("FormationSessionPanel", "submitSplit", { candidateId: candidate.identityId, partCount: trimmedParts.length });
    try {
      const res = await apiFetch(
        `/api/v1/formation-sessions/${sessionId}/candidates/${candidate.identityId}/split`,
        {
          method: "POST",
          body: JSON.stringify({ revision: candidate.currentRevision.revision, parts: trimmedParts }),
        },
      );
      const body = await res.json().catch(() => null);
      if (!res.ok) {
        setError(body?.error?.message ?? "分解処理に失敗しました");
        return;
      }
      setSplittingId(null);
      await load(true);
      onChanged?.();
    } finally {
      setSplitBusy(false);
    }
  }

  /** [2026-08-30新設・M1-C2B DEC-MERGE-001] 統合フォームを開始する。 */
  function startMerge() {
    setMergingOpen(true);
    setMergeDraft({ type: "TASK", title: "", description: "", completionCondition: "" });
    setError("");
  }

  function cancelMerge() {
    setMergingOpen(false);
  }

  async function submitMerge() {
    if (!data) return;
    const title = mergeDraft.title.trim();
    if (!title) {
      setError("統合後のtitleを入力してください");
      return;
    }
    const parents = data.candidates
      .filter((c) => selectedIds.has(c.identityId) && c.currentRevision)
      .map((c) => ({ candidateId: c.identityId, revision: c.currentRevision!.revision }));
    if (parents.length < 2) {
      setError("統合には2件以上の候補選択が必要です");
      return;
    }
    setMergeBusy(true);
    setError("");
    debugLog.event("FormationSessionPanel", "submitMerge", { parentCount: parents.length });
    try {
      const res = await apiFetch(`/api/v1/formation-sessions/${sessionId}/candidates/merge`, {
        method: "POST",
        body: JSON.stringify({
          clientEventId: `ui-merge-${sessionId}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
          parents,
          merged: {
            type: mergeDraft.type,
            title,
            description: mergeDraft.description.trim() || undefined,
            completionCondition: mergeDraft.completionCondition.trim() || undefined,
          },
        }),
      });
      const body = await res.json().catch(() => null);
      if (!res.ok) {
        setError(body?.error?.message ?? "統合処理に失敗しました");
        return;
      }
      setMergingOpen(false);
      setSelectedIds(new Set());
      await load(true);
      onChanged?.();
    } finally {
      setMergeBusy(false);
    }
  }

  /**
   * [M1-B6C-4新設・2026-09-01指示書§6.2] defer/dismiss/resume/retryの共通送信処理。
   * 4 APIとも`{clientEventId, expectedVersion, reasonCode?}`という同じ形の
   * requestを受け取るため、既存decide/materialize等と同じ「busyフラグで二重
   * 送信防止→送信→エラー表示→再読込」の形に統一する。
   *
   * [version conflict後の再fetch] 失敗時(VERSION_CONFLICTに限らず全ての失敗)、
   * `load(true)`で最新のSession状態(および最新version)を必ず再取得する。
   * これにより、他タブ・他ユーザーの操作で競合した場合でも、次の操作は
   * 自動的に最新versionを前提に行われる(ユーザーが手動で再読み込みしなくても
   * 次のクリックが成功する)。
   */
  async function runLifecycleAction(action: "defer" | "dismiss" | "resume" | "retry", reasonCode?: string) {
    if (!data || lifecycleBusy) return;
    setLifecycleBusy(action);
    setError("");
    const clientEventId = `ui-lifecycle-${action}-${sessionId}-${Date.now()}`;
    debugLog.event("FormationSessionPanel", "lifecycleAction", { action, sessionId, hasReasonCode: !!reasonCode });
    try {
      const res = await apiFetch(`/api/v1/formation-sessions/${sessionId}/${action}`, {
        method: "POST",
        body: JSON.stringify({
          clientEventId,
          expectedVersion: data.session.version,
          ...(reasonCode ? { reasonCode } : {}),
        }),
      });
      const body = await res.json().catch(() => null);
      if (!res.ok) {
        const code = body?.error?.code;
        setError(
          code === "VERSION_CONFLICT"
            ? "他の操作と競合しました。最新の状態を再取得しました。もう一度お試しください。"
            : (body?.error?.message ?? "操作に失敗しました"),
        );
        await load(true);
        return;
      }
      setDeferReasonOpen(false);
      setDeferReasonDraft("");
      await load(true);
      onChanged?.();
    } finally {
      setLifecycleBusy(null);
    }
  }

  async function handleDismiss() {
    if (!confirm("このSessionを却下します。未決定の候補は失われません(履歴として残ります)が、このSession自体はもう確認できなくなります。よろしいですか?")) return;
    await runLifecycleAction("dismiss");
  }

  const sessionActive = data ? data.session.state === "REVIEW_READY" || data.session.state === "PARTIALLY_CONFIRMED" : false;


  if (loading) {
    return <div className="border-t border-line bg-canvas/60 px-5 py-4 text-xs text-faint">Session Reviewを読み込み中...</div>;
  }
  if (!data) {
    return (
      <div className="border-t border-line bg-warn-50 px-5 py-4">
        <p className="text-xs text-warn">{error || "Session Reviewの取得に失敗しました"}</p>
      </div>
    );
  }

  const pendingCandidates = data.candidates.filter((c) => !c.formationDecision);
  const decidedCandidates = data.candidates.filter((c) => c.formationDecision);
  const selectablePending = pendingCandidates.filter((c) => c.currentRevision);
  const selectedCount = selectablePending.filter((c) => selectedIds.has(c.identityId)).length;
  const allSelected = selectablePending.length > 0 && selectedCount === selectablePending.length;
  const unansweredQuestions = data.questions
    .filter((q) => !q.latestAnswer)
    .sort((a, b) => a.ordinal - b.ordinal);

  // [M1-B6C-4新設・§6.2] 各操作の許可状態はsessionLifecycle.tsのstate guardと
  // 同じ条件をUI側でも判定する(defer: CLARIFYING/REVIEW_READY/PARTIALLY_CONFIRMED、
  // dismiss: REVIEW_READYのみ、resume: DEFERREDのみ、retry: FAILEDのみ)。
  const canDefer = data.session.state === "CLARIFYING" || data.session.state === "REVIEW_READY" || data.session.state === "PARTIALLY_CONFIRMED";
  const canDismiss = data.session.state === "REVIEW_READY";
  const canResume = data.session.state === "DEFERRED";
  const canRetry = data.session.state === "FAILED";

  return (
    <div className="border-t border-line bg-canvas/60 px-5 py-4">
      <div className="flex items-center justify-between gap-3">
        <div>
          <p className="text-xs font-semibold text-ink">
            Session Review <span className="text-[10px] text-faint font-normal">({SESSION_STATE_LABEL[data.session.state] ?? data.session.state})</span>
          </p>
          <p className="text-[11px] text-faint mt-0.5">
            {data.candidates.length}件の候補({pendingCandidates.length}件が未決定)
          </p>
        </div>
        {data.allowedActions.materialize && (
          <button
            onClick={materialize}
            disabled={materializing}
            className="shrink-0 text-xs bg-ink text-white rounded-lg px-3 py-2 disabled:opacity-40 hover:bg-black transition"
          >
            {materializing ? "確定中..." : "採用済み候補を確定する"}
          </button>
        )}
        {!data.allowedActions.materialize && data.allowedActions.finalize && (
          <button
            onClick={materialize}
            disabled={materializing}
            className="shrink-0 text-xs bg-ink text-white rounded-lg px-3 py-2 disabled:opacity-40 hover:bg-black transition"
          >
            {materializing ? "処理中..." : "このSessionを終了する"}
          </button>
        )}
      </div>

      {/* [M1-B6C-4新設・§6.2] Session Lifecycle操作(defer/dismiss/resume/retry)。
          state別に排他的に表示する(同時に複数の操作が可能な状態は無い)。 */}
      {(canDefer || canDismiss || canResume || canRetry) && (
        <div className="mt-3 flex flex-wrap items-center gap-2">
          {canDefer && !deferReasonOpen && (
            <button
              onClick={() => setDeferReasonOpen(true)}
              disabled={lifecycleBusy !== null}
              className="shrink-0 text-[11px] text-muted border border-line rounded-lg px-2.5 py-1.5 disabled:opacity-40 hover:bg-canvas transition"
            >
              保留にする
            </button>
          )}
          {canDismiss && (
            <button
              onClick={handleDismiss}
              disabled={lifecycleBusy !== null}
              className="shrink-0 text-[11px] text-warn border border-warn-200 rounded-lg px-2.5 py-1.5 disabled:opacity-40 hover:bg-warn-50 transition"
            >
              {lifecycleBusy === "dismiss" ? "却下中..." : "却下する"}
            </button>
          )}
          {canResume && (
            <button
              onClick={() => runLifecycleAction("resume")}
              disabled={lifecycleBusy !== null}
              className="shrink-0 text-[11px] bg-ink text-white rounded-lg px-2.5 py-1.5 disabled:opacity-40 hover:bg-black transition"
            >
              {lifecycleBusy === "resume" ? "再開中..." : "再開する"}
            </button>
          )}
          {canRetry && (
            <button
              onClick={() => runLifecycleAction("retry")}
              disabled={lifecycleBusy !== null}
              className="shrink-0 text-[11px] bg-ink text-white rounded-lg px-2.5 py-1.5 disabled:opacity-40 hover:bg-black transition"
            >
              {lifecycleBusy === "retry" ? "再試行中..." : "再解析する"}
            </button>
          )}
        </div>
      )}
      {/* [M1-B6C-4新設・§6.2] deferの理由入力(任意)。破壊的操作ではないため
          dismissのようなconfirm()は使わず、キャンセル可能なインライン入力にする。 */}
      {canDefer && deferReasonOpen && (
        <div className="mt-3 rounded-lg border border-line bg-white p-3">
          <p className="text-[11px] text-muted mb-1.5">保留にする理由(任意)</p>
          <div className="flex items-center gap-1.5">
            <input
              type="text"
              value={deferReasonDraft}
              onChange={(e) => setDeferReasonDraft(e.target.value)}
              disabled={lifecycleBusy !== null}
              placeholder="例: 来週まで判断を保留したい"
              className="flex-1 min-w-0 text-sm rounded border border-line px-2 py-1.5 disabled:opacity-40"
            />
            <button
              onClick={() => runLifecycleAction("defer", deferReasonDraft.trim() || undefined)}
              disabled={lifecycleBusy !== null}
              className="shrink-0 text-[11px] bg-ink text-white rounded px-2.5 py-1.5 disabled:opacity-40 hover:bg-black transition"
            >
              {lifecycleBusy === "defer" ? "保留中..." : "保留にする"}
            </button>
            <button
              onClick={() => {
                setDeferReasonOpen(false);
                setDeferReasonDraft("");
              }}
              disabled={lifecycleBusy !== null}
              className="shrink-0 text-[11px] text-faint px-2 py-1.5 disabled:opacity-40 hover:text-muted transition"
            >
              キャンセル
            </button>
          </div>
        </div>
      )}
      {data.session.state === "DEFERRED" && (
        <p className="mt-2 text-[11px] text-faint">
          このSessionは保留中です。「再開する」を押すと、保留前の状態から確認を続けられます。
        </p>
      )}
      {data.session.state === "FAILED" && (
        <p className="mt-2 text-[11px] text-faint">
          このSessionは解析に失敗しました。「再解析する」を押すと解析待ち状態へ戻りますが、実際の再解析は別途手動で開始する必要があります。
        </p>
      )}
      {data.session.state === "DISMISSED" && (
        <p className="mt-2 text-[11px] text-faint">このSessionは却下されました。候補の履歴は失われていません。</p>
      )}

      {data.allowedActions.answer && unansweredQuestions.length > 0 && (
        <div className="mt-3 space-y-2">
          <p className="text-[11px] text-muted">
            回答が必要な質問があります({unansweredQuestions.length}件)。回答後、続きの候補確認へ進みます。
          </p>
          {unansweredQuestions.map((q) => (
            <div key={q.id} className="rounded-lg border border-brand-200 bg-brand-50/40 p-3">
              <div className="flex items-center gap-1.5 mb-1.5">
                <span className="text-[10px] px-1.5 py-0.5 rounded font-medium bg-brand-100 text-brand-700">
                  {QUESTION_PRIORITY_LABEL[q.priority] ?? q.priority}
                </span>
                <span className="text-[10px] text-faint">質問 {q.ordinal}</span>
              </div>
              <p className="text-sm text-ink mb-2 break-words">{q.promptText}</p>
              {q.answerKind === "SELECTED" && q.options ? (
                <div className="flex flex-wrap gap-1.5">
                  {q.options.map((opt) => (
                    <button
                      key={opt.id}
                      onClick={() => submitAnswer(q, "SELECTED", opt.id)}
                      disabled={answeringId === q.id}
                      className="text-[11px] bg-ink text-white rounded px-2.5 py-1.5 disabled:opacity-40 hover:bg-black transition"
                    >
                      {opt.label}
                    </button>
                  ))}
                </div>
              ) : (
                <div className="flex items-center gap-1.5">
                  <input
                    type="text"
                    value={answerDrafts[q.id] ?? ""}
                    onChange={(e) => setAnswerDrafts((prev) => ({ ...prev, [q.id]: e.target.value }))}
                    disabled={answeringId === q.id}
                    placeholder="回答を入力"
                    className="flex-1 min-w-0 text-sm rounded border border-line px-2 py-1.5 disabled:opacity-40"
                  />
                  <button
                    onClick={() => {
                      const v = (answerDrafts[q.id] ?? "").trim();
                      if (v) submitAnswer(q, "FREE_TEXT", v);
                    }}
                    disabled={answeringId === q.id || !(answerDrafts[q.id] ?? "").trim()}
                    className="shrink-0 text-[11px] bg-ink text-white rounded px-2.5 py-1.5 disabled:opacity-40 hover:bg-black transition"
                  >
                    回答する
                  </button>
                </div>
              )}
              <div className="flex gap-2 mt-1.5">
                <button
                  onClick={() => submitAnswer(q, "UNKNOWN")}
                  disabled={answeringId === q.id}
                  className="text-[10px] text-faint underline disabled:opacity-40"
                >
                  わからない
                </button>
                <button
                  onClick={() => submitAnswer(q, "DEFERRED")}
                  disabled={answeringId === q.id}
                  className="text-[10px] text-faint underline disabled:opacity-40"
                >
                  あとで答える
                </button>
              </div>
            </div>
          ))}
        </div>
      )}

      {selectablePending.length > 1 && (
        <div className="flex items-center justify-between gap-2 mt-3 rounded-lg border border-line bg-canvas px-3 py-2">
          <label className="flex items-center gap-1.5 text-[11px] text-muted">
            <input
              type="checkbox"
              checked={allSelected}
              onChange={(e) => {
                setSelectedIds(e.target.checked ? new Set(selectablePending.map((c) => c.identityId)) : new Set());
              }}
            />
            すべて選択({selectablePending.length}件中{selectedCount}件選択中)
          </label>
          <div className="flex gap-1.5">
            <button
              onClick={() => bulkDecide("ACCEPTED")}
              disabled={selectedCount === 0 || bulkBusy}
              className="text-[11px] bg-ink text-white rounded px-2.5 py-1.5 disabled:opacity-40 hover:bg-black transition"
            >
              {bulkBusy ? "処理中..." : "選択した候補をまとめて採用"}
            </button>
            <button
              onClick={() => bulkDecide("REJECTED")}
              disabled={selectedCount === 0 || bulkBusy}
              className="text-[11px] bg-canvas border border-line text-muted rounded px-2.5 py-1.5 disabled:opacity-40 hover:bg-line/40 transition"
            >
              まとめて却下
            </button>
            {/* [2026-08-30新設・M1-C2B DEC-MERGE-001] 既存の複数選択(selectedIds)を
                流用し、2件以上選択時のみ「統合する」を出す。 */}
            <button
              onClick={startMerge}
              disabled={selectedCount < 2 || bulkBusy || mergeBusy}
              className="text-[11px] bg-canvas border border-line text-muted rounded px-2.5 py-1.5 disabled:opacity-40 hover:bg-line/40 transition"
            >
              統合する
            </button>
          </div>
        </div>
      )}

      {/* [2026-08-30新設・M1-C2B] 統合フォーム。選択済み候補群(selectedIds)を
          親としてMergeする。本人が統合後の内容を明示入力するまでMergeは
          実行されない(DEC-MERGE-001「AIに統合内容を勝手に決めさせない」)。 */}
      {mergingOpen && (
        <div className="mt-3 rounded-lg border border-line bg-canvas p-3 space-y-2">
          <p className="text-[11px] text-muted">
            選択した{selectedCount}件の候補を1件に統合します。統合後の内容を入力してください(元候補の履歴は削除されません)。
          </p>
          <div className="flex items-center gap-1.5">
            <select
              value={mergeDraft.type}
              onChange={(e) => setMergeDraft((prev) => ({ ...prev, type: e.target.value }))}
              className="text-[11px] rounded border border-line px-1.5 py-1.5"
            >
              {Object.entries(CANDIDATE_TYPE_LABEL).map(([value, label]) => (
                <option key={value} value={value}>
                  {label}
                </option>
              ))}
            </select>
            <input
              type="text"
              value={mergeDraft.title}
              onChange={(e) => setMergeDraft((prev) => ({ ...prev, title: e.target.value }))}
              placeholder="統合後のtitle"
              className="flex-1 min-w-0 text-sm rounded border border-line px-2 py-1.5"
            />
          </div>
          <textarea
            value={mergeDraft.description}
            onChange={(e) => setMergeDraft((prev) => ({ ...prev, description: e.target.value }))}
            placeholder="説明(任意)"
            rows={2}
            className="w-full text-sm rounded border border-line px-2 py-1.5"
          />
          <input
            type="text"
            value={mergeDraft.completionCondition}
            onChange={(e) => setMergeDraft((prev) => ({ ...prev, completionCondition: e.target.value }))}
            placeholder="完了条件(任意)"
            className="w-full text-sm rounded border border-line px-2 py-1.5"
          />
          <div className="flex justify-end gap-1.5">
            <button onClick={cancelMerge} className="text-[11px] text-faint px-2 py-1.5">
              キャンセル
            </button>
            <button
              onClick={submitMerge}
              disabled={mergeBusy || !mergeDraft.title.trim()}
              className="text-[11px] bg-ink text-white rounded px-2.5 py-1.5 disabled:opacity-40 hover:bg-black transition"
            >
              {mergeBusy ? "処理中..." : "統合を確定"}
            </button>
          </div>
        </div>
      )}

      {data.candidates.length > 0 && (
        <ul className="space-y-2 mt-3">
          {data.candidates.map((c) => {
            const rev = c.currentRevision;
            const isPending = !c.formationDecision;
            const isBusy = decidingId === c.identityId;
            // [2026-08-30是正・M1-B5a CLARIFYING UI] 従来はsession.stateを見ずに
            // isPending&&revだけで採否ボタンを描画しており、CLARIFYING中でも
            // ボタンが表示されてクリックするとバックエンドでINVALID_SESSION_STATEに
            // なる紛らわしい状態だった。sessionActive(REVIEW_READY/PARTIALLY_CONFIRMED)
            // でもガードする。
            const isSelectable = isPending && !!rev && sessionActive;
            const conflictCode = c.legacyProjection?.conflictCode ?? null;
            return (
              <li key={c.identityId} className="rounded-lg p-3 bg-ai-50">
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0 flex items-start gap-2">
                    {isSelectable && selectablePending.length > 1 && (
                      <input
                        type="checkbox"
                        className="mt-1 shrink-0"
                        checked={selectedIds.has(c.identityId)}
                        onChange={() => toggleSelected(c.identityId)}
                        aria-label="この候補を一括操作の対象にする"
                      />
                    )}
                    <div className="min-w-0">
                      <div className="flex items-center gap-1.5 flex-wrap">
                        <span className="text-[10px] px-1.5 py-0.5 rounded font-medium bg-brand-50 text-brand-700">
                          {rev ? (CANDIDATE_TYPE_LABEL[rev.type] ?? rev.type) : "(不明)"}
                        </span>
                        {rev && <span className="text-[10px] text-faint">確度 {rev.confidence.toFixed(2)}</span>}
                        {!isPending && c.formationDecision && (
                          <span className="text-[10px] text-faint">
                            ({c.formationDecision.decision === "ACCEPTED" ? "採用済み" : c.formationDecision.decision === "REJECTED" ? "却下済み" : c.formationDecision.decision === "SPLIT" ? "分解済み" : c.formationDecision.decision})
                          </span>
                        )}
                        {c.materialization && <span className="text-[10px] text-safe">✓ 責任として作成済み</span>}
                        {c.atomicityAssessment &&
                          (c.atomicityAssessment.assessment === "SHOULD_DECOMPOSE" ||
                            c.atomicityAssessment.assessment === "NEEDS_CLARIFICATION" ||
                            c.atomicityAssessment.assessment === "CONTEXT_LIKE") && (
                            <span className="text-[10px] px-1.5 py-0.5 rounded font-medium bg-amber-50 text-amber-700">
                              {ATOMICITY_ASSESSMENT_LABEL[c.atomicityAssessment.assessment] ?? c.atomicityAssessment.assessment}
                            </span>
                          )}
                        {conflictCode === "LEGACY_PROJECTION_CONFLICT" && (
                          <span className="text-[10px] text-warn">⚠ 旧経路データ不整合</span>
                        )}
                        {conflictCode === "DECISION_MISMATCH" && (
                          <span className="text-[10px] text-warn">⚠ 旧経路と決定が食い違い</span>
                        )}
                      </div>
                      <p className="text-sm text-ink font-medium mt-1 break-words">
                        {rev?.title ?? "(候補データなし)"}
                      </p>
                      {rev?.description && <p className="text-[11px] text-muted mt-0.5">{rev.description}</p>}
                      {/* [2026-08-30新設・M1-C §11.3「理由、使用Evidence…を表示する」]
                          分解を推奨/要確認/プロジェクト的の場合のみ理由を明示する
                          (通常のATOMIC/PROBABLY_ATOMICは表示ノイズになるため出さない)。
                          Observationの提示のみで、自動分割は一切行わない。 */}
                      {c.atomicityAssessment &&
                        (c.atomicityAssessment.assessment === "SHOULD_DECOMPOSE" ||
                          c.atomicityAssessment.assessment === "NEEDS_CLARIFICATION" ||
                          c.atomicityAssessment.assessment === "CONTEXT_LIKE") && (
                          <div className="mt-1.5 rounded bg-amber-50 px-2 py-1.5 text-[10px] text-amber-800">
                            {Array.isArray(c.atomicityAssessment.evidence)
                              ? (c.atomicityAssessment.evidence as Array<{ detail?: string }>)
                                  .map((e) => e.detail)
                                  .filter(Boolean)
                                  .join(" / ")
                              : null}
                          </div>
                        )}
                      {conflictCode && c.legacyProjection && (
                        <div className="mt-1.5 rounded bg-warn-50 px-2 py-1.5 text-[10px] text-warn">
                          {conflictCode === "DECISION_MISMATCH" ? (
                            <>
                              旧経路(inferenceId: {c.legacyProjection.inferenceId})は
                              {LEGACY_DECISION_LABEL[c.legacyProjection.decision] ?? c.legacyProjection.decision}
                              {c.legacyProjection.decidedAt
                                ? `(${new Date(c.legacyProjection.decidedAt).toLocaleString("ja-JP")})`
                                : ""}
                              ですが、Formation側の決定と食い違っています。想像で自動解消せず、内容を確認してください。
                            </>
                          ) : (
                            <>
                              旧経路(inferenceId: {c.legacyProjection.inferenceId})は
                              {LEGACY_DECISION_LABEL[c.legacyProjection.decision] ?? c.legacyProjection.decision}
                              ですが、対応するResponsibilityが見つかりません(データ不整合)。
                            </>
                          )}
                        </div>
                      )}
                    </div>
                  </div>
                  {isSelectable && (
                    <div className="shrink-0 flex gap-1.5">
                      <button
                        onClick={() => decide(c, "ACCEPTED")}
                        disabled={isBusy}
                        className="text-[11px] bg-ink text-white rounded px-2.5 py-1.5 disabled:opacity-40 hover:bg-black transition"
                      >
                        採用
                      </button>
                      <button
                        onClick={() => decide(c, "REJECTED")}
                        disabled={isBusy}
                        className="text-[11px] bg-canvas border border-line text-muted rounded px-2.5 py-1.5 disabled:opacity-40 hover:bg-line/40 transition"
                      >
                        却下
                      </button>
                      <button
                        onClick={() => startSplit(c.identityId)}
                        disabled={isBusy}
                        className="text-[11px] bg-canvas border border-line text-muted rounded px-2.5 py-1.5 disabled:opacity-40 hover:bg-line/40 transition"
                      >
                        分解する
                      </button>
                    </div>
                  )}
                </div>
                {/* [2026-08-30新設・M1-C §11.4] 分解フォーム。本人が2件以上の部分を
                    入力し確定した場合のみSPLIT Correctionを記録する(§11.3
                    「Assessmentは…責任を自動分割しない」、あくまで本人操作が起点)。 */}
                {splittingId === c.identityId && (
                  <div className="mt-2 rounded-lg border border-line bg-canvas p-3 space-y-2">
                    <p className="text-[11px] text-muted">
                      「{rev?.title}」を2件以上の独立した作業に分解します。各部分の種別とtitleを入力してください。
                    </p>
                    {splitParts.map((part, i) => (
                      <div key={i} className="flex items-center gap-1.5">
                        <select
                          value={part.type}
                          onChange={(e) =>
                            setSplitParts((prev) => prev.map((p, idx) => (idx === i ? { ...p, type: e.target.value } : p)))
                          }
                          className="text-[11px] rounded border border-line px-1.5 py-1.5"
                        >
                          {Object.entries(CANDIDATE_TYPE_LABEL).map(([value, label]) => (
                            <option key={value} value={value}>
                              {label}
                            </option>
                          ))}
                        </select>
                        <input
                          type="text"
                          value={part.title}
                          onChange={(e) =>
                            setSplitParts((prev) => prev.map((p, idx) => (idx === i ? { ...p, title: e.target.value } : p)))
                          }
                          placeholder={`部分${i + 1}のtitle`}
                          className="flex-1 min-w-0 text-sm rounded border border-line px-2 py-1.5"
                        />
                        {splitParts.length > 2 && (
                          <button
                            onClick={() => setSplitParts((prev) => prev.filter((_, idx) => idx !== i))}
                            className="text-[10px] text-faint underline shrink-0"
                          >
                            削除
                          </button>
                        )}
                      </div>
                    ))}
                    <div className="flex items-center justify-between gap-2">
                      <button
                        onClick={() => setSplitParts((prev) => [...prev, { type: "TASK", title: "" }])}
                        className="text-[10px] text-faint underline"
                      >
                        + 部分を追加
                      </button>
                      <div className="flex gap-1.5">
                        <button onClick={cancelSplit} className="text-[11px] text-faint px-2 py-1.5">
                          キャンセル
                        </button>
                        <button
                          onClick={() => submitSplit(c)}
                          disabled={splitBusy}
                          className="text-[11px] bg-ink text-white rounded px-2.5 py-1.5 disabled:opacity-40 hover:bg-black transition"
                        >
                          {splitBusy ? "処理中..." : "分解を確定"}
                        </button>
                      </div>
                    </div>
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      )}
      {data.candidates.length === 0 && (
        <p className="text-[11px] text-faint mt-3">このSessionにはまだ候補がありません。</p>
      )}
      {decidedCandidates.length > 0 && pendingCandidates.length === 0 && !data.allowedActions.materialize && !data.allowedActions.finalize && (
        <p className="text-[11px] text-faint mt-3">全ての候補が処理済みです。</p>
      )}
      {error && <p className="text-sm text-red-600 mt-3">{error}</p>}
    </div>
  );
}
