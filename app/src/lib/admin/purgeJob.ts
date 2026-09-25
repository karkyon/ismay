/**
 * 30日Purge Job(FN-PRV-01/DB設計書8章「通常削除はdeleted_at。30日後にPurge
 * Job」)。
 *
 * [設計判断・想像で全94モデルを手で列挙しない] 削除対象の表・削除順序・scopeは
 * Postgresの実際の外部キー制約(pg_constraint、複合FKの列対応はconkey/confkeyの
 * ordinalで復元)から実行時に算出する(グラフ計算は`purgeGraph.ts`、DB非依存)。
 *
 * [PURGE-SCOPE-02F・2026-09-25是正] 旧実装は「scope判定に使うNULL可能列」を
 * 削除前にNULL化していたため、ai_runs/evidences/pem_evidence_links等が削除
 * されず残存し、formation_session_events/project_context_link_eventsでは
 * actor排他CHECK(23514)でPurge全体が必ずrollbackしていた(Formationを使った
 * ユーザーはPurge不能)。是正として:
 *   1. transaction内で、変更を加える前に全scope表の対象行PKをtemp tableへ
 *      確定する(snapshot)。以後のNULL化・削除はすべてこのsnapshotに対して
 *      行うため、NULL化が削除条件を消すことは構造的に起きない。
 *   2. NULL化は「削除順序の循環を断つためにどうしても必要な列」
 *      (purgeGraph.topologicalDeleteOrderのcycleBreakers)に限定する。
 *   3. scope外の行から削除対象行へのNULL可能参照(例: audit_logs.actor_user_id)は
 *      匿名化(NULL化)として別件数で記録する。NOT NULL参照が外部に残る場合は、
 *      他人のデータを巻き込む(RESTRICT違反またはCASCADEによる越境削除)ため
 *      副作用0で拒否する(EXTERNAL_REFERENCE)。
 *
 * [PURGE-ELIGIBILITY-02C・2026-09-25是正] 旧`executePurgeForUser(target)`は
 * 呼出側が渡したEligibleUserForPurge(userId・workspaceIds)をそのまま削除根拠に
 * しており、transaction内で30日条件の再検証もrow lockもしていなかった。
 * 以後はuserIdだけを受け取り、transaction内で次を行う:
 *   - `SET LOCAL lock_timeout`のうえでusers行を`FOR UPDATE`
 *   - DB時刻(`now() AT TIME ZONE 'UTC'`)基準で`deleted_at IS NOT NULL`かつ
 *     30日経過を再検証(境界は旧実装と同じ`deletedAt <= now - 30日`)
 *   - workspace membershipを再取得し、そのworkspace行も`FOR UPDATE`
 *     (以後、対象workspaceへの新規行INSERTはFK検査のKEY SHARE lockで待たされる)
 *   - 対象workspaceに本人以外のmemberが居れば拒否(1 workspace=1 memberという
 *     現行不変条件が崩れた状態で他人のデータを消さないためのfail closed)
 * 対象なし・未削除(復元済み)・30日未満・共有workspace・外部NOT NULL参照・
 * lock競合は、いずれも副作用0の明示的な結果(PurgeRefusal)として返す。
 *
 * [PURGE-SCOPE-03A・2026-09-25] DEC-PURGE-02Bの利用者決定により、FKを持たなかった
 * event_logs/outbox_events/jobs/consentsへ明示的scope列(workspace_id→workspaces FK)を
 * 追加し、ai_runs.workspace_idにもFKを張った(migration 20260925010000_purge_scope_03a)。
 * これらはFKグラフ経由で自動的にworkspace scopeの削除対象になる。FKで到達しない表は
 * audit_logsだけになり、DEC-PURGE-02B §4.5(B)に従い行を保持して、本人に関係する行の
 * 接続元IP(ip_address)を墨消しする(RETAINED_AUDIT_REDACTION)。backfillで解決できな
 * かった旧行(明示的scope列がNULL)はcountLegacyUnscopedRowsで件数を表示する。
 *
 * [PURGE-REPORT-02E] 件数は「表ごとの削除」「workspace行」「user行」
 * 「循環遮断のNULL化」「外部参照の匿名化」を別フィールドで返し、物理削除の
 * 総数(rowsDeleted)と更新の総数(rowsUpdated)を区別する。dry-runとexecuteは
 * 同じ計画処理(planInTransaction)を通り、dry-runは最後にrollbackする。
 */
import { db } from "@/lib/db";
import { Prisma } from "@/generated/prisma/client";
import { OBJECT_KEY_COLUMNS } from "./purgeObjects";
import {
  unregisteredRetainedTables,
  assertSafeIdentifier,
  buildScopeChain,
  diffManifests,
  finalizeManifest,
  groupForeignKeyConstraints,
  isRetentionElapsed,
  isRootTable,
  purgeEligibleAt,
  retentionCutoff,
  snapshotCreationOrder,
  topologicalDeleteOrder,
  type FkConstraint,
  type ForeignKeyEdge,
  type PurgeColumnUpdateCount,
  type PurgeDriftEntry,
  type PurgeManifest,
  type PurgeTableCount,
  type ScopeKind,
  type ScopeLink,
} from "./purgeGraph";

