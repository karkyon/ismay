/**
 * 30日Purge(PURGE-SCOPE-02F/ELIGIBILITY-02C/AUDIT-02D/REPORT-02E)の
 * DB非依存テスト。既存`patterns/__tests__/casePatternMath.test.ts`と同じ
 * パターン(npx tsx で直接実行、DATABASE_URL不要)。
 *
 * FKグラフは実スキーマ(全migration適用DB)で問題を起こした構造を最小化して
 * 合成する:
 *   - responsibilities ⇄ responsibility_correction_receipts(NULL可能な逆参照で循環)
 *   - formation_session_events: NOT NULL複合FKでformation_sessionsへ、
 *     NULL可能なactor_user_idでusersへ(旧実装はuser scopeへ誤割当て)
 *   - ai_runs: NULL可能なcapture_idのみでcapturesへ(旧実装はNULL化で残存)
 *   - audit_logs: NULL可能なactor_user_idのみでusersへ(行為者参照)
 */
import {
  buildScopeChain,
  computeManifestDigest,
  diffManifests,
  finalizeManifest,
  groupForeignKeyConstraints,
  isRetentionElapsed,
  purgeEligibleAt,
  snapshotCreationOrder,
  topologicalDeleteOrder,
  PURGE_RETENTION_DAYS,
  type ForeignKeyEdge,
  type PurgeManifestWithoutDigest,
} from "../purgeGraph";
import {
  PURGE_EXIT,
  buildPurgeAuditReason,
  maskEmail,
  sanitizeOperatorName,
  summarizePurgeOutcomes,
  type PurgeItemOutcome,
  type PurgeRunContext,
} from "../purgeReporting";

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

let seq = 0;
/** 1制約分のエッジ群を作る。cols: [参照元列, 参照先列, NULL可能か]。 */
function fk(table: string, ref: string, pairs: [string, string, boolean][]): ForeignKeyEdge[] {
  const constraintId = `c${++seq}`;
  return pairs.map(([col, refCol, nullable], i) => ({
    tableName: table,
    columnName: col,
    referencedTableName: ref,
    referencedColumnName: refCol,
    isNullable: nullable,
    constraintId,
    ordinal: i + 1,
  }));
}

const edges: ForeignKeyEdge[] = [
  ...fk("workspace_members", "workspaces", [["workspace_id", "id", false]]),
  ...fk("workspace_members", "users", [["user_id", "id", false]]),
  ...fk("captures", "workspaces", [["workspace_id", "id", false]]),
  ...fk("captures", "users", [["created_by", "id", false]]),
  ...fk("captures", "captures", [["split_from_capture_id", "id", true]]),
  ...fk("responsibilities", "workspaces", [["workspace_id", "id", false]]),
  ...fk("responsibilities", "users", [["created_by", "id", false]]),
  ...fk("responsibilities", "captures", [["capture_id", "id", true]]),
  // 複合FK: (superseded_by_receipt_id, workspace_id) → receipts(id, workspace_id)。ordinalをわざと逆順で渡す。
  ...fk("responsibilities", "responsibility_correction_receipts", [
    ["workspace_id", "workspace_id", false],
    ["superseded_by_receipt_id", "id", true],
  ]).map((e) => ({ ...e, ordinal: e.columnName === "superseded_by_receipt_id" ? 1 : 2 })),
  ...fk("responsibility_correction_receipts", "responsibilities", [
    ["source_responsibility_id", "id", false],
    ["workspace_id", "workspace_id", false],
  ]),
  ...fk("responsibility_correction_receipts", "users", [["actor_user_id", "id", false]]),
  ...fk("formation_sessions", "workspaces", [["workspace_id", "id", false]]),
  ...fk("formation_sessions", "users", [["subject_user_id", "id", false]]),
  ...fk("formation_session_events", "formation_sessions", [
    ["session_id", "id", false],
    ["workspace_id", "workspace_id", false],
  ]),
  ...fk("formation_session_events", "users", [["actor_user_id", "id", true]]),
  ...fk("ai_runs", "captures", [["capture_id", "id", true]]),
  ...fk("ai_inferences", "ai_runs", [["ai_run_id", "id", false]]),
  ...fk("audit_logs", "users", [["actor_user_id", "id", true]]),
  ...fk("user_sessions", "users", [["user_id", "id", false]]),
];

