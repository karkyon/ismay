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
 * 外部キー制約(pg_constraint、複合FKの列対応をordinalで正しく復元できる
 * カタログ。2026-09-20実DB検証で is_nullableをconstraint_column_usage
 * 経由で読む方式が複合FKで列を誤対応させる不具合を発見し、pg_constraintの
 * conkey/confkeyベースへ是正した)を実行時に読み取り、削除順序を
 * topological sortで動的に算出する。これにより将来テーブルが追加されても
 * 自動的に対象へ含まれる。
 *
 * [削除順序のアルゴリズム] エッジX→Y(テーブルXがテーブルYを参照する外部キー
 * 列を持つ)がある場合、Xの行はYの行より先に削除しなければならない(既存の
 * FK制約は主にRESTRICT、一部1:1detail系テーブル(TaskDetail等)はCASCADE。
 * いずれの場合もXを先に削除する順序は安全に機能する——RESTRICTなら必須、
 * CASCADEなら冗長だが無害)。これは「Yの入次数(=Yを参照する未処理テーブル
 * の数)が0になった時点でYを処理可能」というKahnのtopological sortそのもの
 * で、leafテーブル(誰からも参照されない)が最初に、`workspaces`/`users`
 * (最も多く参照される)が最後に処理される順序を自動的に導く。
 *
 * [スコープ列の特定・推移的解決・2026-09-20実DB検証で発見・是正] 列名の
 * 命名規則(workspaceId/ownerSubjectUserId/createdById等、このコードベース
 * だけでも複数の慣行が混在)に依存せず、外部キー制約自体が`workspaces.id`
 * (または`users.id`)へ辿り着けるかどうかで機械的に特定する。[旧実装の欠陥]
 * 「そのテーブル自身がworkspaces.id/users.idを直接参照する列を持つ場合の
 * み」を対象にしていたため、単一列FKで1階層以上離れたテーブル(例:
 * task_details.responsibilityId → responsibilities.id、task_details自身は
 * workspace_id列を持たない)が発見対象から漏れ、94テーブル中54テーブルが
 * Purge対象から漏れていた(実DB検証で発見)。是正として、列名の一致を
 * 要求せず「参照先テーブルが既にスコープ確定済みか」だけを条件に不動点まで
 * 推移的に伝播させ(buildScopeChain)、直接列を持たないテーブルは非相関
 * サブクエリ(buildScopeWhereSql)で絞り込む。user-scoped側は、
 * workspace-scopedで捕捉できないテーブルに限り、`users.id`へ辿り着ける列で
 * 絞り込む(1 workspace=1 memberが現状の不変条件であるため、workspace-scoped
 * 削除で本人のデータは網羅される。`retiredById`等、他人の行に残る「行為者
 * としての参照」列は削除条件に含めない——他人のPatternを誤って削除しない
 * ため。詳細はPURGE_DESIGN_NOTEを参照)。
 */
import { db } from "@/lib/db";
import { Prisma } from "@/generated/prisma/client";

interface ForeignKeyEdge {
  tableName: string;
  columnName: string;
  referencedTableName: string;
  referencedColumnName: string;
  /** [実DB検証で発見] Responsibility.supersededByReceiptId等、意図的な
   *  「後から埋める任意の逆参照」列がworkspace内に実在し、これが
   *  responsibilities⇄responsibility_correction_receiptsのような真の
   *  循環を作ることを実DB実行で検出した。列名を想像で個別に列挙せず、
   *  pg_attribute.attnotnullを機械的に読み取ることで、どの列がこの種の
   *  「任意の逆参照」かを判定する。 */
  isNullable: boolean;
  /** [複合FK是正・2026-09-20実DB検証で発見] 同じFK制約(例: Responsibility
   *  (supersededByReceiptId, workspaceId) → ResponsibilityCorrectionReceipt
   *  (id, workspaceId))に属する列同士をグループ化するための識別子(制約の
   *  OID、単一列FKでも一意)。topologicalDeleteOrderが「同じ制約内の列を
   *  一括で順序制約から除外するか」を判定するために使う(理由は
   *  topologicalDeleteOrderのコメント参照)。 */
  constraintId: string;
}

