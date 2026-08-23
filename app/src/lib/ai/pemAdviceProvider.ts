/**
 * FN-PEM-03 助言(AI-07)・週次レビュー(AI-08)のAI Gateway抽象化。
 * lib/ai/pemProvider.ts(FN-PEM-01)と同じ方針。
 */

export interface PemAdviceUsage {
  inputTokens: number;
  outputTokens: number;
  latencyMs: number;
}

export type PemAdviceOutcome =
  | { ok: true; rawJson: unknown; usage: PemAdviceUsage }
  | { ok: false; kind: "TRANSIENT" | "STRUCTURAL" | "FATAL"; message: string; usage?: PemAdviceUsage };

export interface GenerateHypothesisInput {
  /** 観察の要約文(lib/pem.tsが計算済みの実数値を含む、AIは数値を作らない)。 */
  observationStatement: string;
  sampleSize: number;
  comparisonSampleSize: number;
  gapPercentagePoints: number;
  /** §13「本人がREJECTした仮説は同じ根拠だけで再提案しない」対応。直近の却下済み仮説文があれば渡す。 */
  recentlyRejectedStatements: string[];
}

export interface GenerateWeeklyReviewInput {
  weekLabel: string;
  fulfilledCount: number;
  stalledCount: number;
  /** 実測サンプルが無い場合はnull(AIに数値を捏造させないため、その場合は該当欄をnullにさせる)。 */
  estimateErrorPercent: number | null;
  /** 直近の有効なPEM仮説文(あれば、週次レビューの実験提案と連動させる)。 */
  activeHypothesisStatement: string | null;
}

export interface PemAdviceProvider {
  readonly providerName: string;
  readonly modelName: string;
  readonly promptVersion: string;
  readonly schemaVersion: string;
  generateHypothesis(input: GenerateHypothesisInput): Promise<PemAdviceOutcome>;
  generateWeeklyReview(input: GenerateWeeklyReviewInput): Promise<PemAdviceOutcome>;
}
