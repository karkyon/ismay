"use client";

import { useEffect, useState, useCallback, useRef } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import Link from "next/link";
import { apiFetch, debugFetch } from "@/lib/auth/client";

interface NotificationSettings {
  notifyQuietHoursStart: string | null;
  notifyQuietHoursEnd: string | null;
  notifyBundleWindowMinutes: number;
  notifyDeadlineEnabled: boolean;
  notifyFollowUpEnabled: boolean;
  notifyRiskEnabled: boolean;
}
interface MeResponse {
  data: {
    user: { id: string; email: string; displayName: string | null };
    mfaEnabled: boolean;
    notificationSettings: NotificationSettings;
  };
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
  const searchParams = useSearchParams();
  // [2026-08-22追加] カルキョンさんの指示「ユーザー情報とパスワードは別々のメニューにしろ」
  // に対応。AppShellのユーザーメニューから/dashboard?tab=passwordで来た場合、
  // パスワード変更セクションへ自動スクロールする。
  const passwordSectionRef = useRef<HTMLElement>(null);
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
  // [2026-08-22追加] FN-NTF-01 通知設定(静穏時間帯・まとめ通知の時間窓)。
  const [quietHoursEnabled, setQuietHoursEnabled] = useState(false);
  const [quietHoursStart, setQuietHoursStart] = useState("22:00");
  const [quietHoursEnd, setQuietHoursEnd] = useState("07:00");
  const [bundleWindowMinutes, setBundleWindowMinutes] = useState(15);
  const [deadlineEnabled, setDeadlineEnabled] = useState(true);
  const [followUpEnabled, setFollowUpEnabled] = useState(true);
  const [riskEnabled, setRiskEnabled] = useState(true);
  const [notificationError, setNotificationError] = useState("");
  const [notificationSaving, setNotificationSaving] = useState(false);
  const [notificationSaved, setNotificationSaved] = useState(false);
  // [2026-08-23追加] FN-PRV-01 データ主権(エクスポート・アカウント削除)。
  const [exporting, setExporting] = useState(false);
  const [exportError, setExportError] = useState("");
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [deletePassword, setDeletePassword] = useState("");
  const [deleteConfirmText, setDeleteConfirmText] = useState("");
  const [deleteError, setDeleteError] = useState("");
  const [deleting, setDeleting] = useState(false);

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
    const ns = meBody.data.notificationSettings;
    setQuietHoursEnabled(!!ns.notifyQuietHoursStart && !!ns.notifyQuietHoursEnd);
    if (ns.notifyQuietHoursStart) setQuietHoursStart(ns.notifyQuietHoursStart);
    if (ns.notifyQuietHoursEnd) setQuietHoursEnd(ns.notifyQuietHoursEnd);
    setBundleWindowMinutes(ns.notifyBundleWindowMinutes);
    setDeadlineEnabled(ns.notifyDeadlineEnabled);
    setFollowUpEnabled(ns.notifyFollowUpEnabled);
    setRiskEnabled(ns.notifyRiskEnabled);

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

  useEffect(() => {
    if (searchParams.get("tab") === "password" && !loading) {
      passwordSectionRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
    }
  }, [searchParams, loading]);

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

  async function saveNotificationSettings(e: React.FormEvent) {
    e.preventDefault();
    setNotificationError("");
    setNotificationSaved(false);
    setNotificationSaving(true);
    try {
      const res = await apiFetch("/api/v1/auth/notification-settings", {
        method: "PATCH",
        body: JSON.stringify({
          notifyQuietHoursStart: quietHoursEnabled ? quietHoursStart : null,
          notifyQuietHoursEnd: quietHoursEnabled ? quietHoursEnd : null,
          notifyBundleWindowMinutes: bundleWindowMinutes,
          notifyDeadlineEnabled: deadlineEnabled,
          notifyFollowUpEnabled: followUpEnabled,
          notifyRiskEnabled: riskEnabled,
        }),
      });
      const body = await res.json().catch(() => null);
      if (!res.ok) {
        setNotificationError(body?.error?.message ?? "通知設定の保存に失敗しました");
        return;
      }
      setNotificationSaved(true);
    } catch {
      setNotificationError("通信に失敗しました。ネットワーク状態を確認してもう一度お試しください");
    } finally {
      setNotificationSaving(false);
    }
  }

