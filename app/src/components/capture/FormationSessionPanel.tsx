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
  legacyProjection: { inferenceId: string; decision: string; conflictCode: string | null } | null;
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

export function FormationSessionPanel({ sessionId, onChanged }: { sessionId: string; onChanged?: () => void }) {
  const [data, setData] = useState<ProjectionResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [decidingId, setDecidingId] = useState<string | null>(null);
  const [materializing, setMaterializing] = useState(false);

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
      await load(true);
      onChanged?.();
    } finally {
      setDecidingId(null);
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

      {data.candidates.length > 0 && (
        <ul className="space-y-2 mt-3">
          {data.candidates.map((c) => {
            const rev = c.currentRevision;
            const isPending = !c.formationDecision;
            const isBusy = decidingId === c.identityId;
            return (
              <li key={c.identityId} className="rounded-lg p-3 bg-ai-50">
                <div className="flex items-start justify-between gap-2">
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
                      {c.legacyProjection?.conflictCode && (
                        <span className="text-[10px] text-warn">⚠ 旧経路データ不整合</span>
                      )}
                    </div>
                    <p className="text-sm text-ink font-medium mt-1 break-words">
                      {rev?.title ?? "(候補データなし)"}
                    </p>
                    {rev?.description && <p className="text-[11px] text-muted mt-0.5">{rev.description}</p>}
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
