import { db } from "@/lib/db";

/**
 * WorkspaceMember.role の正式語彙(Gate SECURITY-RBAC-01調査、2026-09-03)。
 * 出典: 統合正本仕様書v5.0 §20.2「役割」: `OWNER / ADMIN / MEMBER / VIEWER / SERVICE`。
 *
 * schema.prisma の WorkspaceMember.role は文字列型のまま `[推論]` コメント付きで
 * 運用されていたが、正本§20.2にこの5値が明記されていることを確認した(想像ではなく
 * 正本の記述に基づく)。`src/lib/workspace.ts` の `ensureDefaultWorkspace()` は
 * 既にワークスペース作成時に `role: "OWNER"` を設定しており、この語彙を前提にした
 * コードが既に存在する。
 *
 * 注意: 統合正本§20はTeam化(複数メンバー運用)の章であり、Team集計(k閾値・差分
 * privacy等、DOC-13 DEC-001)は明示的に保留中。本モジュールはTeam集計機能には
 * 一切触れず、単一Workspace内でのMOD-10 Admin(管理API)アクセス制御のみに使う。
 * 現状はメンバー招待機能が未実装のため、各Workspaceには作成者(OWNER)以外のmemberは
 * 実際には存在しないが、DOC-11 API・Event仕様書§21.1「管理APIはrole guard」に
 * 対応するため、招待機能が実装される前に境界を先に確立しておく。
 */
export const WORKSPACE_ROLES = ["OWNER", "ADMIN", "MEMBER", "VIEWER", "SERVICE"] as const;
export type WorkspaceRole = (typeof WORKSPACE_ROLES)[number];

/** DOC-11 API・Event仕様書 §21.1「管理APIはrole guard」に対応する許可ロール。 */
export const ADMIN_CONSOLE_ROLES: readonly WorkspaceRole[] = ["OWNER", "ADMIN"];

export type RoleCheckResult =
  | { allowed: true; role: WorkspaceRole }
  | { allowed: false; reason: "NOT_A_MEMBER" | "INSUFFICIENT_ROLE"; role: string | null };

/**
 * 指定Workspaceにおけるuserの有効(leftAt=null)membershipを確認し、
 * allowedRolesに含まれるroleを持つかどうかを判定する(deny-by-default:
 * membership自体が無い場合・roleが未知の文字列の場合もfalse側へ倒す)。
 */
export async function checkWorkspaceRole(
  userId: string,
  workspaceId: string,
  allowedRoles: readonly WorkspaceRole[],
): Promise<RoleCheckResult> {
  const membership = await db.workspaceMember.findFirst({
    where: { userId, workspaceId, leftAt: null },
    select: { role: true },
  });
  if (!membership) {
    return { allowed: false, reason: "NOT_A_MEMBER", role: null };
  }
  const role = membership.role;
  if (!(WORKSPACE_ROLES as readonly string[]).includes(role)) {
    return { allowed: false, reason: "INSUFFICIENT_ROLE", role };
  }
  if (!allowedRoles.includes(role as WorkspaceRole)) {
    return { allowed: false, reason: "INSUFFICIENT_ROLE", role };
  }
  return { allowed: true, role: role as WorkspaceRole };
}

/**
 * 管理API(MOD-10 Admin: AI Provider設定・APIキー・利用状況)向けの簡易ガード。
 * 拒否時はAuditLogへ拒否理由付きで記録してからfalseを返す。呼び出し元はfalseを
 * 見て `apiError("ACCESS_DENIED", ...)` を返すこと(secret等は一切含めない)。
 */
export async function requireAdminConsoleRole(params: {
  userId: string;
  workspaceId: string;
  action: string;
}): Promise<boolean> {
  const result = await checkWorkspaceRole(params.userId, params.workspaceId, ADMIN_CONSOLE_ROLES);
  if (!result.allowed) {
    await db.auditLog.create({
      data: {
        actorUserId: params.userId,
        actorType: "USER",
        action: params.action,
        targetType: "Workspace",
        targetId: params.workspaceId,
        result: "FAILURE",
        reason: `ACCESS_DENIED_ADMIN_API(${result.reason}${result.role ? `:${result.role}` : ""})`,
      },
    });
    return false;
  }
  return true;
}
