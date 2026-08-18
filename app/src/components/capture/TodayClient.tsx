"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { debugFetch } from "@/lib/auth/client";
import { debugLog } from "@/lib/debug";
import { QuickCaptureForm } from "@/components/capture/QuickCaptureForm";

interface CaptureListItem {
  id: string;
  processingStatus: string;
}

/**
 * UI-03 ホーム／今日。
 * [既知の制約] 「今やる一つ」の算出にはResponsibility API・Planning API
 * (/planning/now)が必要だが未実装のため、設計書5章の空状態指針に従い
 * 正直な空状態＋Inboxへの導線を表示するに留める。
 */
export function TodayClient() {
  const [captures, setCaptures] = useState<CaptureListItem[]>([]);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    const res = await debugFetch("/api/v1/captures?limit=100");
    if (res.ok) {
      const body = await res.json();
      debugLog.state("TodayClient", "captures", { count: body.data.captures.length });
      setCaptures(body.data.captures);
    }
    setLoading(false);
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const unprocessedCount = captures.filter((c) => c.processingStatus === "SAVED").length;

  return (
    <div className="space-y-6">
      <div>
        <p className="text-xs text-faint font-mono mb-1">
          {new Date().toLocaleDateString("ja-JP", {
            year: "numeric",
            month: "long",
            day: "numeric",
            weekday: "short",
          })}
        </p>
        <h1 className="font-serif text-3xl">今日</h1>
      </div>

      <QuickCaptureForm onCreated={load} />

      <div className="bg-surface border border-line rounded-2xl shadow-card overflow-hidden">
        <div className="px-5 pt-4 pb-3 border-b border-line">
          <span className="text-xs font-mono tracking-wide text-faint">今やる一つ</span>
        </div>
        <div className="p-5">
          <p className="text-sm text-muted">
            「今やる一つ」を計算するには、責任(タスク・約束・判断)としての登録がまだ必要です。
            現在はメモの保存とInboxでの確認までが実装済みです。
          </p>
          <Link href="/inbox" className="inline-block mt-3 text-sm text-brand-700 font-medium hover:underline">
            Inboxで整理する →
          </Link>
        </div>
      </div>

      <div className="bg-surface border border-line rounded-2xl shadow-card p-5">
        <span className="text-xs font-mono tracking-wide text-faint">Inbox状況</span>
        {loading ? (
          <p className="text-sm text-faint mt-2">読み込み中...</p>
        ) : (
          <p className="text-sm text-ink mt-2">
            未整理の入力が <span className="font-semibold">{unprocessedCount}</span> 件、合計{" "}
            <span className="font-semibold">{captures.length}</span> 件を保存済みです。
          </p>
        )}
      </div>
    </div>
  );
}