console.log("=== purgeGraph: 制約のグループ化 ===");
const constraints = groupForeignKeyConstraints(edges);
const supersede = constraints.find((c) => c.tableName === "responsibilities" && c.referencedTableName === "responsibility_correction_receipts")!;
ok("複合FKはordinal順に列が並ぶ", supersede.columns.join(",") === "superseded_by_receipt_id,workspace_id", supersede.columns.join(","));
ok("複合FKの参照先列もordinal順で1:1対応する", supersede.referencedColumns.join(",") === "id,workspace_id", supersede.referencedColumns.join(","));
ok("構成列の1つでもNULL可能なら制約全体がNULL可能(MATCH SIMPLE)", supersede.isNullable && supersede.nullableColumns.join(",") === "superseded_by_receipt_id");
ok("制約数は入力の制約IDと一致する", constraints.length === seq, `${constraints.length} vs ${seq}`);

console.log("=== purgeGraph: 削除順序と循環遮断 ===");
const { order, cycleBreakers } = topologicalDeleteOrder(constraints, ["jobs"]);
const pos = (t: string): number => order.indexOf(t);
ok("循環遮断はresponsibilities.superseded_by_receipt_idの1制約だけ", cycleBreakers.length === 1 && cycleBreakers[0] === supersede, cycleBreakers.map((c) => `${c.tableName}.${c.columns}`).join(";"));
ok("NULL可能でも循環しない辺(ai_runs→captures)は順序に採用される(ai_runsが先)", pos("ai_runs") < pos("captures"));
ok("NULL可能でも循環しない辺(responsibilities→captures)は順序に採用される", pos("responsibilities") < pos("captures"));
ok("NULL可能な行為者参照(audit_logs→users)も順序に採用される", pos("audit_logs") < pos("users"));
ok("NOT NULL辺: receipts→responsibilitiesでreceiptsが先", pos("responsibility_correction_receipts") < pos("responsibilities"));
ok("NOT NULL複合FK: formation_session_events→formation_sessions", pos("formation_session_events") < pos("formation_sessions"));
ok("FKを持たない表(jobs)も順序に含まれる", pos("jobs") >= 0);
ok("workspaces/usersは参照先として後ろに来る", pos("workspaces") > pos("captures") && pos("users") > pos("captures"));
let notNullCycleThrown = false;
try {
  topologicalDeleteOrder(groupForeignKeyConstraints([...fk("a", "b", [["b_id", "id", false]]), ...fk("b", "a", [["a_id", "id", false]])]));
} catch (e) {
  notNullCycleThrown = e instanceof Error && e.message.includes("循環参照");
}
ok("NOT NULL同士の真の循環は想像で解決せず停止する", notNullCycleThrown);

