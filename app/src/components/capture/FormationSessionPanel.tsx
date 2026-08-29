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
  formationDecision: { decision: string; occurredAt: string } | null;
  materialization: { responsibilityId: string; committedAt: string } | null;
  legacyProjection: {
    inferenceId: string;
    decision: string;
    decidedAt: string | null;
    conflictCode: "LEGACY_PROJECTION_CONFLICT" | "DECISION_MISMATCH" | null;
  } | null;
}

interface ProjectionResponse {
  session: { id: string; state: string; version: number };
  candidates: ProjectionCandidate[];
  allowedActions: { decide: boolean; materialize: boolean; finalize: boolean };
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

export function FormationSessionPanel({ sessionId, onChanged }: { sessionId: string; onChanged?: () => void }) {
  const [data, setData] = useState<ProjectionResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [decidingId, setDecidingId] = useState<string | null>(null);
  const [materializing, setMaterializing] = useState(false);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [bulkBusy, setBulkBusy] = useState(false);

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
          </div>
        </div>
      )}

      {data.candidates.length > 0 && (
        <ul className="space-y-2 mt-3">
          {data.candidates.map((c) => {
            const rev = c.currentRevision;
            const isPending = !c.formationDecision;
            const isBusy = decidingId === c.identityId;
            const isSelectable = isPending && !!rev;
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
                            ({c.formationDecision.decision === "ACCEPTED" ? "採用済み" : c.formationDecision.decision === "REJECTED" ? "却下済み" : c.formationDecision.decision})
                          </span>
                        )}
                        {c.materialization && <span className="text-[10px] text-safe">✓ 責任として作成済み</span>}
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
                  {isPending && rev && (
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
                    </div>
                  )}
                </div>
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
