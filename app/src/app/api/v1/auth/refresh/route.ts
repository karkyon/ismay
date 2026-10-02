import type { NextRequest } from "next/server";
import { rotateSession } from "@/lib/auth/session";
import { setAuthCookies, clearAuthCookies, getRefreshTokenCookieName } from "@/lib/auth/cookies";
import { apiOk, apiError } from "@/lib/auth/response";
import { clientIp } from "@/lib/auth/guard";
import { refreshFailureResponse } from "@/lib/auth/refreshRotation";

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
    // [AUTH-REFRESH-07] SUPERSEDED(同じtokenで別の要求が先に回転した)はcookieを消さない。
    // 先に成功した要求が新しいcookieを設定済みのため、ここで消すと正常なsessionを壊す(clientは再試行する)。
    const r = refreshFailureResponse(result.reason);
    if (!r.clearCookies) {
      return apiError(r.code, "別の要求で既に更新されました。再試行してください", { retryable: true });
    }
    const res = apiError(r.code, "セッションが無効です。再度ログインしてください");
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
