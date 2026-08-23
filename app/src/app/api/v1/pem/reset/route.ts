import type { NextRequest } from "next/server";
import { z } from "zod";
import { db } from "@/lib/db";
import { debugServer } from "@/lib/debugServer";
import { requireAuth, requireCsrf } from "@/lib/auth/guard";
import { verifyPassword } from "@/lib/auth/password";
import { apiOk, apiError } from "@/lib/auth/response";

/**
 * POST /pem/reset(2026-08-23新設)。
 * 出典: AI・PEM設計書v1.0 14章「全PEMリセット：再認証と影響確認。Responsibility自体は
 * 削除しない」。API・イベント設計書v1.1にはAPI IDの明記が無いため、
 * auth/account/delete/route.tsと同じ「パスワード再認証+確認文字列」パターンを踏襲した
 * 新規APIとして追加する([設計判断・2026-08-23])。
 *
 * FACT/OBSERVATION/HYPOTHESIS/初回対話・週次レビューキャッシュをすべて論理削除する。
 * Responsibility・Capture等の業務データには一切触れない(要件通り)。
 */
const ResetSchema = z.object({
  currentPassword: z.string().min(1),
  confirmText: z.literal("リセット"),
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
  const parsed = ResetSchema.safeParse(json);
  if (!parsed.success) {
    return apiError("VALIDATION_FAILED", "入力内容を確認してください(確認文字列は「リセット」と入力してください)", {
      fieldErrors: Object.fromEntries(
        Object.entries(parsed.error.flatten().fieldErrors).map(([k, v]) => [k, v?.[0] ?? "不正な値です"]),
      ),
    });
  }

  const user = await db.user.findUnique({ where: { id: auth.user.userId } });
  if (!user || user.deletedAt) {
    return apiError("AUTH_REQUIRED", "ログインが必要です");
  }

  const passwordOk = await verifyPassword(parsed.data.currentPassword, user.passwordHash);
  if (!passwordOk) {
    await db.auditLog.create({
      data: {
        actorUserId: user.id,
        actorType: "USER",
        action: "PEM_RESET_REQUESTED",
        targetType: "User",
        targetId: user.id,
        result: "FAILURE",
        reason: "パスワード不一致",
      },
    });
    return apiError("VALIDATION_FAILED", "現在のパスワードが正しくありません", {
      fieldErrors: { currentPassword: "現在のパスワードが正しくありません" },
    });
  }

  const now = new Date();
  await db.$transaction([
    db.pemObservation.updateMany({ where: { userId: user.id, deletedAt: null }, data: { deletedAt: now } }),
    db.pemHypothesis.updateMany({ where: { userId: user.id, deletedAt: null }, data: { deletedAt: now } }),
    db.pemOnboardingConversation.deleteMany({ where: { userId: user.id } }),
    db.pemWeeklyReview.deleteMany({ where: { userId: user.id } }),
  ]);

  await db.auditLog.create({
    data: {
      actorUserId: user.id,
      actorType: "USER",
      action: "PEM_RESET_REQUESTED",
      targetType: "User",
      targetId: user.id,
      result: "SUCCESS",
    },
  });
  debugServer.state("POST /pem/reset", "PEM全リセット完了", { userId: user.id });

  return apiOk({ reset: true });
}