console.log("=== purgeGraph: scope chain ===");
const chain = buildScopeChain(constraints);
const fse = chain.get("formation_session_events");
ok(
  "formation_session_eventsはNOT NULL複合FK経由のworkspace scope(NULL可能なactor_user_idではない)",
  fse?.scopeKind === "workspace" && fse.constraint.referencedTableName === "formation_sessions" && !fse.viaNullableLink,
  JSON.stringify(fse),
);
const aiRuns = chain.get("ai_runs");
ok("ai_runsはNULL可能なcapture_id経由でworkspace scope(所有関係)", aiRuns?.scopeKind === "workspace" && aiRuns.viaNullableLink === true, JSON.stringify(aiRuns));
ok("ai_runsの子(ai_inferences)もworkspace scope", chain.get("ai_inferences")?.scopeKind === "workspace");
ok("audit_logs(root直結のNULL可能FKのみ)はscope外=削除しない(行為者参照の匿名化対象)", !chain.has("audit_logs"));
ok("receiptsはworkspace scope(responsibilities経由のNOT NULL複合FKを優先)", chain.get("responsibility_correction_receipts")?.scopeKind === "workspace");
ok("user_sessions(usersへのNOT NULLのみ)はuser scope", chain.get("user_sessions")?.scopeKind === "user");
ok("capturesはworkspaces直結(created_byのusersではない)", chain.get("captures")?.constraint.referencedTableName === "workspaces");
ok("root表自体はchainに含まれない", !chain.has("workspaces") && !chain.has("users"));
const snapOrder = snapshotCreationOrder(chain);
ok("snapshot作成順は親が先(captures→ai_runs→ai_inferences)", snapOrder.indexOf("captures") < snapOrder.indexOf("ai_runs") && snapOrder.indexOf("ai_runs") < snapOrder.indexOf("ai_inferences"));
ok("snapshot作成順は親が先(formation_sessions→formation_session_events)", snapOrder.indexOf("formation_sessions") < snapOrder.indexOf("formation_session_events"));

console.log("=== purgeGraph: 30日境界 ===");
const now = new Date("2026-09-25T00:00:00.000Z");
const exact = new Date(now.getTime() - PURGE_RETENTION_DAYS * 86400000);
ok("ちょうど30日前は対象(旧実装のlteと同じ境界)", isRetentionElapsed(exact, now));
ok("30日前より1ms後(=経過が1ms足りない)は対象外", !isRetentionElapsed(new Date(exact.getTime() + 1), now));
ok("30日前より1ms前は対象", isRetentionElapsed(new Date(exact.getTime() - 1), now));
ok("purgeEligibleAtはdeletedAt+30日", purgeEligibleAt(exact).getTime() === now.getTime());

console.log("=== purgeGraph: manifest digest/差分 ===");
const base: PurgeManifestWithoutDigest = {
  userId: "u1",
  workspaceIds: ["w2", "w1"],
  deletedAt: "2026-08-01T00:00:00.000Z",
  evaluatedAt: "2026-09-25T00:00:00.000Z",
  perTable: [
    { tableName: "responsibilities", scopeKind: "workspace", count: 3 },
    { tableName: "captures", scopeKind: "workspace", count: 2 },
  ],
  workspaceRowsDeleted: 2,
  userRowsDeleted: 1,
  cycleBreakUpdates: [{ tableName: "responsibilities", columnNames: ["superseded_by_receipt_id"], referencedTableName: "responsibility_correction_receipts", reason: "CYCLE_BREAK", count: 1 }],
  anonymizedReferences: [{ tableName: "audit_logs", columnNames: ["actor_user_id"], referencedTableName: "users", reason: "ANONYMIZE_EXTERNAL_REFERENCE", count: 4 }],
  retainedUnscopedTables: ["jobs", "audit_logs"],
};
const m1 = finalizeManifest(base);
ok("rowsDeletedは表+workspace+userの合計", m1.totals.rowsDeleted === 3 + 2 + 2 + 1, JSON.stringify(m1.totals));
ok("rowsUpdatedは循環遮断+匿名化の合計(削除数と区別)", m1.totals.rowsUpdated === 1 + 4, JSON.stringify(m1.totals));
ok("digestは評価時刻に依存しない", computeManifestDigest({ ...base, evaluatedAt: "2030-01-01T00:00:00.000Z" }) === m1.digest);
ok("digestはworkspaceIdsの順序に依存しない", computeManifestDigest({ ...base, workspaceIds: ["w1", "w2"] }) === m1.digest);
const m2 = finalizeManifest({ ...base, perTable: [{ tableName: "responsibilities", scopeKind: "workspace", count: 4 }, base.perTable[1]] });
ok("件数が変わればdigestも変わる", m2.digest !== m1.digest);
const drift = diffManifests(m1, m2);
ok("diffManifestsは変化した表だけを返す", drift.length === 1 && drift[0].key === "perTable.responsibilities" && drift[0].expected === 3 && drift[0].actual === 4, JSON.stringify(drift));
ok("同一manifest同士の差分は空", diffManifests(m1, m1).length === 0);
const m3 = finalizeManifest({ ...base, workspaceIds: ["w1", "w2", "w3"] });
ok("membership変化(workspace追加)は差分として検出される", diffManifests(m1, m3).some((d) => d.key === "workspaceIds"));

