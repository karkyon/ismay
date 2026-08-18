"use client";

import { useEffect, useState, type ReactNode } from "react";
import { useRouter, usePathname } from "next/navigation";

const NAV_ITEMS = [
  { href: "/today", label: "今日" },
  { href: "/inbox", label: "Inbox" },
] as const;

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
    fetch("/api/v1/auth/me").then((res) => {
      if (!active) return;
      if (!res.ok) {
        router.replace("/login");
        return;
      }
      setReady(true);
    });
    return () => {
      active = false;
    };
  }, [router]);

  if (!ready) {
    return (
      <div className="min-h-screen flex items-center justify-center text-sm text-muted">
        読み込み中...
      </div>
    );
  }

  return (
    <div className="flex min-h-screen bg-canvas text-ink">
      <aside className="w-[220px] shrink-0 bg-surface border-r border-line hidden md:flex md:flex-col">
        <div className="h-16 flex items-center gap-2 px-5 border-b border-line">
          <div className="w-7 h-7 rounded-lg bg-brand flex items-center justify-center">
            <span className="text-white font-serif text-sm italic">i</span>
          </div>
          <span className="font-serif italic text-lg text-ink">Ismay</span>
        </div>
        <nav className="flex-1 px-3 py-4 space-y-1 text-sm">
          {NAV_ITEMS.map((item) => {
            const active = pathname === item.href;
            return (
              <button
                key={item.href}
                onClick={() => router.push(item.href)}
                className={`w-full text-left px-3 py-2 rounded-lg transition ${
                  active ? "bg-brand-50 text-brand-700 font-semibold" : "text-ink hover:bg-canvas"
                }`}
              >
                {item.label}
              </button>
            );
          })}
        </nav>
        <div className="px-3 py-4 border-t border-line">
          <button
            onClick={() => router.push("/dashboard")}
            className="w-full text-left px-3 py-2 rounded-lg text-sm text-muted hover:bg-canvas"
          >
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
