"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";

/** [AUTH-EMAIL-01新設・2026-09-26] 再設定メールのリンク先(/reset-password?token=...)。 */
interface ApiBody {
  error?: { message?: string; fieldErrors?: Record<string, string> };
}

export function ResetPasswordForm({ token }: { token: string }) {
  const router = useRouter();
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [done, setDone] = useState(false);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError("");
    if (newPassword !== confirmPassword) {
      setError("確認用のパスワードが一致しません");
      return;
    }
    setLoading(true);
    try {
      const res = await fetch("/api/v1/auth/password/reset", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token, newPassword }),
      });
      if (!res.ok) {
        const body = (await res.json()) as ApiBody;
        setError(body.error?.fieldErrors?.newPassword || body.error?.message || "再設定に失敗しました");
        return;
      }
      setDone(true);
      router.replace("/reset-password");
    } catch {
      setError("通信に失敗しました。時間をおいて再度お試しください");
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="min-h-screen flex items-center justify-center bg-slate-100">
      <div className="bg-white rounded-xl shadow-md p-8 w-full max-w-sm space-y-4">
        <div>
          <h1 className="text-xl font-bold text-slate-800 mb-1">新しいパスワードの設定</h1>
          <p className="text-sm text-slate-500">ISMAY</p>
        </div>
        {done ? (
          <>
            <p className="text-sm text-slate-700 bg-slate-50 rounded-lg px-3 py-2">
              パスワードを変更しました。すべての端末からログアウトしています。新しいパスワードでログインしてください。
            </p>
            <Link
              href="/login"
              className="block w-full text-center bg-slate-900 hover:bg-black text-white font-medium rounded-lg px-4 py-2 text-sm transition-colors"
            >
              ログイン画面へ
            </Link>
          </>
        ) : token.length === 0 ? (
          <>
            <p className="text-sm text-red-600 bg-red-50 rounded-lg px-3 py-2">
              再設定リンクが正しくありません。メールのリンクをもう一度開くか、再設定をやり直してください。
            </p>
            <Link href="/forgot-password" className="block text-center text-sm text-slate-500 underline">
              パスワード再設定をやり直す
            </Link>
          </>
        ) : (
          <form onSubmit={handleSubmit} className="space-y-4">
            <div>
              <label className="block text-sm font-medium text-slate-700 mb-1">新しいパスワード</label>
              <input
                type="password"
                value={newPassword}
                onChange={(e) => setNewPassword(e.target.value)}
                required
                autoComplete="new-password"
                className="w-full border border-slate-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
              />
              <p className="text-xs text-slate-400 mt-1">8文字以上、英大小文字・数字・記号のうち3種類以上</p>
            </div>
            <div>
              <label className="block text-sm font-medium text-slate-700 mb-1">新しいパスワード(確認)</label>
              <input
                type="password"
                value={confirmPassword}
                onChange={(e) => setConfirmPassword(e.target.value)}
                required
                autoComplete="new-password"
                className="w-full border border-slate-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
              />
            </div>
            {error && <p className="text-sm text-red-600 bg-red-50 rounded-lg px-3 py-2">{error}</p>}
            <button
              type="submit"
              disabled={loading}
              className="w-full bg-slate-900 hover:bg-black disabled:bg-slate-400 text-white font-medium rounded-lg px-4 py-2 text-sm transition-colors"
            >
              {loading ? "変更中..." : "パスワードを変更する"}
            </button>
          </form>
        )}
      </div>
    </div>
  );
}
