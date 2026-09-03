"use client";

import { useCallback, useEffect, useState, startTransition } from "react";
import { apiFetch, debugFetch } from "@/lib/auth/client";
import { debugLog } from "@/lib/debug";
import { microsToUsd, formatUsd } from "@/lib/ai/pricing";

interface AvailableModel {
  modelName: string;
  label: string;
  /** [2026-08-22追加] モデル切替時に表示する特徴・費用目安。 */
  description: string;
}

/**
 * [2026-08-22新設] カルキョンさんの指示「anthropicやopenaiなどそれぞれのマークを
 * リストに追加して、マーク＋事業者名のリストにしろ」に対応。
 * 実際の商標ロゴ画像は著作権上使用せず、事業者ごとに色分けした頭文字バッジで代替する。
 */
const PROVIDER_META: Record<string, { label: string; color: string; initial: string }> = {
  anthropic: { label: "Anthropic", color: "#D97757", initial: "A" },
  openai: { label: "OpenAI", color: "#10A37F", initial: "O" },
};

function providerMeta(providerKey: string) {
  return PROVIDER_META[providerKey] ?? { label: providerKey, color: "#6b7280", initial: providerKey.slice(0, 1).toUpperCase() };
}

function ProviderBadge({ providerKey, size = 18 }: { providerKey: string; size?: number }) {
  const meta = providerMeta(providerKey);
  return (
    <span
      className="rounded-full flex items-center justify-center text-white font-bold shrink-0"
      style={{ background: meta.color, width: size, height: size, fontSize: size * 0.5 }}
    >
      {meta.initial}
    </span>
  );
}

/**
 * [2026-08-22新設] ネイティブ<select>はoption内にアイコンを描画できないため、
 * 「マーク＋事業者名のリスト」を実現するための簡易カスタムドロップダウン。
 */
