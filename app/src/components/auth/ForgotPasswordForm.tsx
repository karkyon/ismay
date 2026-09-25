"use client";

import { useState } from "react";
import Link from "next/link";

/** [AUTH-EMAIL-01新設・2026-09-26] パスワード再設定メールの要求画面(/forgot-password)。 */
interface ApiBody {
  data?: { message?: string };
  error?: { message?: string };
}

export function ForgotPasswordForm() {
  const [email, setEmail] = useState("");
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError("");
    setMessage("");
    setLoading(true);
    try {
      const res = await fetch("/api/v1/auth/password/forgot", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email }),
      });
      const body = (await res.json()) as ApiBody;
      if (!res.ok) {
        setError(body.error?.message ?? "送信に失敗しました");
        return;
      }
      setMessage(body.data?.message ?? "再設定メールを送信しました");
    } catch {
      setError("通信に失敗しました。時間をおいて再度お試しください");
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="min-h-screen flex items-center justify-center bg-slate-100">
      <div className="bg-white rounded-xl shadow-md p-8 w-full max-w-sm">
        <h1 className="text-xl font-bold text-slate-800 mb-1">パスワードの再設定</h1>
        <p className="text-sm text-slate-500 mb-6">登録したメールアドレスに再設定用のリンクを送ります</p>
        <form onSubmit={handleSubmit} className="space-y-4">
          <div>
            <label className="block text-sm font-medium text-slate-700 mb-1">メールアドレス</label>
            <input
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              required
              className="w-full border border-slate-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
              placeholder="you@example.com"
            />
          </div>
          {message && <p className="text-sm text-slate-700 bg-slate-50 rounded-lg px-3 py-2">{message}</p>}
          {error && <p className="text-sm text-red-600 bg-red-50 rounded-lg px-3 py-2">{error}</p>}
          <button
            type="submit"
            disabled={loading}
            className="w-full bg-slate-900 hover:bg-black disabled:bg-slate-400 text-white font-medium rounded-lg px-4 py-2 text-sm transition-colors"
          >
            {loading ? "送信中..." : "再設定メールを送る"}
          </button>
          <p className="text-xs text-slate-400">
            メールアドレスの確認が済んでいない場合、再設定メールは届きません。先にログイン画面から確認メールを再送してください。
          </p>
          <Link href="/login" className="block text-center text-xs text-slate-500 underline">
            ログイン画面へ戻る
          </Link>
        </form>
      </div>
    </div>
  );
}
