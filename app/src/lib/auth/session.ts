import { db } from "@/lib/db";
import { debugServer } from "@/lib/debugServer";
import {
  generateRefreshToken,
  hashRefreshToken,
  generateTokenFamily,
  signAccessToken,
  REFRESH_TOKEN_TTL_MS,
} from "@/lib/auth/tokens";
import { classifyRetiredTokenPresentation, retiredTokenPruneBefore } from "@/lib/auth/refreshRotation";

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
  debugServer.event("session/createSession", "SESSION_CREATED", { sessionId: session.id, userId });

  return { accessToken, refreshToken, sessionId: session.id, expiresAt };
}

export type RotateFailureReason = "NOT_FOUND" | "EXPIRED" | "REVOKED" | "REUSE_DETECTED" | "SUPERSEDED";

export type RotateResult = { ok: true; tokens: IssuedTokens } | { ok: false; reason: RotateFailureReason };

type RotateOutcome =
  | { kind: "ROTATED"; sessionId: string; userId: string; email: string }
  | {
      kind: "REJECTED";
      reason: RotateFailureReason;
      reuse?: { userId: string; sessionId: string; family: string; source: "RETIRED_TOKEN" | "REVOKED_SESSION"; revokedCount: number };
    };

/**
 * Refresh Tokenのローテーション。
 * [AUTH-REFRESH-07是正・2026-10-02] 旧実装は同じsession行のhashを上書きするだけで、回転済みの旧tokenは
 * 「見つからない」として拒否されるだけだった(コメントの「再送を検知したら系列失効」と不一致、OPEN-AUTH-07)。
 *   - 回転で失効したhashをuser_session_retired_refresh_tokensへ保持する。
 *   - 旧tokenの再提示: 失効から猶予時間以内はSUPERSEDED(同時要求の競合。sessionは維持)、
 *     それを過ぎていれば盗難後の再利用とみなし系列(family)を失効させてREUSE_DETECTED(監査を記録)。
 *   - 同じtokenの同時回転は、現在のhashと一致する場合だけ更新する比較更新で1件だけ成功させ、残りはSUPERSEDED。
 *   - 失効済みsessionのtokenの再提示は従来どおり系列を失効させREUSE_DETECTED。
 * 規則: lib/auth/refreshRotation.ts、契約: docs/decisions/DEC-AUTH-REFRESH-07.md。
 */
