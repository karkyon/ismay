"use client";

import { useEffect, useState, type ReactNode } from "react";
import { useRouter, usePathname } from "next/navigation";
import { apiFetch, debugFetch, AUTH_EXPIRED_EVENT } from "@/lib/auth/client";
import { debugLog } from "@/lib/debug";
import { isTypingTarget } from "@/lib/keyboard";
import { TodayIcon, InboxIcon, CalendarIcon, SettingsIcon, MicIcon } from "@/components/icons";

const NAV_ITEMS = [
  { href: "/today", label: "今日", icon: TodayIcon },
  { href: "/inbox", label: "Inbox", icon: InboxIcon },
  { href: "/responsibilities", label: "今後", icon: CalendarIcon },
  { href: "/relations", label: "関係図", icon: CalendarIcon },
  { href: "/tags", label: "タグ", icon: SettingsIcon },
  { href: "/admin/ai-providers", label: "AIプロバイダー", icon: SettingsIcon },
] as const;

/** [2026-08-21追加] ヘッダーバーの左側に出すページ名。NAV_ITEMSと同じhrefで引く。 */
const PAGE_TITLE: Record<string, string> = Object.fromEntries(NAV_ITEMS.map((i) => [i.href, i.label]));

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
          <div className="relative">
            <button
              onClick={(e) => {
                e.stopPropagation();
                setMenuOpen((v) => !v);
              }}
              className="flex items-center gap-2 rounded-lg px-2 py-1.5 hover:bg-canvas transition"
            >
              <span className="w-7 h-7 rounded-full bg-ink text-white text-xs font-semibold flex items-center justify-center shrink-0">
                {(me?.displayName ?? me?.email ?? "?").slice(0, 1).toUpperCase()}
              </span>
              <span className="text-sm text-ink hidden sm:inline">{me?.displayName ?? me?.email ?? ""}</span>
            </button>
            {menuOpen && (
              <div
                onClick={(e) => e.stopPropagation()}
                className="absolute right-0 mt-2 w-56 bg-surface border border-line rounded-xl shadow-pop py-1.5 z-30 text-sm"
              >
                <div className="px-3.5 py-2 border-b border-line">
                  <p className="font-medium text-ink truncate">{me?.displayName ?? "(表示名未設定)"}</p>
                  <p className="text-xs text-faint truncate">{me?.email}</p>
                </div>
                <button
                  onClick={() => {
                    setMenuOpen(false);
                    router.push("/dashboard");
                  }}
                  className="w-full text-left px-3.5 py-2 hover:bg-canvas text-ink"
                >
                  ユーザー情報・パスワード変更
                </button>
                <button onClick={logout} className="w-full text-left px-3.5 py-2 hover:bg-canvas text-red-600">
                  ログアウト
                </button>
              </div>
            )}
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
