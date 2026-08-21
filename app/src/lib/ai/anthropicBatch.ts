/**
 * Anthropic Message Batches API の低レベルクライアント(2026-08-21新設)。
 *
 * [設計方針] Capture 1件 = Batchリクエスト1件、として都度個別にバッチ投入する
 * (複数Captureを溜めてから1つのバッチにまとめる方式は採らない)。理由:
 * - 溜める方式は「いつバッチを締めて送信するか」の運用ロジックが余分に必要になり、
 *   ユーザーから見た待ち時間も不確定になる(次の締切まで放置される)
 * - Anthropic Batch APIは1件のみのバッチでも正しく50%引きが適用される
 *   (複数リクエストをまとめる必要はない、というのが公式仕様)
 * - 個別投入なら、既存のJob(jobs テーブル)の1件1件をそのままバッチ1件に対応させられ、
 *   Worker側の設計(1 Job = 1 処理単位)を変えずに済む
 *
 * 呼び出し元(anthropicProvider.ts / anthropicOcrProvider.ts)は、通常の
 * POST /v1/messages と同じ params(model/system/messages/tools等)をそのまま
 * このモジュールへ渡す。Batch API内部では { custom_id, params } の配列として送信する。
 */

const ANTHROPIC_BATCHES_URL = "https://api.anthropic.com/v1/messages/batches";
const ANTHROPIC_VERSION = "2023-06-01";
const REQUEST_TIMEOUT_MS = 20_000;
const CUSTOM_ID = "single"; // Capture 1件=バッチ1件のため、リクエストは常に1件だけ

export type AnthropicBatchSubmitResult = { ok: true; batchId: string } | { ok: false; kind: "TRANSIENT" | "FATAL"; message: string };

export type AnthropicBatchProcessingStatus = "in_progress" | "canceling" | "ended";

export type AnthropicBatchStatusResult =
  | { ok: true; processingStatus: AnthropicBatchProcessingStatus; resultsUrl: string | null }
  | { ok: false; kind: "TRANSIENT" | "FATAL"; message: string };

/** Batch結果JSONLの1行(custom_id="single"の1件だけを想定)。 */
export interface AnthropicBatchResultLine {
  custom_id: string;
  result:
    | { type: "succeeded"; message: { content?: Array<{ type: string; text?: string; name?: string; input?: unknown }>; usage?: { input_tokens?: number; output_tokens?: number } } }
    | { type: "errored"; error: { type: string; message: string } }
    | { type: "canceled" }
    | { type: "expired" };
}

export type AnthropicBatchResultFetchResult = { ok: true; line: AnthropicBatchResultLine } | { ok: false; kind: "TRANSIENT" | "FATAL"; message: string };

async function withTimeout<T>(fn: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    return await fn(controller.signal);
  } finally {
    clearTimeout(timeout);
  }
}

/** バッチを1件投入し、batchIdを返す。 */
export async function submitAnthropicBatch(apiKey: string, requestParams: Record<string, unknown>): Promise<AnthropicBatchSubmitResult> {
  try {
    const res = await withTimeout((signal) =>
      fetch(ANTHROPIC_BATCHES_URL, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-api-key": apiKey,
          "anthropic-version": ANTHROPIC_VERSION,
        },
        body: JSON.stringify({ requests: [{ custom_id: CUSTOM_ID, params: requestParams }] }),
        signal,
      }),
    );

    if (res.status === 401 || res.status === 403) {
      return { ok: false, kind: "FATAL", message: `Anthropic API認証エラー(${res.status})` };
    }
    if (res.status === 429 || res.status >= 500) {
      return { ok: false, kind: "TRANSIENT", message: `Anthropic Batch API一時エラー(${res.status})` };
    }
    if (!res.ok) {
      const bodyText = await res.text().catch(() => "");
      return { ok: false, kind: "FATAL", message: `Anthropic Batch APIエラー(${res.status}): ${bodyText.slice(0, 500)}` };
    }

    const body = (await res.json()) as { id?: string };
    if (!body.id) {
      return { ok: false, kind: "FATAL", message: "Batch API応答にidが含まれていません" };
    }
    return { ok: true, batchId: body.id };
  } catch (err) {
    const isAbort = err instanceof Error && err.name === "AbortError";
    return {
      ok: false,
      kind: "TRANSIENT",
      message: isAbort ? "Anthropic Batch APIへのリクエストがタイムアウトしました" : `ネットワークエラー: ${String(err)}`,
    };
  }
}

/** バッチの現在状態を取得する(Worker側のポーリングで使う)。 */
export async function checkAnthropicBatchStatus(apiKey: string, batchId: string): Promise<AnthropicBatchStatusResult> {
  try {
    const res = await withTimeout((signal) =>
      fetch(`${ANTHROPIC_BATCHES_URL}/${batchId}`, {
        method: "GET",
        headers: { "x-api-key": apiKey, "anthropic-version": ANTHROPIC_VERSION },
        signal,
      }),
    );

    if (res.status === 401 || res.status === 403) {
      return { ok: false, kind: "FATAL", message: `Anthropic API認証エラー(${res.status})` };
    }
    if (res.status === 429 || res.status >= 500) {
      return { ok: false, kind: "TRANSIENT", message: `Anthropic Batch API一時エラー(${res.status})` };
    }
    if (!res.ok) {
      const bodyText = await res.text().catch(() => "");
      return { ok: false, kind: "FATAL", message: `Anthropic Batch APIエラー(${res.status}): ${bodyText.slice(0, 500)}` };
    }

    const body = (await res.json()) as { processing_status?: string; results_url?: string | null };
    const processingStatus = (body.processing_status ?? "in_progress") as AnthropicBatchProcessingStatus;
    return { ok: true, processingStatus, resultsUrl: body.results_url ?? null };
  } catch (err) {
    const isAbort = err instanceof Error && err.name === "AbortError";
    return {
      ok: false,
      kind: "TRANSIENT",
      message: isAbort ? "Anthropic Batch APIへのリクエストがタイムアウトしました" : `ネットワークエラー: ${String(err)}`,
    };
  }
}

/** バッチ結果(JSONL、1行のみ想定)を取得する。 */
export async function fetchAnthropicBatchResult(apiKey: string, resultsUrl: string): Promise<AnthropicBatchResultFetchResult> {
  try {
    const res = await withTimeout((signal) =>
      fetch(resultsUrl, {
        method: "GET",
        headers: { "x-api-key": apiKey, "anthropic-version": ANTHROPIC_VERSION },
        signal,
      }),
    );

    if (!res.ok) {
      const bodyText = await res.text().catch(() => "");
      return { ok: false, kind: res.status >= 500 ? "TRANSIENT" : "FATAL", message: `結果取得エラー(${res.status}): ${bodyText.slice(0, 500)}` };
    }

    const text = await res.text();
    const firstLine = text.split("\n").find((l) => l.trim().length > 0);
    if (!firstLine) {
      return { ok: false, kind: "FATAL", message: "Batch結果が空でした" };
    }
    const line = JSON.parse(firstLine) as AnthropicBatchResultLine;
    return { ok: true, line };
  } catch (err) {
    return { ok: false, kind: "TRANSIENT", message: `結果取得中の例外: ${String(err)}` };
  }
}
