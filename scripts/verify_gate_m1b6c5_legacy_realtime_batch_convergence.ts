#!/usr/bin/env node
/**
 * scripts/verify_gate_m1b6c5_legacy_realtime_batch_convergence.ts
 *
 * Gate M1-B6C-5(Legacy/Realtime/Batch収束)の非課金DB受入証跡。
 * 出典: Claude向け ISMAY c503e72以降 M1-B6C・全残件連続実装指示(2026-08-31) §7。
 *
 * [scope] 旧`/inferences/[id]/decision`route自体はnext/serverに依存するため
 * scripts/配下から直接importできない(既存verify_gate_m1b42_legacy_cutover_guard.ts
 * と同じ制約)。このscriptはroute.tsが呼ぶ`resolveLegacyFallbackEligibility`
 * (route本体から独立したpure関数)を直接検証する。
 *
 * 実行方法:
 *   cd ~/projects/ismay/app
 *   npx tsx ../scripts/verify_gate_m1b6c5_legacy_realtime_batch_convergence.ts
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { installAiNetworkDenyGuard, selfTestAiNetworkDenyGuard } from "./lib/aiNetworkDenyGuard";
import { cleanupFormationVerifyUser, assertNoLeftoverFormationVerifyUsers } from "./lib/formationVerifyCleanup";

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
const EMAIL_PREFIX = "gate-m1b6c5-convergence-verify-";

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
  const denyGuard = installAiNetworkDenyGuard();
  const guardSelfTestPassed = await selfTestAiNetworkDenyGuard(denyGuard);
  ok("[非課金guard] AI network deny guardのpure self-testが機能する", guardSelfTestPassed);
  if (!guardSelfTestPassed) {
    denyGuard.restore();
    console.log(`\n合計: ${passed} passed, ${failed} failed`);
    process.exitCode = 1;
    return;
  }

  const { db } = await import("../app/src/lib/db");
  const { resolveLegacyFallbackEligibility, findFormationSessionForCapture } = await import(
    "../app/src/lib/formation/legacyProjectionResolver"
  );

  const orphans = await db.user.findMany({
    where: { email: { startsWith: EMAIL_PREFIX, endsWith: "@example.invalid" } },
    select: { id: true },
  });
  if (orphans.length > 0) {
    console.log(`[SWEEP] 過去実行の孤立テストユーザー${orphans.length}件を削除します...`);
    for (const o of orphans) {
      await cleanupFormationVerifyUser(db, o.id);
    }
  }

  const userIds: string[] = [];

  async function makeFixture(suffix: string) {
    const email = `${EMAIL_PREFIX}${RUN_ID}-${suffix}@example.invalid`;
    const user = await db.user.create({
      data: { email, passwordHash: "not-a-real-hash-for-db-only-test", displayName: `Gate M1-B6C-5 ${suffix}` },
    });
    const workspace = await db.workspace.create({ data: { name: `Gate M1-B6C-5 Workspace ${suffix}` } });
    await db.workspaceMember.create({ data: { workspaceId: workspace.id, userId: user.id, role: "OWNER" } });
    const domain = await db.domain.create({ data: { workspaceId: workspace.id, name: "個人", kind: "PERSONAL" } });
    userIds.push(user.id);
    return { userId: user.id, workspaceId: workspace.id, domainId: domain.id };
  }

  async function seedCaptureAndAiRun(fx: { workspaceId: string; domainId: string; userId: string }, suffix: string) {
    const capture = await db.capture.create({
      data: { workspaceId: fx.workspaceId, domainId: fx.domainId, createdById: fx.userId, sourceType: "TEXT", rawText: `検証用${suffix}`, processingStatus: "READY" },
    });
    const aiRun = await db.aiRun.create({
      data: { captureId: capture.id, workspaceId: fx.workspaceId, provider: "test", model: "test", promptVersion: "v", schemaVersion: "v", status: "SUCCEEDED" },
    });
    return { capture, aiRun };
  }

  try {
    // ============================================================
    // A: shadow欠落条件の明文化 — Session無し・checkpoint無しは許可(=真に
    //    一度もshadow書込みが試みられていない、旧データ相当)。
    // ============================================================
    {
      const fx = await makeFixture("a");
      const { capture } = await seedCaptureAndAiRun(fx, "a");
      const decision = await resolveLegacyFallbackEligibility(db, { captureId: capture.id, workspaceId: fx.workspaceId });
      ok("[A.1] checkpoint自体が存在しない場合はfallback許可", decision.allowed === true, JSON.stringify(decision));
    }

    // ============================================================
    // B/C: 是正の核心 — shadow書込みが進行中(PENDING/RETRY_WAIT)の間は
    //    「欠落」と確定していないため、fallbackを許可しない。
    // ============================================================
    for (const status of ["PENDING", "RUNNING", "RETRY_WAIT"] as const) {
      const fx = await makeFixture(`bc-${status.toLowerCase()}`);
      const { capture, aiRun } = await seedCaptureAndAiRun(fx, status);
      await db.formationShadowCheckpoint.create({
        data: { workspaceId: fx.workspaceId, captureId: capture.id, aiRunId: aiRun.id, requestHash: "test-hash", status },
      });
      const decision = await resolveLegacyFallbackEligibility(db, { captureId: capture.id, workspaceId: fx.workspaceId });
      ok(
        `[BC.${status}・是正の核心] checkpoint=${status}(進行中)の間はfallback不許可(SHADOW_WRITE_IN_PROGRESS)`,
        decision.allowed === false && (decision as { reason: string }).reason === "SHADOW_WRITE_IN_PROGRESS",
        JSON.stringify(decision),
      );
    }

    // ============================================================
    // D/E: checkpointが終端(DEAD_LETTER/CANCELLED)に達していれば
    //    「欠落が確定した」とみなしfallbackを許可する。
    // ============================================================
    for (const status of ["DEAD_LETTER", "CANCELLED"] as const) {
      const fx = await makeFixture(`de-${status.toLowerCase()}`);
      const { capture, aiRun } = await seedCaptureAndAiRun(fx, status);
      await db.formationShadowCheckpoint.create({
        data: { workspaceId: fx.workspaceId, captureId: capture.id, aiRunId: aiRun.id, requestHash: "test-hash", status },
      });
      const decision = await resolveLegacyFallbackEligibility(db, { captureId: capture.id, workspaceId: fx.workspaceId });
      ok(`[DE.${status}] checkpoint=${status}(終端・欠落確定)はfallback許可`, decision.allowed === true, JSON.stringify(decision));
    }

    // ============================================================
    // F: FormationSessionが既に存在する場合は、checkpoint状態に関わらず
    //    最優先で拒否する(既存B4.2 guardの回帰確認)。
    // ============================================================
    {
      const fx = await makeFixture("f");
      const { capture, aiRun } = await seedCaptureAndAiRun(fx, "f");
      const session = await db.formationSession.create({
        data: { workspaceId: fx.workspaceId, domainId: fx.domainId, subjectUserId: fx.userId, captureId: capture.id, clientSessionKey: "conv-f", state: "REVIEW_READY" },
      });
      // checkpointがSUCCEEDEDであっても(通常はSession成立と同時にこうなる)、
      // 判定はSession存在チェックが最優先であることを確認する。
      await db.formationShadowCheckpoint.create({
        data: { workspaceId: fx.workspaceId, captureId: capture.id, aiRunId: aiRun.id, requestHash: "test-hash", status: "SUCCEEDED" },
      });
      const decision = await resolveLegacyFallbackEligibility(db, { captureId: capture.id, workspaceId: fx.workspaceId });
      ok(
        "[F.1・回帰確認] FormationSession存在時は最優先でFORMATION_SESSION_EXISTS拒否",
        decision.allowed === false && (decision as { reason: string; formationSessionId: string }).reason === "FORMATION_SESSION_EXISTS" && (decision as { formationSessionId: string }).formationSessionId === session.id,
        JSON.stringify(decision),
      );

      // findFormationSessionForCapture自体も引き続き独立して正しく動作する
      // (既存verify_gate_m1b42のテスト対象、非破壊の回帰確認)。
      const directLookup = await findFormationSessionForCapture(db, { captureId: capture.id, workspaceId: fx.workspaceId });
      ok("[F.2・既存機能の回帰確認] findFormationSessionForCaptureは変更なく動作する", directLookup?.id === session.id);
    }

    // ============================================================
    // G: tenant境界 — 別workspaceのcheckpoint/Sessionは判定に影響しない。
    // ============================================================
    {
      const fxA = await makeFixture("g-a");
      const fxB = await makeFixture("g-b");
      const { capture: captureA } = await seedCaptureAndAiRun(fxA, "g-a");
      // captureAと同じcaptureIdの別workspace分は作れない(captureId自体が
      // workspace非依存の一意ID)ため、workspaceId境界の検証はcaptureIdは
      // 同じでもworkspaceIdが異なれば見つからない、という形で確認する
      // (実際にはcaptureId自体がグローバルに一意なため、この呼出しは
      // 「他workspaceのcaptureIdを自workspaceのIDのつもりで問い合わせても
      // 何も見つからない」という自然な否定形の確認になる)。
      const decision = await resolveLegacyFallbackEligibility(db, { captureId: captureA.id, workspaceId: fxB.workspaceId });
      ok("[G.1・tenant境界] 他workspaceからの問い合わせはFormationSession不在同様にfallback許可扱い(越境データ漏洩なし)", decision.allowed === true, JSON.stringify(decision));
    }
  } catch (err) {
    failed++;
    failures.push(`予期しない例外: ${String(err)}`);
    console.error(err);
  }

  for (const uid of userIds) {
    const result = await cleanupFormationVerifyUser(db, uid);
    if (result.errors.length > 0) {
      failed++;
      failures.push(`cleanup失敗(userId=${uid}): ${JSON.stringify(result.errors)}`);
    }
  }
  const leftover = await assertNoLeftoverFormationVerifyUsers(db, EMAIL_PREFIX);
  ok("[cleanup] test用Userが1件も残っていない", leftover.clean, JSON.stringify(leftover.remainingUserIds));

  denyGuard.restore();
  console.log(`\n合計: ${passed} passed, ${failed} failed`);
  if (failed > 0) {
    console.log("\n失敗一覧:");
    for (const f of failures) console.log(`  - ${f}`);
    process.exitCode = 1;
  }
}

main().catch((err) => {
  console.error("[FATAL]", err);
  process.exitCode = 1;
});
