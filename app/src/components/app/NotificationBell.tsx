"use client";

import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { apiFetch, debugFetch } from "@/lib/auth/client";
import { debugLog } from "@/lib/debug";
import { BellIcon } from "@/components/icons";

interface NotificationItem {
  id: string;
  type: "DEADLINE" | "FOLLOW_UP" | "RISK" | "DIGEST" | string;
  payload: {
    responsibilityId?: string;
    title?: string;
    hardDeadlineAt?: string;
    followUpAt?: string;
    waitingOn?: string | null;
    occurredAt?: string;
    importance?: string | null;
    siblingCountToday?: string;
    // DIGEST(2026-08-22追加): 複数通知を1件に集約した際のペイロード。
    count?: string;
    itemsJson?: string;
  };
  status: "SENT" | "READ" | string;
  scheduledAt: string;
  sentAt: string | null;
  readAt: string | null;
}

interface DigestItem {
  type: string;
  title: string;
  responsibilityId: string;
}

const POLL_INTERVAL_MS = 30_000;
const HIGH_IMPORTANCE_THRESHOLD = 4;

const TYPE_LABEL: Record<string, string> = {
  DEADLINE: "期限",
  FOLLOW_UP: "追跡",
  RISK: "リスク",
  DIGEST: "まとめ",
};

function parseDigestItems(itemsJson: string | undefined): DigestItem[] {
  if (!itemsJson) return [];
  try {
    const parsed = JSON.parse(itemsJson);
    return Array.isArray(parsed) ? (parsed as DigestItem[]) : [];
  } catch {
    return [];
  }
}

function formatRelative(iso: string): string {
  const diffMs = Date.now() - new Date(iso).getTime();
  const diffMin = Math.round(diffMs / 60000);
  if (diffMin < 1) return "たった今";
  if (diffMin < 60) return `${diffMin}分前`;
  const diffHour = Math.round(diffMin / 60);
  if (diffHour < 24) return `${diffHour}時間前`;
  const diffDay = Math.round(diffHour / 24);
  return `${diffDay}日前`;
}

/**
 * FN-NTF-01 通知センター(2026-08-22新設)。
 *
 * [教訓2.3対応] 過去のセッションで「機能は実装したが発見不可能なUI」が2回発生した
 * (opacity-0 group-hover等)反省を踏まえ、このベルはホバー専用にせず常時表示する。
 * 未読(status=SENT)が1件でもあればバッジで件数を出す。
 */
