/**
 * FR-CAP-02拡張: 画像(会議メモ写真・ホワイトボード等)のOCR文字起こしプロバイダーの
 * 共通インターフェース(2026-08-21新設)。lib/ai/transcriptionProvider.tsと同じ
 * 抽象化方針を踏襲する(AI事業者を切り替え可能にする、FR-AI-07)。
 *
 * [2026-08-21修正] 複数ページ(ノート数枚を1メモとして結合)対応のため、単一画像から
 * 画像配列(ページ順)へ変更した。Anthropic Vision APIは1リクエストで複数画像を
 * 受け付けられるため、ページをまたいだ文脈(「前ページの続き」等)を保ったまま
 * 1回のAPI呼び出しで書き起こせる(ページごとに個別OCRしてから文字列結合する方式より
 * 精度が高いと判断)。
 */

export interface AiOcrImageInput {
  buffer: Buffer;
  /** image/jpeg, image/png, image/gif, image/webp のいずれか。 */
  contentType: string;
  fileName: string;
}

export interface AiOcrInput {
  /** ページ順(pageIndex昇順)。1枚のみの場合も要素数1の配列。 */
  images: AiOcrImageInput[];
}

export type AiOcrOutcome =
  | {
      ok: true;
      text: string;
      usage: { inputTokens: number; outputTokens: number; latencyMs: number };
    }
  | {
      ok: false;
      kind: "TRANSIENT" | "FATAL";
      message: string;
      usage?: { inputTokens: number; outputTokens: number; latencyMs: number };
    };

export interface AiOcrProvider {
  providerName: string;
  modelName: string;
  extractText(input: AiOcrInput): Promise<AiOcrOutcome>;
  /** [2026-08-21追加] Batch API対応。対応プロバイダーのみ実装する(現状Anthropicのみ)。 */
  submitOcrBatch?(input: AiOcrInput): Promise<import("@/lib/ai/provider").AiBatchSubmitResult>;
  checkBatch?(batchId: string): Promise<import("@/lib/ai/provider").AiBatchCheckResult>;
  fetchOcrBatchResult?(resultsUrl: string): Promise<AiOcrOutcome>;
}
