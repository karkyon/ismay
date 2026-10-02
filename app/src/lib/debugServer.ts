/**
 * サーバー側(API Route Handler、Worker)用の構造化デバッグログ。
 * src/lib/debug.tsはブラウザ向け("use client")のため、Route Handler/Workerから
 * importするとサーバーコンポーネント境界の警告や誤動作の原因になり得る。
 * 本モジュールはNode.jsプロセス(ismay-app.service標準出力)向けに同じ書式で出力する。
 *
 * カルキョンさんの指示(2026-08-20): 「APIのレス・入力値・イベント発生状態変化を
 * すべてConsole.logに出力してデバッグできるようにする」に対応。
 * 監査の結果、client.tsx側(debugFetch)のみ実装済みで、Route Handler内部
 * (入力値・EventLog発行・Outbox発行・状態遷移)には一切ログが無かったため新設した。
 */

import { createHash } from "node:crypto";

const ENABLED = process.env.NODE_ENV !== "production";

function timestamp(): string {
  return new Date().toISOString().split("T")[1]?.replace("Z", "") ?? "";
}

function safeLog(...args: unknown[]): void {
  try {
    console.log(...redactLogArgs(args));
  } catch {
    /* ログ出力自体が失敗しても本処理を止めない */
  }
}

// 「code」はMFA(TOTP)検証等で6桁確認コードのフィールド名として使われるため、
// \bcode\b(単語境界)で明示的に対象化する(camelCase複合語のstatusCode等は誤爆させない)。
const SENSITIVE_KEY_PATTERN = /password|secret|totp|otp|token|authorization|cookie|apikey|\bcode\b/i;

/**
 * [SECURITY-RATE-02D] 利用者のemailをjournalへ残さない。開発モードのdebug出力(request body・API応答)が
 * emailをそのまま出していた(SECURITY-RATE-02Cの受入中に175件、OPEN-OPS-03)。
 * 同じアドレスを追跡できるよう、小文字化したアドレスのSHA-256先頭10文字に置き換える(元へは戻せない)。
 */
const EMAIL_IN_TEXT_PATTERN = /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}/g;
const MAX_REDACT_DEPTH = 8;

export function maskEmailsInText(text: string): string {
  return text.replace(EMAIL_IN_TEXT_PATTERN, (m) => `<email:${createHash("sha256").update(m.toLowerCase(), "utf8").digest("hex").slice(0, 10)}>`);
}

/**
 * パスワード・TOTPシークレット・トークン等をログから除外し、文字列中のemailを仮名化する再帰マスク。
 * debugServerの全出力(入力値・API応答・イベント・状態・エラー)はこれを通してから出力する。
 * 深さ上限を超えた入れ子は出力しない(マスクを経ない値を出さないため)。
 */
export function redactSensitive(value: unknown, depth = 0): unknown {
  if (typeof value === "string") return maskEmailsInText(value);
  if (value === null || typeof value !== "object") return value;
  if (depth > MAX_REDACT_DEPTH) return "[depth limit]";
  if (value instanceof Error) {
    const message = maskEmailsInText(value.message);
    const stack = value.stack ? maskEmailsInText(value.stack) : undefined;
    return { name: value.name, message, ...(stack ? { stack } : {}) };
  }
  if (value instanceof Date) return value;
  if (ArrayBuffer.isView(value)) return `[binary ${(value as ArrayBufferView).byteLength} bytes]`;
  if (Array.isArray(value)) {
    return value.map((v) => redactSensitive(v, depth + 1));
  }
  if (value instanceof Map || value instanceof Set) return `[${value.constructor.name} size=${value.size}]`;
  const out: Record<string, unknown> = {};
  for (const [key, val] of Object.entries(value as Record<string, unknown>)) {
    out[key] = SENSITIVE_KEY_PATTERN.test(key) ? "***REDACTED***" : redactSensitive(val, depth + 1);
  }
  return out;
}

/** debugServerの出力引数を一括でマスクする。 */
export function redactLogArgs(args: unknown[]): unknown[] {
  return args.map((a) => redactSensitive(a));
}

export const debugServer = {
  /** APIの最終応答(status、要約body)。apiOk/apiErrorから一元的に呼ばれる。 */
  api(scope: string, method: string, url: string, status: number, body?: unknown, ms?: number) {
    if (!ENABLED) return;
    const tag = status === 0 || status >= 400 ? "\u{1F534} API" : "\u{1F7E2} API";
    safeLog(`[${timestamp()}] ${tag} ${method} ${url} \u2192 ${status}${ms !== undefined ? ` (${ms}ms)` : ""}`, {
      scope,
      body,
    });
  },
  /** ドメインイベント発生(EventLog/Outbox発行、Worker処理等)。 */
  event(scope: string, name: string, detail?: unknown) {
    if (!ENABLED) return;
    safeLog(`[${timestamp()}] \u{1F7E9} EVENT ${scope} \u203a ${name}`, detail ?? "");
  },
  /** 状態変化(Responsibility.status、Capture.processingStatus等)。 */
  state(scope: string, name: string, value: unknown) {
    if (!ENABLED) return;
    safeLog(`[${timestamp()}] \u{1F7EA} STATE ${scope} \u203a ${name} =`, value);
  },
  /** リクエスト入力値(検証前後どちらでも可)。 */
  input(scope: string, field: string, value: unknown) {
    if (!ENABLED) return;
    safeLog(`[${timestamp()}] \u{1F7E7} INPUT ${scope} \u203a ${field} =`, value);
  },
  /** エラーはENABLED判定に関わらず常に出す。 */
  error(scope: string, name: string, error: unknown) {
    try {
      console.error(...redactLogArgs([`[${timestamp()}] \u{1F534} ERROR ${scope} \u203a ${name}`, error]));
    } catch {
      /* ignore */
    }
  },
};

safeLog(
  `[${timestamp()}] \u{1F41B} ISMAY server debug logging ACTIVE (NODE_ENV=${process.env.NODE_ENV ?? "undefined"})`,
);
