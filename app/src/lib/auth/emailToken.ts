import { db } from "@/lib/db";
import { debugServer } from "@/lib/debugServer";
import { hashPassword, validatePasswordPolicy } from "@/lib/auth/password";
import { getMailer } from "@/lib/mail/mailer";
import {
  EMAIL_TOKEN_POLICY,
  EMAIL_TOKEN_RATE_WINDOW_MS,
  EMAIL_TOKEN_ROW_RETENTION_MS,
  buildEmailTokenLink,
  buildEmailTokenMessage,
  classifyEmailTokenState,
  decideIssueAllowance,
  generateEmailToken,
  hashEmailToken,
  isWellFormedEmailToken,
  type EmailTokenPurpose,
} from "@/lib/auth/emailTokenCore";

/**
 * [AUTH-EMAIL-01新設・2026-09-26] メールアドレス確認・パスワード再設定tokenの発行・送信・消費。
 * 規則(期限・再送間隔・上限)は emailTokenCore.ts を参照。
 *
 * 不変条件:
 *   - 発行・消費はusers行を`FOR UPDATE`で直列化する(同時再送で上限を超えない、二重消費しない)
 *   - tokenの平文はDB・監査ログ・debugログへ書かない(メール本文にのみ含まれる)
 *   - 新しいtokenを発行すると、同一user・同一purposeの未消費tokenはsupersededになる
 *   - 消費は「未消費・未supersede・期限内」の条件付きUPDATEが1件だった場合だけ成功する
 *   - 時刻はすべてアプリ側のDateで書き込み・比較する(DBのtimezone設定に依存しない)
 */

const LOCK_TIMEOUT_MS = 5000;

function isLockTimeoutError(err: unknown): boolean {
  const metaCode = (err as { meta?: { code?: unknown } } | null)?.meta?.code;
  if (metaCode === "55P03") return true;
  const text = err instanceof Error ? err.message : String(err);
  return /55P03|lock timeout/i.test(text);
}

