"use client";

import { useCallback, useEffect, useState } from "react";
import { apiFetch, debugFetch } from "@/lib/auth/client";
import { debugLog } from "@/lib/debug";

interface CapabilityConfig {
  capability: string;
  activeProviderKey: string;
  modelName: string | null;
  isDefault: boolean;
  availableProviderKeys: string[];
  updatedAt: string | null;
}

const CAPABILITY_LABEL: Record<string, string> = {
  EXTRACTION: "責任候補抽出(FN-AI-01)",
  EMBEDDING: "意味照合・類似度計算(FN-GR-01)",
};

/**
 * /admin/ai-providers: FR-AI-07「AIモデルを交換可能にする」に基づくAIプロバイダー切替画面。
 *
 * [既知の制約] 現状Userに管理者ロールの概念が無いため、Workspaceに所属する認証済み
 * ユーザーであれば誰でも変更できる(他の全画面と同じ認可レベル)。複数メンバー運用を
 * 始める場合は管理者限定化を別途検討する必要がある。
 */
export function AiProvidersAdminClient() {
  const [capabilities, setCapabilities] = useState<CapabilityConfig[]>([]);
  const [loading, setLoading] = useState(true);
  const [savingCapability, setSavingCapability] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [savedFlash, setSavedFlash] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    const res = await debugFetch("/api/v1/admin/ai-providers");
    if (res.ok) {
      const body = await res.json();
      debugLog.state("AiProvidersAdminClient", "capabilities", body.data.capabilities);
      setCapabilities(body.data.capabilities);
    }
    setLoading(false);
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  async function handleSwitch(capability: string, providerKey: string) {
    setSavingCapability(capability);
    setError("");
    debugLog.input("AiProvidersAdminClient", "providerKey", { capability, providerKey });
    const res = await apiFetch("/api/v1/admin/ai-providers", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ capability, providerKey }),
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

  return (
    <div className="space-y-6">
      <div>
        <p className="text-xs text-faint font-mono mb-1">管理</p>
        <h1 className="font-serif text-3xl">AIプロバイダー</h1>
        <p className="text-sm text-muted mt-1">
          機能ごとに使用するAI事業者を切り替えられます。APIキーはサーバー環境変数側で管理しており、ここでは
          「どの登録済みプロバイダーを使うか」のみを選択します。
        </p>
      </div>

      {error && (
        <div className="bg-red-50 border border-red-200 text-red-700 text-sm rounded-xl px-4 py-3">{error}</div>
      )}

      {loading ? (
        <p className="text-sm text-faint">読み込み中...</p>
      ) : (
        <div className="space-y-4">
          {capabilities.map((c) => (
            <div key={c.capability} className="bg-surface border border-line rounded-2xl shadow-card p-5">
              <div className="flex items-center justify-between mb-3">
                <div>
                  <p className="font-medium text-ink">{CAPABILITY_LABEL[c.capability] ?? c.capability}</p>
                  <p className="text-xs text-faint font-mono mt-0.5">{c.capability}</p>
                </div>
                {savedFlash === c.capability && (
                  <span className="text-xs text-green-700 bg-green-50 border border-green-200 rounded-full px-2.5 py-1">
                    保存しました
                  </span>
                )}
              </div>

              <div className="flex items-center gap-3">
                <select
                  value={c.activeProviderKey}
                  disabled={savingCapability === c.capability}
                  onChange={(e) => handleSwitch(c.capability, e.target.value)}
                  className="border border-line rounded-lg px-3 py-2 text-sm bg-canvas disabled:opacity-50"
                >
                  {c.availableProviderKeys.map((key) => (
                    <option key={key} value={key}>
                      {key}
                    </option>
                  ))}
                </select>
                {c.isDefault && <span className="text-xs text-faint">(未設定のため既定値を使用中)</span>}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
