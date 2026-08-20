import type { NextRequest } from "next/server";
import { z } from "zod";
import { db } from "@/lib/db";
import { debugServer, redactSensitive } from "@/lib/debugServer";
import { verifyMfaChallengeToken } from "@/lib/auth/tokens";
import { decryptTotpSecret, verifyTotpToken, hashRecoveryCode } from "@/lib/auth/totp";
import { createSession } from "@/lib/auth/session";
import { setAuthCookies } from "@/lib/auth/cookies";
import { apiOk, apiError } from "@/lib/auth/response";
import { clientIp } from "@/lib/auth/guard";

const VerifySchema = z.object({
  challengeToken: z.string().min(1),
  code: z.string().min(6).max(64),
});

export async function POST(req: NextRequest) {
  const json = await req.json().catch(() => null);
  debugServer.input("POST /auth/mfa/verify", "requestBody", redactSensitive(json));
  const parsed = VerifySchema.safeParse(json);
  if (!parsed.success) {
    return apiError("VALIDATION_FAILED", "入力内容を確認してください");
  }
  const { challengeToken, code } = parsed.data;

  const userId = await verifyMfaChallengeToken(challengeToken);
  if (!userId) {
    return apiError("AUTH_REQUIRED", "認証セッションの有効期限が切れました。ログインをやり直してください");
  }

  const [user, totp] = await Promise.all([
    db.user.findUnique({ where: { id: userId } }),
    db.userTotpSecret.findUnique({ where: { userId } }),
  ]);
  if (!user || user.deletedAt || !totp || totp.disabledAt) {
    return apiError("AUTH_REQUIRED", "認証状態が不正です。ログインをやり直してください");
  }

  const normalizedCode = code.trim();
  let valid = false;

  if (/^\d{6}$/.test(normalizedCode)) {
    const secret = decryptTotpSecret(totp.secretEncrypted);
    valid = await verifyTotpToken(normalizedCode, secret);
  } else {
    // 6桁数字でなければ復旧コードとして扱う（FR-AUTH-03: 復旧コードを提供する）
    const codeHash = hashRecoveryCode(normalizedCode);
    const recoveryHashes = (totp.recoveryCodesHash as unknown as string[]) ?? [];
    if (recoveryHashes.includes(codeHash)) {
      valid = true;
      const remaining = recoveryHashes.filter((h) => h !== codeHash);
      await db.userTotpSecret.update({
        where: { userId },
        data: { recoveryCodesHash: remaining },
      });
    }
  }

  if (!valid) {
    return apiError("MFA_INVALID", "コードが正しくありません");
  }

  const tokens = await createSession(user.id, user.email, {
    userAgent: req.headers.get("user-agent"),
    ipAddress: clientIp(req),
  });

  const res = apiOk({
    user: { id: user.id, email: user.email, displayName: user.displayName },
  });
  setAuthCookies(res, {
    accessToken: tokens.accessToken,
    refreshToken: tokens.refreshToken,
    refreshExpiresAt: tokens.expiresAt,
  });
  return res;
}
