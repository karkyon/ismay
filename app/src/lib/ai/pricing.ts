/**
 * AIモデル料金表(2026-08-20 web検索で公式レート確認のうえ設定。想像で決めていない)。
 *
 * カルキョンさんの指示「APIの運用コストも明示的に明確に視覚的に随時確認できるように」に対応。
 * AiRun.costMicros(schema.prisma既存列。従来は未使用のまま放置されていた)へ、
 * 抽出成功・失敗の都度この表を使って算出したコストを書き込む。
 *
 * [運用上の注意] 料金は事業者側で随時改定される。本表は実装時点(2026-08-20)の
 * 確認値であり、自動追従はしない。金額が実際の請求と乖離してきた場合は、
 * この表を手動更新する必要がある(TBD候補: 料金表の管理画面化は今回のスコープ外)。
 *
 * 出典:
 * - Claude Haiku 4.5: $1.00/$5.00 per Mtok(入力/出力) — Anthropic公式ドキュメント基準の
 *   複数ソースで一致確認(2026-08-19時点)
 * - OpenAI text-embedding-3-small: $0.02 per Mtok(入力のみ、出力課金なし) — OpenAI公式
 *   pricing pageベースの複数ソースで一致確認
 */

export interface ModelPricing {
  /** 1,000,000トークンあたりの価格(USD)。EmbeddingはoutputPerMillion=0。 */
  inputPerMillionUsd: number;
  outputPerMillionUsd: number;
  /** 料金確認日(このモジュールを更新すべきタイミングの目安として保持)。 */
  verifiedOn: string;
}

export const MODEL_PRICING: Record<string, ModelPricing> = {
  "claude-haiku-4-5-20251001": { inputPerMillionUsd: 1.0, outputPerMillionUsd: 5.0, verifiedOn: "2026-08-19" },
  "text-embedding-3-small": { inputPerMillionUsd: 0.02, outputPerMillionUsd: 0, verifiedOn: "2026-08-19" },
};

const MICROS_PER_USD = 1_000_000;

/**
 * トークン使用量からコスト(costMicros = USD × 1,000,000の整数)を算出する。
 * 未登録モデルの場合はnullを返す(料金表の更新漏れをコスト0円と誤表示しないため)。
 */
export function estimateCostMicros(
  modelName: string,
  inputTokens: number | null | undefined,
  outputTokens: number | null | undefined,
): bigint | null {
  const pricing = MODEL_PRICING[modelName];
  if (!pricing) return null;
  const usd =
    ((inputTokens ?? 0) / 1_000_000) * pricing.inputPerMillionUsd +
    ((outputTokens ?? 0) / 1_000_000) * pricing.outputPerMillionUsd;
  return BigInt(Math.round(usd * MICROS_PER_USD));
}

export function microsToUsd(micros: bigint | number | null | undefined): number {
  if (micros === null || micros === undefined) return 0;
  return Number(micros) / MICROS_PER_USD;
}

export function formatUsd(usd: number): string {
  return `$${usd.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 4 })}`;
}
