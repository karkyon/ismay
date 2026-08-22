import type { NextRequest } from "next/server";
import { z } from "zod";
import { db } from "@/lib/db";
import { debugServer } from "@/lib/debugServer";
import { requireAuth, requireCsrf } from "@/lib/auth/guard";
import { verifyPassword } from "@/lib/auth/password";
import { revokeAllSessions } from "@/lib/auth/session";
import { clearAuthCookies } from "@/lib/auth/cookies";
import { ensureDefaultWorkspace } from "@/lib/workspace";
import { apiOk, apiError } from "@/lib/auth/response";

/**
 * API-PRV-02: POST /auth/account/delete(2026-08-23新設)。
 * FR-AUTH-05「アカウントをエクスポート・削除できる」「本人再認証後に処理し、
 * 処理状況と完了を通知する」、FR-PRV-02「データを...削除できる」。
 *
 * [設計判断・2026-08-23] 本人再認証はパスワード再入力で行う(password/route.tsと
 * 同じ確立パターン)。加えて誤操作防止のため、確認文字列「削除」の入力を必須にする
 * (単なるボタン連打による事故を防ぐ、破壊的操作の一般的な安全策)。
 *
 * DB設計書8章「通常削除はdeleted_at。30日後にPurge Job」の方針に従い、本APIは
 * soft-delete(deletedAt設定)までを行う。Purge Job(30日後の完全物理削除)は
 * 別途スケジュールジョブが必要な独立した機能のため、本パッチのスコープ外とする
 * (「処理状況」を追跡する仕組み自体もPurge Job実装時に併せて設計する)。
 */
const DeleteAccountSchema = z.object({
  currentPassword: z.string().min(1),
  confirmText: z.literal("削除"),
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
  const parsed = DeleteAccountSchema.safeParse(json);
  if (!parsed.success) {
    return apiError("VALIDATION_FAILED", "入力内容を確認してください(確認文字列は「削除」と入力してください)", {
      fieldErrors: Object.fromEntries(
        Object.entries(parsed.error.flatten().fieldErrors).map(([k, v]) => [k, v?.[0] ?? "不正な値です"]),
      ),
    });
  }
  const { currentPassword } = parsed.data;

  const user = await db.user.findUnique({ where: { id: auth.user.userId } });
  if (!user || user.deletedAt) {
    return apiError("AUTH_REQUIRED", "ログインが必要です");
  }

  const passwordOk = await verifyPassword(currentPassword, user.passwordHash);
  if (!passwordOk) {
    await db.auditLog.create({
      data: {
        actorUserId: user.id,
        actorType: "USER",
        action: "ACCOUNT_DELETE_REQUESTED",
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

  const { workspaceId } = await ensureDefaultWorkspace(auth.user.userId, auth.user.email);
  const now = new Date();

  await db.$transaction([
    db.responsibility.updateMany({ where: { workspaceId, deletedAt: null }, data: { deletedAt: now } }),
    db.capture.updateMany({ where: { workspaceId, deletedAt: null }, data: { deletedAt: now } }),
    db.domain.updateMany({ where: { workspaceId, deletedAt: null }, data: { deletedAt: now } }),
    db.workspace.update({ where: { id: workspaceId }, data: { deletedAt: now } }),
    db.user.update({ where: { id: user.id }, data: { deletedAt: now } }),
  ]);
  debugServer.state("POST /auth/account/delete", "soft-delete完了", { userId: user.id, workspaceId });

  await db.auditLog.create({
    data: {
      actorUserId: user.id,
      actorType: "USER",
      action: "ACCOUNT_DELETE_REQUESTED",
      targetType: "User",
      targetId: user.id,
      result: "SUCCESS",
    },
  });

  const revokedCount = await revokeAllSessions(user.id, "ACCOUNT_DELETED");
  debugServer.event("POST /auth/account/delete", "全セッション失効", { userId: user.id, revokedCount });

  const res = apiOk({ deleted: true });
  clearAuthCookies(res);
  return res;
}
