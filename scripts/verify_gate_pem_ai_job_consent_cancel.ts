#!/usr/bin/env node
/**
 * scripts/verify_gate_pem_ai_job_consent_cancel.ts
 *
 * PEM-CONSENT-JOB-CANCEL(AI Job実行前Consent再評価)の実DB受入証跡。
 * 出典: DOC-09(Consent・Data Governance仕様書) 9章「既存Jobも実行前cancel」、
 * CHG-073。
 *
 * [非課金原則] Consent=GRANTED状態でJobを実際に処理させるテストは、実際の
 * AI Provider呼び出し(課金)を伴うため行わない。checkAiJobConsentAllowed単体の
 * 判定ロジックはGRANTED/WITHDRAWN両方を検証するが、processAiExtractJobs経由の
 * E2Eテストは「WITHDRAWN状態でJobがCANCELLEDになり、AI呼び出しが一切発生しない
 * こと」のみを確認する(aiNetworkDenyGuardで機械的に保証)。
 *
 * 実行方法:
 *   cd ~/projects/ismay/app
 *   npx tsx ../scripts/verify_gate_pem_ai_job_consent_cancel.ts
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
const EMAIL_PREFIX = "gate-pem-ai-job-consent-verify-";

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
  const { installAiNetworkDenyGuard, selfTestAiNetworkDenyGuard } = await import("./lib/aiNetworkDenyGuard");
  const denyGuard = installAiNetworkDenyGuard();
  const guardSelfTestPassed = await selfTestAiNetworkDenyGuard(denyGuard);
  ok("[非課金guard] AI network deny guardのpure self-testが機能する", guardSelfTestPassed);
  const deniedBaseline = denyGuard.deniedCallAttempts.length;
  if (!guardSelfTestPassed) {
    console.error("[FATAL] deny guardのself-testに失敗したため、AI課金安全性を保証できません。中断します。");
    process.exitCode = 1;
    return;
  }

  const { db } = await import("../app/src/lib/db");
  const { checkAiJobConsentAllowed } = await import("../app/src/lib/pem/aiJobConsentGate");
  const { processAiExtractJobs } = await import("../app/src/lib/worker/aiExtractJob");

  const orphans = await db.user.findMany({
    where: { email: { startsWith: EMAIL_PREFIX, endsWith: "@example.invalid" } },
    select: { id: true },
  });

  const userIds: string[] = [];

  async function cleanupTestUser(userId: string): Promise<void> {
    const captures = await db.capture.findMany({ where: { createdById: userId }, select: { id: true } }).catch(() => [] as { id: string }[]);
    const captureIds = captures.map((c: { id: string }) => c.id);
    if (captureIds.length > 0) {
      await db.job.deleteMany({ where: { jobType: "AI_EXTRACT", aggregateId: { in: captureIds } } }).catch(() => null);
      await db.eventLog.deleteMany({ where: { aggregateId: { in: captureIds } } }).catch(() => null);
      await db.outboxEvent.deleteMany({ where: { aggregateId: { in: captureIds } } }).catch(() => null);
      await db.capture.deleteMany({ where: { id: { in: captureIds } } }).catch(() => null);
    }
    const memberships = await db.workspaceMember.findMany({ where: { userId }, select: { workspaceId: true } }).catch(() => [] as { workspaceId: string }[]);
    await db.pemConsentEvent.deleteMany({ where: { userId } }).catch(() => null);
    await db.workspaceMember.deleteMany({ where: { userId } }).catch(() => null);
    for (const m of memberships) {
      await db.workspace.deleteMany({ where: { id: m.workspaceId } }).catch(() => null);
    }
    await db.userSession.deleteMany({ where: { userId } }).catch(() => null);
    await db.user.deleteMany({ where: { id: userId } }).catch(() => null);
  }

  if (orphans.length > 0) {
    console.log(`[SWEEP] 過去実行の孤立テストユーザー${orphans.length}件を削除します...`);
    for (const o of orphans) {
      await cleanupTestUser(o.id);
    }
  }

  async function makeFixture(suffix: string) {
    const email = `${EMAIL_PREFIX}${RUN_ID}-${suffix}@example.invalid`;
    const user = await db.user.create({
      data: { email, passwordHash: "not-a-real-hash-for-db-only-test", displayName: `PEM AiJobConsent ${suffix}` },
    });
    const workspace = await db.workspace.create({ data: { name: `PEM AiJobConsent Workspace ${suffix}` } });
    await db.workspaceMember.create({ data: { workspaceId: workspace.id, userId: user.id, role: "OWNER" } });
    const domain = await db.domain.create({ data: { workspaceId: workspace.id, name: "個人", kind: "PERSONAL" } });
    userIds.push(user.id);
    return { userId: user.id, workspaceId: workspace.id, domainId: domain.id };
  }

  async function seedCapture(fx: { workspaceId: string; domainId: string; userId: string }, key: string) {
    return db.capture.create({
      data: {
        workspaceId: fx.workspaceId, domainId: fx.domainId, createdById: fx.userId,
        sourceType: "TEXT", rawText: `検証用${key}`, processingStatus: "SAVED",
      },
    });
  }

  try {
    // ============================================================
    // A: Consent GRANTED時、allowed=true。
    // ============================================================
    {
      const fx = await makeFixture("a");
      const capture = await seedCapture(fx, "a");
      await db.pemConsentEvent.create({
        data: { userId: fx.userId, workspaceId: fx.workspaceId, consentType: "PEM_AI_PROCESSING", action: "GRANTED", policyVersion: "v4.0-2026-08-24", source: "SETTINGS" },
      });
      const result = await checkAiJobConsentAllowed(capture.id);
      ok("[A] Consent GRANTED時はallowed=true", result.allowed === true);
    }

    // ============================================================
    // B: Consent WITHDRAWN時、allowed=false, reason=CONSENT_WITHDRAWN。
    // ============================================================
    {
      const fx = await makeFixture("b");
      const capture = await seedCapture(fx, "b");
      await db.pemConsentEvent.create({
        data: { userId: fx.userId, workspaceId: fx.workspaceId, consentType: "PEM_AI_PROCESSING", action: "GRANTED", policyVersion: "v4.0-2026-08-24", source: "SETTINGS" },
      });
      await db.pemConsentEvent.create({
        data: { userId: fx.userId, workspaceId: fx.workspaceId, consentType: "PEM_AI_PROCESSING", action: "WITHDRAWN", policyVersion: "v4.0-2026-08-24", source: "SETTINGS" },
      });
      const result = await checkAiJobConsentAllowed(capture.id);
      ok("[B] Consent WITHDRAWN時はallowed=false", !result.allowed);
      if (!result.allowed) {
        ok("[B] reason=CONSENT_WITHDRAWN", result.reason === "CONSENT_WITHDRAWN");
      }
    }

    // ============================================================
    // C: Consent未回答(一度もイベントが無い)時、allowed=false。
    // ============================================================
    {
      const fx = await makeFixture("c");
      const capture = await seedCapture(fx, "c");
      const result = await checkAiJobConsentAllowed(capture.id);
      ok("[C] Consent未回答時はallowed=false(GRANTEDと同一視しない)", !result.allowed);
      if (!result.allowed) {
        ok("[C] reason=CONSENT_WITHDRAWN(未回答もGRANTEDでない扱い)", result.reason === "CONSENT_WITHDRAWN");
      }
    }

    // ============================================================
    // D: 存在しないcaptureIdはCAPTURE_NOT_FOUND。
    // ============================================================
    {
      const result = await checkAiJobConsentAllowed("00000000-0000-0000-0000-000000000000");
      ok("[D] 存在しないcaptureIdはCAPTURE_NOT_FOUND", !result.allowed && result.reason === "CAPTURE_NOT_FOUND");
    }

    // ============================================================
    // E: processAiExtractJobs経由。WITHDRAWN状態のJobはCANCELLEDになり、
    // AI呼び出しは一切発生しない(deny guardで機械的に保証)。
    // [安全策・重要] processAiExtractJobsはjobType=AI_EXTRACT/status=QUEUEDの
    // Job全体をグローバルに取得して処理する関数であり、実サーバー上で他の
    // 実ユーザーの正当なQUEUED Jobが存在する状態でこれを呼ぶと、そのJobまで
    // 一緒に処理してしまい実際のAI課金が発生するリスクがある。テスト対象の
    // Jobを作る前に、既存のQUEUED AI_EXTRACT Jobが0件であることを確認できた
    // 場合のみこのシナリオを実行する。1件でも存在する場合は安全側に倒して
    // スキップする(誤って他ユーザーのJobを処理しない)。
    // ============================================================
    {
      const preExistingQueuedCount = await db.job.count({ where: { jobType: "AI_EXTRACT", status: "QUEUED" } });
      if (preExistingQueuedCount > 0) {
        console.log(
          `  SKIP - [E] 既存のQUEUED AI_EXTRACT Jobが${preExistingQueuedCount}件存在するため、` +
          `他ユーザーへの誤影響を避けてこのシナリオをスキップします`,
        );
      } else {
        const fx = await makeFixture("e");
        const capture = await seedCapture(fx, "e");
        await db.pemConsentEvent.create({
          data: { userId: fx.userId, workspaceId: fx.workspaceId, consentType: "PEM_AI_PROCESSING", action: "WITHDRAWN", policyVersion: "v4.0-2026-08-24", source: "SETTINGS" },
        });
        const job = await db.job.create({
          data: {
            jobType: "AI_EXTRACT", aggregateId: capture.id, sourceVersion: capture.version,
            status: "QUEUED", payload: { captureId: capture.id },
          },
        });

        const deniedBeforeE = denyGuard.deniedCallAttempts.length;
        await processAiExtractJobs();
        const deniedAfterE = denyGuard.deniedCallAttempts.length;
        ok("[E] processAiExtractJobs実行中もAI呼び出しは0件のまま", deniedAfterE === deniedBeforeE, `denied=${deniedAfterE - deniedBeforeE}`);

        const jobAfter = await db.job.findUniqueOrThrow({ where: { id: job.id } });
        ok("[E] Job.statusがCANCELLEDになる", jobAfter.status === "CANCELLED");
        ok("[E] lastErrorにConsent撤回の旨が記録される", (jobAfter.lastError ?? "").includes("CONSENT_WITHDRAWN"));

        const captureAfter = await db.capture.findUniqueOrThrow({ where: { id: capture.id } });
        ok("[E] Capture.processingStatusは変更されない(このGateのscope外)", captureAfter.processingStatus === "SAVED");
      }
    }

    const deniedAfterAll = denyGuard.deniedCallAttempts.length;
    ok(
      "[非課金guard] このGateはAI呼び出しを一切行わない(self-test以外の拒否試行0件)",
      deniedAfterAll === deniedBaseline,
      `deniedCallAttempts=${deniedAfterAll} baseline=${deniedBaseline}`,
    );
  } finally {
    console.log("[CLEANUP] テスト用データを削除します...");
    for (const userId of userIds) {
      await cleanupTestUser(userId);
    }
    const leftover = await db.user.findMany({
      where: { email: { startsWith: EMAIL_PREFIX, endsWith: "@example.invalid" } },
      select: { id: true },
    });
    ok("[cleanup] test用Userが1件も残っていない", leftover.length === 0, `remaining=${leftover.length}`);
  }

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
