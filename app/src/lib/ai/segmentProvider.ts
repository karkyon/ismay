/**
 * FN-CAP-01拡張: 音声文字起こし結果の話題自動分割(2026-08-21新設)。
 * カルキョンさんの指示「音声のテーマ切り替わりでの複数Capture自動分割」に対応。
 *
 * 30分の会議等、長い音声の文字起こし結果には複数の独立した話題(例:「前半は現場視察、
 * 後半は別件の見積もり確認」)が混在することがある。1つのCaptureのままAI抽出すると、
 * 責任候補のevidenceSpansやcaptureSummaryが話題をまたいで曖昧になりやすいため、
 * 話題の切れ目がはっきりしている場合のみ複数Captureへ分割する。
 *
 * lib/ai/provider.ts(抽出)・lib/ai/ocrProvider.ts(OCR)と同じ抽象化方針
 * (AI事業者を切り替え可能にする、FR-AI-07)。
 */

export interface AiSegmentInput {
  /** 非信頼原文(Capture.rawText、通常は文字起こし結果)。 */
  rawText: string;
  nowIso: string;
}

export interface AiSegmentUsage {
  inputTokens: number;
  outputTokens: number;
  latencyMs: number;
}

/** rawText内の文字位置(0始まり、endは排他的)によるセグメント境界。 */
export interface AiTextSegment {
  title: string;
  startChar: number;
  endChar: number;
}

export type AiSegmentOutcome =
  | { ok: true; segments: AiTextSegment[]; usage: AiSegmentUsage }
  | { ok: false; kind: "TRANSIENT" | "STRUCTURAL" | "FATAL"; message: string; usage?: AiSegmentUsage };

export interface AiSegmentProvider {
  readonly providerName: string;
  readonly modelName: string;
  readonly promptVersion: string;
  readonly schemaVersion: string;
  segmentText(input: AiSegmentInput): Promise<AiSegmentOutcome>;
}
