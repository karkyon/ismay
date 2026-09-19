/**
 * 30日Purge Job(FN-PRV-01/DB設計書8章「通常削除はdeleted_at。30日後にPurge
 * Job」)。
 * 出典: `auth/account/delete/route.ts`コメント「[スコープ外・2026-08-23]
 * ...本パッチでは対象外とする」(1パッチ単位のスコープ外指定であり、恒久的な
 * 対象外決定ではない)。
 *
 * [設計判断・想像で全94モデルを手で列挙しない] このスキーマは94モデルに
 * 及び、今後のGateでも増え続ける。どのテーブルがworkspace/userのデータを
 * 保持するかを手作業で列挙すると、将来の新設テーブルを見落とすリスクが
 * ある(見落とし=退会したはずのデータが物理削除されず残り続ける、という
 * プライバシー機能として致命的な欠陥になる)。代わりに、Postgresの実際の
 * 外部キー制約(information_schema)を実行時に読み取り、削除順序を
 * topological sortで動的に算出する。これにより将来テーブルが追加されても
 * 自動的に対象へ含まれる。
 *
 * [削除順序のアルゴリズム] エッジX→Y(テーブルXがテーブルYを参照する外部キー
 * 列を持つ)がある場合、Xの行はYの行より先に削除しなければならない(既存の
 * FK制約はすべてRESTRICT、このリポジトリ全体で一貫した方針)。これは
 * 「Yの入次数(=Yを参照する未処理テーブルの数)が0になった時点でYを処理
 * 可能」というKahnのtopological sortそのもので、leafテーブル(誰からも
 * 参照されない)が最初に、`workspaces`/`users`(最も多く参照される)が
 * 最後に処理される順序を自動的に導く。
 *
 * [workspace-scoped列の特定] 列名の命名規則(workspaceId/ownerSubjectUserId
 * /createdById等、このコードベースだけでも複数の慣行が混在)に依存せず、
 * 外部キー制約自体が`workspaces.id`を参照している列を機械的に特定する。
 * user-scoped側は、workspace-scoped列を持たない(=workspacesを経由しない)
 * テーブルに限り、`users.id`を参照する列で絞り込む(1 workspace=1 memberが
 * 現状の不変条件であるため、workspace-scoped削除で本人のデータは網羅される。
 * `retiredById`等、他人の行に残る「行為者としての参照」列は削除条件に含め
 * ない——他人のPatternを誤って削除しないため。詳細はPURGE_DESIGN_NOTEを
 * 参照)。
 */
import { db } from "@/lib/db";
import { Prisma } from "@/generated/prisma/client";

interface ForeignKeyEdge {
  tableName: string;
  columnName: string;
  referencedTableName: string;
  referencedColumnName: string;
}

/** information_schemaから全外部キー制約を読み取る(生SQL、パラメータ無しの固定クエリ)。 */
async function discoverForeignKeyEdges(): Promise<ForeignKeyEdge[]> {
  const rows = await db.$queryRaw<
    { table_name: string; column_name: string; referenced_table_name: string; referenced_column_name: string }[]
  >`
    SELECT
      tc.table_name AS table_name,
      kcu.column_name AS column_name,
      ccu.table_name AS referenced_table_name,
      ccu.column_name AS referenced_column_name
    FROM information_schema.table_constraints tc
    JOIN information_schema.key_column_usage kcu
      ON tc.constraint_name = kcu.constraint_name AND tc.table_schema = kcu.table_schema
    JOIN information_schema.constraint_column_usage ccu
      ON tc.constraint_name = ccu.constraint_name AND tc.table_schema = ccu.table_schema
    WHERE tc.constraint_type = 'FOREIGN KEY' AND tc.table_schema = 'public'
  `;
  return rows.map((r: { table_name: string; column_name: string; referenced_table_name: string; referenced_column_name: string }) => ({
    tableName: r.table_name,
    columnName: r.column_name,
    referencedTableName: r.referenced_table_name,
    referencedColumnName: r.referenced_column_name,
  }));
}

/**
 * Kahnのtopological sort。エッジX→Y(Xの外部キーがYを参照)がある場合、
 * 戻り値の配列でXがYより前に来る(=Xを先に削除してよい順序)。
 * [循環検出] 既存FKはすべてRESTRICTでかつ自己参照(同一テーブル内の列、
 * 例: supersedesFeedbackEventId)は削除順序に影響しないため無視する。
 * それ以外の真の循環(A→B→A)が万一存在する場合は、想像で強制解決せず
 * エラーとして停止する(不完全な順序で削除を強行しない)。
 */
