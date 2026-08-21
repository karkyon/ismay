"use client";

import { useEffect, useState, useCallback } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { apiFetch, debugFetch } from "@/lib/auth/client";

interface MeResponse {
  data: { user: { id: string; email: string; displayName: string | null }; mfaEnabled: boolean };
}
interface SessionItem {
  id: string;
  deviceLabel: string | null;
  userAgent: string | null;
  ipAddress: string | null;
  issuedAt: string;
  lastUsedAt: string;
  expiresAt: string;
  isCurrent: boolean;
}

type EnrollStep = "idle" | "show-qr" | "recovery-codes";

export function DashboardClient() {
  const router = useRouter();
  const [me, setMe] = useState<MeResponse["data"] | null>(null);
  const [sessions, setSessions] = useState<SessionItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [enrollStep, setEnrollStep] = useState<EnrollStep>("idle");
  const [qrCodeDataUrl, setQrCodeDataUrl] = useState("");
  const [secret, setSecret] = useState("");
  const [enrollmentToken, setEnrollmentToken] = useState("");
  const [code, setCode] = useState("");
  const [recoveryCodes, setRecoveryCodes] = useState<string[]>([]);
  const [error, setError] = useState("");
  // [2026-08-21追加] カルキョンさんの指示「パス変更」に対応。従来パスワード変更手段が
  // 一つも存在しなかった(未実装の抜け漏れ)。
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [newPasswordConfirm, setNewPasswordConfirm] = useState("");
  const [passwordError, setPasswordError] = useState("");
  const [passwordSubmitting, setPasswordSubmitting] = useState(false);

  const load = useCallback(async () => {
    // debugFetchは401時に自動でRefresh Tokenによるサイレント延長を1回試みる(src/lib/auth/client.ts)。
    // それでも失敗した場合はAUTH_EXPIRED_EVENTが発火するが、この画面はAppShell配下ではないため
    // 従来通りここでも明示的に/loginへ遷移させる(二重ガード)。
    const meRes = await debugFetch("/api/v1/auth/me");
    if (!meRes.ok) {
      router.replace("/login");
      return;
    }
    const meBody: MeResponse = await meRes.json();
    setMe(meBody.data);

    const sessionsRes = await debugFetch("/api/v1/auth/sessions");
    if (sessionsRes.ok) {
      const body = await sessionsRes.json();
      setSessions(body.data.sessions);
    }
    setLoading(false);
  }, [router]);

  useEffect(() => {
    load();
  }, [load]);

  async function startEnroll() {
    setError("");
    const res = await apiFetch("/api/v1/auth/mfa/enroll", { method: "POST" });
    const body = await res.json();
    if (!res.ok) {
      setError(body.error?.message ?? "MFA登録の開始に失敗しました");
      return;
    }
    setQrCodeDataUrl(body.data.qrCodeDataUrl);
    setSecret(body.data.secret);
    setEnrollmentToken(body.data.enrollmentToken);
    setEnrollStep("show-qr");
  }

  async function confirmEnroll(e: React.FormEvent) {
    e.preventDefault();
    setError("");
    const res = await apiFetch("/api/v1/auth/mfa/enroll/confirm", {
      method: "POST",
      body: JSON.stringify({ enrollmentToken, code }),
    });
    const body = await res.json();
    if (!res.ok) {
      setError(body.error?.message ?? "コードが正しくありません");
      return;
    }
    setRecoveryCodes(body.data.recoveryCodes);
    setEnrollStep("recovery-codes");
    setCode("");
    await load();
  }

  async function logout() {
    await apiFetch("/api/v1/auth/logout", { method: "POST" });
    router.replace("/login");
  }

  async function changePassword(e: React.FormEvent) {
    e.preventDefault();
    setPasswordError("");
    if (newPassword !== newPasswordConfirm) {
      setPasswordError("新しいパスワード(確認)が一致しません");
      return;
    }
    setPasswordSubmitting(true);
    try {
      const res = await apiFetch("/api/v1/auth/password", {
        method: "POST",
        body: JSON.stringify({ currentPassword, newPassword }),
      });
      const body = await res.json().catch(() => null);
      if (!res.ok) {
        setPasswordError(body?.error?.message ?? "パスワードの変更に失敗しました");
        return;
      }
      // 成功時は全端末で再ログインが必要になる(サーバー側で全セッション失効済み)。
      router.replace("/login");
    } catch {
      setPasswordError("通信に失敗しました。ネットワーク状態を確認してもう一度お試しください");
    } finally {
      setPasswordSubmitting(false);
    }
  }

  async function revokeSession(id: string) {
    await apiFetch(`/api/v1/auth/sessions/${id}`, { method: "DELETE" });
    await load();
  }

  if (loading || !me) {
    return <div className="p-8 text-sm text-slate-500">読み込み中...</div>;
  }

  return (
    <div className="max-w-xl mx-auto p-8 space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-bold text-slate-800">{me.user.displayName ?? me.user.email}</h1>
          <p className="text-sm text-slate-500">{me.user.email}</p>
        </div>
        <div className="flex items-center gap-4">
          <Link href="/today" className="text-sm text-slate-500 hover:text-slate-800 underline">
            今日の画面へ
          </Link>
          <button onClick={logout} className="text-sm text-slate-500 hover:text-slate-800 underline">
            ログアウト
          </button>
        </div>
      </div>

      <section className="bg-white border border-slate-200 rounded-xl p-5">
        <h2 className="font-semibold text-slate-800 mb-2">二要素認証(MFA)</h2>
        {me.mfaEnabled && enrollStep === "idle" && (
          <p className="text-sm text-emerald-600">✅ 有効になっています</p>
        )}
        {!me.mfaEnabled && enrollStep === "idle" && (
          <div>
            <p className="text-sm text-slate-500 mb-3">未設定です。Google Authenticator等の認証アプリで設定できます。</p>
            <button
              onClick={startEnroll}
              className="bg-slate-900 hover:bg-black text-white text-sm rounded-lg px-4 py-2"
            >
              MFAを設定する
            </button>
          </div>
        )}
        {enrollStep === "show-qr" && (
          <form onSubmit={confirmEnroll} className="space-y-3">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={qrCodeDataUrl} alt="TOTP QRコード" className="w-48 h-48 border rounded-lg" />
            <p className="text-xs text-slate-500">手動入力する場合の秘密鍵: <code>{secret}</code></p>
            <input
              type="text"
              value={code}
              onChange={(e) => setCode(e.target.value)}
              maxLength={6}
              required
              autoFocus
              placeholder="000000"
              className="w-full border border-slate-300 rounded-lg px-3 py-2 text-sm text-center tracking-widest text-lg"
            />
            <button type="submit" className="w-full bg-slate-900 hover:bg-black text-white text-sm rounded-lg px-4 py-2">
              登録して有効化
            </button>
          </form>
        )}
        {enrollStep === "recovery-codes" && (
          <div className="space-y-2">
            <p className="text-sm text-emerald-600 font-medium">✅ 有効化しました。復旧コード（この画面でのみ表示されます）：</p>
            <ul className="grid grid-cols-2 gap-1 text-xs font-mono bg-slate-50 rounded-lg p-3">
              {recoveryCodes.map((c) => (
                <li key={c}>{c}</li>
              ))}
            </ul>
            <button onClick={() => setEnrollStep("idle")} className="text-xs text-slate-400 underline">
              閉じる
            </button>
          </div>
        )}
        {error && <p className="text-sm text-red-600 mt-2">{error}</p>}
      </section>

      {/* [2026-08-21新設] パスワード変更フォーム。成功時は全端末が再ログイン必須になる。 */}
      <section className="bg-white border border-slate-200 rounded-xl p-5">
        <h2 className="font-semibold text-slate-800 mb-3">パスワード変更</h2>
        <form onSubmit={changePassword} className="space-y-3 max-w-sm">
          <div>
            <label className="text-xs text-slate-500 block mb-1">現在のパスワード</label>
            <input
              type="password"
              value={currentPassword}
              onChange={(e) => setCurrentPassword(e.target.value)}
              required
              autoComplete="current-password"
              className="w-full border border-slate-300 rounded-lg px-3 py-2 text-sm"
            />
          </div>
          <div>
            <label className="text-xs text-slate-500 block mb-1">新しいパスワード</label>
            <input
              type="password"
              value={newPassword}
              onChange={(e) => setNewPassword(e.target.value)}
              required
              autoComplete="new-password"
              className="w-full border border-slate-300 rounded-lg px-3 py-2 text-sm"
            />
            <p className="text-[11px] text-slate-400 mt-1">
              8文字以上、英大文字・英小文字・数字・記号のうち3種類以上を組み合わせてください
            </p>
          </div>
          <div>
            <label className="text-xs text-slate-500 block mb-1">新しいパスワード(確認)</label>
            <input
              type="password"
              value={newPasswordConfirm}
              onChange={(e) => setNewPasswordConfirm(e.target.value)}
              required
              autoComplete="new-password"
              className="w-full border border-slate-300 rounded-lg px-3 py-2 text-sm"
            />
          </div>
          {passwordError && <p className="text-sm text-red-600">{passwordError}</p>}
          <button
            type="submit"
            disabled={passwordSubmitting}
            className="bg-slate-900 hover:bg-black text-white text-sm rounded-lg px-4 py-2 disabled:opacity-50"
          >
            {passwordSubmitting ? "変更中..." : "パスワードを変更する"}
          </button>
          <p className="text-[11px] text-slate-400">変更すると、この端末を含む全ての端末で再ログインが必要になります。</p>
        </form>
      </section>

      <section className="bg-white border border-slate-200 rounded-xl p-5">
        <h2 className="font-semibold text-slate-800 mb-3">ログイン中の端末・セッション</h2>
        <ul className="space-y-2">
          {sessions.map((s) => (
            <li key={s.id} className="flex items-center justify-between text-sm border-b border-slate-100 pb-2">
              <div>
                <p className="text-slate-700">
                  {s.ipAddress ?? "IP不明"} {s.isCurrent && <span className="text-emerald-600">(現在の端末)</span>}
                </p>
                <p className="text-xs text-slate-400 truncate max-w-xs">{s.userAgent ?? ""}</p>
              </div>
              {!s.isCurrent && (
                <button onClick={() => revokeSession(s.id)} className="text-xs text-red-600 underline">
                  失効
                </button>
              )}
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}