function ProviderDropdown({
  value,
  options,
  disabled,
  onChange,
}: {
  value: string;
  options: string[];
  disabled?: boolean;
  onChange: (key: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const meta = providerMeta(value);
  return (
    <div className="relative">
      <button
        type="button"
        disabled={disabled}
        onClick={(e) => {
          e.stopPropagation();
          setOpen((v) => !v);
        }}
        className="flex items-center gap-2 border border-line rounded-lg px-3 py-2 text-sm bg-canvas disabled:opacity-50 hover:border-brand/50 transition min-w-[150px]"
      >
        <ProviderBadge providerKey={value} />
        <span className="flex-1 text-left">{meta.label}</span>
        <span className="text-faint text-xs">▾</span>
      </button>
      {open && (
        <>
          <div className="fixed inset-0 z-10" onClick={() => setOpen(false)} />
          <div className="absolute left-0 mt-1 w-full min-w-[180px] bg-surface border border-line rounded-xl shadow-pop py-1 z-20">
            {options.map((key) => (
              <button
                key={key}
                type="button"
                onClick={() => {
                  onChange(key);
                  setOpen(false);
                }}
                className={`w-full flex items-center gap-2 px-3 py-2 text-sm hover:bg-canvas transition ${
                  key === value ? "bg-brand-50" : ""
                }`}
              >
                <ProviderBadge providerKey={key} />
                <span>{providerMeta(key).label}</span>
              </button>
            ))}
          </div>
        </>
      )}
    </div>
  );
}

interface CapabilityConfig {
  capability: string;
  activeProviderKey: string;
  modelName: string | null;
  isDefault: boolean;
  availableProviderKeys: string[];
  availableModelsByProvider: Record<string, AvailableModel[]>;
  updatedAt: string | null;
}

interface CredentialStatus {
  providerKey: string;
  registered: boolean;
  last4: string | null;
  updatedAt: string | null;
}

interface UsageRow {
  provider: string;
  model: string;
  runCount: number;
  inputTokens: number;
  outputTokens: number;
  costMicros: string | null;
}

interface StatusBreakdownItem {
  status: string;
  count: number;
}

interface DecisionBreakdownItem {
  decision: string;
  count: number;
}

interface RecentRun {
  id: string;
  provider: string;
  model: string;
  status: string;
  inputTokens: number | null;
  outputTokens: number | null;
  costMicros: string | null;
  latencyMs: number | null;
  errorCode: string | null;
  startedAt: string;
}

interface DailyTrendItem {
  date: string;
  costMicros: string;
  runCount: number;
  failedCount: number;
}

interface UsageResponse {
  byModelAllTime: UsageRow[];
  byModelLast30Days: UsageRow[];
  totalCostMicrosAllTime: string;
  totalCostMicrosLast30Days: string;
  unknownCostRunCount: number;
  statusBreakdown: StatusBreakdownItem[];
  successRate: number | null;
  avgLatencyMs: number | null;
  p95LatencyMs: number | null;
  recentRuns: RecentRun[];
  dailyTrend: DailyTrendItem[];
  decisionBreakdown: DecisionBreakdownItem[];
  acceptanceRate: number | null;
}

const STATUS_LABEL: Record<string, string> = {
  SUCCEEDED: "成功",
  FAILED: "失敗",
  PENDING: "処理中",
};

const RUN_STATUS_DOT: Record<string, string> = {
  SUCCEEDED: "bg-green-500",
  FAILED: "bg-red-500",
  PENDING: "bg-amber-400",
};

function formatPercent(ratio: number | null): string {
  if (ratio === null) return "—";
  return `${Math.round(ratio * 1000) / 10}%`;
}

function formatRelativeDate(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleDateString("ja-JP", { month: "short", day: "numeric", weekday: "short" });
}

const CAPABILITY_LABEL: Record<string, string> = {
  EXTRACTION: "責任候補抽出(FN-AI-01)",
  EMBEDDING: "意味照合・類似度計算(FN-GR-01)",
  TRANSCRIPTION: "音声文字起こし(API-CAP-02)",
  OCR: "画像文字起こし(FR-CAP-02)",
  SEGMENTATION: "音声テーマ自動分割",
};

/**
 * /admin/ai-providers: FR-AI-07「AIモデルを交換可能にする」に基づくAIプロバイダー・
 * モデル切替、APIキー登録、運用コスト可視化の統合画面(2026-08-20新設・同日追補)。
 *
 * [既知の制約] 現状Userに管理者ロールの概念が無いため、Workspaceに所属する認証済み
 * ユーザーであれば誰でも変更できる(他の全画面と同じ認可レベル)。
 */
export function AiProvidersAdminClient() {
  const [capabilities, setCapabilities] = useState<CapabilityConfig[]>([]);
  const [credentials, setCredentials] = useState<CredentialStatus[]>([]);
  const [usage, setUsage] = useState<UsageResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [savingCapability, setSavingCapability] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [savedFlash, setSavedFlash] = useState<string | null>(null);
  const [keyInputs, setKeyInputs] = useState<Record<string, string>>({});
  const [savingKeyFor, setSavingKeyFor] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError("");
    const [providersRes, usageRes] = await Promise.all([
      debugFetch("/api/v1/admin/ai-providers"),
      debugFetch("/api/v1/admin/ai-usage"),
    ]);
    if (providersRes.ok) {
      const body = await providersRes.json();
      debugLog.state("AiProvidersAdminClient", "capabilities", body.data.capabilities);
      setCapabilities(body.data.capabilities);
      setCredentials(body.data.credentials);
    } else {
      // [Gate SECURITY-RBAC-01是正] 管理API側でOWNER/ADMIN以外を拒否するようになった
      // ため、拒否時に画面が無言で空表示になるのを避け、理由をそのまま表示する。
      const body = await providersRes.json().catch(() => null);
      setError(body?.error?.message ?? "設定の取得に失敗しました");
    }
    if (usageRes.ok) {
      const body = await usageRes.json();
      debugLog.state("AiProvidersAdminClient", "usage", body.data);
      setUsage(body.data);
    }
    setLoading(false);
  }, []);

  // [Gate Q0是正] react-hooks/set-state-in-effect対応。InboxClient.tsx(B4.2b)と同じ
  // 標準的な回避策(startTransitionで包む)。挙動・タイミングは変えない。
  useEffect(() => {
    startTransition(() => {
      load();
    });
  }, [load]);

  async function handleSwitch(capability: string, providerKey: string, modelName?: string) {
    setSavingCapability(capability);
    setError("");
    debugLog.input("AiProvidersAdminClient", "providerSwitch", { capability, providerKey, modelName });
    const res = await apiFetch("/api/v1/admin/ai-providers", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ capability, providerKey, modelName }),
    });
    if (res.ok) {
      setSavedFlash(capability);
      setTimeout(() => setSavedFlash(null), 2000);
      await load();
    } else {
      const body = await res.json().catch(() => null);
      setError(body?.error?.message ?? "切り替えに失敗しました");
    }
    setSavingCapability(null);
  }

  async function handleSaveKey(providerKey: string) {
    const apiKey = keyInputs[providerKey]?.trim();
    if (!apiKey) return;
    setSavingKeyFor(providerKey);
    setError("");
    // 平文キーはdebugLog.inputへも渡さない(画面ログにも残さない)
    const res = await apiFetch("/api/v1/admin/ai-providers/credentials", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ providerKey, apiKey }),
    });
    if (res.ok) {
      setKeyInputs((prev) => ({ ...prev, [providerKey]: "" }));
      setSavedFlash(`key:${providerKey}`);
      setTimeout(() => setSavedFlash(null), 2000);
      await load();
    } else {
      const body = await res.json().catch(() => null);
      setError(body?.error?.message ?? "APIキーの登録に失敗しました");
    }
    setSavingKeyFor(null);
  }

  async function handleDeleteKey(providerKey: string) {
    setSavingKeyFor(providerKey);
    setError("");
    const res = await apiFetch("/api/v1/admin/ai-providers/credentials", {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ providerKey }),
    });
    if (res.ok) {
      await load();
    } else {
      const body = await res.json().catch(() => null);
      setError(body?.error?.message ?? "APIキーの削除に失敗しました");
    }
    setSavingKeyFor(null);
  }

  const allProviderKeys = Array.from(new Set(capabilities.flatMap((c) => c.availableProviderKeys)));

  return (
    <div className="space-y-6">
      <div>
        <p className="text-xs text-faint font-mono mb-1">管理</p>
        <h1 className="font-serif text-3xl">AIプロバイダー</h1>
        <p className="text-sm text-muted mt-1">
          機能ごとに使用するAI事業者・モデルを切り替え、APIキーを登録し、運用コストを確認できます。
        </p>
      </div>

      {error && (
        <div className="bg-red-50 border border-red-200 text-red-700 text-sm rounded-xl px-4 py-3">{error}</div>
      )}

      {loading ? (
        <p className="text-sm text-faint">読み込み中...</p>
      ) : (
        <>
          {/* 機能ごとのプロバイダー・モデル切替 */}
          <div className="space-y-4">
            {capabilities.map((c) => {
              const models = c.availableModelsByProvider[c.activeProviderKey] ?? [];
              const activeModel = models.find((m) => m.modelName === c.modelName) ?? models[0];
              // [2026-08-22追加] カルキョンさんの指摘「APIキーは登録されているなら
              // 一般的な表示にしろ、登録されているのか判別つかない」に対応。
              // 従来はページ下部の別セクションでしか確認できず、このカード単体では
              // 現在選択中の事業者のキーが登録済みかどうか分からなかった。
              const activeCred = credentials.find((cred) => cred.providerKey === c.activeProviderKey);
              return (
                <div key={c.capability} className="bg-surface border border-line rounded-2xl shadow-card p-5">
                  <div className="flex items-center justify-between mb-3">
                    <div>
                      <p className="font-medium text-ink">{CAPABILITY_LABEL[c.capability] ?? c.capability}</p>
                      <p className="text-xs text-faint font-mono mt-0.5">{c.capability}</p>
                    </div>
                    <div className="flex items-center gap-2">
                      {activeCred?.registered ? (
                        <span className="text-[11px] text-safe bg-safe-50 border border-safe/30 rounded-full px-2.5 py-1 flex items-center gap-1">
                          🔑 APIキー登録済み
                        </span>
                      ) : (
                        <span className="text-[11px] text-muted bg-canvas border border-line rounded-full px-2.5 py-1 flex items-center gap-1">
                          🔑 .envのキーを使用中
                        </span>
                      )}
                      {savedFlash === c.capability && (
                        <span className="text-xs text-green-700 bg-green-50 border border-green-200 rounded-full px-2.5 py-1">
                          保存しました
                        </span>
                      )}
                    </div>
                  </div>

                  <div className="flex flex-wrap items-start gap-3">
                    <div>
                      <label className="block text-xs text-faint mb-1">事業者</label>
                      <ProviderDropdown
                        value={c.activeProviderKey}
                        options={c.availableProviderKeys}
                        disabled={savingCapability === c.capability}
                        onChange={(key) => handleSwitch(c.capability, key)}
                      />
                    </div>

                    {models.length > 0 && (
                      <div>
                        <label className="block text-xs text-faint mb-1">モデル</label>
                        <select
                          value={c.modelName ?? models[0]?.modelName}
                          disabled={savingCapability === c.capability}
                          onChange={(e) => handleSwitch(c.capability, c.activeProviderKey, e.target.value)}
                          className="border border-line rounded-lg px-3 py-2 text-sm bg-canvas disabled:opacity-50 min-w-[260px]"
                        >
                          {models.map((m) => (
                            <option key={m.modelName} value={m.modelName}>
                              {m.label}
                            </option>
                          ))}
                        </select>
                      </div>
                    )}

                    {c.isDefault && <span className="text-xs text-faint self-center pt-5">(未設定のため既定値を使用中)</span>}

                    {/* [2026-08-22新設] カルキョンさんの指示「モデル選択でどのような特徴なのか
                        費用目安など切り替え時に余白スペースに表示しろ」に対応。 */}
                    {activeModel && (
                      <div className="flex-1 min-w-[220px] bg-canvas rounded-lg px-3 py-2 self-stretch">
                        <p className="text-[10px] font-semibold text-faint uppercase tracking-wide mb-0.5">この機能の特徴</p>
                        <p className="text-[11.5px] text-muted leading-snug">{activeModel.description}</p>
                      </div>
                    )}
                  </div>
                </div>
              );
            })}
          </div>

          {/* APIキー登録 */}
          <div className="bg-surface border border-line rounded-2xl shadow-card p-5">
            <p className="font-medium text-ink mb-1">APIキー</p>
            <p className="text-xs text-muted mb-4">
              事業者ごとに1件登録できます。未登録の場合はサーバー環境変数(.env)のキーが使われます。登録したキーは暗号化して保存し、末尾4文字のみ画面に表示します。
            </p>
            <div className="space-y-3">
              {allProviderKeys.map((providerKey) => {
                const cred = credentials.find((c) => c.providerKey === providerKey);
                return (
                  <div key={providerKey} className="flex flex-wrap items-center gap-2 border border-line rounded-xl px-3 py-2.5">
                    <ProviderBadge providerKey={providerKey} />
                    <span className="text-sm font-medium w-24">{providerMeta(providerKey).label}</span>
                    {cred?.registered ? (
                      <>
                        <span className="text-xs text-safe bg-safe-50 border border-safe/30 rounded-full px-2.5 py-1 flex items-center gap-1">
                          ✓ 登録済み(末尾: {cred.last4})
                        </span>
                        <button
                          onClick={() => handleDeleteKey(providerKey)}
                          disabled={savingKeyFor === providerKey}
                          className="text-xs text-red-600 hover:underline disabled:opacity-50"
                        >
                          削除(.envへフォールバック)
                        </button>
                      </>
                    ) : (
                      <span className="text-xs text-muted bg-canvas border border-line rounded-full px-2.5 py-1">
                        未登録(.envのキーを使用中)
                      </span>
                    )}
                    <input
                      type="password"
                      placeholder="新しいAPIキーを入力"
                      value={keyInputs[providerKey] ?? ""}
                      onChange={(e) => setKeyInputs((prev) => ({ ...prev, [providerKey]: e.target.value }))}
                      className="border border-line rounded-lg px-3 py-1.5 text-sm bg-canvas flex-1 min-w-[200px]"
                    />
                    <button
                      onClick={() => handleSaveKey(providerKey)}
                      disabled={savingKeyFor === providerKey || !keyInputs[providerKey]?.trim()}
                      className="text-xs bg-ink text-white rounded-lg px-3 py-1.5 disabled:opacity-40"
                    >
                      保存
                    </button>
                    {savedFlash === `key:${providerKey}` && (
                      <span className="text-xs text-green-700">保存しました</span>
                    )}
                  </div>
                );
              })}
            </div>
          </div>

          {/* KPIカード(市販ツール同様のダッシュボード上部サマリー) */}
          {usage && (
            <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
              <div className="bg-surface border border-line rounded-2xl shadow-card p-4">
                <p className="text-xs text-faint">直近30日コスト</p>
                <p className="text-xl font-serif text-ink mt-1">
                  {formatUsd(microsToUsd(BigInt(usage.totalCostMicrosLast30Days)))}
                </p>
              </div>
              <div className="bg-surface border border-line rounded-2xl shadow-card p-4">
                <p className="text-xs text-faint">成功率(30日)</p>
                <p className="text-xl font-serif text-ink mt-1">{formatPercent(usage.successRate)}</p>
              </div>
              <div className="bg-surface border border-line rounded-2xl shadow-card p-4">
                <p className="text-xs text-faint">平均レイテンシ</p>
                <p className="text-xl font-serif text-ink mt-1">
                  {usage.avgLatencyMs !== null ? `${usage.avgLatencyMs}ms` : "—"}
                </p>
                <p className="text-xs text-faint mt-0.5">
                  p95: {usage.p95LatencyMs !== null ? `${usage.p95LatencyMs}ms` : "—"}
                </p>
              </div>
              <div className="bg-surface border border-line rounded-2xl shadow-card p-4">
                <p className="text-xs text-faint">AI候補の採用率</p>
                <p className="text-xl font-serif text-ink mt-1">{formatPercent(usage.acceptanceRate)}</p>
                <p className="text-xs text-faint mt-0.5">Accept+Edit ÷ 判断済み件数</p>
              </div>
            </div>
          )}

          {/* 日次トレンド(直近14日) */}
          {usage && usage.dailyTrend.length > 0 && (
            <div className="bg-surface border border-line rounded-2xl shadow-card p-5">
              <p className="font-medium text-ink mb-4">日次コスト推移(直近14日)</p>
              {(() => {
                const maxCost = Math.max(
                  ...usage.dailyTrend.map((d) => microsToUsd(BigInt(d.costMicros))),
                  0.0001,
                );
                return (
                  <div className="flex items-end gap-1.5 h-32">
                    {usage.dailyTrend.map((d) => {
                      const usd = microsToUsd(BigInt(d.costMicros));
                      const heightPct = Math.max(4, (usd / maxCost) * 100);
                      return (
                        <div key={d.date} className="flex-1 flex flex-col items-center justify-end h-full group relative">
                          <div
                            className={`w-full rounded-t ${d.failedCount > 0 ? "bg-red-300" : "bg-brand-300"}`}
                            style={{ height: `${heightPct}%` }}
                            title={`${d.date}: ${formatUsd(usd)}(${d.runCount}件${d.failedCount > 0 ? `、失敗${d.failedCount}件` : ""})`}
                          />
                          <span className="text-[9px] text-faint mt-1 rotate-0">{d.date.slice(5)}</span>
                        </div>
                      );
                    })}
                  </div>
                );
              })()}
            </div>
          )}

          {/* モデル別内訳・エラー内訳 */}
          {usage && (
            <div className="grid md:grid-cols-2 gap-4">
              <div className="bg-surface border border-line rounded-2xl shadow-card p-5">
                <p className="font-medium text-ink mb-3">モデル別コスト(累計)</p>
                {usage.unknownCostRunCount > 0 && (
                  <p className="text-xs text-amber-700 bg-amber-50 border border-amber-200 rounded-lg px-3 py-2 mb-3">
                    料金表未登録のモデル呼び出しが{usage.unknownCostRunCount}件あり、コストに含まれていません。
                  </p>
                )}
                <table className="w-full text-sm">
                  <thead>
                    <tr className="text-left text-xs text-faint border-b border-line">
                      <th className="py-1.5 font-normal">モデル</th>
                      <th className="py-1.5 font-normal text-right">回数</th>
                      <th className="py-1.5 font-normal text-right">コスト</th>
                    </tr>
                  </thead>
                  <tbody>
                    {usage.byModelAllTime.map((row) => (
                      <tr key={`${row.provider}/${row.model}`} className="border-b border-line last:border-0">
                        <td className="py-1.5 font-mono text-xs">{row.model}</td>
                        <td className="py-1.5 text-right">{row.runCount.toLocaleString()}</td>
                        <td className="py-1.5 text-right">
                          {row.costMicros !== null ? formatUsd(microsToUsd(BigInt(row.costMicros))) : "不明"}
                        </td>
                      </tr>
                    ))}
                    {usage.byModelAllTime.length === 0 && (
                      <tr>
                        <td colSpan={3} className="py-3 text-center text-faint">
                          まだ利用実績がありません
                        </td>
                      </tr>
                    )}
                  </tbody>
                </table>
              </div>

              <div className="bg-surface border border-line rounded-2xl shadow-card p-5">
                <p className="font-medium text-ink mb-3">AI候補の採否内訳</p>
                <ul className="space-y-1.5">
                  {usage.decisionBreakdown.map((d) => (
                    <li key={d.decision} className="flex items-center justify-between text-sm">
                      <span className="font-mono text-xs text-muted">{d.decision}</span>
                      <span className="text-ink">{d.count.toLocaleString()}件</span>
                    </li>
                  ))}
                  {usage.decisionBreakdown.length === 0 && (
                    <li className="text-sm text-faint">まだAI候補の判断実績がありません</li>
                  )}
                </ul>
              </div>
            </div>
          )}

          {/* 直近の呼び出しログ(ドリルダウン) */}
          {usage && usage.recentRuns.length > 0 && (
            <div className="bg-surface border border-line rounded-2xl shadow-card p-5">
              <p className="font-medium text-ink mb-3">直近の呼び出しログ</p>
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-left text-xs text-faint border-b border-line">
                    <th className="py-1.5 font-normal">状態</th>
                    <th className="py-1.5 font-normal">日時</th>
                    <th className="py-1.5 font-normal">モデル</th>
                    <th className="py-1.5 font-normal text-right">レイテンシ</th>
                    <th className="py-1.5 font-normal text-right">コスト</th>
                  </tr>
                </thead>
                <tbody>
                  {usage.recentRuns.map((run) => (
                    <tr key={run.id} className="border-b border-line last:border-0">
                      <td className="py-1.5">
                        <span className="inline-flex items-center gap-1.5">
                          <span className={`w-1.5 h-1.5 rounded-full ${RUN_STATUS_DOT[run.status] ?? "bg-gray-300"}`} />
                          <span className="text-xs">{STATUS_LABEL[run.status] ?? run.status}</span>
                        </span>
                        {run.errorCode && <p className="text-[10px] text-red-600 mt-0.5">{run.errorCode}</p>}
                      </td>
                      <td className="py-1.5 text-xs text-muted">{formatRelativeDate(run.startedAt)}</td>
                      <td className="py-1.5 font-mono text-xs">{run.model}</td>
                      <td className="py-1.5 text-right text-xs">{run.latencyMs !== null ? `${run.latencyMs}ms` : "—"}</td>
                      <td className="py-1.5 text-right text-xs">
                        {run.costMicros !== null ? formatUsd(microsToUsd(BigInt(run.costMicros))) : "不明"}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}
    </div>
  );
}
