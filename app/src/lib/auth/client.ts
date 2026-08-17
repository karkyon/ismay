"use client";

function readCookie(name: string): string | null {
  const match = document.cookie.match(new RegExp("(?:^|; )" + name + "=([^;]*)"));
  return match ? decodeURIComponent(match[1]) : null;
}

/** state変更系リクエスト用。Cookie(ismay_csrf)からトークンを読み取りヘッダへ付与する。 */
export async function apiFetch(input: string, init: RequestInit = {}) {
  const csrf = readCookie("ismay_csrf");
  const headers = new Headers(init.headers);
  headers.set("Content-Type", "application/json");
  if (csrf) headers.set("X-CSRF-Token", csrf);
  return fetch(input, { ...init, headers, credentials: "same-origin" });
}
