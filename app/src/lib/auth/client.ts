"use client";

import { debugLog } from "@/lib/debug";

/** Access Token失効(未回復)を検知した際に発火するグローバルイベント名。
 * AppShellがこれを購読して/loginへ遷移する(FOCUS_CAPTURE_EVENTと同じDOM CustomEventによる疎結合パターン)。 */
export const AUTH_EXPIRED_EVENT = "ismay:auth-expired";

function readCookie(name: string): string | null {
  const match = document.cookie.match(new RegExp("(?:^|; )" + name + "=([^;]*)"));
  return match ? decodeURIComponent(match[1]) : null;
}

async function logResponse(scope: string, method: string, url: string, res: Response, startedAt: number) {
  const elapsed = Math.round(performance.now() - startedAt);
  let body: unknown;
  try {
    body = await res.clone().json();
  } catch {
    body = undefined;
  }
  debugLog.api(scope, method, url, res.status, body, elapsed);
}

// Access Token(15分)失効時、同時に複数リクエストが401を受けても
// Refresh Token(ローテーション式)を1回しか消費しないよう、進行中のリフレッシュ処理を共有する。
let refreshInFlight: Promise<boolean> | null = null;

async function refreshAccessToken(): Promise<boolean> {
  if (!refreshInFlight) {
    refreshInFlight = (async () => {
      try {
        const res = await fetch("/api/v1/auth/refresh", { method: "POST", credentials: "same-origin" });
        debugLog.event("auth", res.ok ? "silent refresh succeeded" : "silent refresh failed", {
          status: res.status,
        });
        return res.ok;
      } catch (err) {
        debugLog.error("auth", "silent refresh threw", err);
        return false;
      }
    })();
  }
  try {
    return await refreshInFlight;
  } finally {
    refreshInFlight = null;
  }
}

/**
 * Access Tokenの15分失効に対する共通ハンドラ。
 * 401を受けたら一度だけRefresh Tokenでの再取得(/api/v1/auth/refresh)を試み、
 * 成功すれば元のリクエストを1回だけ再送する(doFetchはCSRFトークン等をその都度
 * Cookieから再読込するクロージャであること＝リフレッシュでCSRFトークンも
 * ローテーションされるため、古い値を使い回すと403 ACCESS_DENIEDになる)。
 * 再送後もなお401ならRefresh Token自体が無効と判断し、AUTH_EXPIRED_EVENTを
 * 発火してAppShell側の/loginリダイレクトに委ねる。
 * (/api/v1/auth/refresh自体はここではなくrefreshAccessToken内で直接fetchするため、
 *  無限ループにはならない)
 */
async function withAuthRetry(doFetch: () => Promise<Response>): Promise<Response> {
  let res = await doFetch();
  if (res.status !== 401) {
    return res;
  }

  const refreshed = await refreshAccessToken();
  if (refreshed) {
    res = await doFetch();
  }

  if (res.status === 401 && typeof window !== "undefined") {
    debugLog.event("auth", "still 401 after refresh attempt, dispatching AUTH_EXPIRED_EVENT");
    window.dispatchEvent(new CustomEvent(AUTH_EXPIRED_EVENT));
  }

  return res;
}

/** state変更系リクエスト用。Cookie(ismay_csrf)からトークンを読み取りヘッダへ付与する。 */
export async function apiFetch(input: string, init: RequestInit = {}) {
  const method = init.method ?? "GET";
  const doFetch = async () => {
    const csrf = readCookie("ismay_csrf");
    const headers = new Headers(init.headers);
    headers.set("Content-Type", "application/json");
    if (csrf) headers.set("X-CSRF-Token", csrf);
    const startedAt = performance.now();
    const res = await fetch(input, { ...init, headers, credentials: "same-origin" });
    await logResponse("apiFetch", method, input, res, startedAt);
    return res;
  };
  return withAuthRetry(doFetch);
}

/** 認証確認・一覧取得等のGET系リクエスト用。apiFetchと同じログ書式で出力する。 */
export async function debugFetch(input: string, init?: RequestInit) {
  const method = init?.method ?? "GET";
  const doFetch = async () => {
    const startedAt = performance.now();
    const res = await fetch(input, { ...init, credentials: "same-origin" });
    await logResponse("fetch", method, input, res, startedAt);
    return res;
  };
  return withAuthRetry(doFetch);
}
