/**
 * 30日Purge Jobの「外部キーグラフ計算」部分(DB非依存の純粋関数群)。
 *
 * [PURGE-SCOPE-02F・2026-09-25新設] 旧実装(purgeJob.ts内に同居)は、
 * `db`をimportするモジュール内に純粋ロジックが混在していたため、DB無しの
 * 単体テスト(`npm run test:all`、DATABASE_URL不要が既存規約)から検証
 * できなかった。グラフ計算をこのファイルへ分離し、`__tests__/purgeGraph.test.ts`
 * で合成したFKグラフに対して順序・scope・循環遮断を直接検証できるようにした。
 *
 * 維持している確定事項(PURGE-01 fix02〜fix05、変更禁止):
 *   - FKは`pg_constraint.conkey/confkey`のordinal対応で得た列ペアを前提にする
 *     (呼出側`purgeJob.ts`のdiscoverForeignKeyEdges)。
 *   - NULL可能性は列単位ではなく複合FK「制約」単位で判定する(MATCH SIMPLE)。
 *   - scopeは列名に依存せず、FKグラフを推移的に辿って解決する。
 *
 * [PURGE-SCOPE-02F・実DB再現で発見した欠陥と是正]
 *   (1) 旧buildScopeChainは「users.id直接FKのseed」を「workspace推移伝播」より
 *       先に行っていた。そのため`formation_session_events`のように
 *       NOT NULLの複合FKで`formation_sessions`(workspace配下)へ繋がる表が、
 *       NULL可能な`actor_user_id`経由の"user" scopeに誤って割り当てられた。
 *   (2) 旧実装はNULL可能なFK列を「対象行についてNULLへ更新」してから削除して
 *       いたが、その列がscope判定そのもの(上記actor_user_id、
 *       ai_runs.capture_id、evidences.responsibility_id)である場合、
 *       NULL化によって削除条件が消え、DELETEが0件になって行が残存した。
 *       さらに`formation_session_events`等には「actor_type='USER'なら
 *       actor_user_id NOT NULL」のCHECK制約があり、NULL化自体が23514で失敗し、
 *       Formationを一度でも使ったユーザーのPurgeが必ずrollbackしていた
 *       (隔離Postgresへ全migrationを適用した実DBで再現)。
 *   是正:
 *     - scopeの経路は「NOT NULL制約のFK」を優先し、NOT NULL経路が無い表に
 *       限りNULL可能なFK(scope確定済みの業務表への所有関係)を使う。
 *       `users`/`workspaces`へ直接張られたNULL可能FK(=行為者参照、例:
 *       audit_logs.actor_user_id)はscopeの根拠にしない(削除対象ではなく
 *       参照の匿名化対象として扱う)。
 *     - 削除順序はNOT NULL制約を必須辺とし、NULL可能制約も循環を作らない
 *       限り順序辺へ加える。循環を作るNULL可能制約だけを「循環遮断
 *       (cycle breaker)」としてNULL化対象にする。これによりNULL化は真に
 *       必要な列(現スキーマではresponsibilities.superseded_by_*の2列)に
 *       限定され、CHECK制約付きの行為者列を触らない。
 */
import { createHash } from "node:crypto";

export interface ForeignKeyEdge {
  tableName: string;
  columnName: string;
  referencedTableName: string;
  referencedColumnName: string;
  /** pg_attribute.attnotnullの否定。 */
  isNullable: boolean;
  /** FK制約のOID(文字列)。複合FKの列をまとめる識別子。 */
  constraintId: string;
  /** 制約内での列位置(1始まり、conkey/confkeyのordinal)。 */
  ordinal: number;
}

export interface FkConstraint {
  constraintId: string;
  tableName: string;
  referencedTableName: string;
  /** ordinal順の参照元列。 */
  columns: string[];
  /** columnsと同じ順序の参照先列。 */
  referencedColumns: string[];
  /** 構成列のうちNULL可能な列(ordinal順)。 */
  nullableColumns: string[];
  /** 構成列のいずれかがNULL可能ならtrue(MATCH SIMPLEでは制約全体が不問になり得る)。 */
  isNullable: boolean;
}

