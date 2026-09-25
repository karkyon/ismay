"use client";

import { useState } from "react";
import Link from "next/link";
import { ResendVerificationButton } from "@/components/auth/ResendVerificationButton";

interface ApiError {
  error?: { code: string; message: string };
}

export function RegisterForm() {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  // [AUTH-EMAIL-01・2026-09-26] 登録直後はメール未確認でログインできないため、
  // ログイン画面へ遷移せず確認メールの案内を表示する。
  const [registeredEmail, setRegisteredEmail] = useState("");

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError("");
    setLoading(true);
    try {
      const res = await fetch("/api/v1/auth/register", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email, password, displayName: displayName || undefined }),
      });
      const body = await res.json();
      if (!res.ok) {
        setError((body as ApiError).error?.message ?? "登録に失敗しました");
        return;
      }
      setRegisteredEmail(email);
    } catch {
      setError("通信に失敗しました。時間をおいて再度お試しください");
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="min-h-screen flex items-center justify-center bg-slate-100">
      <div className="bg-white rounded-xl shadow-md p-8 w-full max-w-sm">
        <h1 className="text-xl font-bold text-slate-800 mb-1">アカウント登録</h1>
        <p className="text-sm text-slate-500 mb-6">ISMAY（動作確認用）</p>
        {registeredEmail ? (
          <div className="space-y-4">
            <p className="text-sm text-slate-700 bg-slate-50 rounded-lg px-3 py-2">
              {registeredEmail} 宛てに確認メールを送信しました。メールのリンク(有効期限24時間)を開いて登録を完了してください。確認が済むまでログインできません。
            </p>
            <ResendVerificationButton email={registeredEmail} />
            <Link href="/login" className="block text-center text-sm text-slate-500 underline">
              ログイン画面へ
            </Link>
          </div>
        ) : (
        <form onSubmit={handleSubmit} className="space-y-4">
          <div>
            <label className="block text-sm font-medium text-slate-700 mb-1">表示名(任意)</label>
            <input
              type="text"
              value={displayName}
              onChange={(e) => setDisplayName(e.target.value)}
              className="w-full border border-slate-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
            />
          </div>
          <div>
            <label className="block text-sm font-medium text-slate-700 mb-1">メールアドレス</label>
            <input
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              required
              className="w-full border border-slate-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
            />
          </div>
          <div>
            <label className="block text-sm font-medium text-slate-700 mb-1">パスワード</label>
            <input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              required
              className="w-full border border-slate-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
            />
            <p className="text-xs text-slate-400 mt-1">8文字以上、英大小文字・数字・記号のうち3種類以上</p>
          </div>
          {error && <p className="text-sm text-red-600 bg-red-50 rounded-lg px-3 py-2">{error}</p>}
          <button
            type="submit"
            disabled={loading}
            className="w-full bg-slate-900 hover:bg-black disabled:bg-slate-400 text-white font-medium rounded-lg px-4 py-2 text-sm transition-colors"
          >
            {loading ? "登録中..." : "登録する"}
          </button>
          <Link href="/login" className="block text-center text-xs text-slate-500 underline">
            ログイン画面へ戻る
          </Link>
        </form>
        )}
      </div>
    </div>
  );
}
