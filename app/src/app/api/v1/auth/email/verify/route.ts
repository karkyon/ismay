import type { NextRequest } from "next/server";
import { z } from "zod";
import { apiOk, apiError } from "@/lib/auth/response";
import { clientIp } from "@/lib/auth/guard";
import { consumeEmailVerificationToken } from "@/lib/auth/emailToken";

/**
 * POST /api/v1/auth/email/verify([AUTH-EMAIL-01新設・2026-09-26])。
 * 確認メールのリンク(/verify-email?token=...)の画面から、利用者がボタンを押したときに呼ばれる。
 * GETで確認を完了しないのは、メールのリンク先読み(セキュリティ製品等)で消費されないようにするため。
 * 未ログインで呼ぶAPIのためCSRFは不要(Cookie認証を使わない)。
 */
const VerifySchema = z.object({ token: z.string().min(1).max(512) });

const MESSAGES = {
  USED: "このリンクは使用済みです。確認が完了している場合は、そのままログインしてください",
  EXPIRED: "確認リンクの有効期限が切れています。ログイン画面から確認メールを再送してください",
  SUPERSEDED: "新しい確認メールが送信されたため、このリンクは使えません。最新のメールのリンクを開いてください",
  DEFAULT: "確認リンクが無効です。ログイン画面から確認メールを再送してください",
  LOCK_CONFLICT: "処理が混み合っています。少し時間をおいて再度お試しください",
} as const;

export async function POST(req: NextRequest) {
  const json = await req.json().catch(() => null);
  const parsed = VerifySchema.safeParse(json);
  if (!parsed.success) {
    return apiError("VALIDATION_FAILED", MESSAGES.DEFAULT, { extra: { reason: "NOT_FOUND" } });
  }
  const result = await consumeEmailVerificationToken({ token: parsed.data.token, requestIp: clientIp(req) });
  if (result.ok) {
    return apiOk({ verified: true, alreadyVerified: result.alreadyVerified });
  }
  const message =
    result.reason === "USED" || result.reason === "EXPIRED" || result.reason === "SUPERSEDED" || result.reason === "LOCK_CONFLICT"
      ? MESSAGES[result.reason]
      : MESSAGES.DEFAULT;
  return apiError("VALIDATION_FAILED", message, {
    retryable: result.reason === "LOCK_CONFLICT",
    extra: { reason: result.reason },
  });
}