export type ScopeKind = "workspace" | "user";
export const PURGE_ROOT_TABLES = ["workspaces", "users"] as const;
export type PurgeRootTable = (typeof PURGE_ROOT_TABLES)[number];
const ROOT_BY_KIND: Record<ScopeKind, PurgeRootTable> = { workspace: "workspaces", user: "users" };

export function isRootTable(tableName: string): tableName is PurgeRootTable {
  return (PURGE_ROOT_TABLES as readonly string[]).includes(tableName);
}

/** 生SQLへ埋め込む識別子の防御的検証(カタログ由来だが多層防御)。 */
const SAFE_IDENTIFIER = /^[a-z_][a-z0-9_]*$/;
export function assertSafeIdentifier(name: string): void {
  if (!SAFE_IDENTIFIER.test(name)) {
    throw new Error(`[purgeGraph] 識別子の形式が不正です(想定外の値のため処理を中止): ${name}`);
  }
}

function constraintSortKey(c: FkConstraint): string {
  return `${c.tableName}\u0000${c.columns.join(",")}\u0000${c.referencedTableName}\u0000${c.constraintId}`;
}

/** 列ペア単位のエッジを制約単位へまとめる(ordinal順・決定的な並び)。 */
export function groupForeignKeyConstraints(edges: ForeignKeyEdge[]): FkConstraint[] {
  const byId = new Map<string, ForeignKeyEdge[]>();
  for (const e of edges) {
    const list = byId.get(e.constraintId);
    if (list) list.push(e);
    else byId.set(e.constraintId, [e]);
  }
  const constraints: FkConstraint[] = [];
  for (const [constraintId, list] of byId) {
    const sorted = [...list].sort((a, b) => a.ordinal - b.ordinal);
    const first = sorted[0];
    for (const e of sorted) {
      if (e.tableName !== first.tableName || e.referencedTableName !== first.referencedTableName) {
        throw new Error(`[purgeGraph] 同一制約(${constraintId})内で表が一致しません(カタログ読取の異常)`);
      }
    }
    constraints.push({
      constraintId,
      tableName: first.tableName,
      referencedTableName: first.referencedTableName,
      columns: sorted.map((e) => e.columnName),
      referencedColumns: sorted.map((e) => e.referencedColumnName),
      nullableColumns: sorted.filter((e) => e.isNullable).map((e) => e.columnName),
      isNullable: sorted.some((e) => e.isNullable),
    });
  }
  return constraints.sort((a, b) => (constraintSortKey(a) < constraintSortKey(b) ? -1 : constraintSortKey(a) > constraintSortKey(b) ? 1 : 0));
}

export interface DeleteOrderResult {
  /** 削除してよい順(参照元→参照先)。全表を含む。 */
  order: string[];
  /** 順序へ加えると循環になるため、削除前に対象行でNULL化するNULL可能制約。 */
  cycleBreakers: FkConstraint[];
}

function reachable(adj: Map<string, Set<string>>, from: string, to: string): boolean {
  const stack = [from];
  const seen = new Set<string>();
  while (stack.length > 0) {
    const cur = stack.pop()!;
    if (cur === to) return true;
    if (seen.has(cur)) continue;
    seen.add(cur);
    for (const next of adj.get(cur) ?? []) stack.push(next);
  }
  return false;
}

/**
 * Kahnのtopological sort。辺X→Y(XのFKがYを参照)があればXがYより先に来る。
 * NOT NULL制約は必須辺。NULL可能制約は循環を作らない限り辺として採用し、
 * 循環を作るものだけをcycleBreakersとして返す(自己参照は順序制約にしない。
 * 単一DELETE文で同一表の親子を同時に削除できることを実DBで確認済み)。
 * 必須辺だけで循環する場合(NOT NULL同士の真の循環)は、想像で解決せず停止する。
 */
