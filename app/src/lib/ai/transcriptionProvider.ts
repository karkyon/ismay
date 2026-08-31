/**
 * FN-CAP-02(音声入力)向け文字起こしプロバイダーの共通インターフェース。
 * lib/ai/embeddingProvider.tsと同じ抽象化方針(AI事業者を切り替え可能にする)を踏襲。
 *
 * [M1-B6A §3.2.2新設・2026-08-31指示書] `segments`を後方互換なoptional fieldとして
 * 追加した(既存consumerはこのfieldを無視すれば従来通り動作する)。OpenAI
 * Transcription APIの`response_format=verbose_json`が返す`segments`配列
 * (公式に文書化された安定契約。この事業者選定時点で既にverbose_jsonを
 * 指定済みだったが、`segments`自体はこれまで破棄していた)を正規化した形。
 * 話者分離(speaker diarization)はこのAPIには無いため、`speakerLabel`は
 * 含めない(無い情報を捏造しない。MEETING_SPEAKER Anchorは、話者分離
 * 対応Providerが別途導入されるまでこのProviderからは常にUNAVAILABLEになる、
 * という正直な状態を維持する)。
 */
export interface AiTranscriptionSegment {
  /** segment開始位置(ミリ秒、Capture先頭からの相対時刻)。 */
  startMs: number;
  /** segment終了位置(ミリ秒)。startMsより大きい。 */
  endMs: number;
  text: string;
}

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
      /** [M1-B6A §3.2.2新設] segment単位のtimecode。Providerが返さない場合は
       *  undefined(空配列と未対応を区別する。空配列は「segmentが0件だった」
       *  という事実、undefinedは「この応答形式からはsegmentを取得していない」
       *  という別の事実であり、混同しない)。 */
      segments?: AiTranscriptionSegment[];
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
