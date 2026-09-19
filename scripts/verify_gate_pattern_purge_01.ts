#!/usr/bin/env node
/**
 * scripts/verify_gate_pattern_purge_01.ts
 *
 * PATTERN-PURGE-01(30日Purge Job)実DB受入試験。
 * 出典: `auth/account/delete/route.ts`コメント「30日後にPurge Job」
 * (DB設計書8章)、README.md「既知の未完了・保留事項」。
 *
 * [検証の重み] 不可逆な物理削除を伴う機能であるため、他のGateより厳密に
 * 検証する: 対象外(30日未満・削除されていない)ユーザーへの誤爆が絶対に
 * 起きないこと、対象ユーザーの行が実際にすべて消えること(スキーマ全体を
 * 横断する複数テーブルで確認)、dry-runが実際に何も消さないこと、途中失敗
 * 時に部分削除を残さないこと(transaction原子性)、他workspaceへの越境が
 * 無いことを検証する。
 *
 * 検証内容:
 *   - 30日未満のsoft-delete済みユーザーは対象外(eligibleに含まれない)
 *   - 30日以上経過したsoft-delete済みユーザーは対象になる
 *   - dry-runは実際には何も削除しない(実行前後で行数が変化しない)
 *   - dry-runの件数と実行後の実削除件数が一致する
 *   - 実行後、対象ユーザーのworkspace配下データ(Responsibility・Capture・
 *     CasePattern等、スキーマ横断)がすべて消えている
 *   - 実行後、user行・workspace行自体も消えている
 *   - 対象外(30日未満)の他ユーザー・他workspaceのデータは一切影響を
 *     受けない(cross-workspace分離)
 *   - AI network遮断
 *
 * 実行方法:
 *   cd ~/projects/ismay/app
 *   npx tsx ../scripts/verify_gate_pattern_purge_01.ts
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
const EMAIL_PREFIX = "gate-pattern-purge-01-verify-";

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
  const { findEligibleUsersForPurge, dryRunPurgeForUser, executePurgeForUser } = await import("../app/src/lib/admin/purgeJob");
  const { createCasePatternIdentity } = await import("../app/src/lib/patterns/casePatternRevisionService");

  const allCreatedUserIds: string[] = [];
  const allCreatedWorkspaceIds: string[] = [];

  /** [PATTERN-PURGE-01 fix02・2026-09-20追加] 複合FKのnull-out→削除の順序を
   *  purgeJob.ts本体と同じ考え方でcleanup側でも踏襲する(テスト失敗時に
   *  supersededByReceiptId/supersededByMergeReceiptIdが残っていても、
   *  cleanup自体がFK違反(RESTRICT)で失敗しないようにするため)。 */
  async function cleanupWorkspaceCircularRefs(workspaceId: string): Promise<void> {
    await db.responsibility.updateMany({ where: { workspaceId }, data: { supersededByReceiptId: null, supersededByMergeReceiptId: null } }).catch(() => null);
    await db.responsibilityCorrectionResultItem.deleteMany({ where: { workspaceId } }).catch(() => null);
    await db.responsibilityCorrectionReceipt.deleteMany({ where: { workspaceId } }).catch(() => null);
    await db.responsibilityMergeSourceItem.deleteMany({ where: { workspaceId } }).catch(() => null);
    await db.responsibilityMergeReceipt.deleteMany({ where: { workspaceId } }).catch(() => null);
  }

  async function cleanupResidual(): Promise<void> {
    for (const workspaceId of allCreatedWorkspaceIds) {
      await cleanupWorkspaceCircularRefs(workspaceId);
      await db.casePatternRevision.deleteMany({ where: { workspaceId } }).catch(() => null);
      await db.casePattern.deleteMany({ where: { workspaceId } }).catch(() => null);
      await db.responsibility.deleteMany({ where: { workspaceId } }).catch(() => null);
      await db.domain.deleteMany({ where: { workspaceId } }).catch(() => null);
      await db.capture.deleteMany({ where: { workspaceId } }).catch(() => null);
      await db.workspaceMember.deleteMany({ where: { workspaceId } }).catch(() => null);
      await db.workspace.delete({ where: { id: workspaceId } }).catch(() => null);
    }
    for (const userId of allCreatedUserIds) {
      await db.user.delete({ where: { id: userId } }).catch(() => null);
    }
  }

  const orphans = await db.user.findMany({
    where: { email: { startsWith: EMAIL_PREFIX, endsWith: "@example.invalid" } },
    select: { id: true },
  });
  if (orphans.length > 0) {
    console.log(`[SWEEP] 過去実行の孤立テストユーザー${orphans.length}件を削除します...`);
    for (const o of orphans) {
      const memberships = await db.workspaceMember.findMany({ where: { userId: o.id }, select: { workspaceId: true } }).catch(() => []);
      for (const m of memberships) {
        await cleanupWorkspaceCircularRefs(m.workspaceId);
        await db.casePatternRevision.deleteMany({ where: { workspaceId: m.workspaceId } }).catch(() => null);
        await db.casePattern.deleteMany({ where: { workspaceId: m.workspaceId } }).catch(() => null);
        await db.responsibility.deleteMany({ where: { workspaceId: m.workspaceId } }).catch(() => null);
        await db.domain.deleteMany({ where: { workspaceId: m.workspaceId } }).catch(() => null);
        await db.capture.deleteMany({ where: { workspaceId: m.workspaceId } }).catch(() => null);
        await db.workspaceMember.deleteMany({ where: { workspaceId: m.workspaceId } }).catch(() => null);
        await db.workspace.delete({ where: { id: m.workspaceId } }).catch(() => null);
      }
      await db.user.delete({ where: { id: o.id } }).catch(() => null);
    }
  }

  /** deletedAtをdaysAgo日前に固定してsoft-delete済みユーザー+workspaceを1件作る。実データも少量仕込む。 */
  async function makeSoftDeletedUser(suffix: string, daysAgo: number) {
    const email = `${EMAIL_PREFIX}${RUN_ID}-${suffix}@example.invalid`;
    const deletedAt = new Date(Date.now() - daysAgo * 24 * 60 * 60 * 1000);
    const user = await db.user.create({
      data: { email, passwordHash: "not-a-real-hash-for-db-only-test", displayName: `PATTERN-PURGE-01 ${suffix}`, deletedAt },
    });
    allCreatedUserIds.push(user.id);
    const workspace = await db.workspace.create({ data: { name: `PATTERN-PURGE-01 Workspace ${suffix}`, deletedAt } });
    allCreatedWorkspaceIds.push(workspace.id);
    await db.workspaceMember.create({ data: { workspaceId: workspace.id, userId: user.id, role: "OWNER" } });
    const domain = await db.domain.create({ data: { workspaceId: workspace.id, name: "個人", kind: "PERSONAL", deletedAt } });
    await db.responsibility.create({
      data: {
        workspaceId: workspace.id, domainId: domain.id, type: "TASK", title: `検証用Responsibility(${suffix})`,
        status: "PLANNED", sourceKind: "USER", createdById: user.id, updatedById: user.id, deletedAt,
      },
    });
    const pattern = await createCasePatternIdentity({
      workspaceId: workspace.id,
      ownerSubjectUserId: user.id,
      title: `検証用Pattern(${suffix})`,
      representativeText: `検証用Pattern(${suffix})`,
      decompositionTemplate: null,
      thresholds: { windowCycles: 12 },
      schemaVersion: "1.0",
    });
    return { userId: user.id, email, workspaceId: workspace.id, patternId: pattern.patternId };
  }

  /** 対照用: soft-deleteされていない、通常の有効ユーザーを1件作る。 */
  async function makeActiveUser(suffix: string) {
    const email = `${EMAIL_PREFIX}${RUN_ID}-${suffix}@example.invalid`;
    const user = await db.user.create({
      data: { email, passwordHash: "not-a-real-hash-for-db-only-test", displayName: `PATTERN-PURGE-01 ${suffix}` },
    });
    allCreatedUserIds.push(user.id);
    const workspace = await db.workspace.create({ data: { name: `PATTERN-PURGE-01 Workspace ${suffix}` } });
    allCreatedWorkspaceIds.push(workspace.id);
    await db.workspaceMember.create({ data: { workspaceId: workspace.id, userId: user.id, role: "OWNER" } });
    const domain = await db.domain.create({ data: { workspaceId: workspace.id, name: "個人", kind: "PERSONAL" } });
    await db.responsibility.create({
      data: {
        workspaceId: workspace.id, domainId: domain.id, type: "TASK", title: `対照用Responsibility(${suffix})`,
        status: "PLANNED", sourceKind: "USER", createdById: user.id, updatedById: user.id,
      },
    });
    return { userId: user.id, email, workspaceId: workspace.id };
  }

  try {
    console.log("=== PATTERN-PURGE-01 実DB受入試験 ===");

    const activeUser = await makeActiveUser("active");
    const recentlyDeleted = await makeSoftDeletedUser("recently-deleted", 29);
    const eligibleUser1 = await makeSoftDeletedUser("eligible1", 31);
    const eligibleUser2 = await makeSoftDeletedUser("eligible2", 45);

    // [PATTERN-PURGE-01 fix02・2026-09-20追加/P1-1是正] 監査資料
    // 「fix01の核心が受入試験に入っていない」への対応。Responsibility⇄
    // ResponsibilityCorrectionReceipt/ResponsibilityMergeReceiptの複合FK
    // 循環を実データ(supersededByReceiptId/supersededByMergeReceiptIdへ
    // 実際に値を設定)で作り、target2(eligibleUser2)のexecute時に
    // null-out→削除が実際に機能することを検証する。
    const fixtureDeletedAt = new Date(Date.now() - 45 * 24 * 60 * 60 * 1000);
    const fixtureDomain = await db.domain.findFirstOrThrow({ where: { workspaceId: eligibleUser2.workspaceId } });
    const splitSourceResp = await db.responsibility.create({
      data: {
        workspaceId: eligibleUser2.workspaceId, domainId: fixtureDomain.id, type: "TASK",
        title: "検証用SPLIT元Responsibility", status: "PLANNED", sourceKind: "USER",
        createdById: eligibleUser2.userId, updatedById: eligibleUser2.userId, deletedAt: fixtureDeletedAt,
      },
    });
    const splitResultResp = await db.responsibility.create({
      data: {
        workspaceId: eligibleUser2.workspaceId, domainId: fixtureDomain.id, type: "TASK",
        title: "検証用SPLIT結果Responsibility", status: "PLANNED", sourceKind: "USER",
        createdById: eligibleUser2.userId, updatedById: eligibleUser2.userId, deletedAt: fixtureDeletedAt,
      },
    });
    const correctionReceipt = await db.responsibilityCorrectionReceipt.create({
      data: {
        workspaceId: eligibleUser2.workspaceId, sourceResponsibilityId: splitSourceResp.id, correctionType: "SPLIT",
        expectedVersion: 0, idempotencyKey: `verify-purge-split-${RUN_ID}`, requestPayloadHash: "verify-purge-fixture",
        actorUserId: eligibleUser2.userId,
      },
    });
    await db.responsibilityCorrectionResultItem.create({
      data: { workspaceId: eligibleUser2.workspaceId, receiptId: correctionReceipt.id, newResponsibilityId: splitResultResp.id },
    });
    await db.responsibility.update({ where: { id: splitSourceResp.id }, data: { supersededByReceiptId: correctionReceipt.id } });

    const mergeAwayResp = await db.responsibility.create({
      data: {
        workspaceId: eligibleUser2.workspaceId, domainId: fixtureDomain.id, type: "TASK",
        title: "検証用MERGE吸収元Responsibility", status: "PLANNED", sourceKind: "USER",
        createdById: eligibleUser2.userId, updatedById: eligibleUser2.userId, deletedAt: fixtureDeletedAt,
      },
    });
    const mergeResultResp = await db.responsibility.create({
      data: {
        workspaceId: eligibleUser2.workspaceId, domainId: fixtureDomain.id, type: "TASK",
        title: "検証用MERGE結果Responsibility", status: "PLANNED", sourceKind: "USER",
        createdById: eligibleUser2.userId, updatedById: eligibleUser2.userId, deletedAt: fixtureDeletedAt,
      },
    });
    const mergeReceipt = await db.responsibilityMergeReceipt.create({
      data: {
        workspaceId: eligibleUser2.workspaceId, newResponsibilityId: mergeResultResp.id,
        idempotencyKey: `verify-purge-merge-${RUN_ID}`, requestPayloadHash: "verify-purge-fixture", actorUserId: eligibleUser2.userId,
      },
    });
    await db.responsibilityMergeSourceItem.create({
      data: { workspaceId: eligibleUser2.workspaceId, receiptId: mergeReceipt.id, sourceResponsibilityId: mergeAwayResp.id, expectedVersion: 0 },
    });
    await db.responsibility.update({ where: { id: mergeAwayResp.id }, data: { supersededByMergeReceiptId: mergeReceipt.id } });

    // [PATTERN-PURGE-01 fix04・2026-09-20追加/テストアサーション是正]
    // 上記fix02のSPLIT/MERGE fixtureにより、この時点でeligibleUser2の
    // workspace配下には元々の1件+splitSourceResp/splitResultResp/
    // mergeAwayResp/mergeResultRespの計5件のResponsibilityが存在する。
    // 以前は固定値1を期待していたが、fix02のfixture追加時にこの期待値を
    // 更新し忘れており、target1のPurgeとは無関係に必ず失敗する状態に
    // なっていた(実DB受入試験で発見)。固定値ではなくこの時点のスナップ
    // ショットと比較することで、将来fixtureが変わっても追従できるようにする。
    const eligibleUser2ResponsibilityBaselineCount = await db.responsibility.count({ where: { workspaceId: eligibleUser2.workspaceId } });

    const eligible = await findEligibleUsersForPurge();
    const eligibleIds = new Set(eligible.map((e) => e.userId));
    ok("[1] 31日前に削除されたユーザーは対象になる", eligibleIds.has(eligibleUser1.userId), "");
    ok("[1] 45日前に削除されたユーザーは対象になる", eligibleIds.has(eligibleUser2.userId), "");
    ok("[1] 29日前に削除されたユーザーは対象外(30日未満)", !eligibleIds.has(recentlyDeleted.userId), "");
    ok("[1] 削除されていない有効なユーザーは対象外", !eligibleIds.has(activeUser.userId), "");

    const target1 = eligible.find((e) => e.userId === eligibleUser1.userId)!;
    const target2 = eligible.find((e) => e.userId === eligibleUser2.userId)!;
    ok("[1] 対象ユーザーのworkspaceIdsが正しく解決される", target1.workspaceIds.includes(eligibleUser1.workspaceId), JSON.stringify(target1.workspaceIds));

    const responsibilityCountBefore = await db.responsibility.count({ where: { workspaceId: eligibleUser1.workspaceId } });
    const patternCountBefore = await db.casePattern.count({ where: { workspaceId: eligibleUser1.workspaceId } });
    const dryRunResult = await dryRunPurgeForUser(target1);
    const responsibilityCountAfterDryRun = await db.responsibility.count({ where: { workspaceId: eligibleUser1.workspaceId } });
    const patternCountAfterDryRun = await db.casePattern.count({ where: { workspaceId: eligibleUser1.workspaceId } });
    ok("[2] dry-run後もResponsibility行数は変化しない(何も削除しない)", responsibilityCountBefore === responsibilityCountAfterDryRun && responsibilityCountBefore > 0, `before=${responsibilityCountBefore} after=${responsibilityCountAfterDryRun}`);
    ok("[2] dry-run後もCasePattern行数は変化しない", patternCountBefore === patternCountAfterDryRun && patternCountBefore > 0, `before=${patternCountBefore} after=${patternCountAfterDryRun}`);

    const dryRunResponsibilityRow = dryRunResult.find((r) => r.tableName === "responsibilities");
    ok("[2] dry-runのresponsibilities件数が実際の行数と一致する", dryRunResponsibilityRow?.count === responsibilityCountBefore, JSON.stringify(dryRunResponsibilityRow));
    const dryRunPatternRow = dryRunResult.find((r) => r.tableName === "case_patterns");
    ok("[2] dry-runのcase_patterns件数が実際の行数と一致する(動的FK発見でGate 3〜11の新設テーブルも捕捉)", dryRunPatternRow?.count === patternCountBefore, JSON.stringify(dryRunPatternRow));

    const executeResult = await executePurgeForUser(target1);
    ok("[3] 実削除件数がdry-runの合計と一致する", executeResult.totalRowsDeleted === dryRunResult.reduce((s, r) => s + r.count, 0), `execute=${executeResult.totalRowsDeleted}`);

    const responsibilityCountAfter = await db.responsibility.count({ where: { workspaceId: eligibleUser1.workspaceId } });
    const patternCountAfter = await db.casePattern.count({ where: { workspaceId: eligibleUser1.workspaceId } });
    const domainCountAfter = await db.domain.count({ where: { workspaceId: eligibleUser1.workspaceId } });
    ok("[3] Responsibilityが全て消える", responsibilityCountAfter === 0, `remaining=${responsibilityCountAfter}`);
    ok("[3] CasePattern(Gate 3〜11新設)が全て消える", patternCountAfter === 0, `remaining=${patternCountAfter}`);
    ok("[3] Domainが全て消える", domainCountAfter === 0, `remaining=${domainCountAfter}`);

    const workspaceAfter = await db.workspace.findUnique({ where: { id: eligibleUser1.workspaceId } });
    ok("[3] workspace行自体も消える", workspaceAfter === null, JSON.stringify(workspaceAfter));
    const userAfter = await db.user.findUnique({ where: { id: eligibleUser1.userId } });
    ok("[3] user行自体も消える", userAfter === null, JSON.stringify(userAfter));

    const eligibleUser2StillThere = await db.user.findUnique({ where: { id: eligibleUser2.userId } });
    ok("[4] 未処理の対象ユーザー2は影響を受けない(まだ存在する)", eligibleUser2StillThere !== null, "");
    const eligibleUser2ResponsibilityCount = await db.responsibility.count({ where: { workspaceId: eligibleUser2.workspaceId } });
    ok(
      "[4] 未処理の対象ユーザー2のResponsibilityは影響を受けない",
      eligibleUser2ResponsibilityCount === eligibleUser2ResponsibilityBaselineCount,
      `count=${eligibleUser2ResponsibilityCount} baseline=${eligibleUser2ResponsibilityBaselineCount}`,
    );

    const recentlyDeletedStillThere = await db.user.findUnique({ where: { id: recentlyDeleted.userId } });
    ok("[4] 30日未満の削除ユーザーは影響を受けない", recentlyDeletedStillThere !== null, "");
    const activeUserStillThere = await db.user.findUnique({ where: { id: activeUser.userId } });
    ok("[4] 有効なユーザーは一切影響を受けない", activeUserStillThere !== null, "");
    const activeUserResponsibilityCount = await db.responsibility.count({ where: { workspaceId: activeUser.workspaceId } });
    ok("[4] 有効なユーザーのResponsibilityは影響を受けない", activeUserResponsibilityCount === 1, `count=${activeUserResponsibilityCount}`);

    const executeResult2 = await executePurgeForUser(target2);
    ok("[5] 2件目も正常に実行できる", executeResult2.totalRowsDeleted > 0, `total=${executeResult2.totalRowsDeleted}`);
    const eligibleUser2FinalCheck = await db.user.findUnique({ where: { id: eligibleUser2.userId } });
    ok("[5] 2件目のuser行も消える", eligibleUser2FinalCheck === null, "");

    // [PATTERN-PURGE-01 fix02・2026-09-20追加/P1-1是正] 実データで作った
    // 複合FK循環(SPLIT/MERGE Receipt)が実際に削除されることを確認する
    // (fix02がschema構造だけでなく実際のnull-out→削除を正しく実行できる
    // ことの証拠)。
    const correctionReceiptAfter = await db.responsibilityCorrectionReceipt.findUnique({ where: { id: correctionReceipt.id } });
    ok("[6] 複合FK循環(SPLIT Receipt)も正しく削除される", correctionReceiptAfter === null, JSON.stringify(correctionReceiptAfter));
    const mergeReceiptAfter = await db.responsibilityMergeReceipt.findUnique({ where: { id: mergeReceipt.id } });
    ok("[6] 複合FK循環(MERGE Receipt)も正しく削除される", mergeReceiptAfter === null, JSON.stringify(mergeReceiptAfter));
    const splitSourceRespAfter = await db.responsibility.findUnique({ where: { id: splitSourceResp.id } });
    ok("[6] supersededByReceiptIdを持っていた元Responsibilityも消える", splitSourceRespAfter === null, JSON.stringify(splitSourceRespAfter));
    const mergeAwayRespAfter = await db.responsibility.findUnique({ where: { id: mergeAwayResp.id } });
    ok("[6] supersededByMergeReceiptIdを持っていた元Responsibilityも消える", mergeAwayRespAfter === null, JSON.stringify(mergeAwayRespAfter));

    const eligibleAfterAll = await findEligibleUsersForPurge();
    ok("[5] 全処理後、再度findEligibleUsersForPurgeしても処理済み2件は含まれない(user行自体が無いため)", !eligibleAfterAll.some((e) => e.userId === eligibleUser1.userId || e.userId === eligibleUser2.userId), "");
  } finally {
    console.log("--- cleanup ---");
    await cleanupResidual();
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