export function NotificationBell() {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [items, setItems] = useState<NotificationItem[]>([]);
  const [unreadCount, setUnreadCount] = useState(0);
  const [loaded, setLoaded] = useState(false);

  const load = useCallback(async () => {
    const res = await debugFetch("/api/v1/notifications");
    if (!res.ok) return;
    const body = await res.json();
    setItems(body.data.notifications);
    setUnreadCount(body.data.unreadCount);
    setLoaded(true);
  }, []);

  useEffect(() => {
    load();
    const interval = setInterval(load, POLL_INTERVAL_MS);
    return () => clearInterval(interval);
  }, [load]);

  useEffect(() => {
    if (!open) return;
    function onDocClick() {
      setOpen(false);
    }
    document.addEventListener("click", onDocClick);
    return () => document.removeEventListener("click", onDocClick);
  }, [open]);

  async function markRead(id: string) {
    setItems((prev) => prev.map((n) => (n.id === id ? { ...n, status: "READ" } : n)));
    setUnreadCount((prev) => Math.max(0, prev - 1));
    await apiFetch(`/api/v1/notifications/${id}/read`, { method: "POST" });
  }

  async function markAllRead() {
    debugLog.event("NotificationBell", "mark all read clicked");
    setItems((prev) => prev.map((n) => ({ ...n, status: "READ" })));
    setUnreadCount(0);
    await apiFetch("/api/v1/notifications/read-all", { method: "POST" });
  }

  function onItemClick(item: NotificationItem) {
    if (item.status !== "READ") void markRead(item.id);
    // DIGESTは複数の責任を束ねているため単一の遷移先が無い。「今後」一覧を開くに留める。
    if (item.type === "DIGEST") {
      setOpen(false);
      router.push("/responsibilities");
      return;
    }
    setOpen(false);
    if (item.payload.responsibilityId) {
      router.push(`/responsibilities?focus=${item.payload.responsibilityId}`);
    }
  }

  return (
    <div className="relative">
      <button
        onClick={(e) => {
          e.stopPropagation();
          setOpen((v) => !v);
        }}
        aria-label="通知"
        className={`relative w-9 h-9 rounded-full flex items-center justify-center transition ${
          open ? "bg-canvas ring-1 ring-line" : "hover:bg-canvas"
        }`}
      >
        <BellIcon width={17} height={17} className="text-ink" />
        {unreadCount > 0 && (
          <span className="absolute top-0.5 right-0.5 min-w-[15px] h-[15px] px-1 rounded-full bg-red-500 text-white text-[10px] leading-[15px] text-center font-semibold">
            {unreadCount > 9 ? "9+" : unreadCount}
          </span>
        )}
      </button>
      {open && (
        <div
          onClick={(e) => e.stopPropagation()}
          className="absolute right-0 mt-2.5 w-80 bg-surface/95 backdrop-blur-sm border border-line/70 rounded-2xl shadow-pop py-2 z-30 text-sm overflow-hidden"
        >
          <div className="px-4 py-2.5 flex items-center justify-between bg-canvas/60">
            <span className="font-medium text-ink">通知</span>
            {unreadCount > 0 && (
              <button onClick={markAllRead} className="text-xs text-brand-700 hover:underline">
                すべて既読にする
              </button>
            )}
          </div>
          <div className="max-h-96 overflow-y-auto">
            {!loaded && <p className="px-4 py-6 text-center text-xs text-faint">読み込み中...</p>}
            {loaded && items.length === 0 && (
              <p className="px-4 py-6 text-center text-xs text-faint">通知はありません</p>
            )}
            {items.map((item) => {
              const importance = item.payload.importance ? Number(item.payload.importance) : null;
              const isHighImportance = importance !== null && importance >= HIGH_IMPORTANCE_THRESHOLD;
              const digestItems = item.type === "DIGEST" ? parseDigestItems(item.payload.itemsJson) : [];
              return (
                <button
                  key={item.id}
                  onClick={() => onItemClick(item)}
                  className={`w-full text-left px-4 py-2.5 hover:bg-canvas transition border-b border-line/60 last:border-b-0 ${
                    item.status !== "READ" ? "bg-brand-50/40" : ""
                  }`}
                >
                  <div className="flex items-center gap-2">
                    <span
                      className={`text-[10px] font-semibold rounded px-1.5 py-0.5 border ${
                        isHighImportance
                          ? "text-red-700 border-red-200 bg-red-50"
                          : "text-brand-700 border-brand-200"
                      }`}
                    >
                      {isHighImportance ? "★ " : ""}
                      {TYPE_LABEL[item.type] ?? item.type}
                    </span>
                    {item.status !== "READ" && <span className="w-1.5 h-1.5 rounded-full bg-red-500" />}
                    <span className="ml-auto text-[11px] text-faint">
                      {formatRelative(item.sentAt ?? item.scheduledAt)}
                    </span>
                  </div>
                  {item.type === "DIGEST" ? (
                    <div className="mt-1">
                      <p className="text-ink">{digestItems.length}件の通知をまとめました</p>
                      <ul className="mt-1 space-y-0.5">
                        {digestItems.slice(0, 4).map((d, idx) => (
                          <li key={`${item.id}-${idx}`} className="text-[11px] text-muted truncate">
                            ・{TYPE_LABEL[d.type] ?? d.type}: {d.title}
                          </li>
                        ))}
                        {digestItems.length > 4 && (
                          <li className="text-[11px] text-faint">他{digestItems.length - 4}件</li>
                        )}
                      </ul>
                    </div>
                  ) : (
                    <>
                      <p className="text-ink mt-1 truncate">{item.payload.title ?? "(タイトル不明)"}</p>
                      {item.payload.siblingCountToday && Number(item.payload.siblingCountToday) > 0 && (
                        <p className="text-[11px] text-faint mt-0.5">
                          本日は他に{item.payload.siblingCountToday}件の期限があります
                        </p>
                      )}
                    </>
                  )}
                </button>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}
