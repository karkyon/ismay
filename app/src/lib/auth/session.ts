import { db } from "@/lib/db";
import {
  generateRefreshToken,
  hashRefreshToken,
  generateTokenFamily,
  signAccessToken,
  REFRESH_TOKEN_TTL_MS,
} from "@/lib/auth/tokens";

export interface DeviceContext {
  userAgent?: string | null;
  ipAddress?: string | null;
  deviceLabel?: string | null;
}

export interface IssuedTokens {
  accessToken: string;
  refreshToken: string;
  sessionId: string;
  expiresAt: Date;
}

/** ログイン成功時: 新規セッション(端末)を作成し、Access/Refresh Tokenペアを発行する。 */
export async function createSession(
  userId: string,
  email: string,
  ctx: DeviceContext,
): Promise<IssuedTokens> {
  const refreshToken = generateRefreshToken();
  const family = generateTokenFamily();
  const expiresAt = new Date(Date.now() + REFRESH_TOKEN_TTL_MS);

  const session = await db.userSession.create({
    data: {
      userId,
      deviceLabel: ctx.deviceLabel ?? null,
      userAgent: ctx.userAgent ?? null,
      ipAddress: ctx.ipAddress ?? null,
      refreshTokenHash: hashRefreshToken(refreshToken),
      refreshTokenFamily: family,
      expiresAt,
    },
  });

  const accessToken = await signAccessToken({ sub: userId, sid: session.id, email });

  return { accessToken, refreshToken, sessionId: session.id, expiresAt };
}

export type RotateResult =
  | { ok: true; tokens: IssuedTokens }
  | { ok: false; reason: "NOT_FOUND" | "EXPIRED" | "REVOKED" | "REUSE_DETECTED" };

/**
 * Refresh Tokenのローテーション。
 * 同一Refresh Tokenの再送（盗難後の再利用）を検知した場合は、
 * 該当トークン系列(family)を丸ごと失効させ REUSE_DETECTED を返す。
 */
export async function rotateSession(
  presentedRefreshToken: string,
  ctx: DeviceContext,
): Promise<RotateResult> {
  const presentedHash = hashRefreshToken(presentedRefreshToken);
  const session = await db.userSession.findFirst({ where: { refreshTokenHash: presentedHash } });

  if (!session) {
    return { ok: false, reason: "NOT_FOUND" };
  }
  if (session.revokedAt) {
    // 失効済みトークンの再送 = 盗難の可能性。同系列を念のため全失効。
    await db.userSession.updateMany({
      where: { refreshTokenFamily: session.refreshTokenFamily, revokedAt: null },
      data: { revokedAt: new Date(), revokedReason: "REUSE_DETECTED" },
    });
    return { ok: false, reason: "REUSE_DETECTED" };
  }
  if (session.expiresAt.getTime() < Date.now()) {
    return { ok: false, reason: "EXPIRED" };
  }

  const user = await db.user.findUnique({ where: { id: session.userId } });
  if (!user || user.deletedAt) {
    return { ok: false, reason: "NOT_FOUND" };
  }

  const newRefreshToken = generateRefreshToken();
  const newExpiresAt = new Date(Date.now() + REFRESH_TOKEN_TTL_MS);

  await db.userSession.update({
    where: { id: session.id },
    data: {
      refreshTokenHash: hashRefreshToken(newRefreshToken),
      expiresAt: newExpiresAt,
      lastUsedAt: new Date(),
      userAgent: ctx.userAgent ?? session.userAgent,
      ipAddress: ctx.ipAddress ?? session.ipAddress,
    },
  });

  const accessToken = await signAccessToken({ sub: user.id, sid: session.id, email: user.email });

  return {
    ok: true,
    tokens: { accessToken, refreshToken: newRefreshToken, sessionId: session.id, expiresAt: newExpiresAt },
  };
}

export async function revokeSession(sessionId: string, reason = "LOGOUT"): Promise<void> {
  await db.userSession.update({
    where: { id: sessionId },
    data: { revokedAt: new Date(), revokedReason: reason },
  });
}

/** FR-AUTH-04: 全端末ログアウト。指定ユーザーの有効セッションを一括失効する。 */
export async function revokeAllSessions(userId: string, reason = "LOGOUT_ALL"): Promise<number> {
  const result = await db.userSession.updateMany({
    where: { userId, revokedAt: null },
    data: { revokedAt: new Date(), revokedReason: reason },
  });
  return result.count;
}

export async function listActiveSessions(userId: string) {
  return db.userSession.findMany({
    where: { userId, revokedAt: null },
    orderBy: { lastUsedAt: "desc" },
    select: {
      id: true,
      deviceLabel: true,
      userAgent: true,
      ipAddress: true,
      issuedAt: true,
      lastUsedAt: true,
      expiresAt: true,
    },
  });
}
