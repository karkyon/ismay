"use client";

import { useEffect, useState } from "react";
import { debugFetch } from "@/lib/auth/client";

interface WeeklyReviewResponse {
  weekStart: string;
  weekEnd: string;
  fulfilledCount: number;
  stalledCount: number;
  estimateErrorPercent: number | null;
  strengthStatement: string | null;
  experimentSuggestion: string | null;
  available: boolean;
}

function formatRange(startIso: string, endIso: string): string {
  const start = new Date(startIso);
  const end = new Date(new Date(endIso).getTime() - 1);
  const fmt = (d: Date) => d.toLocaleDateString("ja-JP", { month: "numeric", day: "numeric" });
  return `${fmt(start)} 〜 ${fmt(end)}`;
}

/**
 * UI-10 週次レビュー。API-PEM-03(GET /reviews/weekly)を使う。
 * 初回アクセス時、対象週のレビューが未生成の場合はサーバー側でAI-08を同期呼び出しするため
 * 数秒のローディングが発生しうる(2026-08-23セッションでカルキョンさんへ説明済みの仕様)。
 */
export function WeeklyReviewClient() {
  const [data, setData] = useState<WeeklyReviewResponse | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let active = true;
    (async () => {
      const res = await debugFetch("/api/v1/reviews/weekly");
      if (!active) return;
      if (res.ok) {
        const body = await res.json();
        setData(body.data);
      }
      setLoading(false);
    })();
    return () => {
      active = false;
    };
  }, []);

  return (
    <div>
      <div className="flex items-start justify-between mb-6">
        <div>
          <h1 className="font-serif text-3xl mb-1">今週の振り返り</h1>
          <p className="text-sm text-muted">{data ? formatRange(data.weekStart, data.weekEnd) : ""}</p>
        </div>
      </div>

      {loading ? (
        <p className="text-sm text-faint">
          読み込み中... (初回はAIが生成するため数秒かかる場合があります)
        </p>
      ) : !data?.available ? (
        <div className="bg-surface border border-dashed border-line rounded-2xl p-10 text-center">
          <p className="text-sm font-medium">最初のレビューはもう少し先です</p>
          <p className="text-[12px] text-muted mt-1">
            週次レビューは実績データが1週間分たまってから生成されます。それまでは「今日」画面で日々の進捗をご確認ください。
          </p>
        </div>
      ) : (
        <div>
          <div className="grid grid-cols-3 gap-4 mb-6">
            <div className="bg-surface border border-line rounded-2xl p-4 text-center">
              <p className="font-serif text-3xl">{data.fulfilledCount}</p>
              <p className="text-xs text-muted mt-1">果たした約束・完了</p>
            </div>
            <div className="bg-surface border border-line rounded-2xl p-4 text-center">
              <p className="font-serif text-3xl text-warn">{data.stalledCount}</p>
              <p className="text-xs text-muted mt-1">延期・停滞した項目</p>
            </div>
            <div className="bg-surface border border-line rounded-2xl p-4 text-center">
              <p className="font-serif text-3xl">
                {data.estimateErrorPercent === null ? "―" : `${data.estimateErrorPercent > 0 ? "+" : ""}${data.estimateErrorPercent}%`}
              </p>
              <p className="text-xs text-muted mt-1">所要時間の予測誤差</p>
            </div>
          </div>

          {data.strengthStatement && (
            <div className="bg-surface border border-line rounded-2xl p-5 mb-4">
              <p className="text-xs font-mono text-faint mb-2">発見した強み</p>
              <p className="text-sm">{data.strengthStatement}</p>
            </div>
          )}

          {data.experimentSuggestion && (
            <div className="bg-decide-50 border border-decide/20 rounded-2xl p-5">
              <p className="text-xs font-mono text-decide mb-2">改善実験の提案</p>
              <p className="text-sm">{data.experimentSuggestion}</p>
            </div>
          )}

          {!data.strengthStatement && !data.experimentSuggestion && (
            <p className="text-sm text-muted">
              今週は完了・延期の記録が少なく、気づきを示すには材料が不足しています。
            </p>
          )}
        </div>
      )}
    </div>
  );
}
