import type { NextRequest } from "next/server";
import { z } from "zod";
import { debugServer } from "@/lib/debugServer";
import { db } from "@/lib/db";
import { requireAuth, requireCsrf } from "@/lib/auth/guard";
import { ensureDefaultWorkspace } from "@/lib/workspace";
import { apiOk, apiError } from "@/lib/auth/response";
import { requireAdminConsoleRole } from "@/lib/auth/roleGuard";
import { findEligibleUsersForPurge, executePurgeForUser } from "@/lib/admin/purgeJob";

/**
 * POST /api/v1/admin/purge/execute(PATTERN-PURGE-01新設・2026-09-19)。
 *
 * [不可逆操作への安全策] 1) 誤操作防止のため確認文字列「完全削除」の入力を
 * 必須にする(既存account/delete/route.tsの「削除」確認と同じ方針、より
 * 重大な操作のため文言を強めた)。2) 1ユーザーにつき1 transaction
 * (executePurgeForUser内)、途中で1つでも失敗すればそのユーザー分は全体
 * rollbackされ、部分的な物理削除を残さない。3) あるユーザーの削除失敗は
 * 他ユーザーの処理を止めない(1件ずつ独立、監査ログに個別記録)。
 */
const ExecuteRequestSchema = z.object({
  confirmText: z.literal("完全削除"),
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
  const parsed = ExecuteRequestSchema.safeParse(json);
  if (!parsed.success) {
    return apiError("VALIDATION_FAILED", "確認文字列は「完全削除」と入力してください");
  }

  const { workspaceId } = await ensureDefaultWorkspace(auth.user.userId, auth.user.email);
  const roleOk = await requireAdminConsoleRole({
    userId: auth.user.userId,
    workspaceId,
    action: "ADMIN_PURGE_EXECUTE",
  });
  if (!roleOk) {
    return apiError("ACCESS_DENIED", "この操作には管理者権限(OWNER/ADMIN)が必要です");
  }

  const eligible = await findEligibleUsersForPurge();
  const results = [];
  for (const target of eligible) {
    try {
      const result = await executePurgeForUser(target);
      results.push({ userId: target.userId, email: target.email, ok: true as const, totalRowsDeleted: result.totalRowsDeleted });
      debugServer.event("POST /admin/purge/execute", "PURGE_COMPLETED", {
        purgedUserId: target.userId,
        totalRowsDeleted: result.totalRowsDeleted,
        actorUserId: auth.user.userId,
      });
      await db.auditLog.create({
        data: {
          actorUserId: auth.user.userId,
          actorType: "USER",
          action: "ACCOUNT_PURGE_EXECUTED",
          targetType: "User",
          targetId: target.userId,
          result: "SUCCESS",
          reason: `totalRowsDeleted=${result.totalRowsDeleted}`,
        },
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      results.push({ userId: target.userId, email: target.email, ok: false as const, error: message });
      debugServer.error("POST /admin/purge/execute", "PURGE_FAILED", {
        purgedUserId: target.userId,
        error: message,
      });
      await db.auditLog.create({
        data: {
          actorUserId: auth.user.userId,
          actorType: "USER",
          action: "ACCOUNT_PURGE_EXECUTED",
          targetType: "User",
          targetId: target.userId,
          result: "FAILURE",
          reason: message.slice(0, 500),
        },
      });
    }
  }

  return apiOk({
    processedCount: results.length,
    succeededCount: results.filter((r) => r.ok).length,
    failedCount: results.filter((r) => !r.ok).length,
    results,
  });
}