function topologicalDeleteOrder(edges: ForeignKeyEdge[]): string[] {
  const allTables = new Set<string>();
  for (const e of edges) {
    allTables.add(e.tableName);
    allTables.add(e.referencedTableName);
  }
  const inDegree = new Map<string, number>();
  const outgoing = new Map<string, string[]>();
  for (const t of allTables) {
    inDegree.set(t, 0);
    outgoing.set(t, []);
  }
  for (const e of edges) {
    if (e.tableName === e.referencedTableName) continue; // 自己参照は順序制約にならない。
    outgoing.get(e.tableName)!.push(e.referencedTableName);
    inDegree.set(e.referencedTableName, (inDegree.get(e.referencedTableName) ?? 0) + 1);
  }

  const queue: string[] = [...allTables].filter((t) => inDegree.get(t) === 0).sort();
  const order: string[] = [];
  while (queue.length > 0) {
    const t = queue.shift()!;
    order.push(t);
    for (const next of outgoing.get(t) ?? []) {
      const remaining = (inDegree.get(next) ?? 0) - 1;
      inDegree.set(next, remaining);
      if (remaining === 0) queue.push(next);
    }
    queue.sort();
  }

  if (order.length !== allTables.size) {
    const stuck = [...allTables].filter((t) => !order.includes(t));
    throw new Error(
      `[purgeJob] 外部キーの循環参照を検出したため削除順序を確定できません。対象テーブル: ${stuck.join(", ")}`,
    );
  }
  return order;
}

export interface PurgeScopeTable {
  tableName: string;
  /** このテーブルのうち、削除対象の絞り込みに使う列(workspaces.idまたはusers.idを参照するFK列)。 */
  filterColumn: string;
  /** "workspace" | "user"。usersテーブル自体を"user"扱いにする特別枠も含む。 */
  scopeKind: "workspace" | "user";
}

/**
 * FKグラフから、削除対象スコープ(各テーブル・絞り込み列・削除順序)を
 * 算出する。`workspaces`を直接参照する列を持つテーブルは"workspace"
 * スコープとし、それ以外で`users`を直接参照する列を持つテーブルは"user"
 * スコープとする(workspace-scopedの方を優先する——1 workspace=1 member
 * という現状の不変条件の下では、workspace側で本人のデータは網羅される。
 * user-scoped側は、UserSession等workspaceを経由しない真にuser単体の
 * テーブルのためだけに使う)。
 */
export async function computePurgeScope(): Promise<{ order: PurgeScopeTable[]; deleteOrder: string[] }> {
  const edges = await discoverForeignKeyEdges();
  const deleteOrder = topologicalDeleteOrder(edges);

  const workspaceFilterColumnByTable = new Map<string, string>();
  const userFilterColumnByTable = new Map<string, string>();
  for (const e of edges) {
    if (e.referencedTableName === "workspaces" && e.referencedColumnName === "id") {
      if (!workspaceFilterColumnByTable.has(e.tableName)) {
        workspaceFilterColumnByTable.set(e.tableName, e.columnName);
      }
    }
    if (e.referencedTableName === "users" && e.referencedColumnName === "id") {
      if (!userFilterColumnByTable.has(e.tableName)) {
        userFilterColumnByTable.set(e.tableName, e.columnName);
      }
    }
  }

  const order: PurgeScopeTable[] = [];
  for (const tableName of deleteOrder) {
    if (tableName === "workspaces" || tableName === "users") continue; // 最後に個別処理する。
    const wsCol = workspaceFilterColumnByTable.get(tableName);
    if (wsCol) {
      order.push({ tableName, filterColumn: wsCol, scopeKind: "workspace" });
      continue;
    }
    const userCol = userFilterColumnByTable.get(tableName);
    if (userCol) {
      order.push({ tableName, filterColumn: userCol, scopeKind: "user" });
    }
    // どちらも無いテーブル(workspaces/usersを一切参照しない、真にグローバルな
    // 参照データ)は対象外のまま(想像で無関係なテーブルへ絞り込み条件を
    // 発明しない)。
  }
  return { order, deleteOrder };
}

/** [防御的検証] information_schema由来とはいえ、生SQLへ埋め込む識別子は
 *  念のため安全なパターンへ限定する(多層防御、実際にこの形式を外れる
 *  識別子はPostgres自体が許容しないため通常到達しない)。 */