export {
  PURGE_RETENTION_POLICY,
  PURGE_RETENTION_DAYS,
  isRetentionElapsed,
  purgeEligibleAt,
  diffManifests,
  type PurgeManifest,
  type PurgeTableCount,
  type PurgeColumnUpdateCount,
  type PurgeDriftEntry,
} from "./purgeGraph";

// ---------------------------------------------------------------------------
// カタログ読取
// ---------------------------------------------------------------------------

/** 全外部キー制約を列ペア単位で読む(複合FKはordinalで1:1対応、fix02の方式を維持)。 */
async function discoverForeignKeyEdges(): Promise<ForeignKeyEdge[]> {
  const rows = await db.$queryRaw<
    { table_name: string; column_name: string; referenced_table_name: string; referenced_column_name: string; is_nullable: boolean; constraint_id: string; ordinal: bigint }[]
  >`
    SELECT
      tbl.relname AS table_name,
      att.attname AS column_name,
      reftbl.relname AS referenced_table_name,
      refatt.attname AS referenced_column_name,
      NOT att.attnotnull AS is_nullable,
      con.oid::text AS constraint_id,
      pair.ord AS ordinal
    FROM pg_constraint con
    JOIN pg_class tbl ON tbl.oid = con.conrelid
    JOIN pg_namespace tbl_ns ON tbl_ns.oid = tbl.relnamespace
    JOIN pg_class reftbl ON reftbl.oid = con.confrelid
    JOIN pg_namespace reftbl_ns ON reftbl_ns.oid = reftbl.relnamespace
    CROSS JOIN LATERAL unnest(con.conkey, con.confkey) WITH ORDINALITY AS pair(conattnum, confattnum, ord)
    JOIN pg_attribute att ON att.attrelid = con.conrelid AND att.attnum = pair.conattnum
    JOIN pg_attribute refatt ON refatt.attrelid = con.confrelid AND refatt.attnum = pair.confattnum
    WHERE con.contype = 'f' AND tbl_ns.nspname = 'public' AND reftbl_ns.nspname = 'public'
  `;
  return rows.map((r) => ({
    tableName: r.table_name,
    columnName: r.column_name,
    referencedTableName: r.referenced_table_name,
    referencedColumnName: r.referenced_column_name,
    isNullable: r.is_nullable,
    constraintId: r.constraint_id,
    ordinal: Number(r.ordinal),
  }));
}

/** 各表の主キー列(ordinal順)。snapshotの行特定に使う(id以外のPKや複合PKも実在する)。 */
async function discoverPrimaryKeys(): Promise<Map<string, string[]>> {
  const rows = await db.$queryRaw<{ table_name: string; column_name: string; ordinal: bigint }[]>`
    SELECT tbl.relname AS table_name, att.attname AS column_name, pair.ord AS ordinal
    FROM pg_constraint con
    JOIN pg_class tbl ON tbl.oid = con.conrelid
    JOIN pg_namespace ns ON ns.oid = tbl.relnamespace
    CROSS JOIN LATERAL unnest(con.conkey) WITH ORDINALITY AS pair(attnum, ord)
    JOIN pg_attribute att ON att.attrelid = con.conrelid AND att.attnum = pair.attnum
    WHERE con.contype = 'p' AND ns.nspname = 'public'
  `;
  const map = new Map<string, { column: string; ordinal: number }[]>();
  for (const r of rows) {
    const list = map.get(r.table_name) ?? [];
    list.push({ column: r.column_name, ordinal: Number(r.ordinal) });
    map.set(r.table_name, list);
  }
  const result = new Map<string, string[]>();
  for (const [t, list] of map) result.set(t, list.sort((a, b) => a.ordinal - b.ordinal).map((x) => x.column));
  return result;
}

/** public schemaの全実表(Prisma管理表`_prisma_migrations`を除く)。 */
async function discoverPublicTables(): Promise<string[]> {
  const rows = await db.$queryRaw<{ table_name: string }[]>`
    SELECT c.relname AS table_name
    FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p')
  `;
  return rows.map((r) => r.table_name).filter((t) => !t.startsWith("_prisma")).sort();
}

// ---------------------------------------------------------------------------
// Scope
// ---------------------------------------------------------------------------

export interface PurgeScopeTable {
  tableName: string;
  scopeKind: ScopeKind;
  pkColumns: string[];
  link: ScopeLink;
}

export interface PurgeScope {
  /** 削除順(参照元が先)。root(workspaces/users)は含まない(最後に個別処理)。 */
  deleteOrder: PurgeScopeTable[];
  /** snapshot作成順(scope chainの親が先)。 */
  snapshotOrder: PurgeScopeTable[];
  /** 削除前に対象行でNULL化する循環遮断制約(参照元がscope内のもの)。 */
  cycleBreakers: FkConstraint[];
  /** 全FK制約(外部参照検査に使う)。 */
  constraints: FkConstraint[];
  /** FKでscopeへ到達できず、Purgeでは触れない表(DEC-PURGE-02B未決)。 */
  retainedUnscopedTables: string[];
  pkByTable: Map<string, string[]>;
}


