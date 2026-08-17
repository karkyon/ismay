import type { NextRequest } from "next/server";
import { verifyAccessToken, type VerifiedAccessToken } from "@/lib/auth/tokens";
import { getAccessTokenCookieName, getCsrfCookieName, verifyCsrf } from "@/lib/auth/cookies";

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

export function clientIp(req: NextRequest): string | null {
  const forwarded = req.headers.get("x-forwarded-for");
  if (forwarded) return forwarded.split(",")[0]?.trim() ?? null;
  return req.headers.get("x-real-ip");
}
