import type { NextRequest } from "next/server";
import { db } from "@/lib/db";
import { requireAuth, requireCsrf } from "@/lib/auth/guard";
import { apiError } from "@/lib/auth/response";

/**
 * POST /api/v1/admin/purge/execute(PATTERN-PURGE-01新設・2026-09-19)。
 *
 * [PURGE-SECURITY-02A・2026-09-20是正・P0是正] dry-run/route.tsと同一の
 * 理由でfail closedにする(詳細はdry-run/route.tsのコメント参照)。
 * この経路は不可逆な物理削除を実行するため、dry-run以上に影響が大きい。
 * 運用者は scripts/run_account_purge.ts をCLIから実行すること。
 */
export async function POST(req: NextRequest) {
  const auth = await requireAuth(req);
  if (!auth.authenticated) {
    return apiError("AUTH_REQUIRED", "ログインが必要です");
  }
  if (!requireCsrf(req)) {
    return apiError("ACCESS_DENIED", "CSRFトークンが不正です");
  }

  await db.auditLog.create({
    data: {
      actorUserId: auth.user.userId,
      actorType: "USER",
      action: "ADMIN_PURGE_EXECUTE",
      targetType: "System",
      targetId: null,
      result: "FAILURE",
      reason: "ACCESS_DENIED_PURGE_HTTP_DISABLED(PURGE-SECURITY-02A: プラットフォーム管理者契約が正本未確定のためHTTP経路をfail closed)",
    },
  });
  return apiError(
    "ACCESS_DENIED",
    "この操作はHTTP経由では実行できません。全テナント横断のPurgeを許可する「プラットフォーム管理者」権限が正本で未定義のため、Workspace OWNER/ADMIN権限のみでは実行できない設計へ変更しました。サーバーへの直接アクセス権を持つ運用者は scripts/run_account_purge.ts をCLIから実行してください。",
  );
}