  /** データエクスポート(FN-PRV-01)。複数ファイルを個別Blobとして順にダウンロードさせる
   * (ZIP化は新規npm依存を避けるため今回は行わない。lib/dataExport.ts参照)。 */
  async function exportData() {
    setExportError("");
    setExporting(true);
    try {
      const res = await apiFetch("/api/v1/exports");
      const body = await res.json().catch(() => null);
      if (!res.ok || !body?.data?.files) {
        setExportError(body?.error?.message ?? "エクスポートに失敗しました");
        return;
      }
      const files: Record<string, string> = body.data.files;
      const stamp = new Date().toISOString().slice(0, 10);
      for (const [name, content] of Object.entries(files)) {
        const blob = new Blob([content], { type: name.endsWith(".json") ? "application/json" : "text/csv" });
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = url;
        a.download = `ismay-export-${stamp}-${name}`;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
        // 連続クリックだとブラウザが一部のダウンロードを間引くことがあるため、
        // ファイル間に短い間隔を空ける。
        await new Promise((r) => setTimeout(r, 300));
      }
    } catch {
      setExportError("通信に失敗しました。ネットワーク状態を確認してもう一度お試しください");
    } finally {
      setExporting(false);
    }
  }

  /** アカウント削除(FR-AUTH-05・FR-PRV-02)。本人再認証+確認文字列入力必須。 */
  async function deleteAccount(e: React.FormEvent) {
    e.preventDefault();
    setDeleteError("");
    setDeleting(true);
    try {
      const res = await apiFetch("/api/v1/auth/account/delete", {
        method: "POST",
        body: JSON.stringify({ currentPassword: deletePassword, confirmText: deleteConfirmText }),
      });
      const body = await res.json().catch(() => null);
      if (!res.ok) {
        setDeleteError(body?.error?.message ?? "削除に失敗しました");
        return;
      }
      router.replace("/login");
    } catch {
      setDeleteError("通信に失敗しました。ネットワーク状態を確認してもう一度お試しください");
    } finally {
      setDeleting(false);
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
      <section
        ref={passwordSectionRef}
        className={`bg-white border rounded-xl p-5 transition ${
          searchParams.get("tab") === "password" ? "border-brand ring-2 ring-brand/20" : "border-slate-200"
        }`}
      >
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

      {/* [2026-08-22新設] FN-NTF-01 通知設定。 */}
      <section className="bg-white border border-slate-200 rounded-xl p-5">
        <h2 className="font-semibold text-slate-800 mb-3">通知設定</h2>
        <form onSubmit={saveNotificationSettings} className="space-y-4 max-w-sm">
          <div>
            <label className="flex items-center gap-2 text-sm text-slate-700 mb-2">
              <input
                type="checkbox"
                checked={quietHoursEnabled}
                onChange={(e) => setQuietHoursEnabled(e.target.checked)}
              />
              静穏時間帯を設定する(この時間帯は通知の表示を翌朝まで待ちます)
            </label>
            {quietHoursEnabled && (
              <div className="flex items-center gap-2 text-sm">
                <input
                  type="time"
                  value={quietHoursStart}
                  onChange={(e) => setQuietHoursStart(e.target.value)}
                  className="border border-slate-300 rounded-lg px-2 py-1.5"
                />
                <span className="text-slate-400">〜</span>
                <input
                  type="time"
                  value={quietHoursEnd}
                  onChange={(e) => setQuietHoursEnd(e.target.value)}
                  className="border border-slate-300 rounded-lg px-2 py-1.5"
                />
              </div>
            )}
          </div>
          <div>
            <label className="text-xs text-slate-500 block mb-1">まとめ通知の時間窓(分)</label>
            <input
              type="number"
              min={0}
              max={240}
              value={bundleWindowMinutes}
              onChange={(e) => setBundleWindowMinutes(Number(e.target.value))}
              className="w-28 border border-slate-300 rounded-lg px-3 py-2 text-sm"
            />
            <p className="text-[11px] text-slate-400 mt-1">
              近い時刻に発生した複数の通知をこの間隔単位でまとめて表示します(0で即時表示)
            </p>
          </div>
          <div>
            <label className="text-xs text-slate-500 block mb-2">受け取る通知の種類</label>
            <div className="space-y-1.5">
              <label className="flex items-center gap-2 text-sm text-slate-700">
                <input type="checkbox" checked={deadlineEnabled} onChange={(e) => setDeadlineEnabled(e.target.checked)} />
                期限が近い責任(DEADLINE)
              </label>
              <label className="flex items-center gap-2 text-sm text-slate-700">
                <input type="checkbox" checked={followUpEnabled} onChange={(e) => setFollowUpEnabled(e.target.checked)} />
                追跡日が近いWAITING(FOLLOW_UP)
              </label>
              <label className="flex items-center gap-2 text-sm text-slate-700">
                <input type="checkbox" checked={riskEnabled} onChange={(e) => setRiskEnabled(e.target.checked)} />
                リスクの発生(RISK)
              </label>
            </div>
          </div>
          {notificationError && <p className="text-sm text-red-600">{notificationError}</p>}
          {notificationSaved && <p className="text-sm text-emerald-600">✅ 保存しました</p>}
          <button
            type="submit"
            disabled={notificationSaving}
            className="bg-slate-900 hover:bg-black text-white text-sm rounded-lg px-4 py-2 disabled:opacity-50"
          >
            {notificationSaving ? "保存中..." : "通知設定を保存する"}
          </button>
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

      {/* [2026-08-23新設] FN-PRV-01 データ主権(UI-14)。エクスポート・アカウント削除。 */}
      <section className="bg-white border border-slate-200 rounded-xl p-5">
        <h2 className="font-semibold text-slate-800 mb-3">データのエクスポート</h2>
        <p className="text-xs text-slate-500 mb-3">
          原文・責任・AI推定・PEM・履歴を機械可読(JSON)・人間可読(CSV)の両形式でダウンロードします。
        </p>
        {exportError && <p className="text-sm text-red-600 mb-2">{exportError}</p>}
        <button
          onClick={exportData}
          disabled={exporting}
          className="bg-slate-900 hover:bg-black text-white text-sm rounded-lg px-4 py-2 disabled:opacity-50"
        >
          {exporting ? "エクスポート中..." : "エクスポートをダウンロード"}
        </button>
      </section>

      <section className="bg-white border border-red-200 rounded-xl p-5">
        <h2 className="font-semibold text-red-700 mb-3">アカウントの削除</h2>
        <p className="text-xs text-slate-500 mb-3">
          アカウントと全データを削除します。この操作は取り消せません。削除前にエクスポートをおすすめします。
        </p>
        {!deleteOpen ? (
          <button
            onClick={() => setDeleteOpen(true)}
            className="text-sm text-red-600 border border-red-300 rounded-lg px-4 py-2 hover:bg-red-50"
          >
            アカウントを削除する
          </button>
        ) : (
          <form onSubmit={deleteAccount} className="space-y-3 max-w-sm">
            <div>
              <label className="text-xs text-slate-500 block mb-1">現在のパスワード</label>
              <input
                type="password"
                value={deletePassword}
                onChange={(e) => setDeletePassword(e.target.value)}
                required
                autoComplete="current-password"
                className="w-full border border-slate-300 rounded-lg px-3 py-2 text-sm"
              />
            </div>
            <div>
              <label className="text-xs text-slate-500 block mb-1">
                確認のため「削除」と入力してください
              </label>
              <input
                type="text"
                value={deleteConfirmText}
                onChange={(e) => setDeleteConfirmText(e.target.value)}
                required
                placeholder="削除"
                className="w-full border border-slate-300 rounded-lg px-3 py-2 text-sm"
              />
            </div>
            {deleteError && <p className="text-sm text-red-600">{deleteError}</p>}
            <div className="flex gap-2">
              <button
                type="submit"
                disabled={deleting || deleteConfirmText !== "削除"}
                className="bg-red-600 hover:bg-red-700 text-white text-sm rounded-lg px-4 py-2 disabled:opacity-50"
              >
                {deleting ? "削除中..." : "完全に削除する"}
              </button>
              <button
                type="button"
                onClick={() => {
                  setDeleteOpen(false);
                  setDeletePassword("");
                  setDeleteConfirmText("");
                  setDeleteError("");
                }}
                className="text-sm text-slate-500 px-4 py-2"
              >
                キャンセル
              </button>
            </div>
          </form>
        )}
      </section>
    </div>

  );
}
