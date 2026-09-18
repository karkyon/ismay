import type { NextRequest } from "next/server";
import { db } from "@/lib/db";
import { debugServer } from "@/lib/debugServer";
import { requireAuth, requireCsrf } from "@/lib/auth/guard";
import { ensureDefaultWorkspace } from "@/lib/workspace";
import { apiOk, apiError } from "@/lib/auth/response";
import { requireAdminConsoleRole } from "@/lib/auth/roleGuard";
import { enqueueCaseDetectForAllOwnersInWorkspace } from "@/lib/patterns/casePatternTriggers";

/**
 * MOD-10 Admin: Case Pattern手動再構築(PATTERN-DETECT-TRIGGERS-03新設・
 * 2026-09-18)。
 * 出典: Claude向け_ISMAY_d68e9bf以降_ActionSlot正本準拠・CasePattern実分解
 * 完遂・残工程連続実装指示_2026-09-17.md P1「10. 残り4 reason配線」の
 * MANUAL_REBUILD(trigger配線元: 管理操作)。
 *
 * [用途] embedding source versionのコード定数(CASE_PATTERN_EMBEDDING_
 * SOURCE_VERSION)を書き換えるdeployを行った場合など、自動triggerでは
 * カバーできない状況で管理者が手動で全owner分の再検出をenqueueするための
 * 操作。casePatternTriggers.ts冒頭コメントの運用方針どおり、この手動操作が
 * EMBEDDING_SOURCE_VERSION_CHANGED相当の再構築ニーズを吸収する。
 *
 * [既存パターンとの整合] admin/ai-providers/route.tsと同じrequireAuth→
 * requireCsrf→requireAdminConsoleRoleのguard順序、同じensureDefaultWorkspace
 * によるworkspace解決を用いる(想像で新しいguard順序を発明しない)。
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
    action: "ADMIN_CASE_PATTERNS_MANUAL_REBUILD",
  });
  if (!roleOk) {
    return apiError("ACCESS_DENIED", "この操作には管理者権限(OWNER/ADMIN)が必要です");
  }

  const { ownerCount } = await enqueueCaseDetectForAllOwnersInWorkspace(db, {
    workspaceId,
    reasonCode: "MANUAL_REBUILD",
  });

  debugServer.event("POST /admin/case-patterns/rebuild", "CASE_PATTERN_DETECT_MANUAL_REBUILD_ENQUEUED", {
    workspaceId,
    ownerCount,
  });

  return apiOk({ ownerCount });
}
