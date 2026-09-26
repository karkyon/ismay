import type { RateLimitPolicy } from "@/lib/security/rateLimitCore";

/**
 * [SECURITY-RATE-02B新設・2026-09-26] rate limit policy registry(値はこの1箇所で管理する)。
 * 契約: docs/decisions/DEC-SECURITY-RATE-02.md §5。値の承認は未決事項台帳 OPEN-AUTH-06。
 *
 * - 正本(全機能仕様一覧 SEC-RATE)には方式(Redis token bucket、device/IP signal、lockout監査)だけがあり、
 *   閾値の記載は無い。既存実装の値を引き継げるものは引き継ぎ、それ以外は「実装上の既定値」として
 *   Decision Recordに記録する(AUTH-EMAIL-01のOPEN-AUTH-05と同じ扱い)。
 * - IP次元のpolicyは、client IPが解決できた場合だけ判定する(不明なIPを共通のkeyへまとめない。
 *   まとめると、1人の攻撃者が全利用者を締め出せるため)。
 * - メール発行のDB上限(emailTokenCore.ts: 60秒間隔・1時間5回/user、1時間20件/IP)は削除せず、
 *   多層防御として維持する。
 */
export const RATE_LIMIT_POLICIES = {
  LOGIN_ACCOUNT: {
    id: "auth.login.account",
    version: 1,
    dimension: "account",
    capacity: 10,
    windowMs: 15 * 60 * 1000,
    onBackendFailure: "LOCAL_FALLBACK",
    onSuccess: "RESET",
    basis: "既存値の継承(旧login/route.ts: 同一emailで15分10回の失敗でロック、正しいパスワードで解除)",
  },
  LOGIN_IP: {
    id: "auth.login.ip",
    version: 1,
    dimension: "ip",
    capacity: 30,
    windowMs: 15 * 60 * 1000,
    onBackendFailure: "LOCAL_FALLBACK",
    onSuccess: "REFUND",
    basis: "実装上の既定値(同一IPから多数のアカウントを試すcredential stuffing対策。成功した試行は数えない)",
  },
  MFA_USER: {
    id: "auth.mfa.user",
    version: 1,
    dimension: "user",
    capacity: 5,
    windowMs: 15 * 60 * 1000,
    onBackendFailure: "LOCAL_FALLBACK",
    onSuccess: "RESET",
    basis: "実装上の既定値(6桁TOTP・復旧コードの総当たり対策。challenge tokenの再取得で回数が戻らないようuser単位)",
  },
  MFA_IP: {
    id: "auth.mfa.ip",
    version: 1,
    dimension: "ip",
    capacity: 30,
    windowMs: 15 * 60 * 1000,
    onBackendFailure: "LOCAL_FALLBACK",
    onSuccess: "REFUND",
    basis: "実装上の既定値(login.ipと同じ)",
  },
  EMAIL_RESEND_IP: {
    id: "auth.email_resend.ip",
    version: 1,
    dimension: "ip",
    capacity: 20,
    windowMs: 60 * 60 * 1000,
    onBackendFailure: "FAIL_CLOSED",
    onSuccess: "NONE",
    basis: "既存のIP上限値と同値(emailTokenCore.ts EMAIL_TOKEN_MAX_PER_IP_PER_WINDOW=1時間20件)。DB側は発行件数、こちらは要求件数を数える",
  },
  PASSWORD_FORGOT_IP: {
    id: "auth.password_forgot.ip",
    version: 1,
    dimension: "ip",
    capacity: 20,
    windowMs: 60 * 60 * 1000,
    onBackendFailure: "FAIL_CLOSED",
    onSuccess: "NONE",
    basis: "email_resend.ipと同じ",
  },
} as const satisfies Record<string, RateLimitPolicy>;

export type RateLimitPolicyName = keyof typeof RATE_LIMIT_POLICIES;

export const RATE_LIMIT_POLICY_LIST: readonly RateLimitPolicy[] = Object.values(RATE_LIMIT_POLICIES);
