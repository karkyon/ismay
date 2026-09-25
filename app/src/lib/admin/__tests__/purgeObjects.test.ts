/**
 * [PURGE-OPS-03B・2026-09-25新設] Object Storage段・保持ポリシーのDB非依存テスト。
 * DEC-PURGE-02B §7.1(台帳snapshot→MinIO削除→不存在確認→DB物理削除→匿名化・監査→完了)。
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import {
  OBJECT_KEY_COLUMNS,
  hashObjectKey,
  mergeObjectTargets,
  purgeRetryDelayMs,
  workspaceObjectPrefix,
} from "../purgeObjects";
import { PURGE_RETENTION_POLICY, unregisteredRetainedTables } from "../purgeGraph";
import { computePlanDigest, PURGE_PHASES } from "../purgeLedgerCore";

const __dirname = dirname(fileURLToPath(import.meta.url));

let passed = 0;
let failed = 0;
const failures: string[] = [];
function ok(name: string, cond: boolean, detail?: string): void {
  if (cond) {
    passed++;
    console.log(`  ok - ${name}`);
  } else {
    failed++;
    failures.push(name + (detail ? ` (${detail})` : ""));
    console.log(`  NG - ${name}${detail ? ` :: ${detail}` : ""}`);
  }
}

console.log("=== purgeObjects: object key列の登録 ===");
const schema = readFileSync(resolve(__dirname, "../../../../prisma/schema.prisma"), "utf-8");
// schema.prisma上の「ObjectKey」を名前に含む列(@map付き)をmodel単位で抽出する。
const declared: { table: string; column: string }[] = [];
for (const block of schema.split(/\nmodel /).slice(1)) {
  const mapMatch = block.match(/@@map\("([a-z_]+)"\)/);
  if (!mapMatch) continue;
  for (const line of block.split("\n")) {
    const m = line.match(/^\s*\w*[oO]bjectKey\s+String\??\s+@map\("([a-z_]+)"\)/);
    // 保持ポリシー登録表(Purge台帳自身のpurge_item_objects等)は削除対象ではないため除外する。
    if (m && !(mapMatch[1] in PURGE_RETENTION_POLICY)) declared.push({ table: mapMatch[1], column: m[1] });
  }
}
ok("schema.prismaからObjectKey列を検出できる(検査が空振りしていない)", declared.length >= 3, JSON.stringify(declared));
for (const d of declared) {
  const registered = OBJECT_KEY_COLUMNS.some((e) => e.tableName === d.table && e.columnNames.includes(d.column));
  ok(`${d.table}.${d.column} はOBJECT_KEY_COLUMNSに登録されている(未登録だとPurgeでobjectが残る)`, registered);
}
for (const e of OBJECT_KEY_COLUMNS) {
  for (const c of e.columnNames) ok(`登録済み${e.tableName}.${c}はschema.prismaに実在する`, declared.some((d) => d.table === e.tableName && d.column === c));
}

console.log("=== purgeObjects: 接頭辞・hash・統合 ===");
ok("workspace接頭辞はlib/storage.tsのkey規約(workspaceId/)と一致", workspaceObjectPrefix("w-1") === "w-1/");
let slashRejected = false;
try {
  workspaceObjectPrefix("a/b");
} catch {
  slashRejected = true;
}
ok("'/'を含むworkspaceIdは拒否(他workspaceの接頭辞を誤って削除しない)", slashRejected);
let emptyRejected = false;
try {
  workspaceObjectPrefix("");
} catch {
  emptyRejected = true;
}
ok("空のworkspaceIdは拒否(バケット全体の接頭辞''を作らない)", emptyRejected);
ok("hashはbucketとkeyの両方に依存する", hashObjectKey("b1", "k") !== hashObjectKey("b2", "k") && hashObjectKey("b1", "k") === hashObjectKey("b1", "k"));
const merged = mergeObjectTargets(["w/c/a", "w/c/b"], ["w/c/b", "w/orphan"]);
ok("DB参照と接頭辞一覧は重複除去して統合される", merged.length === 3, JSON.stringify(merged));
ok("重複はDB_REFERENCEを優先", merged.find((t) => t.objectKey === "w/c/b")?.source === "DB_REFERENCE");
ok("DBに無いkeyはPREFIX_LISTING(孤立objectの回収)", merged.find((t) => t.objectKey === "w/orphan")?.source === "PREFIX_LISTING");
ok("遅延回収はLATE_PREFIX_LISTINGで記録できる", mergeObjectTargets([], ["w/x"], "LATE_PREFIX_LISTING")[0].source === "LATE_PREFIX_LISTING");

console.log("=== purgeObjects: retry backoff ===");
ok("1回目の失敗後は30秒", purgeRetryDelayMs(1) === 30_000);
ok("指数的に増える(2回目60秒・3回目120秒)", purgeRetryDelayMs(2) === 60_000 && purgeRetryDelayMs(3) === 120_000);
ok("上限は1時間", purgeRetryDelayMs(30) === 3_600_000);

console.log("=== 保持ポリシー(FKが無いから保持、を認めない) ===");
ok("audit_logsと台帳3表が保持理由つきで登録されている", ["audit_logs", "purge_runs", "purge_items", "purge_item_objects"].every((t) => typeof PURGE_RETENTION_POLICY[t] === "string" && PURGE_RETENTION_POLICY[t].length > 0));
ok("登録済みの表だけなら未登録0件", unregisteredRetainedTables(["audit_logs", "purge_items"]).length === 0);
ok("未登録の非scope表は検出される(Purgeは実行を拒否する)", unregisteredRetainedTables(["audit_logs", "new_log_table"]).join(",") === "new_log_table");
ok("event_logs等の明示的scope列の表は保持ポリシーに含まれない(削除対象)", ["event_logs", "outbox_events", "jobs", "consents", "ai_runs"].every((t) => !(t in PURGE_RETENTION_POLICY)));

console.log("=== 台帳: phase順序・plan digest ===");
ok("phaseはDEC-PURGE-02B §7.1の順序どおり", PURGE_PHASES.join(">") === "NONE>OBJECTS_SNAPSHOTTED>OBJECTS_DELETED>OBJECTS_VERIFIED>DB_PURGED>AUDITED>COMPLETED");
const d1 = computePlanDigest([{ userId: "u2", plannedDigest: "b", refusalStatus: null }, { userId: "u1", plannedDigest: "a", refusalStatus: null }]);
const d2 = computePlanDigest([{ userId: "u1", plannedDigest: "a", refusalStatus: null }, { userId: "u2", plannedDigest: "b", refusalStatus: null }]);
ok("plan digestはitemの順序に依存しない", d1 === d2);
ok("拒否statusもplan digestに反映される", d1 !== computePlanDigest([{ userId: "u1", plannedDigest: "a", refusalStatus: null }, { userId: "u2", plannedDigest: null, refusalStatus: "NOT_DELETED" }]));

console.log(`\n=== 結果: ${passed} passed / ${failed} failed ===`);
if (failed > 0) {
  console.log("失敗一覧:");
  for (const f of failures) console.log(`  - ${f}`);
  process.exit(1);
}
