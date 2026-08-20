/**
 * FN-GR-01 意味照合。Responsibilityから埋め込み対象テキストを構築する。
 * 出典: ISMAY_機能別詳細設計書v1.1 9章(FN-GR-01)、DB設計書v1.1 7章「検索・Embedding」。
 *
 * どのフィールドを連結するかで検索精度が大きく変わるため、単一箇所に集約する
 * (責任作成時の埋め込み生成と、検索クエリ側の埋め込み生成で必ず同じロジックを使う)。
 */
export function buildEmbeddingText(input: {
  title: string;
  description?: string | null;
  actor?: string | null;
  counterparty?: string | null;
}): string {
  const parts = [input.title];
  if (input.actor) parts.push(`担当: ${input.actor}`);
  if (input.counterparty) parts.push(`相手: ${input.counterparty}`);
  if (input.description) parts.push(input.description);
  return parts.join("\n").slice(0, 8000);
}
