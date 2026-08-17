import { NextResponse } from "next/server";
import { randomBytes } from "node:crypto";

// システム基本設計書v1.2 7章: 「WebはSecure、HttpOnly、SameSite Cookieを基本としCSRF対策を行う」に対応。
const ACCESS_COOKIE = "ismay_at";
const REFRESH_COOKIE = "ismay_rt";
const CSRF_COOKIE = "ismay_csrf";

const isProd = process.env.NODE_ENV === "production";

export function setAuthCookies(
  res: NextResponse,
  params: { accessToken: string; refreshToken: string; refreshExpiresAt: Date },
) {
  res.cookies.set(ACCESS_COOKIE, params.accessToken, {
    httpOnly: true,
    secure: isProd,
    sameSite: "lax",
    path: "/",
    maxAge: 15 * 60,
  });
  res.cookies.set(REFRESH_COOKIE, params.refreshToken, {
    httpOnly: true,
    secure: isProd,
    sameSite: "lax",
    // Refresh Tokenは認証系エンドポイントにのみ送出させ、露出範囲を最小化する
    path: "/api/v1/auth",
    expires: params.refreshExpiresAt,
  });
  const csrfToken = randomBytes(24).toString("base64url");
  res.cookies.set(CSRF_COOKIE, csrfToken, {
    httpOnly: false, // JS側でヘッダへ複写するため読み取り可能にする(Double Submit Cookie)
    secure: isProd,
    sameSite: "lax",
    path: "/",
    expires: params.refreshExpiresAt,
  });
}

export function clearAuthCookies(res: NextResponse) {
  res.cookies.set(ACCESS_COOKIE, "", { path: "/", maxAge: 0 });
  res.cookies.set(REFRESH_COOKIE, "", { path: "/api/v1/auth", maxAge: 0 });
  res.cookies.set(CSRF_COOKIE, "", { path: "/", maxAge: 0 });
}

export function getAccessTokenCookieName() {
  return ACCESS_COOKIE;
}
export function getRefreshTokenCookieName() {
  return REFRESH_COOKIE;
}
export function getCsrfCookieName() {
  return CSRF_COOKIE;
}

/** state変更系リクエストのCSRF検証（Double Submit Cookie方式）。 */
export function verifyCsrf(cookieValue: string | undefined, headerValue: string | null): boolean {
  if (!cookieValue || !headerValue) return false;
  return cookieValue === headerValue;
}