export function topologicalDeleteOrder(constraints: FkConstraint[], extraTables: string[] = []): DeleteOrderResult {
  const allTables = new Set<string>(extraTables);
  for (const c of constraints) {
    allTables.add(c.tableName);
    allTables.add(c.referencedTableName);
  }
  const adj = new Map<string, Set<string>>();
  for (const t of allTables) adj.set(t, new Set());

  for (const c of constraints) {
    if (c.tableName === c.referencedTableName || c.isNullable) continue;
    adj.get(c.tableName)!.add(c.referencedTableName);
  }
  const cycleBreakers: FkConstraint[] = [];
  for (const c of constraints) {
    if (c.tableName === c.referencedTableName || !c.isNullable) continue;
    if (adj.get(c.tableName)!.has(c.referencedTableName)) continue;
    if (reachable(adj, c.referencedTableName, c.tableName)) {
      cycleBreakers.push(c);
    } else {
      adj.get(c.tableName)!.add(c.referencedTableName);
    }
  }

  const inDegree = new Map<string, number>();
  for (const t of allTables) inDegree.set(t, 0);
  for (const [, targets] of adj) {
    for (const y of targets) inDegree.set(y, (inDegree.get(y) ?? 0) + 1);
  }
  const queue = [...allTables].filter((t) => inDegree.get(t) === 0).sort();
  const order: string[] = [];
  while (queue.length > 0) {
    const t = queue.shift()!;
    order.push(t);
    for (const next of adj.get(t) ?? []) {
      const remaining = (inDegree.get(next) ?? 0) - 1;
      inDegree.set(next, remaining);
      if (remaining === 0) queue.push(next);
    }
    queue.sort();
  }
  if (order.length !== allTables.size) {
    const stuck = [...allTables].filter((t) => !order.includes(t)).sort();
    throw new Error(
      `[purgeGraph] NOT NULL外部キーの循環参照を検出したため削除順序を確定できません。対象テーブル: ${stuck.join(", ")}`,
    );
  }
  return { order, cycleBreakers };
}

export interface ScopeLink {
  scopeKind: ScopeKind;
  /** この表の行をscopeへ結び付けるFK制約(親はroot表または他のscope確定表)。 */
  constraint: FkConstraint;
  /** NULL可能制約経由(NOT NULL経路が無かった表)ならtrue。 */
  viaNullableLink: boolean;
}

/**
 * FKグラフから各表のscope(workspace/user)と、その根拠となるFK制約を推移的に
 * 決める。優先順位:
 *   1. workspace: NOT NULL制約で不動点まで伝播 → NULL可能制約(root直結を除く)で
 *      1段追加 → 再びNOT NULLで伝播…を追加が無くなるまで繰り返す。
 *   2. user: 1で確定しなかった表について同様に行う。
 * root(`workspaces`/`users`)へ直接張られたNULL可能FKは「行為者参照」として
 * scopeの根拠にしない(同じworkspace scope内の表なら1で先に確定するため、
 * ここで除外されるのは他の所有経路を持たない表だけ。現スキーマではaudit_logs)。
 */
export function buildScopeChain(constraints: FkConstraint[]): Map<string, ScopeLink> {
  const chain = new Map<string, ScopeLink>();

  const tryLink = (c: FkConstraint, kind: ScopeKind, allowNullable: boolean): boolean => {
    if (chain.has(c.tableName) || isRootTable(c.tableName)) return false;
    if (c.tableName === c.referencedTableName) return false;
    if (c.isNullable && !allowNullable) return false;
    const root = ROOT_BY_KIND[kind];
    if (c.referencedTableName === root) {
      if (c.isNullable) return false; // 行為者参照(root直結のNULL可能FK)はscopeの根拠にしない。
      if (c.referencedColumns.length !== 1 || c.referencedColumns[0] !== "id") return false;
      chain.set(c.tableName, { scopeKind: kind, constraint: c, viaNullableLink: false });
      return true;
    }
    const parent = chain.get(c.referencedTableName);
    if (parent && parent.scopeKind === kind) {
      chain.set(c.tableName, { scopeKind: kind, constraint: c, viaNullableLink: c.isNullable });
      return true;
    }
    return false;
  };

  for (const kind of ["workspace", "user"] as const) {
    for (;;) {
      let changed = true;
      while (changed) {
        changed = false;
        for (const c of constraints) if (tryLink(c, kind, false)) changed = true;
      }
      let addedNullable = false;
      for (const c of constraints) {
        if (tryLink(c, kind, true)) {
          addedNullable = true;
          break; // 1本ずつ追加し、直後に再びNOT NULL経路を優先して伝播させる。
        }
      }
      if (!addedNullable) break;
    }
  }
  return chain;
}

