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

interface PlanningCandidate {
  id: string;
  type: string;
  title: string;
  status: string;
  reasonCodes: string[];
}

interface PlanningSummaryItem {
  id: string;
  title: string;
  status: string;
}

interface PlanningNowResponse {
  primary: PlanningCandidate | null;
  alternatives: PlanningCandidate[];
  decisions: PlanningSummaryItem[];
  waitings: PlanningSummaryItem[];
  risks: PlanningSummaryItem[];
}

/** reasonCodes(lib/planning.ts)の表示ラベル。UIはreasonCodesの値そのものを表示しない。 */
const REASON_LABEL: Record<string, string> = {
  HARD_DEADLINE_OVERDUE: "締切超過",
  HARD_DEADLINE_WITHIN_24H: "締切24時間以内",
  HARD_DEADLINE_WITHIN_72H: "締切72時間以内",
  HARD_DEADLINE_UPCOMING: "締切が近づいています",
  FOLLOW_UP_DUE_NOW: "追跡期限到来",
  FOLLOW_UP_DUE_SOON: "追跡期限が近い",
  TARGET_AT_TODAY: "目標日が本日",
  TARGET_AT_SOON: "目標日が近い",
  HIGH_IMPORTANCE: "重要度が高い",
  NO_STRONG_SIGNAL: "強い要因はありません",
};

function reasonLabels(codes: string[]): string {
  return codes.map((c) => REASON_LABEL[c] ?? c).join("・");
}

/**
 * UI-03 ホーム／今日。
 * API-PLAN-01(GET /planning/now)による「今やる一つ」(FN-WK-02、依存関係・PEM補正なしの
 * 決定論版)を表示する。ブロック解消・最低ライン・切替コスト・場所権限・スヌーズは
 * lib/planning.tsに明記の理由により今回未対応(assumptionsとしてAPIから返る)。
 */
export function TodayClient() {
  const [captures, setCaptures] = useState<CaptureListItem[]>([]);
  const [planning, setPlanning] = useState<PlanningNowResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [planningLoading, setPlanningLoading] = useState(true);

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

  const loadPlanning = useCallback(async () => {
    setPlanningLoading(true);
    const res = await debugFetch("/api/v1/planning/now");
    if (res.ok) {
      const body = await res.json();
      debugLog.state("TodayClient", "planning", { hasPrimary: Boolean(body.data.primary) });
      setPlanning(body.data);
    }
    setPlanningLoading(false);
  }, []);

  const reload = useCallback(() => {
    load();
    loadPlanning();
  }, [load, loadPlanning]);

  useEffect(() => {
    load();
    loadPlanning();
  }, [load, loadPlanning]);

  const unprocessedCount = captures.filter((c) => c.processingStatus === "SAVED").length;
  const relatedCount = planning
    ? planning.decisions.length + planning.waitings.length + planning.risks.length
    : 0;

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

      <QuickCaptureForm onCreated={reload} />

      <div className="bg-surface border border-line rounded-2xl shadow-card overflow-hidden">
        <div className="px-5 pt-4 pb-3 border-b border-line">
          <span className="text-xs font-mono tracking-wide text-faint">今やる一つ</span>
        </div>
        <div className="p-5">
          {planningLoading ? (
            <p className="text-sm text-faint">読み込み中...</p>
          ) : planning?.primary ? (
            <div className="space-y-4">
              <div>
                <p className="font-serif text-xl text-ink">{planning.primary.title}</p>
                <p className="text-xs text-muted mt-1">{reasonLabels(planning.primary.reasonCodes)}</p>
              </div>
              {planning.alternatives.length > 0 && (
                <div>
                  <span className="text-xs font-mono tracking-wide text-faint">代わりに</span>
                  <ul className="mt-1 space-y-1">
                    {planning.alternatives.map((a) => (
                      <li key={a.id} className="text-sm text-muted">
                        {a.title}
                        <span className="text-xs text-faint ml-2">{reasonLabels(a.reasonCodes)}</span>
                      </li>
                    ))}
                  </ul>
                </div>
              )}
            </div>
          ) : (
            <div>
              <p className="text-sm text-muted">
                今実行できる責任(タスク・約束・待ちの追跡)が見つかりませんでした。
                Inboxで整理されていない入力があるか確認してください。
              </p>
              <Link href="/inbox" className="inline-block mt-3 text-sm text-brand-700 font-medium hover:underline">
                Inboxで整理する →
              </Link>
            </div>
          )}
        </div>
      </div>

      {planning && relatedCount > 0 && (
        <div className="bg-surface border border-line rounded-2xl shadow-card p-5 space-y-2">
          <span className="text-xs font-mono tracking-wide text-faint">判断・待ち・危険</span>
          {planning.decisions.length > 0 && (
            <p className="text-sm text-ink">
              判断待ち: <span className="font-semibold">{planning.decisions.length}</span>件
            </p>
          )}
          {planning.waitings.length > 0 && (
            <p className="text-sm text-ink">
              追跡中の待ち: <span className="font-semibold">{planning.waitings.length}</span>件
            </p>
          )}
          {planning.risks.length > 0 && (
            <p className="text-sm text-ink">
              監視中の危険: <span className="font-semibold">{planning.risks.length}</span>件
            </p>
          )}
          <Link href="/responsibilities" className="inline-block text-sm text-brand-700 font-medium hover:underline">
            今後で詳細を見る →
          </Link>
        </div>
      )}

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