export async function computePurgeScope(): Promise<PurgeScope> {
  const [edges, pkByTable, tables] = await Promise.all([discoverForeignKeyEdges(), discoverPrimaryKeys(), discoverPublicTables()]);
  const constraints = groupForeignKeyConstraints(edges);
  const { order, cycleBreakers } = topologicalDeleteOrder(constraints, tables);
  const chain = buildScopeChain(constraints);

  for (const c of constraints) {
    assertSafeIdentifier(c.tableName);
    assertSafeIdentifier(c.referencedTableName);
    for (const col of [...c.columns, ...c.referencedColumns]) assertSafeIdentifier(col);
  }
  for (const root of ["workspaces", "users"]) {
    const pk = pkByTable.get(root);
    if (!pk || pk.length !== 1 || pk[0] !== "id") {
      throw new Error(`[purgeJob] root表${root}の主キーが"id"単一列ではありません(想定外のため停止)`);
    }
  }
  const toScopeTable = (tableName: string): PurgeScopeTable => {
    const link = chain.get(tableName)!;
    const pk = pkByTable.get(tableName);
    if (!pk || pk.length === 0) {
      throw new Error(`[purgeJob] Purge対象表${tableName}に主キーがありません(行を特定できないため停止)`);
    }
    assertSafeIdentifier(tableName);
    for (const col of pk) assertSafeIdentifier(col);
    return { tableName, scopeKind: link.scopeKind, pkColumns: pk, link };
  };

  const retainedUnscopedTables = tables.filter((t) => !chain.has(t) && !isRootTable(t));
  const unregistered = unregisteredRetainedTables(retainedUnscopedTables);
  if (unregistered.length > 0) {
    throw new Error(
      `[purgeJob] 削除scope(workspaces/usersへのFK経路)に到達せず、保持理由(PURGE_RETENTION_POLICY)も登録されていない表があるため実行を拒否します(DEC-PURGE-02B): ${unregistered.join(", ")}`,
    );
  }

  return {
    deleteOrder: order.filter((t) => chain.has(t)).map(toScopeTable),
    snapshotOrder: snapshotCreationOrder(chain).map(toScopeTable),
    cycleBreakers: cycleBreakers.filter((c) => chain.has(c.tableName)),
    constraints,
    retainedUnscopedTables,
    pkByTable,
  };
}

/**
 * DEC-PURGE-02B §4.5(推奨B。2026-09-25利用者決定で明示的scope列方式を採用した際に
 * 併せて採用): audit_logsは法的・安全目的の監査証跡として行を保持し(DOC-09 §1)、
 * 本人が行為者または対象である行の接続元IPを墨消しする。行為者参照(actor_user_id)の
 * NULL化は外部参照の匿名化(ANONYMIZE_EXTERNAL_REFERENCE)として別途行われる。
 */
const RETAINED_AUDIT_REDACTION = {
  tableName: "audit_logs",
  columnNames: ["ip_address"],
  referencedTableName: "users",
  whereSql: `("actor_user_id" = $1 OR ("target_type" = 'User' AND "target_id" = $1)) AND "ip_address" IS NOT NULL`,
} as const;

export interface LegacyUnscopedCount {
  tableName: string;
  columnName: string;
  count: number;
}

/**
 * [PURGE-SCOPE-03A] 明示的scope列がNULLの旧行(migration時のbackfillで集約を
 * 解決できなかった行。集約自体が既に存在しない孤立行)の件数。これらはどの
 * ユーザーのPurgeでも到達できないため、運用者へ件数を示す(削除はしない)。
 */
export async function countLegacyUnscopedRows(scope?: PurgeScope): Promise<LegacyUnscopedCount[]> {
  const s = scope ?? (await computePurgeScope());
  const result: LegacyUnscopedCount[] = [];
  for (const t of s.deleteOrder) {
    if (!t.link.explicitScopeColumn) continue;
    const columnName = t.link.constraint.columns[0];
    assertSafeIdentifier(columnName);
    const rows = await db.$queryRawUnsafe<{ count: bigint }[]>(`SELECT COUNT(*)::bigint AS count FROM "${t.tableName}" WHERE "${columnName}" IS NULL`);
    result.push({ tableName: t.tableName, columnName, count: Number(rows[0]?.count ?? 0) });
  }
  return result;
}

// ---------------------------------------------------------------------------
// 対象一覧(参考値)
// ---------------------------------------------------------------------------

export interface EligibleUserForPurge {
  userId: string;
  email: string;
  deletedAt: Date;
  workspaceIds: string[];
}

/**
 * 30日経過したsoft-delete済みユーザーの一覧(表示・対象選択用の参考値)。
 * [PURGE-ELIGIBILITY-02C] この戻り値は削除の権限根拠ではない。実削除時は
 * executePurgeForUserがtransaction内で同じ条件を再検証し、membershipも
 * 再取得する。
 */
export async function findEligibleUsersForPurge(now: Date = new Date()): Promise<EligibleUserForPurge[]> {
  const users = await db.user.findMany({
    where: { deletedAt: { not: null, lte: retentionCutoff(now) } },
    select: { id: true, email: true, deletedAt: true, workspaceMembers: { select: { workspaceId: true } } },
    orderBy: { deletedAt: "asc" },
  });
  return users.map((u: { id: string; email: string; deletedAt: Date | null; workspaceMembers: { workspaceId: string }[] }) => ({
    userId: u.id,
    email: u.email,
    deletedAt: u.deletedAt!,
    workspaceIds: [...new Set(u.workspaceMembers.map((m) => m.workspaceId))].sort(),
  }));
}

// ---------------------------------------------------------------------------
// 結果型
// ---------------------------------------------------------------------------

