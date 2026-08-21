import type { NextRequest } from "next/server";
import { z } from "zod";
import { db } from "@/lib/db";
import { debugServer } from "@/lib/debugServer";
import { requireAuth, requireCsrf } from "@/lib/auth/guard";
import { hashPassword, verifyPassword, validatePasswordPolicy } from "@/lib/auth/password";
import { revokeAllSessions } from "@/lib/auth/session";
import { clearAuthCookies } from "@/lib/auth/cookies";
import { apiOk, apiError } from "@/lib/auth/response";

/**
 * POST /api/v1/auth/password(2026-08-21新設)。
 * カルキョンさんの指示「ヘッダバーに...一般的な機能(ユーザ情報、パス変更、ログアウト)
 * メニュー実装」に対応。従来ログイン(register)・MFA登録のみでパスワード変更手段が
 * 一つも存在しなかった(未実装の抜け漏れ)。
 *
 * 設計判断: 変更成功時は現在のセッションを含む全セッションを失効させ、
 * クッキーもクリアして再ログインを要求する(パスワード変更後は「変更前の
 * 認証情報で開いたままの他端末」を必ず切断すべき、というセキュリティ上の一般的方針)。
 * 呼び出し元(フロント)は成功時に/loginへ遷移させること。
 */

const ChangePasswordSchema = z.object({
  currentPassword: z.string().min(1),
  newPassword: z.string().min(1),
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
  // パスワード自体はログに残さない(redactSensitiveの対象キー名と衝突しても
  // 値を出さない方が安全なため、ここではinputログ自体を取らない)。
  const parsed = ChangePasswordSchema.safeParse(json);
  if (!parsed.success) {
    return apiError("VALIDATION_FAILED", "入力内容を確認してください", {
      fieldErrors: Object.fromEntries(
        Object.entries(parsed.error.flatten().fieldErrors).map(([k, v]) => [k, v?.[0] ?? "不正な値です"]),
      ),
    });
  }
  const { currentPassword, newPassword } = parsed.data;

  const user = await db.user.findUnique({ where: { id: auth.user.userId } });
  if (!user || user.deletedAt) {
    return apiError("AUTH_REQUIRED", "ログインが必要です");
  }

  const currentOk = await verifyPassword(currentPassword, user.passwordHash);
  if (!currentOk) {
    return apiError("VALIDATION_FAILED", "現在のパスワードが正しくありません", {
      fieldErrors: { currentPassword: "現在のパスワードが正しくありません" },
    });
  }

  const policy = validatePasswordPolicy(newPassword);
  if (!policy.valid) {
    return apiError("VALIDATION_FAILED", policy.reason ?? "パスワードが要件を満たしません", {
      fieldErrors: { newPassword: policy.reason ?? "" },
    });
  }

  const newHash = await hashPassword(newPassword);
  await db.user.update({ where: { id: user.id }, data: { passwordHash: newHash } });
  debugServer.event("POST /auth/password", "パスワード変更完了", { userId: user.id });

  const revokedCount = await revokeAllSessions(user.id, "PASSWORD_CHANGED");
  debugServer.event("POST /auth/password", "全セッション失効", { userId: user.id, revokedCount });

  const res = apiOk({ changed: true });
  clearAuthCookies(res);
  return res;
}