function truncate(text: string, max = 300): string {
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

// ---------------------------------------------------------------------------
// 発行
// ---------------------------------------------------------------------------

export interface IssuedEmailToken {
  status: "ISSUED";
  purpose: EmailTokenPurpose;
  userId: string;
  email: string;
  displayName: string | null;
  /** 平文。メール本文の組み立てにのみ使い、保存・ログ出力しない */
  token: string;
  tokenId: string;
  expiresAt: Date;
}

export type IssueSkipReason =
  | "USER_NOT_FOUND"
  | "USER_NOT_ELIGIBLE"
  | "INTERVAL"
  | "WINDOW_LIMIT"
  | "IP_LIMIT"
  | "LOCK_CONFLICT";

export type IssueEmailTokenResult =
  | IssuedEmailToken
  | { status: "SKIPPED"; purpose: EmailTokenPurpose; reason: IssueSkipReason; retryAfterMs?: number };

/**
 * 用途ごとの発行対象:
 *   EMAIL_VERIFICATION … 未削除かつメール未確認のuser
 *   PASSWORD_RESET     … 未削除かつメール確認済みのuser(AUTH-RESET「検証済mailのみ利用」)
 */
function isEligible(purpose: EmailTokenPurpose, user: { deletedAt: Date | null; emailVerifiedAt: Date | null }): boolean {
  if (user.deletedAt) return false;
  return purpose === "EMAIL_VERIFICATION" ? user.emailVerifiedAt === null : user.emailVerifiedAt !== null;
}

export async function issueEmailToken(params: {
  purpose: EmailTokenPurpose;
  userId?: string;
  email?: string;
  requestIp: string | null;
  now?: Date;
}): Promise<IssueEmailTokenResult> {
  const { purpose } = params;
  let userId = params.userId ?? null;
  if (!userId) {
    const email = params.email?.trim().toLowerCase();
    if (!email) return { status: "SKIPPED", purpose, reason: "USER_NOT_FOUND" };
    const found = await db.user.findUnique({ where: { email }, select: { id: true } });
    if (!found) return { status: "SKIPPED", purpose, reason: "USER_NOT_FOUND" };
    userId = found.id;
  }
  const targetUserId = userId;
  const requestIp = params.requestIp && params.requestIp.length > 0 ? params.requestIp : null;

  try {
    return await db.$transaction(async (tx): Promise<IssueEmailTokenResult> => {
      await tx.$executeRawUnsafe(`SET LOCAL lock_timeout = '${LOCK_TIMEOUT_MS}ms'`);
      await tx.$queryRawUnsafe(`SELECT "id" FROM "users" WHERE "id" = $1 FOR UPDATE`, targetUserId);
      const now = params.now ?? new Date();

      const user = await tx.user.findUnique({
        where: { id: targetUserId },
        select: { id: true, email: true, displayName: true, deletedAt: true, emailVerifiedAt: true },
      });
      if (!user) return { status: "SKIPPED", purpose, reason: "USER_NOT_FOUND" };
      if (!isEligible(purpose, user)) return { status: "SKIPPED", purpose, reason: "USER_NOT_ELIGIBLE" };

      const windowStart = new Date(now.getTime() - EMAIL_TOKEN_RATE_WINDOW_MS);
      const recentUser = await tx.authEmailToken.findMany({
        where: { userId: user.id, purpose, createdAt: { gt: windowStart } },
        select: { createdAt: true },
      });
      const recentIp = requestIp
        ? await tx.authEmailToken.findMany({
            where: { requestIp, createdAt: { gt: windowStart } },
            select: { createdAt: true },
          })
        : null;
      const allowance = decideIssueAllowance({
        now,
        recentUserIssues: recentUser.map((r) => r.createdAt),
        recentIpIssues: recentIp ? recentIp.map((r) => r.createdAt) : null,
      });
      if (!allowance.allowed) {
        return { status: "SKIPPED", purpose, reason: allowance.reason, retryAfterMs: allowance.retryAfterMs };
      }

      await tx.authEmailToken.updateMany({
        where: { userId: user.id, purpose, consumedAt: null, supersededAt: null },
        data: { supersededAt: now },
      });
      await tx.authEmailToken.deleteMany({
        where: { userId: user.id, createdAt: { lt: new Date(now.getTime() - EMAIL_TOKEN_ROW_RETENTION_MS) } },
      });

      const token = generateEmailToken();
      const expiresAt = new Date(now.getTime() + EMAIL_TOKEN_POLICY[purpose].ttlMs);
      const row = await tx.authEmailToken.create({
        data: {
          userId: user.id,
          purpose,
          tokenHash: hashEmailToken(token),
          sentToEmail: user.email,
          requestIp,
          expiresAt,
          createdAt: now,
        },
        select: { id: true },
      });
      return {
        status: "ISSUED",
        purpose,
        userId: user.id,
        email: user.email,
        displayName: user.displayName,
        token,
        tokenId: row.id,
        expiresAt,
      };
    });
  } catch (err) {
    if (isLockTimeoutError(err)) return { status: "SKIPPED", purpose, reason: "LOCK_CONFLICT" };
    throw err;
  }
}

// ---------------------------------------------------------------------------
// 送信
// ---------------------------------------------------------------------------

export type DeliverResult = { sent: true; transport: string } | { sent: false; error: string };

/** 発行済みtokenをメールで送り、結果をaudit_logsへ記録する(SYSTEM actor)。例外は投げない。 */
export async function deliverEmailToken(issued: IssuedEmailToken, requestIp: string | null): Promise<DeliverResult> {
  const action = EMAIL_TOKEN_POLICY[issued.purpose].auditAction;
  let result: DeliverResult;
  const mailer = getMailer();
  if (!mailer.ok) {
    result = { sent: false, error: `MAIL_CONFIG_ERROR: ${mailer.error}` };
  } else {
    const link = buildEmailTokenLink(mailer.config.baseUrl, issued.purpose, issued.token);
    const message = buildEmailTokenMessage({
      purpose: issued.purpose,
      to: issued.email,
      link,
      displayName: issued.displayName,
    });
    try {
      await mailer.transport.send({ ...message, from: mailer.config.from });
      result = { sent: true, transport: mailer.transport.kind };
    } catch (err) {
      result = { sent: false, error: `SEND_FAILED: ${truncate(err instanceof Error ? err.message : String(err))}` };
    }
  }

  try {
    await db.auditLog.create({
      data: {
        actorUserId: null,
        actorType: "SYSTEM",
        action,
        targetType: "User",
        targetId: issued.userId,
        result: result.sent ? "SUCCESS" : "FAILURE",
        reason: result.sent ? `transport=${result.transport} tokenId=${issued.tokenId}` : `${result.error} tokenId=${issued.tokenId}`,
        ipAddress: requestIp,
      },
    });
  } catch (err) {
    debugServer.error("emailToken/deliver", "監査記録に失敗しました", err);
  }
  if (!result.sent) debugServer.error("emailToken/deliver", `${action} 送信失敗`, { userId: issued.userId, error: result.error });
  return result;
}

// ---------------------------------------------------------------------------
// 消費
// ---------------------------------------------------------------------------

export type ConsumeFailureReason =
  | "NOT_FOUND"
  | "USED"
  | "SUPERSEDED"
  | "EXPIRED"
  | "EMAIL_CHANGED"
  | "USER_INACTIVE"
  | "LOCK_CONFLICT";

async function recordConsumeFailure(params: {
  action: string;
  userId: string;
  reason: ConsumeFailureReason;
  tokenId: string;
  requestIp: string | null;
}): Promise<void> {
  try {
    await db.auditLog.create({
      data: {
        actorUserId: null,
        actorType: "SYSTEM",
        action: params.action,
        targetType: "User",
        targetId: params.userId,
        result: "FAILURE",
        reason: `${params.reason} tokenId=${params.tokenId}`,
        ipAddress: params.requestIp,
      },
    });
  } catch (err) {
    debugServer.error("emailToken/consume", "監査記録に失敗しました", err);
  }
}

export type VerifyEmailResult =
  | { ok: true; userId: string; alreadyVerified: boolean }
  | { ok: false; reason: ConsumeFailureReason };

export async function consumeEmailVerificationToken(params: {
  token: string;
  requestIp: string | null;
  now?: Date;
}): Promise<VerifyEmailResult> {
  if (!isWellFormedEmailToken(params.token)) return { ok: false, reason: "NOT_FOUND" };
  const tokenHash = hashEmailToken(params.token);
  const found = await db.authEmailToken.findUnique({ where: { tokenHash }, select: { id: true, userId: true, purpose: true } });
  if (!found || found.purpose !== "EMAIL_VERIFICATION") return { ok: false, reason: "NOT_FOUND" };

  let outcome: VerifyEmailResult;
  try {
    outcome = await db.$transaction(async (tx): Promise<VerifyEmailResult> => {
      await tx.$executeRawUnsafe(`SET LOCAL lock_timeout = '${LOCK_TIMEOUT_MS}ms'`);
      await tx.$queryRawUnsafe(`SELECT "id" FROM "users" WHERE "id" = $1 FOR UPDATE`, found.userId);
      const now = params.now ?? new Date();
      const row = await tx.authEmailToken.findUnique({ where: { id: found.id } });
      const user = await tx.user.findUnique({
        where: { id: found.userId },
        select: { id: true, email: true, deletedAt: true, emailVerifiedAt: true },
      });
      if (!row || !user) return { ok: false, reason: "NOT_FOUND" };
      const state = classifyEmailTokenState(row, now);
      if (state !== "USABLE") return { ok: false, reason: state };
      if (user.deletedAt) return { ok: false, reason: "USER_INACTIVE" };
      if (user.email !== row.sentToEmail) return { ok: false, reason: "EMAIL_CHANGED" };

      const consumed = await tx.authEmailToken.updateMany({
        where: { id: row.id, consumedAt: null, supersededAt: null, expiresAt: { gt: now } },
        data: { consumedAt: now },
      });
      if (consumed.count !== 1) return { ok: false, reason: "USED" };

      const alreadyVerified = user.emailVerifiedAt !== null;
      if (!alreadyVerified) {
        await tx.user.update({ where: { id: user.id }, data: { emailVerifiedAt: now } });
      }
      await tx.authEmailToken.updateMany({
        where: { userId: user.id, purpose: "EMAIL_VERIFICATION", consumedAt: null, supersededAt: null },
        data: { supersededAt: now },
      });
      await tx.auditLog.create({
        data: {
          actorUserId: user.id,
          actorType: "USER",
          action: "EMAIL_VERIFIED",
          targetType: "User",
          targetId: user.id,
          result: "SUCCESS",
          reason: `tokenId=${row.id}${alreadyVerified ? " alreadyVerified" : ""}`,
          ipAddress: params.requestIp,
        },
      });
      return { ok: true, userId: user.id, alreadyVerified };
    });
  } catch (err) {
    if (!isLockTimeoutError(err)) throw err;
    outcome = { ok: false, reason: "LOCK_CONFLICT" };
  }
  if (!outcome.ok && outcome.reason !== "NOT_FOUND") {
    await recordConsumeFailure({
      action: "EMAIL_VERIFIED",
      userId: found.userId,
      reason: outcome.reason,
      tokenId: found.id,
      requestIp: params.requestIp,
    });
  }
  return outcome;
}

export type ResetPasswordResult =
  | { ok: true; userId: string; revokedSessions: number }
  | { ok: false; reason: ConsumeFailureReason }
  | { ok: false; reason: "PASSWORD_POLICY"; message: string };

export async function consumePasswordResetToken(params: {
  token: string;
  newPassword: string;
  requestIp: string | null;
  now?: Date;
}): Promise<ResetPasswordResult> {
  const policy = validatePasswordPolicy(params.newPassword);
  if (!policy.valid) {
    return { ok: false, reason: "PASSWORD_POLICY", message: policy.reason ?? "パスワードが要件を満たしません" };
  }
  if (!isWellFormedEmailToken(params.token)) return { ok: false, reason: "NOT_FOUND" };
  const tokenHash = hashEmailToken(params.token);
  const found = await db.authEmailToken.findUnique({ where: { tokenHash } });
  if (!found || found.purpose !== "PASSWORD_RESET") return { ok: false, reason: "NOT_FOUND" };

  // Argon2idは重いため、明らかに使えないtokenではhashを計算しない(transaction内で必ず再判定する)。
  const preState = classifyEmailTokenState(found, params.now ?? new Date());
  let outcome: ResetPasswordResult;
  if (preState !== "USABLE") {
    outcome = { ok: false, reason: preState };
  } else {
    const newHash = await hashPassword(params.newPassword);
    try {
      outcome = await db.$transaction(async (tx): Promise<ResetPasswordResult> => {
        await tx.$executeRawUnsafe(`SET LOCAL lock_timeout = '${LOCK_TIMEOUT_MS}ms'`);
        await tx.$queryRawUnsafe(`SELECT "id" FROM "users" WHERE "id" = $1 FOR UPDATE`, found.userId);
        const now = params.now ?? new Date();
        const row = await tx.authEmailToken.findUnique({ where: { id: found.id } });
        const user = await tx.user.findUnique({
          where: { id: found.userId },
          select: { id: true, email: true, deletedAt: true, emailVerifiedAt: true },
        });
        if (!row || !user) return { ok: false, reason: "NOT_FOUND" };
        const state = classifyEmailTokenState(row, now);
        if (state !== "USABLE") return { ok: false, reason: state };
        if (user.deletedAt || user.emailVerifiedAt === null) return { ok: false, reason: "USER_INACTIVE" };
        if (user.email !== row.sentToEmail) return { ok: false, reason: "EMAIL_CHANGED" };

        const consumed = await tx.authEmailToken.updateMany({
          where: { id: row.id, consumedAt: null, supersededAt: null, expiresAt: { gt: now } },
          data: { consumedAt: now },
        });
        if (consumed.count !== 1) return { ok: false, reason: "USED" };

        await tx.user.update({ where: { id: user.id }, data: { passwordHash: newHash } });
        await tx.authEmailToken.updateMany({
          where: { userId: user.id, purpose: "PASSWORD_RESET", consumedAt: null, supersededAt: null },
          data: { supersededAt: now },
        });
        const revoked = await tx.userSession.updateMany({
          where: { userId: user.id, revokedAt: null },
          data: { revokedAt: now, revokedReason: "PASSWORD_RESET" },
        });
        await tx.auditLog.create({
          data: {
            actorUserId: user.id,
            actorType: "USER",
            action: "PASSWORD_RESET_COMPLETED",
            targetType: "User",
            targetId: user.id,
            result: "SUCCESS",
            reason: `tokenId=${row.id} revokedSessions=${revoked.count}`,
            ipAddress: params.requestIp,
          },
        });
        return { ok: true, userId: user.id, revokedSessions: revoked.count };
      });
    } catch (err) {
      if (!isLockTimeoutError(err)) throw err;
      outcome = { ok: false, reason: "LOCK_CONFLICT" };
    }
  }
  if (!outcome.ok && outcome.reason !== "NOT_FOUND" && outcome.reason !== "PASSWORD_POLICY") {
    await recordConsumeFailure({
      action: "PASSWORD_RESET_COMPLETED",
      userId: found.userId,
      reason: outcome.reason,
      tokenId: found.id,
      requestIp: params.requestIp,
    });
  }
  return outcome;
}