export type PurgeRefusalStatus =
  | "NOT_FOUND"
  | "NOT_DELETED"
  | "RETENTION_NOT_ELAPSED"
  | "SHARED_WORKSPACE"
  | "EXTERNAL_REFERENCE"
  | "LOCK_CONFLICT";

export interface PurgeRefusal {
  status: PurgeRefusalStatus;
  userId: string;
  /** 運用者向けの説明(emailは含めない)。 */
  detail: string;
}

export type PurgePlanResult =
  | {
      status: "ELIGIBLE";
      manifest: PurgeManifest;
      /** [PURGE-OPS-03B] 削除対象行が参照するobject key(OBJECT_KEY_COLUMNS)。接頭辞一覧は含まない。 */
      dbObjectKeys: string[];
    }
  | PurgeRefusal;

export type PurgeExecutionResult =
  | {
      status: "PURGED";
      /** transaction内の実値。 */
      manifest: PurgeManifest;
      /** options.expected(dry-run manifest)を渡した場合のみ。差分が無ければ空配列。 */
      drift: PurgeDriftEntry[] | null;
      expectedDigest: string | null;
    }
  | PurgeRefusal;

export interface PurgeRequest {
  userId: string;
}

export interface PurgeRunOptions {
  /** users/workspaces行のlock待ち上限(ms)。既定5000。 */
  lockTimeoutMs?: number;
  /** interactive transaction全体の上限(ms)。既定600000。 */
  transactionTimeoutMs?: number;
}

/**
 * [PURGE-OPS-03B] 台帳・Object Storage段を1ユーザーtransactionへ組み込むためのhook。
 * どちらもusers/workspaces行lockと30日再検証・snapshot確定の後に呼ばれる。例外を投げると
 * transaction全体がrollbackされ、DBは一切変更されない。
 */
export interface PurgeExecuteHooks {
  /**
   * DB変更の直前(DEC-PURGE-02B §7.1の工程1〜3: 台帳snapshot・object削除・不存在確認)。
   * lockを保持したまま呼ばれるため、この間に対象ユーザーの復元等は割り込めない。
   */
  beforeDatabaseMutation?: (input: { userId: string; workspaceIds: string[]; dbObjectKeys: string[]; plannedManifest: PurgeManifest }) => Promise<void>;
  /** DB削除後・commit直前(同じtransaction内。台帳のDB_PURGEDを原子的に記録する)。 */
  beforeCommit?: (tx: Prisma.TransactionClient, input: { manifest: PurgeManifest; drift: PurgeDriftEntry[] | null }) => Promise<void>;
}

export interface PurgeExecuteOptions extends PurgeRunOptions {
  hooks?: PurgeExecuteHooks;
  /** dry-runのmanifest(参考値)。実値との差分をresult.driftへ記録する。 */
  expected?: PurgeManifest | null;
}

const DEFAULT_LOCK_TIMEOUT_MS = 5_000;
const DEFAULT_TRANSACTION_TIMEOUT_MS = 10 * 60 * 1000;
const TRANSACTION_MAX_WAIT_MS = 30_000;

function validatedLockTimeout(ms: number | undefined): number {
  const v = ms ?? DEFAULT_LOCK_TIMEOUT_MS;
  if (!Number.isInteger(v) || v < 1 || v > 600_000) {
    throw new Error(`[purgeJob] lockTimeoutMsが不正です(1〜600000の整数): ${String(ms)}`);
  }
  return v;
}

function isLockTimeoutError(err: unknown): boolean {
  const metaCode = (err as { meta?: { code?: unknown } } | null)?.meta?.code;
  if (metaCode === "55P03") return true;
  const text = err instanceof Error ? err.message : String(err);
  return /55P03|lock timeout/i.test(text);
}

// ---------------------------------------------------------------------------
// transaction内の適格性評価
// ---------------------------------------------------------------------------

interface EligibilityOk {
  status: "ELIGIBLE";
  userId: string;
  deletedAt: Date;
  evaluatedAt: Date;
  workspaceIds: string[];
}

const ISO_UTC_FORMAT = `'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'`;

