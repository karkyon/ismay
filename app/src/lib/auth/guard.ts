import type { NextRequest } from "next/server";
import { verifyAccessToken, type VerifiedAccessToken } from "@/lib/auth/tokens";
import { getAccessTokenCookieName, getCsrfCookieName, verifyCsrf } from "@/lib/auth/cookies";
import { resolveRequestClientIpText } from "@/lib/security/clientIp";

export type AuthResult =
  | { authenticated: true; user: VerifiedAccessToken }
  | { authenticated: false; reason: "NO_TOKEN" | "INVALID_TOKEN" };

/** Cookie中のAccess Tokenを検証する。保護APIの先頭で呼び出す。 */
export async function requireAuth(req: NextRequest): Promise<AuthResult> {
  const token = req.cookies.get(getAccessTokenCookieName())?.value;
  if (!token) {
    return { authenticated: false, reason: "NO_TOKEN" };
  }
  const verified = await verifyAccessToken(token);
  if (!verified) {
    return { authenticated: false, reason: "INVALID_TOKEN" };
  }
  return { authenticated: true, user: verified };
}

/** POST/PATCH/DELETE等の状態変更系エンドポイントで呼び出すCSRFガード。 */
export function requireCsrf(req: NextRequest): boolean {
  const cookieValue = req.cookies.get(getCsrfCookieName())?.value;
  const headerValue = req.headers.get("x-csrf-token");
  return verifyCsrf(cookieValue, headerValue);
}

/**
 * client IP(正規化済み文字列)。不明ならnull。
 * [SECURITY-RATE-02B是正・2026-09-26] 旧実装は`X-Forwarded-For`の先頭要素・`X-Real-IP`
 * (攻撃者が自由に書ける値)を採用していた。解決規則は lib/security/clientIp.ts に一本化した
 * (信頼proxy未設定時はforwarded系headerを使わない)。
 */
export function clientIp(req: NextRequest): string | null {
  return resolveRequestClientIpText(req);
}
