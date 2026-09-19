import type { NextRequest } from "next/server";
import { requireAuth, requireCsrf } from "@/lib/auth/guard";
import { ensureDefaultWorkspace } from "@/lib/workspace";
import { apiOk, apiError } from "@/lib/auth/response";
import { requireAdminConsoleRole } from "@/lib/auth/roleGuard";
import { findEligibleUsersForPurge, dryRunPurgeForUser } from "@/lib/admin/purgeJob";

/**
 * POST /api/v1/admin/purge/dry-run(PATTERN-PURGE-01新設・2026-09-19)。
 * 出典: `auth/account/delete/route.ts`コメント「30日後にPurge Job」
 * (DB設計書8章)、README.md「既知の未完了・保留事項」。
 *
 * [何も削除しない] 対象(deletedAtから30日以上経過した全ユーザー)ごとに、
 * 各テーブルで削除対象となる行数のみを数えて返す。実行前に必ずこの結果を
 * 確認できるようにする(不可逆な物理削除を無人で自動実行しない設計、
 * Gate 10のMANUAL_REBUILDと同じ管理者操作パターン)。
 */
export async function POST(req: NextRequest) {
  const auth = await requireAuth(req);
  if (!auth.authenticated) {
    return apiError("AUTH_REQUIRED", "ログインが必要です");
  }
  if (!requireCsrf(req)) {
    return apiError("ACCESS_DENIED", "CSRFトークンが不正です");
  }

  const { workspaceId } = await ensureDefaultWorkspace(auth.user.userId, auth.user.email);
  const roleOk = await requireAdminConsoleRole({
    userId: auth.user.userId,
    workspaceId,
    action: "ADMIN_PURGE_DRY_RUN",
  });
  if (!roleOk) {
    return apiError("ACCESS_DENIED", "この操作には管理者権限(OWNER/ADMIN)が必要です");
  }

  const eligible = await findEligibleUsersForPurge();
  const results = [];
  for (const target of eligible) {
    const perTable = await dryRunPurgeForUser(target);
    const totalRows = perTable.reduce((sum, t) => sum + t.count, 0);
    results.push({
      userId: target.userId,
      email: target.email,
      deletedAt: target.deletedAt.toISOString(),
      workspaceCount: target.workspaceIds.length,
      totalRowsWouldBeDeleted: totalRows,
      perTable: perTable.filter((t) => t.count > 0),
    });
  }

  return apiOk({ eligibleUserCount: eligible.length, results });
}