/** snapshot作成順(親が先)。scope chainは森構造(各表の親は1つ)なので深さ優先で決まる。 */
export function snapshotCreationOrder(chain: Map<string, ScopeLink>): string[] {
  const order: string[] = [];
  const state = new Map<string, "visiting" | "done">();
  const visit = (t: string): void => {
    if (isRootTable(t)) return;
    const s = state.get(t);
    if (s === "done") return;
    if (s === "visiting") throw new Error(`[purgeGraph] scope chainに循環があります(想定外): ${t}`);
    state.set(t, "visiting");
    const link = chain.get(t);
    if (!link) throw new Error(`[purgeGraph] scope未解決の表がchain参照に現れました(想定外): ${t}`);
    visit(link.constraint.referencedTableName);
    state.set(t, "done");
    order.push(t);
  };
  for (const t of [...chain.keys()].sort()) visit(t);
  return order;
}

// ---------------------------------------------------------------------------
// 30日保持期間(DB設計書8章「通常削除はdeleted_at。30日後にPurge Job」)
// ---------------------------------------------------------------------------

export const PURGE_RETENTION_DAYS = 30;
const DAY_MS = 24 * 60 * 60 * 1000;

/** deletedAtからretentionDays経過した瞬間(この時刻ちょうどから対象になる)。 */
export function purgeEligibleAt(deletedAt: Date, retentionDays: number = PURGE_RETENTION_DAYS): Date {
  return new Date(deletedAt.getTime() + retentionDays * DAY_MS);
}

/** 旧findEligibleUsersForPurgeの`deletedAt <= now - 30日`(lte)と同じ境界。 */
export function isRetentionElapsed(deletedAt: Date, now: Date, retentionDays: number = PURGE_RETENTION_DAYS): boolean {
  return deletedAt.getTime() <= now.getTime() - retentionDays * DAY_MS;
}

export function retentionCutoff(now: Date, retentionDays: number = PURGE_RETENTION_DAYS): Date {
  return new Date(now.getTime() - retentionDays * DAY_MS);
}

// ---------------------------------------------------------------------------
// Manifest(dry-run/execute共通の件数台帳)とdigest・差分
// ---------------------------------------------------------------------------

export interface PurgeTableCount {
  tableName: string;
  scopeKind: ScopeKind;
  count: number;
}

export type PurgeColumnUpdateReason = "CYCLE_BREAK" | "ANONYMIZE_EXTERNAL_REFERENCE";

export interface PurgeColumnUpdateCount {
  tableName: string;
  columnNames: string[];
  referencedTableName: string;
  reason: PurgeColumnUpdateReason;
  count: number;
}

export interface PurgeManifest {
  userId: string;
  /** transaction内で再取得したmembership(昇順)。 */
  workspaceIds: string[];
  /** ISO8601(UTC)。 */
  deletedAt: string;
  /** 判定に使ったDB時刻(ISO8601・UTC)。digestには含めない。 */
  evaluatedAt: string;
  /** root以外の削除件数(削除順)。 */
  perTable: PurgeTableCount[];
  workspaceRowsDeleted: number;
  userRowsDeleted: number;
  cycleBreakUpdates: PurgeColumnUpdateCount[];
  anonymizedReferences: PurgeColumnUpdateCount[];
  /** FKで到達できずPurge対象外として保持される表(DEC-PURGE-02B未決)。 */
  retainedUnscopedTables: string[];
  totals: {
    /** perTable + workspace + user の合計(物理削除した行数)。 */
    rowsDeleted: number;
    /** cycleBreakUpdates + anonymizedReferencesの合計(削除せず更新した行数)。 */
    rowsUpdated: number;
  };
  digest: string;
}