export async function rotateSession(
  presentedRefreshToken: string,
  ctx: DeviceContext,
): Promise<RotateResult> {
  const presentedHash = hashRefreshToken(presentedRefreshToken);
  const newRefreshToken = generateRefreshToken();
  const newRefreshTokenHash = hashRefreshToken(newRefreshToken);
  const now = new Date();
  const newExpiresAt = new Date(now.getTime() + REFRESH_TOKEN_TTL_MS);

  const outcome = await db.$transaction(async (tx): Promise<RotateOutcome> => {
    const session = await tx.userSession.findFirst({ where: { refreshTokenHash: presentedHash } });
    if (session) {
      if (session.revokedAt) {
        // 失効済みトークンの再送 = 盗難の可能性。同系列を念のため全失効。
        const revoked = await tx.userSession.updateMany({
          where: { refreshTokenFamily: session.refreshTokenFamily, revokedAt: null },
          data: { revokedAt: now, revokedReason: "REUSE_DETECTED" },
        });
        return {
          kind: "REJECTED",
          reason: "REUSE_DETECTED",
          reuse: { userId: session.userId, sessionId: session.id, family: session.refreshTokenFamily, source: "REVOKED_SESSION", revokedCount: revoked.count },
        };
      }
      if (session.expiresAt.getTime() < now.getTime()) return { kind: "REJECTED", reason: "EXPIRED" };
      const user = await tx.user.findUnique({ where: { id: session.userId }, select: { id: true, email: true, deletedAt: true } });
      if (!user || user.deletedAt) return { kind: "REJECTED", reason: "NOT_FOUND" };

      // 比較更新: 現在のhashが提示hashのままの場合だけ回転する(同時要求は1件だけ成功する)
      const updated = await tx.userSession.updateMany({
        where: { id: session.id, refreshTokenHash: presentedHash, revokedAt: null },
        data: {
          refreshTokenHash: newRefreshTokenHash,
          expiresAt: newExpiresAt,
          lastUsedAt: now,
          userAgent: ctx.userAgent ?? session.userAgent,
          ipAddress: ctx.ipAddress ?? session.ipAddress,
        },
      });
      if (updated.count !== 1) return { kind: "REJECTED", reason: "SUPERSEDED" };
      await tx.userSessionRetiredRefreshToken.create({ data: { sessionId: session.id, tokenHash: presentedHash, retiredAt: now } });
      await tx.userSessionRetiredRefreshToken.deleteMany({ where: { sessionId: session.id, retiredAt: { lt: retiredTokenPruneBefore(now) } } });
      return { kind: "ROTATED", sessionId: session.id, userId: user.id, email: user.email };
    }

    const retired = await tx.userSessionRetiredRefreshToken.findUnique({
      where: { tokenHash: presentedHash },
      select: { retiredAt: true, session: { select: { id: true, userId: true, refreshTokenFamily: true } } },
    });
    if (!retired) return { kind: "REJECTED", reason: "NOT_FOUND" };
    if (classifyRetiredTokenPresentation(retired.retiredAt, now) === "WITHIN_GRACE") {
      return { kind: "REJECTED", reason: "SUPERSEDED" };
    }
    const revoked = await tx.userSession.updateMany({
      where: { refreshTokenFamily: retired.session.refreshTokenFamily, revokedAt: null },
      data: { revokedAt: now, revokedReason: "REUSE_DETECTED" },
    });
    return {
      kind: "REJECTED",
      reason: "REUSE_DETECTED",
      reuse: { userId: retired.session.userId, sessionId: retired.session.id, family: retired.session.refreshTokenFamily, source: "RETIRED_TOKEN", revokedCount: revoked.count },
    };
  });

  if (outcome.kind === "REJECTED") {
    if (outcome.reuse) {
      await auditRefreshReuse(outcome.reuse, ctx.ipAddress ?? null);
      debugServer.error("session/rotateSession", "REUSE_DETECTED(トークン盗難の可能性)", {
        sessionId: outcome.reuse.sessionId,
        source: outcome.reuse.source,
        revokedCount: outcome.reuse.revokedCount,
      });
    } else {
      debugServer.event("session/rotateSession", "REFRESH_REJECTED", { reason: outcome.reason });
    }
    return { ok: false, reason: outcome.reason };
  }

  const accessToken = await signAccessToken({ sub: outcome.userId, sid: outcome.sessionId, email: outcome.email });
  debugServer.state("session/rotateSession", "UserSession.refreshTokenHash", { sessionId: outcome.sessionId, rotated: true });

  return {
    ok: true,
    tokens: { accessToken, refreshToken: newRefreshToken, sessionId: outcome.sessionId, expiresAt: newExpiresAt },
  };
}

/** 再利用検知の監査。本人の行(target=User)としてアカウントPurgeの墨消し対象になる。生のtokenは記録しない。 */
async function auditRefreshReuse(
  reuse: { userId: string; sessionId: string; family: string; source: "RETIRED_TOKEN" | "REVOKED_SESSION"; revokedCount: number },
  ipAddress: string | null,
): Promise<void> {
  try {
    await db.auditLog.create({
      data: {
        actorUserId: null,
        actorType: "SYSTEM",
        action: "AUTH_REFRESH_REUSE_DETECTED",
        targetType: "User",
        targetId: reuse.userId,
        result: "FAILURE",
        reason: `session=${reuse.sessionId} family=${reuse.family.slice(0, 8)} source=${reuse.source} revokedSessions=${reuse.revokedCount}`,
        ipAddress,
      },
    });
  } catch (err) {
    debugServer.error("session/rotateSession", "再利用検知の監査記録に失敗しました", err);
  }
}

export async function revokeSession(sessionId: string, reason = "LOGOUT"): Promise<void> {
  await db.userSession.update({
    where: { id: sessionId },
    data: { revokedAt: new Date(), revokedReason: reason },
  });
  debugServer.state("session/revokeSession", "UserSession.revokedAt", { sessionId, reason });
}

/** FR-AUTH-04: 全端末ログアウト。指定ユーザーの有効セッションを一括失効する。 */
export async function revokeAllSessions(userId: string, reason = "LOGOUT_ALL"): Promise<number> {
  const result = await db.userSession.updateMany({
    where: { userId, revokedAt: null },
    data: { revokedAt: new Date(), revokedReason: reason },
  });
  debugServer.state("session/revokeAllSessions", "UserSession.revokedAt(一括)", { userId, count: result.count, reason });
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
