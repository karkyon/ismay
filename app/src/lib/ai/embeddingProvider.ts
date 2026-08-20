/**
 * AI Gateway - Embedding Provider Adapter層。
 * provider.ts(抽出用AiExtractionProvider)と同型で、FR-AI-07「AIモデルを交換可能にする」を
 * Embedding(FN-GR-01意味照合の類似度計算)にも適用する。ドメイン層はこのインターフェース
 * のみに依存し、特定事業者のレスポンス形状に直接依存しない。
 */

export interface AiEmbeddingInput {
  /** ベクトル化対象テキスト(Responsibility.title+description等)。 */
  text: string;
}

export interface AiEmbeddingUsage {
  inputTokens: number;
  latencyMs: number;
}

export interface AiEmbeddingSuccess {
  ok: true;
  vector: number[];
  dimensions: number;
  usage: AiEmbeddingUsage;
}

export interface AiEmbeddingFailure {
  ok: false;
  /** TRANSIENT: 再試行の価値がある失敗。FATAL: 認証エラー等、再試行しても解決しない失敗。 */
  kind: "TRANSIENT" | "FATAL";
  message: string;
  usage?: AiEmbeddingUsage;
}

export type AiEmbeddingOutcome = AiEmbeddingSuccess | AiEmbeddingFailure;

export interface AiEmbeddingProvider {
  readonly providerName: string;
  readonly modelName: string;
  /** responsibility_embeddings.embeddingのpgvector次元数(schema.prisma: vector(1536))と
   *  一致しないプロバイダーを選んだ場合、書き込み時にDBエラーとなる想定(意図的にfail-fast)。 */
  readonly dimensions: number;
  embed(input: AiEmbeddingInput): Promise<AiEmbeddingOutcome>;
}