async function evaluateEligibilityInTx(
  tx: Prisma.TransactionClient,
  userId: string,
  lock: boolean,
): Promise<EligibilityOk | PurgeRefusal> {
  if (lock) {
    await tx.$queryRawUnsafe(`SELECT "id" FROM "users" WHERE "id" = $1 FOR UPDATE`, userId);
  }
  // lock取得後に改めて読む(READ COMMITTEDでは文ごとに最新のcommit済み値が見える)。
  // deleted_atはPrismaがUTCで保存するtimestamp(3) without time zone。セッション
  // TimeZoneに依存しないよう、DB時刻もUTCの壁時計へ変換して文字列で比較材料にする。
  const rows = await tx.$queryRawUnsafe<{ id: string | null; deleted_at: string | null; db_now: string }[]>(
    `SELECT u."id", to_char(u."deleted_at", ${ISO_UTC_FORMAT}) AS deleted_at, to_char(now() AT TIME ZONE 'UTC', ${ISO_UTC_FORMAT}) AS db_now
     FROM (SELECT 1) AS one LEFT JOIN "users" u ON u."id" = $1`,
    userId,
  );
  const row = rows[0];
  if (!row || row.id === null) {
    return { status: "NOT_FOUND", userId, detail: "users行が存在しません(既にPurge済み、またはIDが不正)" };
  }
  const evaluatedAt = new Date(row.db_now);
  if (row.deleted_at === null) {
    return { status: "NOT_DELETED", userId, detail: "deletedAtがNULLです(削除要求されていない、または復元済み)" };
  }
  const deletedAt = new Date(row.deleted_at);
  if (!isRetentionElapsed(deletedAt, evaluatedAt)) {
    return {
      status: "RETENTION_NOT_ELAPSED",
      userId,
      detail: `保持期間未経過(deletedAt=${deletedAt.toISOString()} 対象になる時刻=${purgeEligibleAt(deletedAt).toISOString()} DB時刻=${evaluatedAt.toISOString()})`,
    };
  }
  const memberships = await tx.$queryRawUnsafe<{ workspace_id: string }[]>(
    `SELECT DISTINCT "workspace_id" FROM "workspace_members" WHERE "user_id" = $1 ORDER BY "workspace_id"`,
    userId,
  );
  const workspaceIds = memberships.map((m) => m.workspace_id);
  if (workspaceIds.length > 0) {
    if (lock) {
      await tx.$queryRawUnsafe(`SELECT "id" FROM "workspaces" WHERE "id" = ANY($1::text[]) ORDER BY "id" FOR UPDATE`, workspaceIds);
    }
    const others = await tx.$queryRawUnsafe<{ workspace_id: string }[]>(
      `SELECT DISTINCT "workspace_id" FROM "workspace_members" WHERE "workspace_id" = ANY($1::text[]) AND "user_id" <> $2 ORDER BY "workspace_id"`,
      workspaceIds,
      userId,
    );
    if (others.length > 0) {
      return {
        status: "SHARED_WORKSPACE",
        userId,
        detail: `本人以外のmemberが居るworkspaceがあるため削除しません(workspaceId=${others.map((o) => o.workspace_id).join(",")})`,
      };
    }
  }
  return { status: "ELIGIBLE", userId, deletedAt, evaluatedAt, workspaceIds };
}

// ---------------------------------------------------------------------------
// 計画(snapshot)と実行
// ---------------------------------------------------------------------------

const q = (identifier: string): string => {
  assertSafeIdentifier(identifier);
  return `"${identifier}"`;
};
const cols = (alias: string, columns: string[]): string => columns.map((c) => `${alias}.${q(c)}`).join(", ");
const tuple = (alias: string, columns: string[]): string => (columns.length === 1 ? `${alias}.${q(columns[0])}` : `(${cols(alias, columns)})`);
const pkJoin = (a: string, b: string, pk: string[]): string => pk.map((c) => `${a}.${q(c)} = ${b}.${q(c)}`).join(" AND ");

interface PlanContext {
  tx: Prisma.TransactionClient;
  scope: PurgeScope;
  eligibility: EligibilityOk;
  /** 表名 → snapshot temp table名(root含む)。 */
  snapshotName: Map<string, string>;
  /** 表名 → snapshot行数(root含む)。 */
  snapshotCount: Map<string, number>;
}

async function countOf(tx: Prisma.TransactionClient, sql: string, ...values: unknown[]): Promise<number> {
  const rows = await tx.$queryRawUnsafe<{ count: bigint }[]>(sql, ...values);
  return Number(rows[0]?.count ?? 0);
}

async function createSnapshots(tx: Prisma.TransactionClient, scope: PurgeScope, eligibility: EligibilityOk): Promise<Pick<PlanContext, "snapshotName" | "snapshotCount">> {
  const snapshotName = new Map<string, string>();
  const snapshotCount = new Map<string, number>();

  const rootSpecs: { table: "workspaces" | "users"; values: string[] }[] = [
    { table: "workspaces", values: eligibility.workspaceIds },
    { table: "users", values: [eligibility.userId] },
  ];
  for (const { table, values } of rootSpecs) {
    const name = `_purge_snap_root_${table}`;
    await tx.$executeRawUnsafe(`CREATE TEMP TABLE ${name} ON COMMIT DROP AS SELECT r."id" FROM ${q(table)} r WHERE false`);
    await tx.$executeRawUnsafe(`INSERT INTO ${name} SELECT r."id" FROM ${q(table)} r WHERE r."id" = ANY($1::text[])`, values);
    snapshotName.set(table, name);
    snapshotCount.set(table, await countOf(tx, `SELECT COUNT(*)::bigint AS count FROM ${name}`));
  }

  scope.snapshotOrder.forEach((t, index) => snapshotName.set(t.tableName, `_purge_snap_${index}`));
  for (const t of scope.snapshotOrder) {
    const name = snapshotName.get(t.tableName)!;
    const c = t.link.constraint;
    const parent = c.referencedTableName;
    const parentSnap = snapshotName.get(parent);
    const parentPk = scope.pkByTable.get(parent);
    if (!parentSnap || !parentPk) {
      throw new Error(`[purgeJob] 親表${parent}のsnapshotが未作成です(作成順の不整合、想定外)`);
    }
    await tx.$executeRawUnsafe(
      `CREATE TEMP TABLE ${name} ON COMMIT DROP AS
       SELECT ${cols("t", t.pkColumns)} FROM ${q(t.tableName)} t
       WHERE ${tuple("t", c.columns)} IN (
         SELECT ${cols("p", c.referencedColumns)} FROM ${q(parent)} p JOIN ${parentSnap} s ON ${pkJoin("p", "s", parentPk)}
       )`,
    );
    snapshotCount.set(t.tableName, await countOf(tx, `SELECT COUNT(*)::bigint AS count FROM ${name}`));
  }
  return { snapshotName, snapshotCount };
}

