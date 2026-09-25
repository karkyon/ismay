import type { NextRequest } from "next/server";
import { z } from "zod";
import { apiOk, apiError } from "@/lib/auth/response";
import { clientIp } from "@/lib/auth/guard";
import { clearAuthCookies } from "@/lib/auth/cookies";
import { consumePasswordResetToken } from "@/lib/auth/emailToken";

/**
 * POST /api/v1/auth/password/reset([AUTH-EMAIL-01新設・2026-09-26])。
 * 再設定メールのtokenと新しいパスワードを受け取り、パスワードを変更する。
 * 成功時は全セッションを失効させる(password/route.tsのパスワード変更と同じ方針)。
 * パスワードポリシー違反ではtokenを消費しない。TOTP(MFA)の設定は変更しない。
 */
const ResetSchema = z.object({
  token: z.string().min(1).max(512),
  newPassword: z.string().min(1),
});

const MESSAGES = {
  USED: "このリンクは使用済みです。もう一度パスワード再設定をやり直してください",
  EXPIRED: "再設定リンクの有効期限が切れています。もう一度パスワード再設定をやり直してください",
  SUPERSEDED: "新しい再設定メールが送信されたため、このリンクは使えません。最新のメールのリンクを開いてください",
  DEFAULT: "再設定リンクが無効です。もう一度パスワード再設定をやり直してください",
  LOCK_CONFLICT: "処理が混み合っています。少し時間をおいて再度お試しください",
} as const;

export async function POST(req: NextRequest) {
  const json = await req.json().catch(() => null);
  const parsed = ResetSchema.safeParse(json);
  if (!parsed.success) {
    return apiError("VALIDATION_FAILED", "入力内容を確認してください", {
      fieldErrors: Object.fromEntries(
        Object.entries(parsed.error.flatten().fieldErrors).map(([k, v]) => [k, v?.[0] ?? "不正な値です"]),
      ),
    });
  }
  const result = await consumePasswordResetToken({
    token: parsed.data.token,
    newPassword: parsed.data.newPassword,
    requestIp: clientIp(req),
  });
  if (result.ok) {
    const res = apiOk({ reset: true });
    clearAuthCookies(res);
    return res;
  }
  if (result.reason === "PASSWORD_POLICY") {
    return apiError("VALIDATION_FAILED", result.message, { fieldErrors: { newPassword: result.message } });
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