/**
 * Postgresカタログから全外部キー制約を読み取る(生SQL、パラメータ無しの
 * 固定クエリ)。
 *
 * [複合FK列対応の是正・2026-09-20実DB検証で発見・是正] 旧実装は
 * information_schema.key_column_usageとconstraint_column_usageを
 * constraint_nameのみで結合していたが、複合FK(このコードベースの
 * (xxxId, workspaceId) → (id, workspaceId)パターン全体、tenant境界の
 * 二重防御として全域で意図的に多用されている設計)では、参照元列がN列・
 * 参照先列がN列ある場合にN×Nの直積(2列なら2×2=4行)が生成され、本来
 * 対応しない列同士(例: Responsibility.workspaceId →
 * ResponsibilityCorrectionReceipt.id)という実在しない偽のエッジが混入して
 * いた。この偽エッジはworkspaceId自体が必須列であるためNOT NULLとして
 * 扱われ、実在する逆方向の真のNOT NULLエッジ(receipt.sourceResponsibilityId
 * → responsibility.id)と組み合わさってNOT NULL同士の偽の循環を作り、
 * PATTERN-PURGE-01 fix01(NULL可能な列を個別に除外する是正)適用後もなお
 * topologicalDeleteOrderを停止させていた(実DB受入試験で再現・特定)。
 *
 * 是正: Postgresカタログ(pg_constraint.conkey/confkey)を
 * `unnest(...) WITH ORDINALITY`で同じ添字同士を対応付けて読み取る
 * (PostgreSQL公式ドキュメント: confkeyはconkeyと同じ順序で対応する列を
 * 列挙する)。これにより複合FKでも列が正しく1:1で対応し、偽エッジが発生
 * しない。また各行にconstraintId(制約のOID)を付与し、後続の
 * topologicalDeleteOrderが複合FKを制約単位で正しく扱えるようにする。
 */
