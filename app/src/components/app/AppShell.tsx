"use client";

import { useEffect, useState, type ReactNode } from "react";
import { useRouter, usePathname } from "next/navigation";
import { debugFetch, AUTH_EXPIRED_EVENT } from "@/lib/auth/client";
import { debugLog } from "@/lib/debug";
import { isTypingTarget } from "@/lib/keyboard";
import { TodayIcon, InboxIcon, CalendarIcon, SettingsIcon, MicIcon } from "@/components/icons";

const NAV_ITEMS = [
  { href: "/today", label: "今日", icon: TodayIcon },
  { href: "/inbox", label: "Inbox", icon: InboxIcon },
  { href: "/responsibilities", label: "今後", icon: CalendarIcon },
  { href: "/relations", label: "関係図", icon: CalendarIcon },
  { href: "/admin/ai-providers", label: "AIプロバイダー", icon: SettingsIcon },
] as const;

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
    });
    return () => {
      active = false;
    };
  }, [router]);

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

  if (!ready) {
    return (
      <div className="min-h-screen flex items-center justify-center text-sm text-muted">
        読み込み中...
      </div>
    );
  }

  return (
    <div className="flex min-h-screen bg-canvas text-ink">
      <aside className="w-[240px] shrink-0 bg-surface border-r border-line hidden md:flex md:flex-col">
        <div className="h-16 flex items-center gap-2 px-5 border-b border-line">
          <div className="w-7 h-7 rounded-lg bg-brand flex items-center justify-center">
            <span className="text-white font-serif text-sm italic">i</span>
          </div>
          <span className="font-serif italic text-lg text-ink">Ismay</span>
        </div>

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

        <nav className="flex-1 px-3 py-2 space-y-0.5 text-sm">
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
  );
}