const SAFE_IDENTIFIER = /^[a-z_][a-z0-9_]*$/;
function assertSafeIdentifier(name: string): void {
  if (!SAFE_IDENTIFIER.test(name)) {
    throw new Error(`[purgeJob] 識別子の形式が不正です(想定外の値のため処理を中止): ${name}`);
  }
}

export interface EligibleUserForPurge {
  userId: string;
  email: string;
  deletedAt: Date;
  workspaceIds: string[];
}

/** [30日基準] deletedAtから30日以上経過(現在時刻基準)、かつ本人再有効化
 *  (このリポジトリにアカウント復元APIは存在しないため理論上は起きないが、
 *  念のためdeletedAt IS NOT NULLで再確認する)。 */
export async function findEligibleUsersForPurge(now: Date = new Date()): Promise<EligibleUserForPurge[]> {
  const cutoff = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
  const users = await db.user.findMany({
    where: { deletedAt: { not: null, lte: cutoff } },
    select: { id: true, email: true, deletedAt: true, workspaceMembers: { select: { workspaceId: true } } },
  });
  return users.map((u: { id: string; email: string; deletedAt: Date | null; workspaceMembers: { workspaceId: string }[] }) => ({
    userId: u.id,
    email: u.email,
    deletedAt: u.deletedAt!,
    workspaceIds: u.workspaceMembers.map((m) => m.workspaceId),
  }));
}

export interface PurgeTableCount {
  tableName: string;
  scopeKind: "workspace" | "user";
  count: number;
}

/** dry-run: 何も削除せず、各テーブルで削除対象となる行数のみを数える。 */
export async function dryRunPurgeForUser(target: EligibleUserForPurge): Promise<PurgeTableCount[]> {
  const { order } = await computePurgeScope();
  const results: PurgeTableCount[] = [];
  for (const t of order) {
    assertSafeIdentifier(t.tableName);
    assertSafeIdentifier(t.filterColumn);
    const values = t.scopeKind === "workspace" ? target.workspaceIds : [target.userId];
    if (values.length === 0) {
      results.push({ tableName: t.tableName, scopeKind: t.scopeKind, count: 0 });
      continue;
    }
    const rows = await db.$queryRawUnsafe<{ count: bigint }[]>(
      `SELECT COUNT(*)::bigint AS count FROM "${t.tableName}" WHERE "${t.filterColumn}" = ANY($1)`,
      values,
    );
    results.push({ tableName: t.tableName, scopeKind: t.scopeKind, count: Number(rows[0]?.count ?? 0) });
  }
  return results;
}

export interface PurgeExecutionResult {
  userId: string;
  email: string;
  perTable: PurgeTableCount[];
  totalRowsDeleted: number;
}

/**
 * 実削除。1ユーザーにつき1 transactionで全テーブル+workspace行+user行を
 * 削除する(全体が1つの原子的操作、途中で1つでも失敗すれば全体をrollbackし、
 * 部分的な物理削除を絶対に残さない)。
 */
export async function executePurgeForUser(target: EligibleUserForPurge): Promise<PurgeExecutionResult> {
  const { order } = await computePurgeScope();
  const perTable: PurgeTableCount[] = [];

  await db.$transaction(async (tx: Prisma.TransactionClient) => {
    for (const t of order) {
      assertSafeIdentifier(t.tableName);
      assertSafeIdentifier(t.filterColumn);
      const values = t.scopeKind === "workspace" ? target.workspaceIds : [target.userId];
      if (values.length === 0) {
        perTable.push({ tableName: t.tableName, scopeKind: t.scopeKind, count: 0 });
        continue;
      }
      const deleted = await tx.$executeRawUnsafe(
        `DELETE FROM "${t.tableName}" WHERE "${t.filterColumn}" = ANY($1)`,
        values,
      );
      perTable.push({ tableName: t.tableName, scopeKind: t.scopeKind, count: deleted });
    }
    // [最後にworkspace→user] topological sortの対象から意図的に除外していた
    // 2テーブルをここで処理する(このtargetが所有するworkspaceのみ、他人の
    // workspaceには一切触れない)。
    if (target.workspaceIds.length > 0) {
      await tx.$executeRawUnsafe(`DELETE FROM "workspaces" WHERE "id" = ANY($1)`, target.workspaceIds);
    }
    await tx.$executeRawUnsafe(`DELETE FROM "users" WHERE "id" = $1`, target.userId);
  });

  const totalRowsDeleted = perTable.reduce((sum, t) => sum + t.count, 0);
  return { userId: target.userId, email: target.email, perTable, totalRowsDeleted };
}
