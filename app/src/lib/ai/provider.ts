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

export interface AiExtractionProvider {
  readonly providerName: string;
  readonly modelName: string;
  readonly promptVersion: string;
  readonly schemaVersion: string;
  extractCandidates(input: AiExtractionInput): Promise<AiExtractionOutcome>;
}
