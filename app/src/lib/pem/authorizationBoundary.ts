/**
 * PEM 認可・データ主体境界ヘルパー(Phase 0G・v2)。
 * 出典: ISMAY_PEMサブシステム_統合正本仕様書_v4_0 4章。
 *
 * v1(733959a)からの修正点:
 *  - 架空の DEFAULT_TENANT_ID="default" 固定をやめ、既存の Workspace/WorkspaceMember
 *    モデルから実際の tenantId(実体はworkspaceId)をDBで解決するようにした。
 *  - actorUserId(現在の操作主体)とsubjectUserId(PEMデータ主体)を分離した。
 *  - 「本人のPEMは原則本人だけ閲覧可能」という方針を、Workspace ADMINだからPEMを
 *    閲覧できる、とは自動的にしない形で明文化した(assertSelfOnlyAccess)。
 */
import { db } from "@/lib/db";
import { ensureDefaultWorkspace } from "@/lib/workspace";

export interface PemAuthorizationContext {
  /** 実体はworkspaceId。v4.0 4章の用語(tenantId)をそのまま踏襲するが、値は実データ由来。 */
  readonly tenantId: string;
  /** PEMデータの主体(このデータが誰のものか)。 */
  readonly subjectUserId: string;
  /** 現在の操作主体(通常はsubjectUserIdと同じだが、将来の代理操作等では異なりうる)。 */
  readonly actorUserId: string;
  readonly workspaceRole: string;
  readonly authenticationContextId: string;
}

/**
 * v4.0 4.1節「APIはクライアント指定のsubjectUserIdを信用せず、認証contextから
 * 確定する」。認証済みユーザーIDから、実際のWorkspace membershipを解決して
 * PemAuthorizationContextを構築する。
 *
 * MVP(1ユーザー=1 Workspace固定)では actorUserId === subjectUserId が常に成立する。
 * 将来、他ユーザーのPEMを代理閲覧する機能を追加する場合も、subjectUserIdを
 * クライアント入力からではなく、明示的な権限確認を経てここへ渡す設計とすること。
 */
export async function buildPemAuthorizationContext(
  authenticatedUserId: string,
  authenticationContextId: string,
  subjectUserIdOverride?: string,
): Promise<PemAuthorizationContext> {
  const { workspaceId } = await ensureDefaultWorkspace(authenticatedUserId);
  const subjectUserId = subjectUserIdOverride ?? authenticatedUserId;

  const membership = await db.workspaceMember.findFirst({
    where: { workspaceId, userId: authenticatedUserId, leftAt: null },
    select: { role: true },
  });
  if (!membership) {
    throw new Error("PEM: 指定Workspaceのmembershipが見つかりません");
  }

  return {
    tenantId: workspaceId,
    subjectUserId,
    actorUserId: authenticatedUserId,
    workspaceRole: membership.role,
    authenticationContextId,
  };
}

/**
 * v4.0「本人はPEM全体…を個別に停止できる」「本人閲覧権」の前提となる方針:
 * PEMデータは、Workspace内の役割(ADMIN等)に関わらず、原則として
 * subjectUserId本人(actorUserId === subjectUserId)のみが閲覧・操作できる。
 * Workspace ADMINであることを理由にPEMアクセスを許可しない。
 */
export function assertSelfOnlyAccess(ctx: PemAuthorizationContext): void {
  if (ctx.actorUserId !== ctx.subjectUserId) {
    throw new Error(
      "PEM: 本人以外による閲覧・操作は許可されません(Workspace内の役割に関わらず本人限定)",
    );
  }
}

/**
 * v4.0 4.1節「tenantを跨ぐFK参照、検索、集計及び再計算を禁止する」の機械的ガード。
 * 2つのcontextが同一tenant(workspaceId)・同一subjectであることを検証する。
 */
export function assertSameSubject(a: PemAuthorizationContext, b: PemAuthorizationContext): void {
  if (a.tenantId !== b.tenantId || a.subjectUserId !== b.subjectUserId) {
    throw new Error("PEM: tenant(workspace)/subjectUser境界を越える操作は許可されません");
  }
}

/**
 * v4.0 4.1節「DB制約、Row Level Security又は同等の境界検証とアプリケーション認可を
 * 二重化する」の一環。アプリケーション層での境界チェックはこの関数群が担う。
 * DB制約(unique/index/FK)側の二重化は、Phase 0A以降の実テーブル設計で
 * tenantId(workspaceId)を含む複合キーとして行う。
 */
export function scopedWhere(ctx: PemAuthorizationContext): { workspaceId: string; subjectUserId: string } {
  return { workspaceId: ctx.tenantId, subjectUserId: ctx.subjectUserId };
}
