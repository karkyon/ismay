import { REFRESH_TOKEN_TTL_MS } from "@/lib/auth/tokens";

/**
 * [AUTH-REFRESH-07新設・2026-10-02] Refresh Token回転・再利用検知の規則(pure)。OPEN-AUTH-07の是正。
 * 契約: docs/decisions/DEC-AUTH-REFRESH-07.md。
 *
 * - 回転で失効したtokenのhashを保持し(user_session_retired_refresh_tokens)、後から提示された場合:
 *     失効から猶予時間以内 … 同時要求(複数tab・再送)の競合とみなし、拒否するだけ(SUPERSEDED、session維持)
 *     猶予時間を過ぎた      … 盗難後の再利用とみなし、そのsession(token系列)を失効させる(REUSE_DETECTED)
 * - 同じtokenで同時に回転要求が来た場合、DB上の比較更新(現在のhashと一致する場合だけ更新)で1件だけ成功させ、
 *   残りはSUPERSEDEDとする(系列は失効させない)。
 * - 猶予時間は実装上の既定値(値の承認はOPEN-AUTH-07の残件)。
 */
export const REFRESH_REUSE_GRACE_MS = 10 * 1000;

export type RetiredTokenVerdict = "WITHIN_GRACE" | "REUSE";

export function classifyRetiredTokenPresentation(retiredAt: Date, now: Date, graceMs = REFRESH_REUSE_GRACE_MS): RetiredTokenVerdict {
  const elapsed = now.getTime() - retiredAt.getTime();
  // 時計の逆行(負の経過時間)は猶予内として扱う(誤って系列を失効させない)
  return elapsed <= graceMs ? "WITHIN_GRACE" : "REUSE";
}

/** この時刻より前に失効したhashは、Refresh Tokenの有効期間を過ぎており保持不要(回転時にsession単位で削除)。 */
export function retiredTokenPruneBefore(now: Date): Date {
  return new Date(now.getTime() - REFRESH_TOKEN_TTL_MS);
}

/** refresh APIの失敗理由→HTTP応答の扱い。SUPERSEDEDはcookieを消さない(先に成功した要求のcookieを壊さない)。 */
export function refreshFailureResponse(reason: "NOT_FOUND" | "EXPIRED" | "REVOKED" | "REUSE_DETECTED" | "SUPERSEDED"): {
  code: "AUTH_REQUIRED" | "VERSION_CONFLICT";
  clearCookies: boolean;
} {
  if (reason === "SUPERSEDED") return { code: "VERSION_CONFLICT", clearCookies: false };
  return { code: "AUTH_REQUIRED", clearCookies: true };
}
