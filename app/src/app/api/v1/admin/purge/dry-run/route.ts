import type { NextRequest } from "next/server";
import { db } from "@/lib/db";
import { requireAuth, requireCsrf } from "@/lib/auth/guard";
import { apiError } from "@/lib/auth/response";

/**
 * POST /api/v1/admin/purge/dry-run(PATTERN-PURGE-01新設・2026-09-19)。
 *
 * [PURGE-SECURITY-02A・2026-09-20是正・P0是正] 実DB再監査(2026-09-19)で、
 * この経路が「呼出者が自分の既定WorkspaceでOWNER/ADMINであること」しか
 * 確認していないにもかかわらず、`findEligibleUsersForPurge()`は
 * workspace条件なしで全workspaceの対象ユーザーを列挙していたことが判明した。
 * 現状は各Workspaceの作成者が自動的にOWNERになる(招待機能未実装)ため、
 * 事実上ほぼ全利用者が他テナントを含む全対象ユーザーのメールアドレス・
 * 削除件数を閲覧できてしまう欠陥だった。
 *
 * `WorkspaceMember.role`(OWNER/ADMIN/MEMBER/VIEWER/SERVICE、
 * `src/lib/auth/roleGuard.ts`)は単一Workspace内のMOD-10 Admin(AI Provider
 * 設定等)向けに設計されたものであり、全テナント横断の操作を許可する
 * 「プラットフォーム管理者」という概念はこのコードベース・正本のどこにも
 * 定義されていない(調査済み・想像で発明しない)。この不一致を正しく解消
 * するには、正本側でプラットフォーム管理者ロールの契約(Decision Record)を
 * 確定させる必要があるが、それが無い間はHTTP経路を安全側でfail closedに
 * するのが唯一の正しい対応である(監査資料の推奨方針に従う)。
 *
 * 運用者(サーバーへの直接アクセス権を持つ者)は、代わりに
 * `scripts/run_account_purge.ts`をCLIから直接実行すること
 * (dry-runと実削除が同一プロセス内・同一スナップショットで完結するため、
 * このHTTP経路が抱えていたもう一つの問題——dry-run表示後に対象集合が
 * 変わりうる——も合わせて解消される)。
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
      action: "ADMIN_PURGE_DRY_RUN",
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
