/**
 * AI Gateway - Provider Adapter層。
 * FR-AI-07「AIモデルを交換可能にする」に対応し、ドメイン層(extract.ts)は
 * このインターフェースのみに依存する(Anthropic固有のレスポンス形状に直接依存しない)。
 */

export interface AiExtractionInput {
  /** 非信頼原文(Capture.rawText)。プロンプト内で明示的にデータとして分離する。 */
  rawText: string;
  /** モデルへ伝える現在時刻(相対日付の解釈基準)。 */
  nowIso: string;
  timezone: string;
  /** [2026-08-21追加] 候補のsuggestedTags推定時、既存タグから優先的に選ばせるための一覧。 */
  existingTagNames?: string[];
}

export interface AiExtractionUsage {
  inputTokens: number;
  outputTokens: number;
  latencyMs: number;
}

export interface AiExtractionSuccess {
  ok: true;
  /** JSON Schema検証前の生JSON(呼び出し側でzod検証する)。 */
  rawJson: unknown;
  usage: AiExtractionUsage;
}

export interface AiExtractionFailure {
  ok: false;
  /** TRANSIENT: ネットワーク/タイムアウト/5xx等、再試行の価値がある失敗。
   *  STRUCTURAL: モデルがtool_useを使わなかった等、同一プロンプトでの再試行で
   *              修復し得る出力形式の失敗。
   *  FATAL: 認証エラー等、再試行しても解決しない失敗。 */
  kind: "TRANSIENT" | "STRUCTURAL" | "FATAL";
  message: string;
  usage?: AiExtractionUsage;
}

export type AiExtractionOutcome = AiExtractionSuccess | AiExtractionFailure;

/**
 * [2026-08-21追加] Batch API対応(Anthropic Message Batches、50%引き・完了まで最大24時間)。
 * すべてのプロバイダーが対応するとは限らないため任意メソッドとする(現状Anthropicのみ実装)。
 * 呼び出し元(extract.ts)は `ai.submitExtractionBatch` の有無で対応可否を判定する。
 */
export type AiBatchSubmitResult = { ok: true; batchId: string } | { ok: false; kind: "TRANSIENT" | "FATAL"; message: string };
export type AiBatchProcessingStatus = "IN_PROGRESS" | "ENDED" | "CANCELING";
export type AiBatchCheckResult =
  | { ok: true; status: AiBatchProcessingStatus; resultsUrl: string | null }
  | { ok: false; kind: "TRANSIENT" | "FATAL"; message: string };

export interface AiExtractionProvider {
  readonly providerName: string;
  readonly modelName: string;
  readonly promptVersion: string;
  readonly schemaVersion: string;
  extractCandidates(input: AiExtractionInput): Promise<AiExtractionOutcome>;
  /** Batch APIでの投入。対応プロバイダーのみ実装する。 */
  submitExtractionBatch?(input: AiExtractionInput): Promise<AiBatchSubmitResult>;
  /** Batchの進捗確認。 */
  checkBatch?(batchId: string): Promise<AiBatchCheckResult>;
  /** Batch完了後の結果取得・パース(extractCandidatesと同じ形のOutcomeを返す)。 */
  fetchExtractionBatchResult?(resultsUrl: string): Promise<AiExtractionOutcome>;
}