console.log("=== purgeReporting: 監査分離・exit code ===");
ok("maskEmailは先頭1文字とドメインのみ", maskEmail("alice@example.com") === "a***@example.com", maskEmail("alice@example.com"));
ok("maskEmailは@の無い値を全伏字にする", maskEmail("no-at-sign") === "***");
ok("sanitizeOperatorNameは制御文字を除去し空はnull", sanitizeOperatorName("ka\u0007rkyon\n") === "karkyon" && sanitizeOperatorName("  ") === null);
const purgedOutcome = (auditRecorded: boolean): PurgeItemOutcome => ({
  userId: "u",
  purgeStatus: "PURGED",
  purgeSucceeded: true,
  totals: { rowsDeleted: 10, rowsUpdated: 1 },
  workspaceRowsDeleted: 1,
  userRowsDeleted: 1,
  anonymizedRows: 1,
  digest: "d",
  expectedDigest: "d",
  driftCount: 0,
  detail: null,
  auditRecorded,
  auditError: auditRecorded ? null : "audit down",
});
const refusedOutcome: PurgeItemOutcome = { ...purgedOutcome(true), purgeStatus: "NOT_DELETED", purgeSucceeded: false, totals: null, detail: "restored" };
ok("全件成功はexit 0", summarizePurgeOutcomes([purgedOutcome(true)]).exitCode === PURGE_EXIT.OK);
const auditOnly = summarizePurgeOutcomes([purgedOutcome(false)]);
ok("削除成功+監査失敗は削除成功のまま数え、exit 4", auditOnly.purged === 1 && auditOnly.notPurged === 0 && auditOnly.auditFailed === 1 && auditOnly.exitCode === 4, JSON.stringify(auditOnly));
ok("削除されなかった対象があればexit 2", summarizePurgeOutcomes([purgedOutcome(true), refusedOutcome]).exitCode === 2);
ok("未削除と監査失敗が両方あればexit 6", summarizePurgeOutcomes([purgedOutcome(false), refusedOutcome]).exitCode === 6);
ok("未削除の内訳はstatus別に集計される", summarizePurgeOutcomes([refusedOutcome, refusedOutcome]).notPurgedByStatus["NOT_DELETED"] === 2);
const ctx: PurgeRunContext = { runId: "run-1", osUser: "ops", hostname: "host", pid: 42, operatorDeclared: null, startedAt: "x" };
const reason = buildPurgeAuditReason(ctx, purgedOutcome(true));
ok("監査文言にrun/osUser/host/pid/自己申告operatorが入る", ["run=run-1", "osUser=ops", "host=host", "pid=42", "operator(self-declared)=-"].every((s) => reason.includes(s)), reason);
ok("監査文言に削除数と更新数が別々に入る", reason.includes("rowsDeleted=10") && reason.includes("rowsUpdated=1"), reason);
ok("拒否時の監査文言はstatusと理由を持つ", buildPurgeAuditReason(ctx, refusedOutcome).includes("status=NOT_DELETED"));

console.log(`\n=== 結果: ${passed} passed / ${failed} failed ===`);
if (failed > 0) {
  console.log("失敗一覧:");
  for (const f of failures) console.log(`  - ${f}`);
  process.exit(1);
}