export type PurgeManifestWithoutDigest = Omit<PurgeManifest, "digest" | "totals">;

export function computeManifestTotals(m: PurgeManifestWithoutDigest): PurgeManifest["totals"] {
  const tableRows = m.perTable.reduce((s, t) => s + t.count, 0);
  const updates = [...m.cycleBreakUpdates, ...m.anonymizedReferences].reduce((s, u) => s + u.count, 0);
  return { rowsDeleted: tableRows + m.workspaceRowsDeleted + m.userRowsDeleted, rowsUpdated: updates };
}

/** digest対象の正規形(時刻を除く、件数と対象の同一性のみ)。 */
export function canonicalManifestPayload(m: PurgeManifestWithoutDigest): string {
  return JSON.stringify({
    v: 1,
    userId: m.userId,
    workspaceIds: [...m.workspaceIds].sort(),
    deletedAt: m.deletedAt,
    perTable: m.perTable.map((t) => [t.tableName, t.scopeKind, t.count]),
    workspaceRowsDeleted: m.workspaceRowsDeleted,
    userRowsDeleted: m.userRowsDeleted,
    cycleBreakUpdates: m.cycleBreakUpdates.map((u) => [u.tableName, u.columnNames.join(","), u.referencedTableName, u.count]),
    anonymizedReferences: m.anonymizedReferences.map((u) => [u.tableName, u.columnNames.join(","), u.referencedTableName, u.count]),
    retainedUnscopedTables: [...m.retainedUnscopedTables].sort(),
  });
}

/** manifestの件数・対象同一性に対するsha256(dry-runとexecuteの対応付けに使う)。 */
export function computeManifestDigest(m: PurgeManifestWithoutDigest): string {
  return createHash("sha256").update(canonicalManifestPayload(m)).digest("hex");
}

export function finalizeManifest(m: PurgeManifestWithoutDigest): PurgeManifest {
  return { ...m, totals: computeManifestTotals(m), digest: computeManifestDigest(m) };
}

export interface PurgeDriftEntry {
  key: string;
  expected: string | number;
  actual: string | number;
}

/** dry-run(参考値)とexecute(transaction内の実値)の差分。 */
export function diffManifests(expected: PurgeManifest, actual: PurgeManifest): PurgeDriftEntry[] {
  const drift: PurgeDriftEntry[] = [];
  const cmp = (key: string, e: string | number, a: string | number): void => {
    if (e !== a) drift.push({ key, expected: e, actual: a });
  };
  cmp("userId", expected.userId, actual.userId);
  cmp("workspaceIds", [...expected.workspaceIds].sort().join(","), [...actual.workspaceIds].sort().join(","));
  cmp("deletedAt", expected.deletedAt, actual.deletedAt);
  const tableKeys = new Set([...expected.perTable, ...actual.perTable].map((t) => t.tableName));
  const eTable = new Map(expected.perTable.map((t) => [t.tableName, t.count]));
  const aTable = new Map(actual.perTable.map((t) => [t.tableName, t.count]));
  for (const k of [...tableKeys].sort()) cmp(`perTable.${k}`, eTable.get(k) ?? 0, aTable.get(k) ?? 0);
  cmp("workspaceRowsDeleted", expected.workspaceRowsDeleted, actual.workspaceRowsDeleted);
  cmp("userRowsDeleted", expected.userRowsDeleted, actual.userRowsDeleted);
  const updKey = (u: PurgeColumnUpdateCount): string => `${u.reason}.${u.tableName}.${u.columnNames.join("+")}->${u.referencedTableName}`;
  const eUpd = new Map([...expected.cycleBreakUpdates, ...expected.anonymizedReferences].map((u) => [updKey(u), u.count]));
  const aUpd = new Map([...actual.cycleBreakUpdates, ...actual.anonymizedReferences].map((u) => [updKey(u), u.count]));
  for (const k of [...new Set([...eUpd.keys(), ...aUpd.keys()])].sort()) cmp(`updates.${k}`, eUpd.get(k) ?? 0, aUpd.get(k) ?? 0);
  return drift;
}
