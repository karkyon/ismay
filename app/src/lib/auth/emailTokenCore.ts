import { randomBytes, createHash } from "node:crypto";

/**
 * [AUTH-EMAIL-01新設・2026-09-26] メールアドレス確認・パスワード再設定tokenの規則(pure)。
 *
 * 出典: 全機能仕様一覧 AUTH-RESET「検証済mailのみ利用し安全にpassword再発行。token、期限、
 * rate limit、mail provider、監査」。
 * 利用者決定(2026-09-26):
 *   - 確認リンクは24時間・1回限り
 *   - 再送は60秒間隔、かつ1時間5回まで
 *   - 新しいリンクを発行すると旧リンクは無効
 *   - メール未確認のユーザーはログイン不可
 *   - パスワード再設定も同じGateで実装
 * 実装上の既定値(利用者の個別指定なし、docs/spec-addenda/ADD-2026-09-26-AUTH-EMAIL.mdに記録):
 *   - パスワード再設定リンクは60分(再設定リンクは確認リンクより被害が大きいため短くする)
 *   - IP単位の発行上限は1時間20件(存在しないアドレス宛ての要求は件数に含めない)
 *   - 1ユーザー・1用途あたりのtoken行は、発行時に7日より古いものを削除する
 */

export const EMAIL_TOKEN_PURPOSES = ["EMAIL_VERIFICATION", "PASSWORD_RESET"] as const;
export type EmailTokenPurpose = (typeof EMAIL_TOKEN_PURPOSES)[number];

export const EMAIL_TOKEN_POLICY: Record<EmailTokenPurpose, { ttlMs: number; path: string; auditAction: string }> = {
  EMAIL_VERIFICATION: { ttlMs: 24 * 60 * 60 * 1000, path: "/verify-email", auditAction: "EMAIL_VERIFICATION_SENT" },
  PASSWORD_RESET: { ttlMs: 60 * 60 * 1000, path: "/reset-password", auditAction: "PASSWORD_RESET_REQUESTED" },
};

export const EMAIL_TOKEN_RESEND_INTERVAL_MS = 60 * 1000;
export const EMAIL_TOKEN_RATE_WINDOW_MS = 60 * 60 * 1000;
export const EMAIL_TOKEN_MAX_PER_WINDOW = 5;
export const EMAIL_TOKEN_MAX_PER_IP_PER_WINDOW = 20;
export const EMAIL_TOKEN_ROW_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;

/** tokenは32byteの乱数(base64urlで43文字)。 */
export const EMAIL_TOKEN_BYTES = 32;
export const EMAIL_TOKEN_MIN_LENGTH = 40;
export const EMAIL_TOKEN_MAX_LENGTH = 128;

export function isEmailTokenPurpose(value: string): value is EmailTokenPurpose {
  return (EMAIL_TOKEN_PURPOSES as readonly string[]).includes(value);
}

export function generateEmailToken(): string {
  return randomBytes(EMAIL_TOKEN_BYTES).toString("base64url");
}

export function hashEmailToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

/** 入力tokenの形式検査。形式外の値はDB照会せずに無効として扱う。 */
export function isWellFormedEmailToken(token: string): boolean {
  return (
    token.length >= EMAIL_TOKEN_MIN_LENGTH &&
    token.length <= EMAIL_TOKEN_MAX_LENGTH &&
    /^[A-Za-z0-9_-]+$/.test(token)
  );
}

export type IssueAllowance =
  | { allowed: true }
  | { allowed: false; reason: "INTERVAL" | "WINDOW_LIMIT" | "IP_LIMIT"; retryAfterMs: number };

/**
 * 発行可否の判定。
 * @param recentUserIssues 同一user・同一purposeで直近WINDOW内に発行したtokenのcreatedAt
 * @param recentIpIssues   同一IPから直近WINDOW内に発行したtokenのcreatedAt(IP不明時はnull)
 */