async function discoverForeignKeyEdges(): Promise<ForeignKeyEdge[]> {
  const rows = await db.$queryRaw<
    { table_name: string; column_name: string; referenced_table_name: string; referenced_column_name: string; is_nullable: boolean; constraint_id: string }[]
  >`
    SELECT
      tbl.relname AS table_name,
      att.attname AS column_name,
      reftbl.relname AS referenced_table_name,
      refatt.attname AS referenced_column_name,
      NOT att.attnotnull AS is_nullable,
      con.oid::text AS constraint_id
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
  return rows.map((r: { table_name: string; column_name: string; referenced_table_name: string; referenced_column_name: string; is_nullable: boolean; constraint_id: string }) => ({
    tableName: r.table_name,
    columnName: r.column_name,
    referencedTableName: r.referenced_table_name,
    referencedColumnName: r.referenced_column_name,
    isNullable: r.is_nullable,
    constraintId: r.constraint_id,
  }));
}

/**
 * Kahnのtopological sort。エッジX→Y(Xの外部キーがYを参照)がある場合、
 * 戻り値の配列でXがYより前に来る(=Xを先に削除してよい順序)。
 *
 * [循環の断ち切り・実DB検証で発見・是正] NOT NULL制約の列のみを順序制約
 * として使う。NULL可能な列(例: Responsibility.supersededByReceiptId⇄
 * ResponsibilityCorrectionReceipt.responsibilityId)は「後から埋める任意の
 * 逆参照」であり、削除順序の制約にはしない。代わりに、削除実行の直前に
 * これらのNULL可能な列を対象行についてNULLへ更新してから通常の削除順序を
 * 実行することで、循環を安全に断ち切る(nullOutNullableBackReferences関数)。
 * 自己参照(同一テーブル内の列)も同様に順序制約から除外する。
 * [複合FKは制約単位で判定・2026-09-20実DB検証で発見・是正] Postgresの
 * 複合FKはデフォルトMATCH SIMPLEであり、複合キーを構成する列のうち1つでも
 * NULLであれば制約全体が不問になる(PostgreSQL公式ドキュメント「MATCH
 * SIMPLE...if any of them are null, the row is not required to have a
 * match」)。そのため「列ごと」にNULL可能性を判定するのではなく「同じ制約
 * (constraintId)に属する列のいずれかがNULL可能」であれば、その制約が
 * 生成する全ての列ペアを一括で順序制約から除外する。列単位で判定すると、
 * 複合キーの中のNOT NULL列(例: workspaceId、これ自体は必須列)だけが
 * 独立した順序制約として残ってしまい、真にNULLへ更新される列(例:
 * supersededByReceiptId)を除外しても循環が解消されない(実DB受入試験で
 * 再現・特定した不具合そのもの)。
 *
 * これでもなお解決できない循環(NOT NULL制約同士の真の循環)が万一存在する
 * 場合は、想像で強制解決せずエラーとして停止する。
 */
function topologicalDeleteOrder(edges: ForeignKeyEdge[]): string[] {
  const allTables = new Set<string>();
  for (const e of edges) {
    allTables.add(e.tableName);
    allTables.add(e.referencedTableName);
  }

  // 同じ制約(constraintId)に属する列のうち1つでもNULL可能なら、その制約
  // 全体をMATCH SIMPLE的に「NULL可能」として扱う(上記コメント参照)。
  const constraintHasNullableMember = new Map<string, boolean>();
  for (const e of edges) {
    const prev = constraintHasNullableMember.get(e.constraintId) ?? false;
    constraintHasNullableMember.set(e.constraintId, prev || e.isNullable);
  }

  const inDegree = new Map<string, number>();
  const outgoing = new Map<string, string[]>();
  for (const t of allTables) {
    inDegree.set(t, 0);
    outgoing.set(t, []);
  }
  const seenOrderEdge = new Set<string>();
  for (const e of edges) {
    if (e.tableName === e.referencedTableName) continue; // 自己参照は順序制約にならない。
    if (constraintHasNullableMember.get(e.constraintId)) continue; // NULL可能な逆参照(複合FKの場合は制約全体)は別途null-outで処理する。
    const pairKey = `${e.tableName}->${e.referencedTableName}`;
    if (seenOrderEdge.has(pairKey)) continue; // 複合FKの列数だけ同じ有向辺が重複するため1本にまとめる。
    seenOrderEdge.add(pairKey);
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
      `[purgeJob] NOT NULL外部キーの循環参照を検出したため削除順序を確定できません。対象テーブル: ${stuck.join(", ")}`,
    );
  }
  return order;
}

export interface PurgeScopeTable {
  tableName: string;
  /** "workspace" | "user"。usersテーブル自体を"user"扱いにする特別枠も含む。 */
  scopeKind: "workspace" | "user";
  /** [fix03・2026-09-20実DB検証で発見・是正] このテーブルの行を絞り込む
   *  WHERE句(パラメータ$1はtarget.workspaceIds/target.userId)。旧実装は
   *  「テーブル自身がworkspaces.id/users.idを直接参照する列を持つ場合のみ」
   *  を対象にしており、単一列FKで1階層以上離れたテーブル(例:
   *  task_details.responsibilityId → responsibilities.id、
   *  responsibilitiesは直接workspaces.idを参照するが、task_details自身は
   *  workspace_id列を持たない)が発見対象から漏れていた。実DB検証で
   *  94テーブル中40テーブルしか捕捉できていないことを確認(残り54テーブル
   *  中50テーブルは本来workspace/userスコープ配下で物理削除されるべき行を
   *  持つ)。是正として、列名の一致を要求せず「参照先テーブルが既に
   *  スコープ確定済みか」だけを条件に推移的にスコープを解決し(BFS的な
   *  不動点反復)、直接列を持たないテーブルは
   *  `"col" IN (SELECT "parentCol" FROM "parentTable" WHERE <parentのWHERE句>)`
   *  という非相関(non-correlated)サブクエリで絞り込む。削除順序上、子テーブル
   *  は親テーブルより先に削除されるため、この時点で親テーブルの対象行は
   *  まだ存在しており、このサブクエリは正しく解決できる。 */
  whereSql: string;
}

export interface NullableBackReference {
  tableName: string;
  /** NULLへ更新する対象列(NULL可能な逆参照FK)。 */
  columnName: string;
  /** [fix03] このテーブルの行を絞り込むWHERE句。PurgeScopeTable.whereSqlと同じ仕組み。 */
  whereSql: string;
  scopeKind: "workspace" | "user";
}

/** [防御的検証] Postgresカタログ由来とはいえ、生SQLへ埋め込む識別子は
 *  念のため安全なパターンへ限定する(多層防御、実際にこの形式を外れる
 *  識別子はPostgres自体が許容しないため通常到達しない)。 */
const SAFE_IDENTIFIER = /^[a-z_][a-z0-9_]*$/;
function assertSafeIdentifier(name: string): void {
  if (!SAFE_IDENTIFIER.test(name)) {
    throw new Error(`[purgeJob] 識別子の形式が不正です(想定外の値のため処理を中止): ${name}`);
  }
}

interface ScopeLink {
  /** このテーブル自身が持つFK列(削除対象の絞り込みに使う)。 */
  ownColumn: string;
  /** 参照先テーブル("workspaces"/"users"、または他のスコープ確定済みテーブル)。 */
  parentTable: string;
  /** 参照先テーブル側の列(通常は"id"だが、複合FKの場合は他の列もありうる)。 */
  parentColumn: string;
  scopeKind: "workspace" | "user";
}

/**
 * [fix03・2026-09-20実DB検証で発見・是正] FKグラフから、各テーブルの
 * スコープ(workspace/user)を推移的(transitive)に解決する。
 *
 * [旧実装の欠陥] 「そのテーブル自身がworkspaces.id/users.idを直接参照する
 * 列を持つか」だけを見ており、1階層以上離れたテーブル(単一列FKでの
 * 間接参照、例: task_details → responsibilities → workspaces)を
 * 一切捕捉できていなかった。実DB検証(66件のmigrationを適用した実
 * スキーマ)で、94テーブル中54テーブルがこの欠陥によりPurge対象から
 * 漏れていたことを確認した(退会したはずのデータが物理削除されず残り
 * 続ける、プライバシー機能として致命的な欠陥)。
 *
 * [是正] 列名の一致を要求せず、「エッジの参照先テーブルが既にスコープ
 * 確定済みか」だけを条件に、不動点(fixed point)に達するまで繰り返し
 * 伝播させる。workspaceスコープを完全に伝播させてから(既存の「workspace
 * 優先」設計を踏襲)、残りをuserスコープで伝播させる。
 */
function buildScopeChain(edges: ForeignKeyEdge[]): Map<string, ScopeLink> {
  const chain = new Map<string, ScopeLink>();

  for (const e of edges) {
    if (e.referencedTableName === "workspaces" && e.referencedColumnName === "id" && !chain.has(e.tableName)) {
      chain.set(e.tableName, { ownColumn: e.columnName, parentTable: "workspaces", parentColumn: "id", scopeKind: "workspace" });
    }
  }
  for (const e of edges) {
    if (e.referencedTableName === "users" && e.referencedColumnName === "id" && !chain.has(e.tableName)) {
      chain.set(e.tableName, { ownColumn: e.columnName, parentTable: "users", parentColumn: "id", scopeKind: "user" });
    }
  }

  for (const wantedKind of ["workspace", "user"] as const) {
    let changed = true;
    while (changed) {
      changed = false;
      for (const e of edges) {
        if (chain.has(e.tableName)) continue;
        if (e.tableName === e.referencedTableName) continue; // 自己参照はスコープの根拠にしない。
        const parent = chain.get(e.referencedTableName);
        if (parent && parent.scopeKind === wantedKind) {
          chain.set(e.tableName, { ownColumn: e.columnName, parentTable: e.referencedTableName, parentColumn: e.referencedColumnName, scopeKind: parent.scopeKind });
          changed = true;
        }
      }
    }
  }
  return chain;
}

/**
 * [fix03] テーブル1件分のWHERE句(SQL断片)を再帰的に組み立てる。
 * workspaces/usersへ直接つながる場合は `"col" = ANY($1)`、それ以外は
 * `"col" IN (SELECT "parentCol" FROM "parentTable" WHERE <親のWHERE句>)`
 * という非相関サブクエリになる(親はまだ削除されていない時点でこの
 * サブクエリが評価されるため正しく解決できる。削除順序の根拠は
 * topologicalDeleteOrder参照)。同じテーブルが複数箇所から参照される
 * 場合に備えcacheで再計算を避ける。識別子はこの関数内で全て
 * assertSafeIdentifierを通す(多層防御)。
 */
function buildScopeWhereSql(tableName: string, chain: Map<string, ScopeLink>, cache: Map<string, string>): string {
  const cached = cache.get(tableName);
  if (cached !== undefined) return cached;
  const link = chain.get(tableName);
  if (!link) {
    throw new Error(`[purgeJob] スコープが解決できないテーブルのWHERE句を要求されました(想定外): ${tableName}`);
  }
  assertSafeIdentifier(link.ownColumn);
  assertSafeIdentifier(link.parentTable);
  assertSafeIdentifier(link.parentColumn);
  let sql: string;
  if (link.parentTable === "workspaces" || link.parentTable === "users") {
    sql = `"${link.ownColumn}" = ANY($1)`;
  } else {
    const parentWhere = buildScopeWhereSql(link.parentTable, chain, cache);
    sql = `"${link.ownColumn}" IN (SELECT "${link.parentColumn}" FROM "${link.parentTable}" WHERE ${parentWhere})`;
  }
  cache.set(tableName, sql);
  return sql;
}

/**
 * FKグラフから、削除対象スコープ(各テーブル・WHERE句・削除順序)を
 * 算出する。`workspaces`を(直接または間接に)参照するテーブルは
 * "workspace"スコープとし、それ以外で`users`を(直接または間接に)
 * 参照するテーブルは"user"スコープとする(workspace-scopedの方を
 * 優先する——1 workspace=1 memberという現状の不変条件の下では、
 * workspace側で本人のデータは網羅される)。
 */
export async function computePurgeScope(): Promise<{
  order: PurgeScopeTable[];
  deleteOrder: string[];
  nullableBackReferences: NullableBackReference[];
}> {
  const edges = await discoverForeignKeyEdges();
  const deleteOrder = topologicalDeleteOrder(edges);
  const chain = buildScopeChain(edges);
  const whereSqlCache = new Map<string, string>();

  const order: PurgeScopeTable[] = [];
  for (const tableName of deleteOrder) {
    if (tableName === "workspaces" || tableName === "users") continue; // 最後に個別処理する。
    const link = chain.get(tableName);
    if (link) {
      order.push({ tableName, scopeKind: link.scopeKind, whereSql: buildScopeWhereSql(tableName, chain, whereSqlCache) });
    }
    // どちらのスコープも無いテーブル(workspaces/usersを一切参照しない、
    // 真にグローバルな参照データ。例: jobs/outbox_events/event_logsは
    // 集約IDを文字列で保持するのみで正式なFKを意図的に張っていない
    // ——既存AuditLog等と同じ設計、想像で無関係なテーブルへ絞り込み
    // 条件を発明しない)は対象外のまま。
  }

  // [循環を断ち切るためNULLへ更新する対象列] topologicalDeleteOrderが順序
  // 制約から除外したNULL可能なエッジ(または複合FKで同じ制約に属する
  // NULL可能な列を含むエッジ)のうち、テーブル自身がworkspace/user
  // スコープを持つもののみを対象にする(それ以外は削除対象外テーブルの
  // ため実際には到達しない)。
  const nullableBackReferences: NullableBackReference[] = [];
  for (const e of edges) {
    if (e.tableName === e.referencedTableName) continue;
    if (!e.isNullable) continue;
    const link = chain.get(e.tableName);
    if (!link) continue;
    nullableBackReferences.push({
      tableName: e.tableName,
      columnName: e.columnName,
      whereSql: buildScopeWhereSql(e.tableName, chain, whereSqlCache),
      scopeKind: link.scopeKind,
    });
  }

  return { order, deleteOrder, nullableBackReferences };
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
    const values = t.scopeKind === "workspace" ? target.workspaceIds : [target.userId];
    if (values.length === 0) {
      results.push({ tableName: t.tableName, scopeKind: t.scopeKind, count: 0 });
      continue;
    }
    const rows = await db.$queryRawUnsafe<{ count: bigint }[]>(
      `SELECT COUNT(*)::bigint AS count FROM "${t.tableName}" WHERE ${t.whereSql}`,
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
 *
 * [循環の断ち切り・実DB検証で発見・是正] 通常の削除ループの前に、NULL可能な
 * 逆参照列(例: Responsibility.supersededByReceiptId)を対象行についてNULLへ
 * 更新する。これにより、その列が指していたテーブル(例: Responsibility
 * CorrectionReceipt)を後続の通常順序で安全に削除できる(この更新も同一
 * transaction内のため、原子性は保たれる)。
 */
export async function executePurgeForUser(target: EligibleUserForPurge): Promise<PurgeExecutionResult> {
  const { order, nullableBackReferences } = await computePurgeScope();
  const perTable: PurgeTableCount[] = [];

  await db.$transaction(async (tx: Prisma.TransactionClient) => {
    for (const n of nullableBackReferences) {
      assertSafeIdentifier(n.tableName);
      assertSafeIdentifier(n.columnName);
      const values = n.scopeKind === "workspace" ? target.workspaceIds : [target.userId];
      if (values.length === 0) continue;
      await tx.$executeRawUnsafe(
        `UPDATE "${n.tableName}" SET "${n.columnName}" = NULL WHERE ${n.whereSql} AND "${n.columnName}" IS NOT NULL`,
        values,
      );
    }
    for (const t of order) {
      assertSafeIdentifier(t.tableName);
      const values = t.scopeKind === "workspace" ? target.workspaceIds : [target.userId];
      if (values.length === 0) {
        perTable.push({ tableName: t.tableName, scopeKind: t.scopeKind, count: 0 });
        continue;
      }
      const deleted = await tx.$executeRawUnsafe(
        `DELETE FROM "${t.tableName}" WHERE ${t.whereSql}`,
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
