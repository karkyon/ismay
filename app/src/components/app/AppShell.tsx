"use client";

import { useEffect, useState, type ReactNode } from "react";
import { useRouter, usePathname } from "next/navigation";
import { apiFetch, debugFetch, AUTH_EXPIRED_EVENT } from "@/lib/auth/client";
import { debugLog } from "@/lib/debug";
import { isTypingTarget } from "@/lib/keyboard";
import { TodayIcon, InboxIcon, CalendarIcon, SettingsIcon, MicIcon, SearchIcon, PemIcon, ReviewIcon, ContextIcon } from "@/components/icons";
import { NotificationBell } from "@/components/app/NotificationBell";

const NAV_ITEMS = [
  { href: "/today", label: "今日", icon: TodayIcon },
  { href: "/inbox", label: "Inbox", icon: InboxIcon },
  { href: "/responsibilities", label: "今後", icon: CalendarIcon },
  { href: "/relations", label: "関係図", icon: CalendarIcon },
  // [2026-08-27追加・V5-M1-A UI] Gate M1-A(Project Context DB/API/UI)のUI部分。
  // 統合正本v5.0 8章。DB(M1-A1)・API(M1-A2)に続く常設ナビ導線。
  { href: "/project-contexts", label: "案件", icon: ContextIcon },
  { href: "/search", label: "検索", icon: SearchIcon },
  // [2026-08-23追加] ワイヤーフレーム(ISMAY_画面UX設計書v2.1)のサイドナビ「理解」区分に
  // 相当。UI-02(初回対話)とは異なり、UI-09/UI-10は常設ナビから直接開ける画面。
  { href: "/pem", label: "PEM", icon: PemIcon },
  { href: "/pem/review", label: "週次レビュー", icon: ReviewIcon },
  { href: "/tags", label: "タグ", icon: SettingsIcon },
  { href: "/admin/ai-providers", label: "AIプロバイダー", icon: SettingsIcon },
  { href: "/admin/audit-logs", label: "監査ログ", icon: SettingsIcon },
] as const;

/** [2026-08-21追加] ヘッダーバーの左側に出すページ名。NAV_ITEMSと同じhrefで引く。 */
const PAGE_TITLE: Record<string, string> = {
  ...Object.fromEntries(NAV_ITEMS.map((i) => [i.href, i.label])),
  // [2026-08-23追加] FN-PEM-01初回対話。常設サイドナビには入れず(UI-03の未完了バナー
  // からのみ遷移する設計)、ヘッダータイトルのみ対応させる。
  "/pem/onboarding": "初回対話",
};

/** クイック入力欄へフォーカスを移すためのグローバルイベント名。
 * "C"キーはLinear同様、アプリ内どこからでも効くグローバルショートカットとし、
 * AppShell(どこにでもある)とQuickCaptureForm(/today・/inboxにある)を
 * DOM CustomEventで疎結合に繋ぐ。 */
export const FOCUS_CAPTURE_EVENT = "ismay:focus-capture";

/**
 * 認証必須画面の共通シェル。/api/v1/auth/me で認証確認し、
 * 未認証なら/loginへリダイレクトする(DashboardClientと同じガード方針)。
 */
