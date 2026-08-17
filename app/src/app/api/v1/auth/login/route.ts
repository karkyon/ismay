import type { NextRequest } from "next/server";
import { z } from "zod";
import { db } from "@/lib/db";
import { verifyPassword } from "@/lib/auth/password";
import { signMfaChallengeToken } from "@/lib/auth/tokens";
import { createSession } from "@/lib/auth/session";
import { setAuthCookies } from "@/lib/auth/cookies";
import { apiOk, apiError } from "@/lib/auth/response";
import { clientIp } from "@/lib/auth/guard";

const LoginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1),
});

// FR-AUTH-02受入基準の一部: 連続失敗時のロック。[推論・簡易実装]
const MAX_ATTEMPTS = 10;
const LOCK_WINDOW_MS = 15 * 60 * 1000;
const failureLog = new Map<string, { count: number; firstAt: number }>();

function isLocked(email: string): boolean {
  const entry = failureLog.get(email);
  if (!entry) return false;
  if (Date.now() - entry.firstAt > LOCK_WINDOW_MS) {
    failureLog.delete(email);
    return false;
  }
  return entry.count >= MAX_ATTEMPTS;
}

function recordFailure(email: string): void {
  const entry = failureLog.get(email);
  if (!entry || Date.now() - entry.firstAt > LOCK_WINDOW_MS) {
    failureLog.set(email, { count: 1, firstAt: Date.now() });
  } else {
    entry.count += 1;
  }
}

function clearFailures(email: string): void {
  failureLog.delete(email);
}

export async function POST(req: NextRequest) {
  const json = await req.json().catch(() => null);
  const parsed = LoginSchema.safeParse(json);
  if (!parsed.success) {
    return apiError("VALIDATION_FAILED", "入力内容を確認してください");
  }
  const email = parsed.data.email.toLowerCase();
  const { password } = parsed.data;

  if (isLocked(email)) {
    return apiError("ACCOUNT_LOCKED", "試行回数の上限に達しました。しばらく時間を置いてから再度お試しください");
  }

  const user = await db.user.findUnique({ where: { email } });
  if (!user || user.deletedAt || !(await verifyPassword(password, user.passwordHash))) {
    recordFailure(email);
    // 列挙攻撃対策: メール未登録とパスワード不一致を区別しないメッセージにする
    return apiError("CREDENTIALS_INVALID", "メールアドレスまたはパスワードが正しくありません");
  }
  clearFailures(email);

  const totp = await db.userTotpSecret.findUnique({ where: { userId: user.id } });
  const mfaEnabled = !!totp && !totp.disabledAt;

  if (mfaEnabled) {
    const challengeToken = await signMfaChallengeToken(user.id);
    return apiOk({ mfaRequired: true, challengeToken });
  }

  const tokens = await createSession(user.id, user.email, {
    userAgent: req.headers.get("user-agent"),
    ipAddress: clientIp(req),
  });

  const res = apiOk({
    mfaRequired: false,
    user: { id: user.id, email: user.email, displayName: user.displayName },
  });
  setAuthCookies(res, {
    accessToken: tokens.accessToken,
    refreshToken: tokens.refreshToken,
    refreshExpiresAt: tokens.expiresAt,
  });
  return res;
}
