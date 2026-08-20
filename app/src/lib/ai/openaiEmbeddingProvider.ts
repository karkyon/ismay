import { debugServer } from "@/lib/debugServer";
import type { AiEmbeddingInput, AiEmbeddingOutcome, AiEmbeddingProvider } from "@/lib/ai/embeddingProvider";

// 2026-08-20カルキョンさん合意: Embedding事業者はOpenAI text-embedding-3-small
// (1536次元、schema.prisma responsibility_embeddings.embedding vector(1536)と一致)に確定。
const DEFAULT_MODEL = "text-embedding-3-small";
const DIMENSIONS = 1536;
const OPENAI_API_URL = "https://api.openai.com/v1/embeddings";
const REQUEST_TIMEOUT_MS = 15_000;

interface OpenAiEmbeddingResponse {
  data: { embedding: number[] }[];
  usage: { prompt_tokens: number };
}

export function createOpenAiEmbeddingProvider(opts?: { apiKey?: string; model?: string }): AiEmbeddingProvider {
  const modelName = opts?.model ?? process.env.OPENAI_EMBEDDING_MODEL ?? DEFAULT_MODEL;

  return {
    providerName: "openai",
    modelName,
    dimensions: DIMENSIONS,

    async embed(input: AiEmbeddingInput): Promise<AiEmbeddingOutcome> {
      const apiKey = opts?.apiKey ?? process.env.OPENAI_API_KEY;
      if (!apiKey) {
        return { ok: false, kind: "FATAL", message: "OpenAI APIキーが未設定です(管理画面または.envで設定してください)" };
      }

      const started = Date.now();
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

      try {
        const res = await fetch(OPENAI_API_URL, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${apiKey}`,
          },
          body: JSON.stringify({ model: modelName, input: input.text }),
          signal: controller.signal,
        });
        const latencyMs = Date.now() - started;

        if (!res.ok) {
          const kind = res.status >= 500 || res.status === 429 ? "TRANSIENT" : "FATAL";
          const bodyText = await res.text().catch(() => "");
          debugServer.error("openaiEmbeddingProvider", "APIエラー", { status: res.status, bodyText });
          return { ok: false, kind, message: `OpenAI Embedding API ${res.status}`, usage: { inputTokens: 0, latencyMs } };
        }

        const body = (await res.json()) as OpenAiEmbeddingResponse;
        const vector = body.data[0]?.embedding;
        if (!vector || vector.length !== DIMENSIONS) {
          return {
            ok: false,
            kind: "FATAL",
            message: `想定次元数(${DIMENSIONS})と異なるベクトルが返却されました(実際: ${vector?.length ?? 0})`,
          };
        }

        return {
          ok: true,
          vector,
          dimensions: DIMENSIONS,
          usage: { inputTokens: body.usage?.prompt_tokens ?? 0, latencyMs },
        };
      } catch (err) {
        const latencyMs = Date.now() - started;
        const isAbort = err instanceof Error && err.name === "AbortError";
        return {
          ok: false,
          kind: "TRANSIENT",
          message: isAbort ? "タイムアウトしました" : String(err),
          usage: { inputTokens: 0, latencyMs },
        };
      } finally {
        clearTimeout(timeout);
      }
    },
  };
}