/** 参照先がsnapshot対象の制約について「snapshot外の行からの参照」を絞るWHERE句。 */
function externalReferenceWhere(ctx: PlanContext, c: FkConstraint): string {
  const refSnap = ctx.snapshotName.get(c.referencedTableName)!;
  const refPk = ctx.scope.pkByTable.get(c.referencedTableName)!;
  let where = `${tuple("x", c.columns)} IN (SELECT ${cols("r", c.referencedColumns)} FROM ${q(c.referencedTableName)} r JOIN ${refSnap} s ON ${pkJoin("r", "s", refPk)})`;
  const ownSnap = ctx.snapshotName.get(c.tableName);
  if (ownSnap) {
    const ownPk = ctx.scope.pkByTable.get(c.tableName)!;
    where += ` AND NOT EXISTS (SELECT 1 FROM ${ownSnap} sx WHERE ${pkJoin("sx", "x", ownPk)})`;
  }
  return where;
}

/** 循環遮断: snapshot内の行のうち、参照先snapshotの行を指しているもの。 */
function cycleBreakWhere(ctx: PlanContext, c: FkConstraint): string {
  const ownSnap = ctx.snapshotName.get(c.tableName)!;
  const ownPk = ctx.scope.pkByTable.get(c.tableName)!;
  const refSnap = ctx.snapshotName.get(c.referencedTableName)!;
  const refPk = ctx.scope.pkByTable.get(c.referencedTableName)!;
  return (
    `EXISTS (SELECT 1 FROM ${ownSnap} sx WHERE ${pkJoin("sx", "x", ownPk)})` +
    ` AND ${tuple("x", c.columns)} IN (SELECT ${cols("r", c.referencedColumns)} FROM ${q(c.referencedTableName)} r JOIN ${refSnap} s ON ${pkJoin("r", "s", refPk)})`
  );
}

interface PlanOutcome {
  refusal: PurgeRefusal | null;
  ctx: PlanContext;
  /** dry-run件数(snapshot基準)。 */
  plannedPerTable: PurgeTableCount[];
  plannedCycleBreaks: PurgeColumnUpdateCount[];
  plannedAnonymized: { constraint: FkConstraint; count: number }[];
  plannedRedactions: PurgeColumnUpdateCount[];
}

async function planInTransaction(tx: Prisma.TransactionClient, scope: PurgeScope, eligibility: EligibilityOk): Promise<PlanOutcome> {
  const snaps = await createSnapshots(tx, scope, eligibility);
  const ctx: PlanContext = { tx, scope, eligibility, ...snaps };

  const externalNotNull: string[] = [];
  const plannedAnonymized: { constraint: FkConstraint; count: number }[] = [];
  for (const c of scope.constraints) {
    if (!ctx.snapshotName.has(c.referencedTableName)) continue;
    if ((ctx.snapshotCount.get(c.referencedTableName) ?? 0) === 0) continue;
    const count = await countOf(tx, `SELECT COUNT(*)::bigint AS count FROM ${q(c.tableName)} x WHERE ${externalReferenceWhere(ctx, c)}`);
    if (count === 0) continue;
    if (c.isNullable) {
      plannedAnonymized.push({ constraint: c, count });
    } else {
      externalNotNull.push(`${c.tableName}(${c.columns.join(",")})→${c.referencedTableName}: ${count}行`);
    }
  }

  const plannedCycleBreaks: PurgeColumnUpdateCount[] = [];
  for (const c of scope.cycleBreakers) {
    if ((ctx.snapshotCount.get(c.tableName) ?? 0) === 0 || (ctx.snapshotCount.get(c.referencedTableName) ?? 0) === 0) continue;
    const count = await countOf(tx, `SELECT COUNT(*)::bigint AS count FROM ${q(c.tableName)} x WHERE ${cycleBreakWhere(ctx, c)}`);
    if (count > 0) {
      plannedCycleBreaks.push({ tableName: c.tableName, columnNames: c.nullableColumns, referencedTableName: c.referencedTableName, reason: "CYCLE_BREAK", count });
    }
  }

  const plannedRedactions: PurgeColumnUpdateCount[] = [];
  if (scope.retainedUnscopedTables.includes(RETAINED_AUDIT_REDACTION.tableName)) {
    const count = await countOf(tx, `SELECT COUNT(*)::bigint AS count FROM "${RETAINED_AUDIT_REDACTION.tableName}" WHERE ${RETAINED_AUDIT_REDACTION.whereSql}`, eligibility.userId);
    if (count > 0) {
      plannedRedactions.push({
        tableName: RETAINED_AUDIT_REDACTION.tableName,
        columnNames: [...RETAINED_AUDIT_REDACTION.columnNames],
        referencedTableName: RETAINED_AUDIT_REDACTION.referencedTableName,
        reason: "REDACT_RETAINED_AUDIT",
        count,
      });
    }
  }

  const plannedPerTable = scope.deleteOrder.map((t) => ({ tableName: t.tableName, scopeKind: t.scopeKind, count: ctx.snapshotCount.get(t.tableName) ?? 0 }));

  const refusal: PurgeRefusal | null =
    externalNotNull.length > 0
      ? {
          status: "EXTERNAL_REFERENCE",
          userId: eligibility.userId,
          detail: `削除対象外の行からNOT NULL外部キーで参照されているため削除しません(他人のデータを巻き込む恐れ): ${externalNotNull.join(" / ")}`,
        }
      : null;
  return { refusal, ctx, plannedPerTable, plannedCycleBreaks, plannedAnonymized, plannedRedactions };
}