export function decideIssueAllowance(input: {
  now: Date;
  recentUserIssues: Date[];
  recentIpIssues: Date[] | null;
}): IssueAllowance {
  const nowMs = input.now.getTime();
  const windowStart = nowMs - EMAIL_TOKEN_RATE_WINDOW_MS;
  const userIssues = input.recentUserIssues
    .map((d) => d.getTime())
    .filter((t) => t > windowStart)
    .sort((a, b) => a - b);

  const latest = userIssues[userIssues.length - 1];
  if (latest !== undefined && nowMs - latest < EMAIL_TOKEN_RESEND_INTERVAL_MS) {
    return { allowed: false, reason: "INTERVAL", retryAfterMs: EMAIL_TOKEN_RESEND_INTERVAL_MS - (nowMs - latest) };
  }
  if (userIssues.length >= EMAIL_TOKEN_MAX_PER_WINDOW) {
    const oldestInWindow = userIssues[userIssues.length - EMAIL_TOKEN_MAX_PER_WINDOW]!;
    return { allowed: false, reason: "WINDOW_LIMIT", retryAfterMs: oldestInWindow + EMAIL_TOKEN_RATE_WINDOW_MS - nowMs };
  }
  if (input.recentIpIssues !== null) {
    const ipIssues = input.recentIpIssues
      .map((d) => d.getTime())
      .filter((t) => t > windowStart)
      .sort((a, b) => a - b);
    if (ipIssues.length >= EMAIL_TOKEN_MAX_PER_IP_PER_WINDOW) {
      const oldestInWindow = ipIssues[ipIssues.length - EMAIL_TOKEN_MAX_PER_IP_PER_WINDOW]!;
      return { allowed: false, reason: "IP_LIMIT", retryAfterMs: oldestInWindow + EMAIL_TOKEN_RATE_WINDOW_MS - nowMs };
    }
  }
  return { allowed: true };
}

export type EmailTokenState = "USABLE" | "USED" | "SUPERSEDED" | "EXPIRED";

/** 消費可否。期限はちょうどexpiresAtの時点で失効(expiresAt > now のときだけ有効)。 */
export function classifyEmailTokenState(
  row: { consumedAt: Date | null; supersededAt: Date | null; expiresAt: Date },
  now: Date,
): EmailTokenState {
  if (row.consumedAt) return "USED";
  if (row.supersededAt) return "SUPERSEDED";
  if (row.expiresAt.getTime() <= now.getTime()) return "EXPIRED";
  return "USABLE";
}

export function buildEmailTokenLink(baseUrl: string, purpose: EmailTokenPurpose, token: string): string {
  return `${baseUrl.replace(/\/+$/, "")}${EMAIL_TOKEN_POLICY[purpose].path}?token=${encodeURIComponent(token)}`;
}

export function describeTtl(ttlMs: number): string {
  const minutes = Math.round(ttlMs / 60000);
  if (minutes % 60 === 0) return `${minutes / 60}時間`;
  return `${minutes}分`;
}

export interface EmailTokenMessage {
  to: string;
  subject: string;
  text: string;
}

export function buildEmailTokenMessage(params: {
  purpose: EmailTokenPurpose;
  to: string;
  link: string;
  displayName: string | null;
}): EmailTokenMessage {
  const ttl = describeTtl(EMAIL_TOKEN_POLICY[params.purpose].ttlMs);
  const greeting = params.displayName ? `${params.displayName} 様` : "ISMAYをご利用の皆様";
  if (params.purpose === "EMAIL_VERIFICATION") {
    return {
      to: params.to,
      subject: "[ISMAY] メールアドレスの確認",
      text: [
        greeting,
        "",
        "ISMAYへのご登録ありがとうございます。",
        "次のリンクを開き、「メールアドレスを確認する」を押して登録を完了してください。",
        "",
        params.link,
        "",
        `このリンクの有効期限は${ttl}で、1回だけ使用できます。`,
        "新しい確認メールを再送した場合、以前のリンクは使えなくなります。",
        "",
        "このメールに心当たりがない場合は、何もせずに破棄してください。",
      ].join("\n"),
    };
  }
  return {
    to: params.to,
    subject: "[ISMAY] パスワードの再設定",
    text: [
      greeting,
      "",
      "パスワード再設定の要求を受け付けました。",
      "次のリンクを開き、新しいパスワードを設定してください。",
      "",
      params.link,
      "",
      `このリンクの有効期限は${ttl}で、1回だけ使用できます。`,
      "再設定が完了すると、すべての端末からログアウトされます。",
      "",
      "パスワード再設定を要求していない場合は、このメールを破棄してください。パスワードは変更されません。",
    ].join("\n"),
  };
}
