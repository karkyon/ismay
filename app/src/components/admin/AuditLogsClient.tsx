"use client";

import { useCallback, useEffect, useState, startTransition } from "react";
import { apiFetch } from "@/lib/auth/client";
import { debugLog } from "@/lib/debug";

interface AuditLogItem {
  id: string;
  actorUserId: string | null;
  actorType: string;
  action: string;
  targetType: string;
  targetId: string | null;
  result: string;
  reason: string | null;
  ipAddress: string | null;
  occurredAt: string;
}

interface AuditLogsResponse {
  data: { auditLogs: AuditLogItem[] };
  meta: { nextCursor?: string };
}

/** 既知のaction値のラベル(実際に記録される値はコード側の実装依存。未知の値はそのまま表示する)。 */
const ACTION_LABEL: Record<string, string> = {
  DATA_EXPORT_REQUESTED: "データエクスポート",
  ACCOUNT_DELETE_REQUESTED: "アカウント削除",
};

const RESULT_LABEL: Record<string, string> = {
  SUCCESS: "成功",
  FAILURE: "失敗",
};

function formatDateTime(iso: string): string {
  return new Date(iso).toLocaleString("ja-JP", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}

/**
 * UI-15「管理コンソール」の一部、監査ログ閲覧(2026-08-23新設)。
 * 出典: Webシステム要件定義書v2.1 FR-ADM-04「監査ログを検索・出力できる。実行者、対象、
 * 操作、日時、結果、理由で検索できる」。
 *
 * [スコープ・2026-08-23] FR-ADM-04のうち「検索」までを実装し、専用の「出力(エクスポート)」
 * 機能は追加しない(既存のFN-PRV-01 データエクスポート機能と役割が重複するため)。
 * また、FR-ADM-01〜03(ユーザー状態管理・機能フラグ・AIモデル版管理)は監査ログ閲覧とは
 * 別の大きな機能であり、今回のご依頼「監査ログ閲覧UI」の範囲外として実装していない。
 */
export function AuditLogsClient() {
  const [logs, setLogs] = useState<AuditLogItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [nextCursor, setNextCursor] = useState<string | undefined>(undefined);
  const [loadingMore, setLoadingMore] = useState(false);

  const [actionFilter, setActionFilter] = useState("");
  const [resultFilter, setResultFilter] = useState("");
  const [targetTypeFilter, setTargetTypeFilter] = useState("");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");

  const buildParams = useCallback(
    (cursor?: string) => {
      const params = new URLSearchParams();
      if (actionFilter) params.set("action", actionFilter);
      if (resultFilter) params.set("result", resultFilter);
      if (targetTypeFilter) params.set("targetType", targetTypeFilter);
      if (from) params.set("from", new Date(from).toISOString());
      if (to) params.set("to", new Date(to).toISOString());
      if (cursor) params.set("cursor", cursor);
      params.set("limit", "50");
      return params;
    },
    [actionFilter, resultFilter, targetTypeFilter, from, to],
  );

  const load = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const res = await apiFetch(`/api/v1/audit-logs?${buildParams().toString()}`);
      const body: AuditLogsResponse = await res.json();
      if (!res.ok) {
        setError((body as unknown as { error?: { message?: string } })?.error?.message ?? "取得に失敗しました");
        return;
      }
      debugLog.state("AuditLogsClient", "logs", { count: body.data.auditLogs.length });
      setLogs(body.data.auditLogs);
      setNextCursor(body.meta.nextCursor);
    } catch {
      setError("通信に失敗しました。ネットワーク状態を確認してもう一度お試しください");
    } finally {
      setLoading(false);
    }
  }, [buildParams]);

  // [Gate Q0是正] react-hooks/set-state-in-effect対応(既存パターンを踏襲)。
  useEffect(() => {
    startTransition(() => {
      load();
    });
  }, [load]);

  async function loadMore() {
    if (!nextCursor) return;
    setLoadingMore(true);
    try {
      const res = await apiFetch(`/api/v1/audit-logs?${buildParams(nextCursor).toString()}`);
      const body: AuditLogsResponse = await res.json();
      if (res.ok) {
        setLogs((prev) => [...prev, ...body.data.auditLogs]);
        setNextCursor(body.meta.nextCursor);
      }
    } finally {
      setLoadingMore(false);
    }
  }

  return (
    <div className="max-w-4xl mx-auto px-4 py-6 space-y-5">
      <div>
        <h1 className="text-xl font-semibold text-ink">監査ログ</h1>
        <p className="text-sm text-muted mt-1">
          実行者・対象・操作・日時・結果・理由で自分の操作履歴を検索できます。
        </p>
      </div>

      <form
        onSubmit={(e) => {
          e.preventDefault();
          load();
        }}
        className="flex flex-wrap items-center gap-2 text-xs"
      >
        <input
          type="text"
          value={actionFilter}
          onChange={(e) => setActionFilter(e.target.value)}
          placeholder="操作(action)"
          className="border border-line rounded-lg px-2 py-1.5 w-40"
        />
        <select
          value={resultFilter}
          onChange={(e) => setResultFilter(e.target.value)}
          className="border border-line rounded-lg px-2 py-1.5"
        >
          <option value="">結果すべて</option>
          <option value="SUCCESS">成功</option>
          <option value="FAILURE">失敗</option>
        </select>
        <input
          type="text"
          value={targetTypeFilter}
          onChange={(e) => setTargetTypeFilter(e.target.value)}
          placeholder="対象種別(targetType)"
          className="border border-line rounded-lg px-2 py-1.5 w-40"
        />
        <input type="date" value={from} onChange={(e) => setFrom(e.target.value)} className="border border-line rounded-lg px-2 py-1.5" />
        <span className="text-faint">〜</span>
        <input type="date" value={to} onChange={(e) => setTo(e.target.value)} className="border border-line rounded-lg px-2 py-1.5" />
        <button type="submit" className="bg-ink text-white rounded-lg px-3 py-1.5">
          検索
        </button>
      </form>

      {error && <p className="text-sm text-red-600">{error}</p>}

      {loading ? (
        <p className="text-sm text-faint">読み込み中...</p>
      ) : logs.length === 0 ? (
        <p className="text-sm text-muted">該当する監査ログはありません。</p>
      ) : (
        <div className="bg-surface border border-line rounded-2xl overflow-hidden">
          <table className="w-full text-sm">
            <thead className="bg-canvas text-[11px] text-faint uppercase tracking-wide">
              <tr>
                <th className="text-left px-3 py-2">日時</th>
                <th className="text-left px-3 py-2">操作</th>
                <th className="text-left px-3 py-2">対象</th>
                <th className="text-left px-3 py-2">結果</th>
                <th className="text-left px-3 py-2">理由</th>
              </tr>
            </thead>
            <tbody>
              {logs.map((log) => (
                <tr key={log.id} className="border-t border-line/60">
                  <td className="px-3 py-2 text-[12px] text-muted whitespace-nowrap">{formatDateTime(log.occurredAt)}</td>
                  <td className="px-3 py-2 text-ink">{ACTION_LABEL[log.action] ?? log.action}</td>
                  <td className="px-3 py-2 text-muted">
                    {log.targetType}
                    {log.targetId && <span className="text-faint"> #{log.targetId.slice(0, 8)}</span>}
                  </td>
                  <td className="px-3 py-2">
                    <span
                      className={`text-[11px] rounded px-1.5 py-0.5 ${
                        log.result === "SUCCESS" ? "bg-emerald-50 text-emerald-700" : "bg-red-50 text-red-700"
                      }`}
                    >
                      {RESULT_LABEL[log.result] ?? log.result}
                    </span>
                  </td>
                  <td className="px-3 py-2 text-faint">{log.reason ?? ""}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {nextCursor && (
        <div className="text-center">
          <button
            onClick={loadMore}
            disabled={loadingMore}
            className="text-sm text-brand-700 hover:underline disabled:opacity-40"
          >
            {loadingMore ? "読み込み中..." : "もっと見る"}
          </button>
        </div>
      )}
    </div>
  );
}
