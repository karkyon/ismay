#!/usr/bin/env node
/**
 * scripts/verify_gate_pattern_detect_01b.ts
 *
 * PATTERN-DETECT-01B(Queue・generation・trigger)の実DB受入証跡。
 * 出典: Claude向け_ISMAY_0fcea2b以降_再監査是正・PATTERN-DETECT連続実装指示_2026-09-03.md
 * §6 PATTERN-DETECT-01B、§7 受入条件 PD-07。
 *
 * AI providerへの実通信は行わない(installAiNetworkDenyGuardで機械的に保証)。
 *
 * 実行方法:
 *   cd ~/projects/ismay/app
 *   npx tsx ../scripts/verify_gate_pattern_detect_01b.ts
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
const EMAIL_PREFIX = "gate-pattern-detect-01b-verify-";

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
  const {
    enqueueCaseDetect,
    claimCaseDetectJobs,
    completeCaseDetectJob,
    failCaseDetectJob,
  } = await import("../app/src/lib/patterns/caseDetectQueue");

  const userIds: string[] = [];

  async function cleanupTestUser(userId: string): Promise<void> {
    await db.casePatternDetectJob.deleteMany({ where: { ownerSubjectUserId: userId } }).catch(() => null);
    await db.workspaceMember.findMany({ where: { userId }, select: { workspaceId: true } }).then(async (rows) => {
      for (const r of rows) {
        await db.workspaceMember.deleteMany({ where: { workspaceId: r.workspaceId } }).catch(() => null);
        await db.workspace.deleteMany({ where: { id: r.workspaceId } }).catch(() => null);
      }
    }).catch(() => null);
    await db.user.deleteMany({ where: { id: userId } }).catch(() => null);
  }

  const orphans = await db.user.findMany({
    where: { email: { startsWith: EMAIL_PREFIX, endsWith: "@example.invalid" } },
    select: { id: true },
  });
  if (orphans.length > 0) {
    console.log(`[SWEEP] 過去実行の孤立テストユーザー${orphans.length}件を削除します...`);
    for (const o of orphans) await cleanupTestUser(o.id);
  }

  async function makeUser(suffix: string): Promise<{ userId: string; workspaceId: string }> {
    const email = `${EMAIL_PREFIX}${RUN_ID}-${suffix}@example.invalid`;
    const user = await db.user.create({
      data: { email, passwordHash: "not-a-real-hash-for-db-only-test", displayName: `PATTERN-DETECT-01B ${suffix}` },
    });
    const workspace = await db.workspace.create({ data: { name: `PATTERN-DETECT-01B Workspace ${suffix}` } });
    await db.workspaceMember.create({ data: { workspaceId: workspace.id, userId: user.id, role: "OWNER" } });
    userIds.push(user.id);
    return { userId: user.id, workspaceId: workspace.id };
  }

  try {
    console.log("=== PATTERN-DETECT-01B 実DB受入試験 ===");

    // ================================================================
    // enqueue → 新規PENDING行作成
    // ================================================================
    {
      const fx = await makeUser("enqueue");
      const result = await enqueueCaseDetect(db, {
        workspaceId: fx.workspaceId,
        ownerSubjectUserId: fx.userId,
        reasonCode: "PRIMARY_LINKED",
      });
      ok("[enqueue] 初回enqueueは新規行を作成する(coalesced=false)", result.coalesced === false);
      ok("[enqueue] 初回generationは1", result.generation === 1);

      // ================================================================
      // coalescing: 既存PENDING行があれば新規行を作らずgenerationを増やす
      // ================================================================
      const result2 = await enqueueCaseDetect(db, {
        workspaceId: fx.workspaceId,
        ownerSubjectUserId: fx.userId,
        reasonCode: "PRIMARY_LINKED",
      });
      ok("[coalescing] 2回目のenqueueはcoalesceされる(coalesced=true)", result2.coalesced === true);
      ok("[coalescing] 同一jobId", result2.id === result.id);
      ok("[coalescing] generationが2へ増加", result2.generation === 2);

      const count = await db.casePatternDetectJob.count({
        where: { workspaceId: fx.workspaceId, ownerSubjectUserId: fx.userId },
      });
      ok("[coalescing] DB上のjob行数は1件のまま(重複行なし)", count === 1, `count=${count}`);
    }

    // ================================================================
    // claim → complete: 正常系
    // ================================================================
    {
      const fx = await makeUser("claim");
      await enqueueCaseDetect(db, { workspaceId: fx.workspaceId, ownerSubjectUserId: fx.userId, reasonCode: "PRIMARY_LINKED" });

      const claimed = await claimCaseDetectJobs(`test-worker-${RUN_ID}`, 10);
      const mine = claimed.filter((c) => c.ownerSubjectUserId === fx.userId);
      ok("[claim] enqueueした自分のjobが1件claimされる", mine.length === 1, `claimed=${mine.length}`);

      if (mine.length === 1) {
        const job = mine[0]!;
        const processing = await db.casePatternDetectJob.findUnique({ where: { id: job.id }, select: { status: true } });
        ok("[claim] claim後の状態はPROCESSING", processing?.status === "PROCESSING");

        const completeResult = await completeCaseDetectJob(job.id, job.generation);
        ok("[complete] generation一致時はDONEへ確定する", completeResult.status === "DONE");
        const done = await db.casePatternDetectJob.findUnique({ where: { id: job.id }, select: { status: true } });
        ok("[complete] DB上もDONE", done?.status === "DONE");
      }
    }

    // ================================================================
    // PD-07: generation更新後、旧worker結果のcommit0
    // (claim → 処理中にcoalescingでgeneration増加 → complete時に古い
    //  generationを渡すとDONEにならずPENDINGへ差し戻される)
    // ================================================================
    {
      const fx = await makeUser("pd07");
      await enqueueCaseDetect(db, { workspaceId: fx.workspaceId, ownerSubjectUserId: fx.userId, reasonCode: "PRIMARY_LINKED" });

      const claimed = await claimCaseDetectJobs(`test-worker-pd07-${RUN_ID}`, 10);
      const mine = claimed.filter((c) => c.ownerSubjectUserId === fx.userId);
      ok("[PD-07前提] claim成功", mine.length === 1);
      const job = mine[0]!;
      const observedGeneration = job.generation;

      // claim後、処理中に新たなPRIMARY link作成が発生した想定(coalescing)。
      const coalesceResult = await enqueueCaseDetect(db, {
        workspaceId: fx.workspaceId,
        ownerSubjectUserId: fx.userId,
        reasonCode: "PRIMARY_LINKED",
      });
      ok("[PD-07前提] PROCESSING中のcoalescingでgenerationが増加する", coalesceResult.generation > observedGeneration);

      // Workerは古いgeneration(claim時点の値)でcompleteしようとする。
      const staleComplete = await completeCaseDetectJob(job.id, observedGeneration);
      ok(
        "[PD-07] 古いgenerationでのcomplete試行はDONEにならずPENDINGへ差し戻される(旧Worker結果のcommit拒否)",
        staleComplete.status === "PENDING",
      );
      const afterStale = await db.casePatternDetectJob.findUnique({ where: { id: job.id }, select: { status: true, generation: true } });
      ok("[PD-07] DB上もPENDINGのまま(DONEになっていない)", afterStale?.status === "PENDING");
      ok("[PD-07] generationは増加した値を保持している(coalescing結果を失っていない)", afterStale?.generation === coalesceResult.generation);

      // 最新generationで再claim・completeすれば正しくDONEになる。
      const reclaimed = await claimCaseDetectJobs(`test-worker-pd07b-${RUN_ID}`, 10);
      const mineAgain = reclaimed.filter((c) => c.ownerSubjectUserId === fx.userId);
      ok("[PD-07] 差し戻し後は再claimできる", mineAgain.length === 1);
      if (mineAgain.length === 1) {
        const finalComplete = await completeCaseDetectJob(mineAgain[0]!.id, mineAgain[0]!.generation);
        ok("[PD-07] 最新generationでのcompleteはDONEに確定する", finalComplete.status === "DONE");
      }
    }

    // ================================================================
    // dead-letter: maxAttempts到達でDEAD_LETTERへ
    // ================================================================
    {
      const fx = await makeUser("deadletter");
      const enq = await enqueueCaseDetect(db, { workspaceId: fx.workspaceId, ownerSubjectUserId: fx.userId, reasonCode: "PRIMARY_LINKED" });
      await db.casePatternDetectJob.update({ where: { id: enq.id }, data: { maxAttempts: 1 } });

      const claimed = await claimCaseDetectJobs(`test-worker-dl-${RUN_ID}`, 10);
      const mine = claimed.filter((c) => c.ownerSubjectUserId === fx.userId);
      ok("[dead-letter前提] claim成功・attempt=1", mine.length === 1 && mine[0]!.attempt === 1);

      const failResult = await failCaseDetectJob(mine[0]!.id, new Error("verify-forced-failure"));
      ok("[dead-letter] maxAttempts(1)到達時点でDEAD_LETTERへ確定する", failResult.status === "DEAD_LETTER");
      const final = await db.casePatternDetectJob.findUnique({ where: { id: mine[0]!.id }, select: { status: true, lastErrorCode: true } });
      ok("[dead-letter] DB上もDEAD_LETTER", final?.status === "DEAD_LETTER");
      ok("[dead-letter] lastErrorCodeが記録される", !!final?.lastErrorCode);
    }

    // ================================================================
    // 二重worker同時claimでも重複0(FOR UPDATE SKIP LOCKEDの効果)
    // ================================================================
    {
      const fx = await makeUser("dualworker");
      await enqueueCaseDetect(db, { workspaceId: fx.workspaceId, ownerSubjectUserId: fx.userId, reasonCode: "PRIMARY_LINKED" });

      const [claimedA, claimedB] = await Promise.all([
        claimCaseDetectJobs(`test-worker-dualA-${RUN_ID}`, 10),
        claimCaseDetectJobs(`test-worker-dualB-${RUN_ID}`, 10),
      ]);
      const mineA = claimedA.filter((c) => c.ownerSubjectUserId === fx.userId).length;
      const mineB = claimedB.filter((c) => c.ownerSubjectUserId === fx.userId).length;
      ok("[二重worker] 合計claim件数は1件のみ(重複claim0件)", mineA + mineB === 1, `A=${mineA} B=${mineB}`);
    }

    ok("[AI課金] AI providerへの通信は0件", guard.deniedCallAttempts.length === 0, `attempts=${guard.deniedCallAttempts.length}`);
  } finally {
    console.log("\n[CLEANUP] テスト用データを削除します...");
    for (const userId of userIds) await cleanupTestUser(userId);
    const leftover = await db.user.findMany({ where: { email: { startsWith: EMAIL_PREFIX, endsWith: "@example.invalid" } }, select: { id: true } });
    ok("[cleanup] test用Userが1件も残っていない", leftover.length === 0, `remaining=${leftover.length}`);
    guard.restore();
  }

  console.log(`\n合計: ${passed} passed, ${failed} failed`);
  if (failed > 0) {
    console.log("\n失敗した項目:");
    for (const f of failures) console.log(`  - ${f}`);
    process.exit(1);
  }
}

main().catch((err) => {
  console.error("FATAL:", err);
  process.exit(1);
});
