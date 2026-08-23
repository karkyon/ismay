"use client";

import { useCallback, useEffect, useState } from "react";
import { apiFetch, debugFetch } from "@/lib/auth/client";
import { debugLog } from "@/lib/debug";

interface FactRow {
  id: string;
  payload: { statement?: string; source?: string };
  occurredAt: string;
}
interface ObservationRow {
  id: string;
  payload: { statement?: string; sampleSize?: number; comparisonSampleSize?: number; windowDays?: number };
  occurredAt: string;
}
interface HypothesisRow {
  id: string;
  statement: string;
  sampleSize: number;
  confidence: number;
  userVerdict: string;
  createdAt: string;
}
interface HypothesesResponse {
  facts: FactRow[];
  observations: ObservationRow[];
  hypotheses: HypothesisRow[];
}

function confidenceLabel(confidence: number): string {
  if (confidence >= 0.6) return "高";
  if (confidence >= 0.3) return "中";
  return "低";
}

/**
 * UI-09 あなたの実行モデル。API-PEM-02(GET /pem/hypotheses、GET/PATCH /pem/hypotheses/{id})
 * を使う。ワイヤーフレーム(ISMAY_画面UX設計書v2.1)のUI-09を実装として再現する。
 */
export function PemModelClient() {
  const [data, setData] = useState<HypothesesResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [resetOpen, setResetOpen] = useState(false);
  const [resetPassword, setResetPassword] = useState("");
  const [resetConfirm, setResetConfirm] = useState("");
  const [resetError, setResetError] = useState<string | null>(null);
  const [resetBusy, setResetBusy] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    const res = await debugFetch("/api/v1/pem/hypotheses");
    if (res.ok) {
      const body = await res.json();
      setData(body.data);
    }
    setLoading(false);
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  async function setVerdict(id: string, userVerdict: "CONFIRMED" | "REJECTED" | "TEMPORARY") {
    setBusyId(id);
    try {
      const res = await apiFetch(`/api/v1/pem/hypotheses/${id}`, {
        method: "PATCH",
        body: JSON.stringify({ userVerdict }),
      });
      if (res.ok) await load();
      else debugLog.error("PemModelClient", "訂正失敗", null);
    } finally {
      setBusyId(null);
    }
  }

  async function forget(id: string) {
    setBusyId(id);
    try {
      const res = await apiFetch(`/api/v1/pem/hypotheses/${id}`, {
        method: "PATCH",
        body: JSON.stringify({ forget: true }),
      });
      if (res.ok) await load();
    } finally {
      setBusyId(null);
    }
  }

  async function submitReset() {
    setResetError(null);
    if (resetConfirm !== "リセット") {
      setResetError("確認文字列に「リセット」と入力してください");
      return;
    }
    setResetBusy(true);
    try {
      const res = await apiFetch("/api/v1/pem/reset", {
        method: "POST",
        body: JSON.stringify({ currentPassword: resetPassword, confirmText: resetConfirm }),
      });
      if (res.ok) {
        setResetOpen(false);
        setResetPassword("");
        setResetConfirm("");
        await load();
      } else {
        const body = await res.json().catch(() => null);
        setResetError(body?.error?.message ?? "リセットに失敗しました");
      }
    } finally {
      setResetBusy(false);
    }
  }

  if (loading) {
    return <p className="text-sm text-faint">読み込み中...</p>;
  }

  const hasContent = !!data && (data.facts.length > 0 || data.observations.length > 0 || data.hypotheses.length > 0);

  return (
    <div>
      <div className="mb-6">
        <h1 className="font-serif text-3xl mb-1">あなたの実行モデル</h1>
        <p className="text-sm text-muted">固定的な「先延ばし度」のようなスコアは表示しません。すべて根拠と母数を伴います</p>
      </div>

      {!hasContent ? (
        <div className="bg-surface border border-dashed border-line rounded-2xl p-10 text-center">
          <p className="text-sm font-medium text-ink">まだ十分な観察がありません</p>
          <p className="text-[12px] text-muted mt-1 max-w-sm mx-auto">
            母数が少ないうちは仮説を提示しません。あと数回、責任の完了・延期が記録されると最初の観察が表示されます。
          </p>
        </div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-5">
          {data!.facts.map((f) => (
            <div key={f.id} className="bg-surface border border-line rounded-2xl p-5">
              <div className="flex items-center gap-2 mb-3">
                <span className="w-2 h-2 rounded-full bg-safe" />
                <span className="text-xs font-mono text-faint">確認済み事実・FACT</span>
              </div>
              <p className="text-sm">{f.payload.statement}</p>
              <p className="text-[11px] text-faint mt-2">
                {f.payload.source === "ONBOARDING" ? "初回対話" : "記録"} {new Date(f.occurredAt).toLocaleDateString("ja-JP")}
              </p>
            </div>
          ))}

          {data!.observations.map((o) => (
            <div key={o.id} className="bg-surface border border-line rounded-2xl p-5">
              <div className="flex items-center gap-2 mb-3">
                <span className="w-2 h-2 rounded-full bg-brand" />
                <span className="text-xs font-mono text-faint">観察・OBSERVATION</span>
              </div>
              <p className="text-sm">{o.payload.statement}</p>
              <p className="text-[11px] text-faint mt-2">
                過去{o.payload.windowDays ? Math.round(o.payload.windowDays / 7) : 4}週間・母数{o.payload.sampleSize}
              </p>
            </div>
          ))}

          {data!.hypotheses.map((h) => (
            <div key={h.id} className="bg-surface border-2 border-ai/30 rounded-2xl p-5 md:col-span-2">
              <div className="flex items-center justify-between mb-3">
                <div className="flex items-center gap-2">
                  <span className="w-2 h-2 rounded-full bg-ai" />
                  <span className="text-xs font-mono text-ai">
                    仮説・HYPOTHESIS・確度:{confidenceLabel(h.confidence)}
                  </span>
                </div>
                {h.userVerdict !== "PENDING" && (
                  <span className="text-[11px] text-faint">
                    {h.userVerdict === "CONFIRMED" ? "合っている" : h.userVerdict === "REJECTED" ? "違う" : "今だけ一時的"}
                  </span>
                )}
              </div>
              <p className="text-sm">{h.statement}</p>
              <div className="flex items-center gap-2 mt-4 flex-wrap">
                <button
                  onClick={() => setVerdict(h.id, "CONFIRMED")}
                  disabled={busyId === h.id}
                  className={`text-xs border rounded-lg px-3 py-1.5 hover:bg-canvas disabled:opacity-40 ${h.userVerdict === "CONFIRMED" ? "border-brand text-brand-700" : "border-line"}`}
                >
                  合っている
                </button>
                <button
                  onClick={() => setVerdict(h.id, "REJECTED")}
                  disabled={busyId === h.id}
                  className={`text-xs border rounded-lg px-3 py-1.5 hover:bg-canvas disabled:opacity-40 ${h.userVerdict === "REJECTED" ? "border-red-400 text-red-600" : "border-line"}`}
                >
                  違う
                </button>
                <button
                  onClick={() => setVerdict(h.id, "TEMPORARY")}
                  disabled={busyId === h.id}
                  className={`text-xs border rounded-lg px-3 py-1.5 hover:bg-canvas disabled:opacity-40 ${h.userVerdict === "TEMPORARY" ? "border-amber-400 text-amber-700" : "border-line"}`}
                >
                  今だけ一時的
                </button>
                <button
                  onClick={() => forget(h.id)}
                  disabled={busyId === h.id}
                  className="text-xs text-faint hover:text-red-600 ml-auto"
                >
                  今後使わない(忘却)
                </button>
              </div>
            </div>
          ))}
        </div>
      )}

      <div className="mt-6 flex items-center gap-4 text-xs text-muted">
        <button onClick={() => setResetOpen(true)} className="hover:text-red-600 text-red-600/80">
          モデルをリセットする
        </button>
      </div>

      {resetOpen && (
        <div
          className="fixed inset-0 bg-black/30 z-40 flex items-center justify-center p-4"
          onClick={() => !resetBusy && setResetOpen(false)}
        >
          <div
            onClick={(e) => e.stopPropagation()}
            className="bg-surface rounded-2xl shadow-pop w-full max-w-sm p-5"
          >
            <p className="text-sm font-medium text-ink mb-1">実行モデルをリセットしますか?</p>
            <p className="text-[12px] text-muted mb-4">
              事実・観察・仮説をすべて削除します(責任・約束等の業務データは削除されません)。本人確認のためパスワードと確認文字列の入力が必要です。
            </p>
            <input
              type="password"
              value={resetPassword}
              onChange={(e) => setResetPassword(e.target.value)}
              placeholder="現在のパスワード"
              className="w-full text-sm border border-line rounded-lg px-3 py-2 mb-2 focus:outline-none focus:border-brand"
            />
            <input
              type="text"
              value={resetConfirm}
              onChange={(e) => setResetConfirm(e.target.value)}
              placeholder="「リセット」と入力"
              className="w-full text-sm border border-line rounded-lg px-3 py-2 mb-2 focus:outline-none focus:border-brand"
            />
            {resetError && <p className="text-xs text-red-600 mb-2">{resetError}</p>}
            <div className="flex items-center justify-end gap-2 mt-2">
              <button onClick={() => setResetOpen(false)} disabled={resetBusy} className="text-xs text-faint px-3 py-2">
                キャンセル
              </button>
              <button
                onClick={submitReset}
                disabled={resetBusy}
                className="text-xs bg-red-600 text-white font-medium px-4 py-2 rounded-lg disabled:opacity-40"
              >
                リセットする
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
