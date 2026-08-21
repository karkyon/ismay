import { debugServer } from "@/lib/debugServer";
import type { AiTranscriptionInput, AiTranscriptionOutcome, AiTranscriptionProvider } from "@/lib/ai/transcriptionProvider";

// 2026-08-21カルキョンさん合意: 文字起こし事業者はOpenAI gpt-transcribeに確定。
// (2026-07-28リリース、OpenAI公式ドキュメントで旧whisper-1/gpt-4o-transcribeの
// 後継として案内されている最新モデル。$0.0045/分、旧モデル比で誤り率が大幅に低い)
const DEFAULT_MODEL = "gpt-transcribe";
const OPENAI_API_URL = "https://api.openai.com/v1/audio/transcriptions";
const REQUEST_TIMEOUT_MS = 120_000; // 音声ファイルは処理に時間がかかるため長めに設定
const USD_PER_MINUTE = 0.0045;

interface OpenAiTranscriptionResponse {
  text: string;
  duration?: number;
}

export function createOpenAiTranscriptionProvider(opts?: { apiKey?: string; model?: string }): AiTranscriptionProvider {
  const modelName = opts?.model ?? process.env.OPENAI_TRANSCRIPTION_MODEL ?? DEFAULT_MODEL;

  return {
    providerName: "openai",
    modelName,

    async transcribe(input: AiTranscriptionInput): Promise<AiTranscriptionOutcome> {
      const apiKey = opts?.apiKey ?? process.env.OPENAI_API_KEY;
      if (!apiKey) {
        return { ok: false, kind: "FATAL", message: "OpenAI APIキーが未設定です(管理画面または.envで設定してください)" };
      }

      const started = Date.now();
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

      try {
        const form = new FormData();
        // Node.js 22のグローバルFetch/FormDataはBlobを要求するため、Bufferから変換する。
        const blob = new Blob([new Uint8Array(input.audioBuffer)], { type: input.contentType });
        form.append("file", blob, input.fileName);
        form.append("model", modelName);
        // 会議メモ・独り言メモが中心のためja固定はせず自動検出に任せる(多言語対応)。
        form.append("response_format", "verbose_json");

        const res = await fetch(OPENAI_API_URL, {
          method: "POST",
          headers: { Authorization: `Bearer ${apiKey}` },
          body: form,
          signal: controller.signal,
        });
        const latencyMs = Date.now() - started;

        if (!res.ok) {
          const kind = res.status >= 500 || res.status === 429 ? "TRANSIENT" : "FATAL";
          const bodyText = await res.text().catch(() => "");
          debugServer.error("openaiTranscriptionProvider", "APIエラー", { status: res.status, bodyText });
          return { ok: false, kind, message: `OpenAI Transcription API ${res.status}`, usage: { latencyMs } };
        }

        const body = (await res.json()) as OpenAiTranscriptionResponse;
        if (!body.text) {
          return { ok: false, kind: "FATAL", message: "文字起こし結果が空でした", usage: { latencyMs } };
        }

        return {
          ok: true,
          text: body.text,
          durationSeconds: typeof body.duration === "number" ? body.duration : null,
          usage: { latencyMs },
        };
      } catch (err) {
        const latencyMs = Date.now() - started;
        const isAbort = err instanceof Error && err.name === "AbortError";
        return {
          ok: false,
          kind: "TRANSIENT",
          message: isAbort ? "タイムアウトしました(音声が長すぎる可能性があります)" : String(err),
          usage: { latencyMs },
        };
      } finally {
        clearTimeout(timeout);
      }
    },
  };
}

/** コスト計算(分単位課金)。extract.ts/embedding側のトークン単価計算とは単位が異なるため専用関数にする。 */
export function estimateTranscriptionCostMicros(durationSeconds: number | null): bigint | null {
  if (durationSeconds === null) return null;
  const minutes = durationSeconds / 60;
  const usd = minutes * USD_PER_MINUTE;
  return BigInt(Math.round(usd * 1_000_000));
}