export function AppShell({ children }: { children: ReactNode }) {
  const router = useRouter();
  const pathname = usePathname();
  const [ready, setReady] = useState(false);
  // [2026-08-21追加] カルキョンさんの指示「ヘッダバーを入れてくれ、右端にログインユーザ名、
  // 一般的な機能(ユーザ情報、パス変更、ログアウト)メニュー実装」に対応。
  const [me, setMe] = useState<{ email: string; displayName: string | null } | null>(null);
  const [menuOpen, setMenuOpen] = useState(false);

  useEffect(() => {
    let active = true;
    debugFetch("/api/v1/auth/me").then((res) => {
      if (!active) return;
      if (!res.ok) {
        debugLog.event("AppShell", "auth check failed, redirecting to /login", { status: res.status });
        router.replace("/login");
        return;
      }
      debugLog.event("AppShell", "auth check ok");
      setReady(true);
      res.json().then((body) => {
        if (active) setMe(body.data.user);
      });
    });
    return () => {
      active = false;
    };
  }, [router]);

  async function logout() {
    debugLog.event("AppShell", "logout clicked");
    await apiFetch("/api/v1/auth/logout", { method: "POST" });
    router.replace("/login");
  }

  // 画面滞在中にAccess Tokenが失効し、かつRefresh Tokenでの自動延長(client.ts側)も
  // 失敗した場合、apiFetch/debugFetchがAUTH_EXPIRED_EVENTを発火する。
  // ここはページのどこに居ても捕捉できるよう、常にマウントされているAppShellで購読する。
  useEffect(() => {
    function onAuthExpired() {
      debugLog.event("AppShell", "auth expired event received, redirecting to /login");
      router.replace("/login");
    }
    window.addEventListener(AUTH_EXPIRED_EVENT, onAuthExpired);
    return () => window.removeEventListener(AUTH_EXPIRED_EVENT, onAuthExpired);
  }, [router]);

  // Linearの"C"仕様(公式チートシート記載: 「アプリ内どこからでも効く」)を踏襲。
  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if (e.key.toLowerCase() !== "c") return;
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      if (isTypingTarget(e.target)) return;
      debugLog.event("AppShell", "shortcut C pressed");
      window.dispatchEvent(new CustomEvent(FOCUS_CAPTURE_EVENT));
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  // [2026-08-21追加] ユーザーメニューの外側クリックで閉じる(一般的なドロップダウンの挙動)。
  useEffect(() => {
    if (!menuOpen) return;
    function onDocClick() {
      setMenuOpen(false);
    }
    document.addEventListener("click", onDocClick);
    return () => document.removeEventListener("click", onDocClick);
  }, [menuOpen]);

  if (!ready) {
    return (
      <div className="min-h-screen flex items-center justify-center text-sm text-muted">
        読み込み中...
      </div>
    );
  }

  return (
    // [2026-08-21修正] min-h-screen(下限のみ)だとページ全体がコンテンツ長に応じて伸び、
    // ブラウザのウィンドウスクロールがaside(サイドバー)ごと動かしてしまい
    // 「サイドバーが固定されない」不備の原因になっていた。h-screen(ビューポート高さに固定)
    // にしたうえで、main側だけがoverflow-y-autoで内部スクロールするようにする。
    //
    // [2026-08-22修正] カルキョンさんの指摘「ヘッダ左端がずれてる、下端の線の高さを合わせろ、
    // 左端から1本のバーで表示しろ」に対応。従来はサイドバー側のロゴ枠(h-16=64px)と
    // ヘッダー側(h-14=56px)の高さが一致しておらず、境界線が左右でズレていた。
    // ロゴをヘッダー側へ統合し、画面最上部に「左端から右端まで高さの揃った1本のバー」を
    // 敷いたうえで、その下にサイドバー+メインを配置する構成に変更した。
    <div className="flex flex-col h-screen bg-canvas text-ink overflow-hidden">
      <header className="h-14 shrink-0 border-b border-line bg-surface flex items-stretch">
        <div className="w-[240px] shrink-0 hidden md:flex items-center gap-2 px-5 border-r border-line">
          <div className="w-7 h-7 rounded-lg bg-brand flex items-center justify-center">
            <span className="text-white font-serif text-sm italic">i</span>
          </div>
          <span className="font-serif italic text-lg text-ink">Ismay</span>
        </div>
        <div className="flex-1 min-w-0 flex items-center justify-between px-5 md:px-8">
          <p className="text-sm font-semibold text-ink">{PAGE_TITLE[pathname] ?? ""}</p>
          <div className="flex items-center gap-1.5">
          {/* [2026-08-22追加] FN-NTF-01通知ベル。教訓2.3(発見できないUI)を踏まえ、
              ホバー専用にせず常時表示する。ユーザーメニューの左隣に固定配置。 */}
          <NotificationBell />
          <div className="relative">
            <button
              onClick={(e) => {
                e.stopPropagation();
                setMenuOpen((v) => !v);
              }}
              className={`flex items-center gap-2 rounded-full pl-1 pr-3 py-1 transition ${
                menuOpen ? "bg-canvas ring-1 ring-line" : "hover:bg-canvas"
              }`}
            >
              <span className="w-7 h-7 rounded-full bg-gradient-to-br from-ink to-ink/70 text-white text-xs font-semibold flex items-center justify-center shrink-0">
                {(me?.displayName ?? me?.email ?? "?").slice(0, 1).toUpperCase()}
              </span>
              <span className="text-sm text-ink hidden sm:inline">{me?.displayName ?? me?.email ?? ""}</span>
            </button>
            {menuOpen && (
              <div
                onClick={(e) => e.stopPropagation()}
                className="absolute right-0 mt-2.5 w-64 bg-surface/95 backdrop-blur-sm border border-line/70 rounded-2xl shadow-pop py-2 z-30 text-sm overflow-hidden"
              >
                <div className="px-4 py-3 flex items-center gap-3 bg-canvas/60">
                  <span className="w-9 h-9 rounded-full bg-ink text-white text-sm font-semibold flex items-center justify-center shrink-0">
                    {(me?.displayName ?? me?.email ?? "?").slice(0, 1).toUpperCase()}
                  </span>
                  <div className="min-w-0">
                    <p className="font-medium text-ink truncate">{me?.displayName ?? "(表示名未設定)"}</p>
                    <p className="text-[11px] text-faint truncate">{me?.email}</p>
                  </div>
                </div>
                <div className="py-1.5">
                  {/* [2026-08-22修正] カルキョンさんの指示「ユーザー情報とパスワードは
                      別々のメニューにしろ」に対応。従来1項目にまとめていたものを分割した。 */}
                  <button
                    onClick={() => {
                      setMenuOpen(false);
                      router.push("/dashboard");
                    }}
                    className="w-full text-left px-4 py-2.5 hover:bg-canvas text-ink transition flex items-center gap-2.5"
                  >
                    <span className="w-4 text-faint">👤</span>
                    ユーザー情報
                  </button>
                  <button
                    onClick={() => {
                      setMenuOpen(false);
                      router.push("/dashboard?tab=password");
                    }}
                    className="w-full text-left px-4 py-2.5 hover:bg-canvas text-ink transition flex items-center gap-2.5"
                  >
                    <span className="w-4 text-faint">🔒</span>
                    パスワード変更
                  </button>
                </div>
                <div className="border-t border-line py-1.5">
                  <button
                    onClick={logout}
                    className="w-full text-left px-4 py-2.5 hover:bg-red-50 text-red-600 transition flex items-center gap-2.5"
                  >
                    <span className="w-4">↪</span>
                    ログアウト
                  </button>
                </div>
              </div>
            )}
          </div>
          </div>
        </div>
      </header>

      <div className="flex flex-1 min-h-0">
        <aside className="w-[240px] shrink-0 bg-surface border-r border-line hidden md:flex md:flex-col">
          <button
            onClick={() => {
              debugLog.event("AppShell", "quick capture button clicked");
              if (pathname === "/today" || pathname === "/inbox") {
                window.dispatchEvent(new CustomEvent(FOCUS_CAPTURE_EVENT));
              } else {
                router.push("/inbox");
              }
            }}
            className="mx-4 mt-4 mb-2 px-3 py-2.5 rounded-xl bg-ink text-white text-sm font-medium flex items-center gap-2 hover:bg-black transition"
          >
            <MicIcon width={15} height={15} />
            話す・メモする
            <span className="ml-auto text-[10px] font-mono border border-white/25 text-white/60 rounded px-1.5 py-0.5">
              C
            </span>
          </button>

          <nav className="flex-1 px-3 py-2 space-y-0.5 text-sm overflow-y-auto">
            {NAV_ITEMS.map((item) => {
              const active = pathname === item.href;
              const Icon = item.icon;
              return (
                <button
                  key={item.href}
                  onClick={() => router.push(item.href)}
                  className={`w-full text-left px-3 py-2 rounded-lg transition flex items-center gap-2.5 ${
                    active ? "bg-brand-50 text-brand-700 font-semibold" : "text-ink hover:bg-canvas"
                  }`}
                >
                  <Icon width={16} height={16} className={active ? "text-brand-700" : "text-faint"} />
                  {item.label}
                </button>
              );
            })}
          </nav>

          <div className="px-3 py-4 border-t border-line">
            <button
              onClick={() => router.push("/dashboard")}
              className="w-full text-left px-3 py-2 rounded-lg text-sm text-muted hover:bg-canvas flex items-center gap-2.5"
            >
              <SettingsIcon width={16} height={16} className="text-faint" />
              アカウント設定
            </button>
          </div>
        </aside>

        <main className="flex-1 min-w-0 overflow-y-auto">
          <div className="max-w-5xl mx-auto px-5 py-8 md:px-8">{children}</div>
        </main>
      </div>
    </div>
  );
}
