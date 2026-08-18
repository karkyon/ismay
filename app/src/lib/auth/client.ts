"use client";

import { debugLog } from "@/lib/debug";

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

/** state変更系リクエスト用。Cookie(ismay_csrf)からトークンを読み取りヘッダへ付与する。 */
export async function apiFetch(input: string, init: RequestInit = {}) {
  const csrf = readCookie("ismay_csrf");
  const headers = new Headers(init.headers);
  headers.set("Content-Type", "application/json");
  if (csrf) headers.set("X-CSRF-Token", csrf);
  const method = init.method ?? "GET";
  const startedAt = performance.now();
  const res = await fetch(input, { ...init, headers, credentials: "same-origin" });
  await logResponse("apiFetch", method, input, res, startedAt);
  return res;
}

/** 認証確認・一覧取得等のGET系リクエスト用。apiFetchと同じログ書式で出力する。 */
export async function debugFetch(input: string, init?: RequestInit) {
  const method = init?.method ?? "GET";
  const startedAt = performance.now();
  const res = await fetch(input, init);
  await logResponse("fetch", method, input, res, startedAt);
  return res;
}
