"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";

/**
 * [AUTH-EMAIL-01新設・2026-09-26] 確認メールのリンク先(/verify-email?token=...)。
 * 画面を開いただけでは確認を完了せず、ボタン押下でPOSTする
 * (メールのリンク先読みでtokenが消費されることを防ぐ)。
 */
interface ApiBody {
  data?: { verified?: boolean; alreadyVerified?: boolean };
  error?: { message?: string };
}

export function EmailVerifyForm({ token }: { token: string }) {
  const router = useRouter();
  const [status, setStatus] = useState<"idle" | "done">("idle");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  async function handleVerify() {
    setError("");
    setLoading(true);
    try {
      const res = await fetch("/api/v1/auth/email/verify", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token }),
      });
      const body = (await res.json()) as ApiBody;
      if (!res.ok) {
        setError(body.error?.message ?? "確認に失敗しました");
        return;
      }
      setStatus("done");
      // URLからtokenを消す(履歴・画面共有への残存を減らす)
      router.replace("/verify-email");
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
          <h1 className="text-xl font-bold text-slate-800 mb-1">メールアドレスの確認</h1>
          <p className="text-sm text-slate-500">ISMAY</p>
        </div>
        {status === "done" ? (
          <>
            <p className="text-sm text-slate-700 bg-slate-50 rounded-lg px-3 py-2">
              メールアドレスの確認が完了しました。ログインしてご利用ください。
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
              確認リンクが正しくありません。メールのリンクをもう一度開くか、ログイン画面から確認メールを再送してください。
            </p>
            <Link href="/login" className="block text-center text-sm text-slate-500 underline">
              ログイン画面へ
            </Link>
          </>
        ) : (
          <>
            <p className="text-sm text-slate-700">下のボタンを押すと、メールアドレスの確認が完了します。</p>
            {error && <p className="text-sm text-red-600 bg-red-50 rounded-lg px-3 py-2">{error}</p>}
            <button
              type="button"
              onClick={handleVerify}
              disabled={loading}
              className="w-full bg-slate-900 hover:bg-black disabled:bg-slate-400 text-white font-medium rounded-lg px-4 py-2 text-sm transition-colors"
            >
              {loading ? "確認中..." : "メールアドレスを確認する"}
            </button>
            <Link href="/login" className="block text-center text-xs text-slate-400">
              ログイン画面へ
            </Link>
          </>
        )}
      </div>
    </div>
  );
}
