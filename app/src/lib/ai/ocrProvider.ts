/**
 * FR-CAP-02拡張: 画像(会議メモ写真・ホワイトボード等)のOCR文字起こしプロバイダーの
 * 共通インターフェース(2026-08-21新設)。lib/ai/transcriptionProvider.tsと同じ
 * 抽象化方針を踏襲する(AI事業者を切り替え可能にする、FR-AI-07)。
 */

export interface AiOcrInput {
  imageBuffer: Buffer;
  /** image/jpeg, image/png, image/gif, image/webp のいずれか。 */
  contentType: string;
  fileName: string;
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
}
