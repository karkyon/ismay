"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

type Step = "login" | "mfa-verify";

interface ApiError {
  error?: { code: string; message: string };
}

export function LoginForm() {
  const router = useRouter();
  const [step, setStep] = useState<Step>("login");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [code, setCode] = useState("");
  const [challengeToken, setChallengeToken] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  async function handleLogin(e: React.FormEvent) {
    e.preventDefault();
    setError("");
    setLoading(true);
    try {
      const res = await fetch("/api/v1/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email, password }),
      });
      const body = await res.json();
      if (!res.ok) {
        setError((body as ApiError).error?.message ?? "ログインに失敗しました");
        return;
      }
      if (body.data.mfaRequired) {
        setChallengeToken(body.data.challengeToken);
        setStep("mfa-verify");
        return;
      }
      router.push("/dashboard");
      router.refresh();
    } catch {
      setError("通信に失敗しました。時間をおいて再度お試しください");
    } finally {
      setLoading(false);
    }
  }

  async function handleMfaVerify(e: React.FormEvent) {
    e.preventDefault();
    setError("");
    setLoading(true);
    try {
      const res = await fetch("/api/v1/auth/mfa/verify", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ challengeToken, code }),
      });
      const body = await res.json();
      if (!res.ok) {
        setError((body as ApiError).error?.message ?? "コードが正しくありません");
        return;
      }
      router.push("/dashboard");
      router.refresh();
    } catch {
      setError("通信に失敗しました。時間をおいて再度お試しください");
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="min-h-screen flex items-center justify-center bg-slate-100">
      <div className="bg-white rounded-xl shadow-md p-8 w-full max-w-sm">
        <h1 className="text-xl font-bold text-slate-800 mb-1">おかえりなさい</h1>
        <p className="text-sm text-slate-500 mb-6">ISMAY</p>

        {step === "login" && (
          <form onSubmit={handleLogin} className="space-y-4">
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
            <div>
              <label className="block text-sm font-medium text-slate-700 mb-1">パスワード</label>
              <input
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                required
                className="w-full border border-slate-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
              />
            </div>
            {error && <p className="text-sm text-red-600 bg-red-50 rounded-lg px-3 py-2">{error}</p>}
            <button
              type="submit"
              disabled={loading}
              className="w-full bg-slate-900 hover:bg-black disabled:bg-slate-400 text-white font-medium rounded-lg px-4 py-2 text-sm transition-colors"
            >
              {loading ? "確認中..." : "サインイン"}
            </button>
          </form>
        )}

        {step === "mfa-verify" && (
          <form onSubmit={handleMfaVerify} className="space-y-4">
            <div className="bg-slate-50 rounded-lg p-3 text-sm text-slate-700">
              <p className="font-bold mb-1">🔐 二要素認証</p>
              <p>認証アプリの6桁コード、または復旧コードを入力してください。</p>
            </div>
            <div>
              <input
                type="text"
                value={code}
                onChange={(e) => setCode(e.target.value)}
                required
                autoFocus
                className="w-full border border-slate-300 rounded-lg px-3 py-2 text-sm text-center tracking-widest text-lg focus:outline-none focus:ring-2 focus:ring-blue-500"
                placeholder="000000"
              />
            </div>
            {error && <p className="text-sm text-red-600 bg-red-50 rounded-lg px-3 py-2">{error}</p>}
            <button
              type="submit"
              disabled={loading}
              className="w-full bg-slate-900 hover:bg-black disabled:bg-slate-400 text-white font-medium rounded-lg px-4 py-2 text-sm transition-colors"
            >
              {loading ? "確認中..." : "確認する"}
            </button>
            <button
              type="button"
              onClick={() => setStep("login")}
              className="w-full text-center text-xs text-slate-400"
            >
              戻る
            </button>
          </form>
        )}
      </div>
    </div>
  );
}
