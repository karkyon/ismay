"use client";

// process.env参照に何らかの理由で失敗してもログを消さない(fail-open)。
const ENABLED = (() => {
  try {
    return typeof process === "undefined" || typeof process.env === "undefined"
      ? true
      : process.env.NODE_ENV !== "production";
  } catch {
    return true;
  }
})();

function timestamp(): string {
  return new Date().toISOString().split("T")[1]?.replace("Z", "") ?? "";
}

function safeLog(...args: unknown[]): void {
  try {
    console.log(...args);
  } catch {
    /* ログ出力自体が失敗しても本処理を止めない */
  }
}

/**
 * 開発用の構造化コンソールログ。API応答・入力値・イベント発生・状態変化を
 * 一貫した書式で出力する。
 *
 * 2026-08-18改訂: 以前はconsole.groupCollapsed()で折り畳んでいたが、
 * 折り畳みヘッダーが見落とされる/観測できないという報告を受け、常に
 * 開いた1行ログ(絵文字タグ付き)に変更した。ENABLED判定はfail-openとし、
 * 判定に失敗した場合もログを出す側に倒す。
 */
export const debugLog = {
  api(scope: string, method: string, url: string, status: number, body?: unknown, ms?: number) {
    if (!ENABLED) return;
    const tag = status === 0 || status >= 400 ? "\u{1F534} API" : "\u{1F7E2} API";
    safeLog(
      `[${timestamp()}] ${tag} ${method} ${url} \u2192 ${status}${ms !== undefined ? ` (${ms}ms)` : ""}`,
      { scope, body },
    );
  },
  event(scope: string, name: string, detail?: unknown) {
    if (!ENABLED) return;
    safeLog(`[${timestamp()}] \u{1F7E9} EVENT ${scope} \u203a ${name}`, detail ?? "");
  },
  state(scope: string, name: string, value: unknown) {
    if (!ENABLED) return;
    safeLog(`[${timestamp()}] \u{1F7EA} STATE ${scope} \u203a ${name} =`, value);
  },
  input(scope: string, field: string, value: unknown) {
    if (!ENABLED) return;
    safeLog(`[${timestamp()}] \u{1F7E7} INPUT ${scope} \u203a ${field} =`, value);
  },
  error(scope: string, name: string, error: unknown) {
    // errorはENABLED判定に関わらず常に出す
    try {
      console.error(`[${timestamp()}] \u{1F534} ERROR ${scope} \u203a ${name}`, error);
    } catch {
      /* ignore */
    }
  },
};

// 起動確認用バナー。これが出ない場合はモジュール自体が読み込まれていない
// (import経路・ビルドの問題)ことを意味するため、切り分けに使う。
safeLog(
  "%c\u{1F41B} ISMAY debug logging ACTIVE \u2014 API/EVENT/STATE/INPUTログはこの書式で出力されます",
  "color:#2F5D62;font-weight:700;font-size:12px",
);
