import type { NextRequest } from "next/server";
import { requireAuth, requireCsrf } from "@/lib/auth/guard";
import { generateTotpSecret, generateTotpQrCodeDataUrl, encryptTotpSecret } from "@/lib/auth/totp";
import { signEnrollmentToken } from "@/lib/auth/tokens";
import { apiOk, apiError } from "@/lib/auth/response";
import { debugServer } from "@/lib/debugServer";

export async function POST(req: NextRequest) {
  const auth = await requireAuth(req);
  if (!auth.authenticated) {
    return apiError("AUTH_REQUIRED", "ログインが必要です");
  }
  if (!requireCsrf(req)) {
    return apiError("ACCESS_DENIED", "CSRFトークンが不正です");
  }

  const secret = generateTotpSecret();
  const [qrCodeDataUrl, enrollmentToken] = await Promise.all([
    generateTotpQrCodeDataUrl(auth.user.email, secret),
    signEnrollmentToken(auth.user.userId, encryptTotpSecret(secret)),
  ]);
  // secret自体は(平文シークレットのため)ログに出さない。開始した事実のみ記録する。
  debugServer.event("POST /auth/mfa/enroll", "MFA_ENROLLMENT_STARTED", { userId: auth.user.userId });

  // secretはこの初回応答でのみ平文表示する（手動入力用フォールバック）。
  // 以後はenrollmentTokenの暗号化ペイロードのみがサーバーに残る。
  return apiOk({ secret, qrCodeDataUrl, enrollmentToken });
}
