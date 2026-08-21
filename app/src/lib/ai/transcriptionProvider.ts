/**
 * FN-CAP-02(音声入力)向け文字起こしプロバイダーの共通インターフェース。
 * lib/ai/embeddingProvider.tsと同じ抽象化方針(AI事業者を切り替え可能にする)を踏襲。
 */

export interface AiTranscriptionInput {
  audioBuffer: Buffer;
  /** MIMEタイプ(audio/mp4, audio/mpeg, audio/wav 等)。事業者APIへのファイル名拡張子判定に使う。 */
  contentType: string;
  fileName: string;
}

export type AiTranscriptionOutcome =
  | {
      ok: true;
      text: string;
      /** 音声の長さ(秒)。事業者が返す場合のみ設定(コスト計算に使う)。 */
      durationSeconds: number | null;
      usage: { latencyMs: number };
    }
  | {
      ok: false;
      kind: "TRANSIENT" | "FATAL";
      message: string;
      usage?: { latencyMs: number };
    };

export interface AiTranscriptionProvider {
  providerName: string;
  modelName: string;
  transcribe(input: AiTranscriptionInput): Promise<AiTranscriptionOutcome>;
}