function buildManifest(
  scope: PurgeScope,
  eligibility: EligibilityOk,
  perTable: PurgeTableCount[],
  workspaceRowsDeleted: number,
  userRowsDeleted: number,
  cycleBreakUpdates: PurgeColumnUpdateCount[],
  anonymizedReferences: PurgeColumnUpdateCount[],
  redactedRetainedRows: PurgeColumnUpdateCount[],
): PurgeManifest {
  return finalizeManifest({
    userId: eligibility.userId,
    workspaceIds: eligibility.workspaceIds,
    deletedAt: eligibility.deletedAt.toISOString(),
    evaluatedAt: eligibility.evaluatedAt.toISOString(),
    perTable,
    workspaceRowsDeleted,
    userRowsDeleted,
    cycleBreakUpdates,
    anonymizedReferences,
    redactedRetainedRows,
    retainedUnscopedTables: scope.retainedUnscopedTables,
  });
}

/** [PURGE-OPS-03B] snapshot内の行が参照するobject key(重複除去・昇順)。 */
async function collectDbObjectKeys(ctx: PlanContext): Promise<string[]> {
  const keys = new Set<string>();
  for (const entry of OBJECT_KEY_COLUMNS) {
    const snap = ctx.snapshotName.get(entry.tableName);
    const pk = ctx.scope.pkByTable.get(entry.tableName);
    if (!snap || !pk) continue;
    for (const col of entry.columnNames) {
      const rows = await ctx.tx.$queryRawUnsafe<{ k: string | null }[]>(
        `SELECT DISTINCT t.${q(col)} AS k FROM ${q(entry.tableName)} t JOIN ${snap} s ON ${pkJoin("t", "s", pk)} WHERE t.${q(col)} IS NOT NULL`,
      );
      for (const r of rows) if (r.k) keys.add(r.k);
    }
  }
  return [...keys].sort();
}

function plannedManifestOf(scope: PurgeScope, eligibility: EligibilityOk, plan: PlanOutcome): PurgeManifest {
  return buildManifest(
    scope,
    eligibility,
    plan.plannedPerTable,
    plan.ctx.snapshotCount.get("workspaces") ?? 0,
    plan.ctx.snapshotCount.get("users") ?? 0,
    plan.plannedCycleBreaks,
    plan.plannedAnonymized.map(({ constraint: c, count }) => ({
      tableName: c.tableName,
      columnNames: c.nullableColumns,
      referencedTableName: c.referencedTableName,
      reason: "ANONYMIZE_EXTERNAL_REFERENCE" as const,
      count,
    })),
    plan.plannedRedactions,
  );
}

class DryRunRollback extends Error {
  constructor(readonly result: PurgePlanResult) {
    super("PURGE_DRY_RUN_ROLLBACK");
  }
}

/**
 * dry-run: executeと同じ計画処理(適格性評価→snapshot→外部参照検査→件数算出)を
 * transaction内で行い、最後に必ずrollbackする(何も変更しない)。行lockは取らない。
 */
export async function dryRunPurgeForUser(request: PurgeRequest, options: PurgeRunOptions = {}): Promise<PurgePlanResult> {
  const userId = requireUserId(request);
  const scope = await computePurgeScope();
  try {
    await db.$transaction(
      async (tx: Prisma.TransactionClient): Promise<void> => {
        const eligibility = await evaluateEligibilityInTx(tx, userId, false);
        if (eligibility.status !== "ELIGIBLE") throw new DryRunRollback(eligibility);
        const plan = await planInTransaction(tx, scope, eligibility);
        if (plan.refusal) throw new DryRunRollback(plan.refusal);
        const manifest = plannedManifestOf(scope, eligibility, plan);
        const dbObjectKeys = await collectDbObjectKeys(plan.ctx);
        throw new DryRunRollback({ status: "ELIGIBLE", manifest, dbObjectKeys });
      },
      { timeout: options.transactionTimeoutMs ?? DEFAULT_TRANSACTION_TIMEOUT_MS, maxWait: TRANSACTION_MAX_WAIT_MS },
    );
  } catch (err) {
    if (err instanceof DryRunRollback) return err.result;
    throw err;
  }
  throw new Error("[purgeJob] dry-runがrollbackされずに終了しました(想定外)");
}

function requireUserId(request: PurgeRequest): string {
  const userId = request?.userId;
  if (typeof userId !== "string" || userId.length === 0) {
    throw new Error("[purgeJob] userIdが指定されていません");
  }
  return userId;
}

/**
 * 実削除。1ユーザーにつき1 transaction(途中で1つでも失敗すれば全体rollback、
 * 部分削除を残さない)。request.userId以外の入力は削除根拠に使わない。
 */
