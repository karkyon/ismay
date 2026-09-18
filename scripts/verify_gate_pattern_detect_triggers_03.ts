#!/usr/bin/env node
/**
 * scripts/verify_gate_pattern_detect_triggers_03.ts
 *
 * PATTERN-DETECT-TRIGGERS-03(EMBEDDING_MODEL_CHANGED/MANUAL_REBUILDの
 * trigger配線)実DB受入試験。
 * 出典: Claude向け_ISMAY_d68e9bf以降_ActionSlot正本準拠・CasePattern実分解
 * 完遂・残工程連続実装指示_2026-09-17.md P1「10. 残り4 reason配線」。
 *
 * 検証内容:
 *   - enqueueCaseDetectForAllOwnersInWorkspaceが、workspace内で既に
 *     CasePatternを持つ全ownerへreasonCode付きでenqueueする
 *   - Patternを持たないownerへは何もenqueueされない
 *   - EMBEDDING_MODEL_CHANGED/MANUAL_REBUILDの両reasonCodeが実DB CHECK制約に
 *     違反せず挿入できる(migrationの検証)
 *   - 同一操作を2回呼ぶとcoalesceされる(新規Job行が増えない、generationのみ増加)
 *   - owner/workspace分離、cleanup
 *
 * 実行方法:
 *   cd ~/projects/ismay/app
 *   npx tsx ../scripts/verify_gate_pattern_detect_triggers_03.ts
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

function loadDotEnv(envPath: string): void {
  let content: string;
  try {
    content = readFileSync(envPath, "utf-8");
  } catch {
    return;
  }
  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
    if (value.length >= 2 && value[0] === value[value.length - 1] && (value[0] === '"' || value[0] === "'")) {
      value = value.slice(1, -1);
    }
    if (process.env[key] === undefined) process.env[key] = value;
  }
}
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
loadDotEnv(join(__dirname, "..", "app", ".env"));

const RUN_ID = Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
const EMAIL_PREFIX = "gate-pattern-detect-triggers-03-verify-";

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

async function main(): Promise<void> {
  const { installAiNetworkDenyGuard } = await import("./lib/aiNetworkDenyGuard");
  const guard = installAiNetworkDenyGuard();

  const { db } = await import("../app/src/lib/db");
  const { createCasePatternIdentity } = await import("../app/src/lib/patterns/casePatternRevisionService");
  const { enqueueCaseDetectForAllOwnersInWorkspace } = await import("../app/src/lib/patterns/casePatternTriggers");

  // [本scriptのfixtureはcapture/session/responsibilityを一切作らず、
  // User+WorkspaceMember+CasePattern+CasePatternDetectJobのみで完結する。
  // かつ本scriptは初めて「1 workspaceに複数owner(複数User)が同居する」
  // fixtureを使う(既存verify script群は全てowner=1のworkspaceを個別に
  // 使う設計だった)。既存の共有cleanupFormationVerifyUser(単一user・単一
  // workspace前提)をuser単位で複数回呼ぶと、workspace削除(RESTRICT FK)の
  // 呼び出し順序次第で不整合を起こしうるため、本scriptはこの軽量fixtureに
  // 適した専用cleanupをその場で組む(想像で共有helperの内部動作を仮定せず、
  // 自己完結させる)。]
  const workspaceIds: string[] = [];
  const userIds: string[] = [];

  async function cleanupAll(): Promise<void> {
    for (const workspaceId of workspaceIds) {
      await db.casePatternDetectJob.deleteMany({ where: { workspaceId } }).catch(() => null);
      await db.casePatternRevision.deleteMany({ where: { workspaceId } }).catch(() => null);
      await db.casePattern.deleteMany({ where: { workspaceId } }).catch(() => null);
      await db.workspaceMember.deleteMany({ where: { workspaceId } }).catch(() => null);
    }
    for (const workspaceId of workspaceIds) {
      await db.workspace.delete({ where: { id: workspaceId } }).catch(() => null);
    }
    for (const userId of userIds) {
      await db.user.delete({ where: { id: userId } }).catch(() => null);
    }
  }

  const orphans = await db.user.findMany({
    where: { email: { startsWith: EMAIL_PREFIX, endsWith: "@example.invalid" } },
    select: { id: true },
  });
  if (orphans.length > 0) {
    console.log(`[SWEEP] 過去実行の孤立テストユーザー${orphans.length}件を削除します...`);
    const orphanWorkspaceIds = await db.workspaceMember.findMany({
      where: { userId: { in: orphans.map((o) => o.id) } },
      select: { workspaceId: true },
      distinct: ["workspaceId"],
    });
    for (const { workspaceId } of orphanWorkspaceIds) {
      await db.casePatternDetectJob.deleteMany({ where: { workspaceId } }).catch(() => null);
      await db.casePatternRevision.deleteMany({ where: { workspaceId } }).catch(() => null);
      await db.casePattern.deleteMany({ where: { workspaceId } }).catch(() => null);
      await db.workspaceMember.deleteMany({ where: { workspaceId } }).catch(() => null);
      await db.workspace.delete({ where: { id: workspaceId } }).catch(() => null);
    }
    for (const o of orphans) {
      await db.user.delete({ where: { id: o.id } }).catch(() => null);
    }
  }

  async function makeFixtureUser(workspaceId: string, suffix: string) {
    const email = `${EMAIL_PREFIX}${RUN_ID}-${suffix}@example.invalid`;
    const user = await db.user.create({
      data: { email, passwordHash: "not-a-real-hash-for-db-only-test", displayName: `PATTERN-DETECT-TRIGGERS-03 ${suffix}` },
    });
    await db.workspaceMember.create({ data: { workspaceId, userId: user.id, role: "OWNER" } }).catch(() => null);
    userIds.push(user.id);
    return user.id;
  }

  async function makePatternForOwner(workspaceId: string, ownerSubjectUserId: string, title: string) {
    return createCasePatternIdentity({
      workspaceId,
      ownerSubjectUserId,
      title,
      representativeText: title,
      decompositionTemplate: null,
      thresholds: { windowCycles: 12 },
      schemaVersion: "1.0",
    });
  }

  try {
    console.log("=== PATTERN-DETECT-TRIGGERS-03 実DB受入試験 ===");

    const workspace = await db.workspace.create({ data: { name: `PATTERN-DETECT-TRIGGERS-03 Workspace ${RUN_ID}` } });
    workspaceIds.push(workspace.id);
    const ownerA = await makeFixtureUser(workspace.id, "ownerA");
    const ownerB = await makeFixtureUser(workspace.id, "ownerB");
    const ownerNoPattern = await makeFixtureUser(workspace.id, "owner-no-pattern");

    // ================================================================
    // [対照group] owner/workspace分離。
    // ================================================================
    const workspaceOther = await db.workspace.create({ data: { name: `PATTERN-DETECT-TRIGGERS-03 対照 ${RUN_ID}` } });
    workspaceIds.push(workspaceOther.id);
    const ownerOther = await makeFixtureUser(workspaceOther.id, "isolation-control");
    await makePatternForOwner(workspaceOther.id, ownerOther, "対照Pattern");

    // ================================================================
    // [1] ownerA・ownerBはPatternを持つ、ownerNoPatternは持たない。
    // ================================================================
    await makePatternForOwner(workspace.id, ownerA, "OwnerAのPattern");
    await makePatternForOwner(workspace.id, ownerB, "OwnerBのPattern");

    const result1 = await enqueueCaseDetectForAllOwnersInWorkspace(db, { workspaceId: workspace.id, reasonCode: "EMBEDDING_MODEL_CHANGED" });
    ok("[1] Patternを持つ2ownerへenqueueされる(ownerCount=2)", result1.ownerCount === 2, JSON.stringify(result1));

    const jobs = await db.casePatternDetectJob.findMany({ where: { workspaceId: workspace.id } });
    ok("[1] Job行が2件作られる(ownerA・ownerB)", jobs.length === 2, `count=${jobs.length}`);
    ok("[1] 両JobともreasonCode=EMBEDDING_MODEL_CHANGED", jobs.every((j) => j.reasonCode === "EMBEDDING_MODEL_CHANGED"), JSON.stringify(jobs.map((j) => j.reasonCode)));
    ok("[1] ownerNoPatternへはJobが作られない", !jobs.some((j) => j.ownerSubjectUserId === ownerNoPattern), JSON.stringify(jobs.map((j) => j.ownerSubjectUserId)));
    ok("[1] EMBEDDING_MODEL_CHANGEDはDB CHECK制約に違反せず挿入できる(migration検証)", jobs.length === 2, "");

    // ================================================================
    // [2] MANUAL_REBUILDも同様にDB CHECK制約へ違反せず挿入できる。
    // ================================================================
    await db.casePatternDetectJob.deleteMany({ where: { workspaceId: workspace.id } });
    const result2 = await enqueueCaseDetectForAllOwnersInWorkspace(db, { workspaceId: workspace.id, reasonCode: "MANUAL_REBUILD" });
    ok("[2] MANUAL_REBUILDでも2ownerへenqueueされる", result2.ownerCount === 2, JSON.stringify(result2));
    const jobsManual = await db.casePatternDetectJob.findMany({ where: { workspaceId: workspace.id } });
    ok("[2] MANUAL_REBUILDはDB CHECK制約に違反せず挿入できる(migration検証)", jobsManual.every((j) => j.reasonCode === "MANUAL_REBUILD"), JSON.stringify(jobsManual.map((j) => j.reasonCode)));

    // ================================================================
    // [3] 同一操作を2回呼ぶとcoalesceされる(新規Job行が増えない)。
    // ================================================================
    const beforeGenerations = new Map(jobsManual.map((j) => [j.id, j.generation]));
    const result3 = await enqueueCaseDetectForAllOwnersInWorkspace(db, { workspaceId: workspace.id, reasonCode: "MANUAL_REBUILD" });
    ok("[3] 2回目もownerCount=2を返す", result3.ownerCount === 2, JSON.stringify(result3));
    const jobsAfterSecond = await db.casePatternDetectJob.findMany({ where: { workspaceId: workspace.id } });
    ok("[3] Job行数は2件のまま(coalesced、新規行が増えない)", jobsAfterSecond.length === 2, `count=${jobsAfterSecond.length}`);
    ok(
      "[3] 各Jobのgenerationが増加している",
      jobsAfterSecond.every((j) => (beforeGenerations.get(j.id) ?? 0) < j.generation),
      JSON.stringify(jobsAfterSecond.map((j) => ({ id: j.id, before: beforeGenerations.get(j.id), after: j.generation }))),
    );

    // ================================================================
    // [4] owner/workspace分離: 対照groupは一連の操作で影響を受けない。
    // ================================================================
    const jobsOther = await db.casePatternDetectJob.count({ where: { workspaceId: workspaceOther.id } });
    ok("[4] 対照group(workspaceOther)にJobは作られない", jobsOther === 0, `count=${jobsOther}`);
  } finally {
    console.log("--- cleanup ---");
    await cleanupAll();
    const remaining = await db.user.count({ where: { email: { startsWith: EMAIL_PREFIX, endsWith: "@example.invalid" } } });
    ok("[cleanup] cleanup後、専用fixtureユーザーの残存0件", remaining === 0, `remaining=${remaining}`);

    guard.restore();
    ok("[AI network] AI networkへの実通信試行は0回", guard.deniedCallAttempts.length === 0, `attempts=${JSON.stringify(guard.deniedCallAttempts)}`);

    await db.$disconnect();
  }

  console.log(`\n=== 結果: ${passed} passed / ${failed} failed ===`);
  if (failed > 0) {
    console.log("失敗一覧:");
    for (const f of failures) console.log(`  - ${f}`);
    process.exit(1);
  }
}

main().catch((err) => {
  console.error("[verify script fatal error]", err);
  process.exit(1);
});
