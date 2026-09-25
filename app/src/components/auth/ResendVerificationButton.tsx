"use client";

import { useEffect, useState } from "react";

/**
 * [AUTH-EMAIL-01新設・2026-09-26] 確認メールの再送ボタン(ログイン画面・登録完了画面で共用)。
 * サーバー側の再送間隔(60秒)に合わせ、押した後60秒は押せないようにする。
 * 応答は登録有無を区別しない(サーバーが同じ文言を返す)。
 */
const COOLDOWN_SECONDS = 60;

interface ApiBody {
  data?: { message?: string };
  error?: { message?: string };
}

export function ResendVerificationButton({ email }: { email: string }) {
  const [remaining, setRemaining] = useState(0);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (remaining <= 0) return;
    const timer = setTimeout(() => setRemaining((r) => r - 1), 1000);
    return () => clearTimeout(timer);
  }, [remaining]);

  async function handleResend() {
    setError("");
    setMessage("");
    setLoading(true);
    try {
      const res = await fetch("/api/v1/auth/email/resend", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email }),
      });
      const body = (await res.json()) as ApiBody;
      if (!res.ok) {
        setError(body.error?.message ?? "再送に失敗しました");
        return;
      }
      setMessage(body.data?.message ?? "確認メールを送信しました");
      setRemaining(COOLDOWN_SECONDS);
    } catch {
      setError("通信に失敗しました。時間をおいて再度お試しください");
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="space-y-2">
      <button
        type="button"
        onClick={handleResend}
        disabled={loading || remaining > 0 || email.length === 0}
        className="w-full border border-slate-300 hover:bg-slate-50 disabled:text-slate-400 text-slate-700 font-medium rounded-lg px-4 py-2 text-sm transition-colors"
      >
        {loading ? "送信中..." : remaining > 0 ? `確認メールを再送する(${remaining}秒後に再送可)` : "確認メールを再送する"}
      </button>
      {message && <p className="text-xs text-slate-600 bg-slate-50 rounded-lg px-3 py-2">{message}</p>}
      {error && <p className="text-xs text-red-600 bg-red-50 rounded-lg px-3 py-2">{error}</p>}
    </div>
  );
}
