import type { NextRequest } from "next/server";
import { z } from "zod";
import { db } from "@/lib/db";
import { debugServer, redactSensitive } from "@/lib/debugServer";
import { verifyPassword } from "@/lib/auth/password";
import { signMfaChallengeToken } from "@/lib/auth/tokens";
import { createSession } from "@/lib/auth/session";
import { setAuthCookies } from "@/lib/auth/cookies";
import { apiOk, apiError } from "@/lib/auth/response";
import { clientIp } from "@/lib/auth/guard";
import { consumeRateLimit, settleRateLimitSuccess } from "@/lib/security/rateLimiter";
import { RATE_LIMIT_POLICIES } from "@/lib/security/rateLimitPolicies";
import { withRetryAfter } from "@/lib/security/rateLimitHttp";

const LoginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1),
});

// FR-AUTH-02受入基準の一部: 連続失敗時のロック。
// [SECURITY-RATE-02B是正・2026-09-26] 旧実装はprocess内Map(再起動で消え、複数processで共有されず、
// 判定と記録が別処理のため同時要求で上限を超え得た)。Redis token bucket(lib/security/rateLimiter.ts)へ
// 置き換えた。試行の前に1回分を原子的に消費し、正しいパスワードだった場合だけ戻す
// (account: 満杯へ戻す=旧clearFailuresと同じ、IP: 今回の1回分だけ戻す)。
// 値はlib/security/rateLimitPolicies.ts(同一emailで15分10回は旧実装の値を継承)。

export async function POST(req: NextRequest) {
  const json = await req.json().catch(() => null);
  debugServer.input("POST /auth/login", "requestBody", redactSensitive(json));
  const parsed = LoginSchema.safeParse(json);
  if (!parsed.success) {
    return apiError("VALIDATION_FAILED", "入力内容を確認してください");
  }
  const email = parsed.data.email.toLowerCase();
  const { password } = parsed.data;

  const requestIp = clientIp(req);
  // 登録の有無に関わらず同じ規則で消費する(応答からアドレスの登録有無を判別させない)
  const limit = await consumeRateLimit(
    "POST /auth/login",
    [
      { policy: RATE_LIMIT_POLICIES.LOGIN_ACCOUNT, value: email },
      { policy: RATE_LIMIT_POLICIES.LOGIN_IP, value: requestIp },
    ],
  );
  if (!limit.allowed) {
    if (limit.deniedPolicyIds.includes(RATE_LIMIT_POLICIES.LOGIN_ACCOUNT.id)) {
      return withRetryAfter(
        apiError("ACCOUNT_LOCKED", "試行回数の上限に達しました。しばらく時間を置いてから再度お試しください"),
        limit.retryAfterMs,
      );
    }
    return withRetryAfter(
      apiError("RATE_LIMITED", "短時間に多くのログインが試行されました。しばらく時間を置いてから再度お試しください", { retryable: true }),
      limit.retryAfterMs,
    );
  }

  const user = await db.user.findUnique({ where: { email } });
  if (!user || user.deletedAt || !(await verifyPassword(password, user.passwordHash))) {
    // 列挙攻撃対策: メール未登録とパスワード不一致を区別しないメッセージにする
    return apiError("CREDENTIALS_INVALID", "メールアドレスまたはパスワードが正しくありません");
  }
  await settleRateLimitSuccess(limit);

  // [AUTH-EMAIL-01・2026-09-26] メール未確認のユーザーはログイン不可(利用者決定)。
  // パスワードが正しい場合にだけ返すため、登録有無の列挙には使えない。
  // 画面側はreason=EMAIL_NOT_VERIFIEDを見て確認メールの再送を案内する。
  if (!user.emailVerifiedAt) {
    return apiError("ACCESS_DENIED", "メールアドレスの確認が完了していません。確認メールのリンクを開いてください", {
      extra: { reason: "EMAIL_NOT_VERIFIED" },
    });
  }

  const totp = await db.userTotpSecret.findUnique({ where: { userId: user.id } });
  const mfaEnabled = !!totp && !totp.disabledAt;

  if (mfaEnabled) {
    const challengeToken = await signMfaChallengeToken(user.id);
    return apiOk({ mfaRequired: true, challengeToken });
  }

  const tokens = await createSession(user.id, user.email, {
    userAgent: req.headers.get("user-agent"),
    ipAddress: requestIp,
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