export async function executePurgeForUser(request: PurgeRequest, options: PurgeExecuteOptions = {}): Promise<PurgeExecutionResult> {
  const userId = requireUserId(request);
  const lockTimeoutMs = validatedLockTimeout(options.lockTimeoutMs);
  const scope = await computePurgeScope();
  try {
    return await db.$transaction(
      async (tx: Prisma.TransactionClient): Promise<PurgeExecutionResult> => {
        await tx.$executeRawUnsafe(`SET LOCAL lock_timeout = '${lockTimeoutMs}ms'`);
        const eligibility = await evaluateEligibilityInTx(tx, userId, true);
        if (eligibility.status !== "ELIGIBLE") return eligibility;

        const plan = await planInTransaction(tx, scope, eligibility);
        if (plan.refusal) return plan.refusal;
        const { ctx } = plan;

        // [PURGE-OPS-03B] DEC-PURGE-02B §7.1の工程1〜3(台帳snapshot・object削除・不存在確認)は
        // lockを保持したままDB変更より前に行う(DBを先に消すとobject keyを失い回収不能になるため)。
        if (options.hooks?.beforeDatabaseMutation) {
          await options.hooks.beforeDatabaseMutation({
            userId: eligibility.userId,
            workspaceIds: eligibility.workspaceIds,
            dbObjectKeys: await collectDbObjectKeys(ctx),
            plannedManifest: plannedManifestOf(scope, eligibility, plan),
          });
        }

        // 0) 保持するaudit_logsの墨消し(行為者参照のNULL化より前に、本人の行を特定できるうちに行う)。
        const redactedRetainedRows: PurgeColumnUpdateCount[] = [];
        for (const planned of plan.plannedRedactions) {
          const setSql = planned.columnNames.map((col) => `${q(col)} = NULL`).join(", ");
          const count = await tx.$executeRawUnsafe(`UPDATE ${q(planned.tableName)} SET ${setSql} WHERE ${RETAINED_AUDIT_REDACTION.whereSql}`, eligibility.userId);
          redactedRetainedRows.push({ ...planned, count });
        }
        // 1) 外部(snapshot外)からのNULL可能参照を匿名化する。
        const anonymizedReferences: PurgeColumnUpdateCount[] = [];
        for (const { constraint: c } of plan.plannedAnonymized) {
          const setSql = c.nullableColumns.map((col) => `${q(col)} = NULL`).join(", ");
          const count = await tx.$executeRawUnsafe(`UPDATE ${q(c.tableName)} AS x SET ${setSql} WHERE ${externalReferenceWhere(ctx, c)}`);
          anonymizedReferences.push({ tableName: c.tableName, columnNames: c.nullableColumns, referencedTableName: c.referencedTableName, reason: "ANONYMIZE_EXTERNAL_REFERENCE", count });
        }
        // 2) 削除順序の循環を断つ列だけをsnapshot内でNULL化する。
        const cycleBreakUpdates: PurgeColumnUpdateCount[] = [];
        for (const planned of plan.plannedCycleBreaks) {
          const c = scope.cycleBreakers.find(
            (b) => b.tableName === planned.tableName && b.referencedTableName === planned.referencedTableName && b.nullableColumns.join(",") === planned.columnNames.join(","),
          )!;
          const setSql = c.nullableColumns.map((col) => `${q(col)} = NULL`).join(", ");
          const count = await tx.$executeRawUnsafe(`UPDATE ${q(c.tableName)} AS x SET ${setSql} WHERE ${cycleBreakWhere(ctx, c)}`);
          cycleBreakUpdates.push({ ...planned, count });
        }
        // 3) snapshotに対して削除(参照元→参照先の順)。
        const perTable: PurgeTableCount[] = [];
        for (const t of scope.deleteOrder) {
          const snap = ctx.snapshotName.get(t.tableName)!;
          const deleted = (ctx.snapshotCount.get(t.tableName) ?? 0) === 0
            ? 0
            : await tx.$executeRawUnsafe(`DELETE FROM ${q(t.tableName)} AS t USING ${snap} s WHERE ${pkJoin("t", "s", t.pkColumns)}`);
          perTable.push({ tableName: t.tableName, scopeKind: t.scopeKind, count: deleted });
        }
        // 4) 最後にworkspace→user(このユーザーのmembershipだけ。他人のworkspaceには触れない)。
        const workspaceRowsDeleted = await tx.$executeRawUnsafe(
          `DELETE FROM "workspaces" AS t USING ${ctx.snapshotName.get("workspaces")} s WHERE t."id" = s."id"`,
        );
        const userRowsDeleted = await tx.$executeRawUnsafe(`DELETE FROM "users" AS t USING ${ctx.snapshotName.get("users")} s WHERE t."id" = s."id"`);

        const manifest = buildManifest(scope, eligibility, perTable, workspaceRowsDeleted, userRowsDeleted, cycleBreakUpdates, anonymizedReferences, redactedRetainedRows);
        const expected = options.expected ?? null;
        const drift = expected ? diffManifests(expected, manifest) : null;
        if (options.hooks?.beforeCommit) {
          await options.hooks.beforeCommit(tx, { manifest, drift });
        }
        return {
          status: "PURGED",
          manifest,
          drift,
          expectedDigest: expected ? expected.digest : null,
        };
      },
      { timeout: options.transactionTimeoutMs ?? DEFAULT_TRANSACTION_TIMEOUT_MS, maxWait: TRANSACTION_MAX_WAIT_MS },
    );
  } catch (err) {
    if (isLockTimeoutError(err)) {
      return { status: "LOCK_CONFLICT", userId, detail: `users/workspaces行のlockを${lockTimeoutMs}ms以内に取得できなかったため、何も変更せず中止しました` };
    }
    throw err;
  }
}
