import type { NextRequest } from "next/server";
import { rotateSession } from "@/lib/auth/session";
import { setAuthCookies, clearAuthCookies, getRefreshTokenCookieName } from "@/lib/auth/cookies";
import { apiOk, apiError } from "@/lib/auth/response";
import { clientIp } from "@/lib/auth/guard";

export async function POST(req: NextRequest) {
  const refreshToken = req.cookies.get(getRefreshTokenCookieName())?.value;
  if (!refreshToken) {
    return apiError("AUTH_REQUIRED", "ログインが必要です");
  }

  const result = await rotateSession(refreshToken, {
    userAgent: req.headers.get("user-agent"),
    ipAddress: clientIp(req),
  });

  if (!result.ok) {
    const res = apiError("AUTH_REQUIRED", "セッションが無効です。再度ログインしてください");
    clearAuthCookies(res);
    return res;
  }

  const res = apiOk({ refreshed: true });
  setAuthCookies(res, {
    accessToken: result.tokens.accessToken,
    refreshToken: result.tokens.refreshToken,
    refreshExpiresAt: result.tokens.expiresAt,
  });
  return res;
}
