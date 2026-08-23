/**
 * PEM 認可・テナント境界ヘルパー(Phase 0G)。
 * 出典: ISMAY_PEMサブシステム_統合正本仕様書_v4_0 4章。
 *
 * MVP(ISMAY_インフラ_運用設計書等)は1ユーザー=1 Workspace固定のため、
 * tenantIdは現時点で固定値運用となるが、v4.0 4.1節の不変条件
 * 「tenantを跨ぐFK参照・検索・集計・再計算を禁止する」を将来の
 * マルチテナント化時にも機械的に守れるよう、境界チェックを型・関数として
 * 今のうちに用意しておく(Phase 0A以降の全PEM関連リポジトリ層がこれを経由する想定)。
 */

/** MVP固定のtenantId。将来のマルチテナント化までの暫定値。 */
export const DEFAULT_TENANT_ID = "default";

export interface PemSubjectContext {
  readonly tenantId: string;
  readonly subjectUserId: string;
}

/**
 * v4.0 4.1節「APIはクライアント指定のsubjectUserIdを信用せず、認証contextから
 * 確定する」。呼び出し側は必ず認証済みセッションからこのcontextを構築し、
 * リクエストボディ中のuserId等をそのまま使わないこと。
 */
export function buildSubjectContext(authenticatedUserId: string): PemSubjectContext {
  return { tenantId: DEFAULT_TENANT_ID, subjectUserId: authenticatedUserId };
}

/**
 * v4.0 4.1節「tenantを跨ぐFK参照、検索、集計及び再計算を禁止する」の機械的ガード。
 * 2つのcontextが同一tenant・同一subjectであることを検証する。
 */
export function assertSameSubject(a: PemSubjectContext, b: PemSubjectContext): void {
  if (a.tenantId !== b.tenantId || a.subjectUserId !== b.subjectUserId) {
    throw new Error("PEM: tenant/subjectUser境界を越える操作は許可されません");
  }
}

/**
 * v4.0 4.1節「DB制約、Row Level Security又は同等の境界検証とアプリケーション認可を
 * 二重化する」の一環。アプリケーション層での境界チェックはこの関数群が担い、
 * DB制約(unique/index/FK)側の二重化はPhase 0A以降のPrismaスキーマ設計で行う。
 */
export function scopedWhere(ctx: PemSubjectContext): { tenantId: string; subjectUserId: string } {
  return { tenantId: ctx.tenantId, subjectUserId: ctx.subjectUserId };
}
