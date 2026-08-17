import type { NextRequest } from "next/server";
import { z } from "zod";
import { db } from "@/lib/db";
import { requireAuth, requireCsrf } from "@/lib/auth/guard";
import { verifyEnrollmentToken } from "@/lib/auth/tokens";
import { decryptTotpSecret, verifyTotpToken, generateRecoveryCodes } from "@/lib/auth/totp";
import { apiOk, apiError } from "@/lib/auth/response";

const ConfirmSchema = z.object({
  enrollmentToken: z.string().min(1),
  code: z.string().length(6),
});

export async function POST(req: NextRequest) {
  const auth = await requireAuth(req);
  if (!auth.authenticated) {
    return apiError("AUTH_REQUIRED", "ログインが必要です");
  }
  if (!requireCsrf(req)) {
    return apiError("ACCESS_DENIED", "CSRFトークンが不正です");
  }

  const json = await req.json().catch(() => null);
  const parsed = ConfirmSchema.safeParse(json);
  if (!parsed.success) {
    return apiError("VALIDATION_FAILED", "6桁のコードを入力してください");
  }

  const enrollment = await verifyEnrollmentToken(parsed.data.enrollmentToken);
  if (!enrollment || enrollment.userId !== auth.user.userId) {
    return apiError("VALIDATION_FAILED", "登録セッションの有効期限が切れました。最初からやり直してください");
  }

  const secret = decryptTotpSecret(enrollment.secretEncrypted);
  if (!(await verifyTotpToken(parsed.data.code, secret))) {
    return apiError("MFA_INVALID", "コードが正しくありません。認証アプリの6桁を再入力してください");
  }

  const { plain, hashed } = generateRecoveryCodes();

  await db.userTotpSecret.upsert({
    where: { userId: auth.user.userId },
    create: {
      userId: auth.user.userId,
      secretEncrypted: enrollment.secretEncrypted,
      recoveryCodesHash: hashed,
    },
    update: {
      secretEncrypted: enrollment.secretEncrypted,
      recoveryCodesHash: hashed,
      disabledAt: null,
      enrolledAt: new Date(),
    },
  });

  // 復旧コードはこの応答でのみ平文表示する。以後はハッシュのみ保持し再表示不可。
  return apiOk({ recoveryCodes: plain });
}
