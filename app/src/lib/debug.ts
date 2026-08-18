"use client";

const ENABLED = process.env.NODE_ENV !== "production";

function timestamp(): string {
  return new Date().toISOString().split("T")[1]?.replace("Z", "") ?? "";
}

/**
 * 開発用の構造化コンソールログ。API応答・入力値・イベント発生・状態変化を
 * 一貫した書式で出力する。process.env.NODE_ENV==='production'では自動的に無効化される。
 */
export const debugLog = {
  api(scope: string, method: string, url: string, status: number, body?: unknown, ms?: number) {
    if (!ENABLED) return;
    const color = status === 0 || status >= 400 ? "#C2410C" : "#15803D";
    console.groupCollapsed(
      `%c${timestamp()} %cAPI %c${method} ${url} → ${status}${ms !== undefined ? ` (${ms}ms)` : ""}`,
      "color:#9CA3AF;font-weight:400",
      `color:${color};font-weight:700`,
      "color:#14181F;font-weight:400",
    );
    console.log("scope:", scope);
    if (body !== undefined) console.log("body:", body);
    console.groupEnd();
  },
  event(scope: string, name: string, detail?: unknown) {
    if (!ENABLED) return;
    console.log(
      `%c${timestamp()} %cEVENT %c${scope} › ${name}`,
      "color:#9CA3AF;font-weight:400",
      "color:#2F5D62;font-weight:700",
      "color:#14181F;font-weight:400",
      detail ?? "",
    );
  },
  state(scope: string, name: string, value: unknown) {
    if (!ENABLED) return;
    console.log(
      `%c${timestamp()} %cSTATE %c${scope} › ${name} =`,
      "color:#9CA3AF;font-weight:400",
      "color:#6D28D9;font-weight:700",
      "color:#14181F;font-weight:400",
      value,
    );
  },
  input(scope: string, field: string, value: unknown) {
    if (!ENABLED) return;
    console.log(
      `%c${timestamp()} %cINPUT %c${scope} › ${field} =`,
      "color:#9CA3AF;font-weight:400",
      "color:#B45309;font-weight:700",
      "color:#14181F;font-weight:400",
      value,
    );
  },
  error(scope: string, name: string, error: unknown) {
    console.error(`[${timestamp()}] ${scope} › ${name} ERROR`, error);
  },
};
