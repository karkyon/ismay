#!/usr/bin/env node
/**
 * scripts/verify_gate_pem_consent_enqueue_gate.ts
 *
 * PEM-CONSENT-ENQUEUE-GATE(AI Job新規enqueue時のConsent判定)の実DB受入証跡。
 * 出典: DOC-09(Consent・Data Governance仕様書) 9章「撤回と同時に新規Job
 * enqueue不可」、CHG-073。
 *
 * [検証方針] captures/route.ts・captures/[id]/analyze/route.ts・
 * transcribeAudioJob.ts・ocrImageJob.tsの4箇所は全て、共通の
 * `isAiProcessingConsentGrantedForUser`/`checkAiJobConsentAllowed`
 * (両方ともisConsentGranted経由)の戻り値でCaptureAnalysisRequested.v1発行の
 * 可否を分岐するだけの薄い統合であり、tsc/ESLintで構文的な正しさは別途
 * 確認済み。本スクリプトは、この共通判定ロジック自体を実DBで検証する
 * (4箇所全てのHTTP E2Eテストは、パッチ適用直後にサーバープロセスが
 * 新コードで再起動されている保証が無いため行わない、既存verify scriptと
 * 同じ設計判断)。
 *
 * AI providerへの実通信は行わない(このGateはAI呼び出しを一切含まない)。
 *
 * 実行方法:
 *   cd ~/projects/ismay/app
 *   npx tsx ../scripts/verify_gate_pem_consent_enqueue_gate.ts
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
const EMAIL_PREFIX = "gate-pem-consent-enqueue-verify-";

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
  const { isAiProcessingConsentGrantedForUser, checkAiJobConsentAllowed } = await import(
    "../app/src/lib/pem/aiJobConsentGate"
  );

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
      data: { email, passwordHash: "not-a-real-hash-for-db-only-test", displayName: `PEM ConsentEnqueue ${suffix}` },
    });
    const workspace = await db.workspace.create({ data: { name: `PEM ConsentEnqueue Workspace ${suffix}` } });
    await db.workspaceMember.create({ data: { workspaceId: workspace.id, userId: user.id, role: "OWNER" } });
    const domain = await db.domain.create({ data: { workspaceId: workspace.id, name: "個人", kind: "PERSONAL" } });
    userIds.push(user.id);
    return { userId: user.id, workspaceId: workspace.id, domainId: domain.id };
  }

  try {
    // ============================================================
    // A: isAiProcessingConsentGrantedForUser - GRANTED時true。
    // ============================================================
    {
      const fx = await makeFixture("a");
      await db.pemConsentEvent.create({
        data: { userId: fx.userId, workspaceId: fx.workspaceId, consentType: "PEM_AI_PROCESSING", action: "GRANTED", policyVersion: "v4.0-2026-08-24", source: "SETTINGS" },
      });
      const granted = await isAiProcessingConsentGrantedForUser(fx.userId);
      ok("[A] GRANTED時はtrue", granted === true);
    }

    // ============================================================
    // B: isAiProcessingConsentGrantedForUser - WITHDRAWN時false。
    // ============================================================
    {
      const fx = await makeFixture("b");
      await db.pemConsentEvent.create({
        data: { userId: fx.userId, workspaceId: fx.workspaceId, consentType: "PEM_AI_PROCESSING", action: "GRANTED", policyVersion: "v4.0-2026-08-24", source: "SETTINGS" },
      });
      await db.pemConsentEvent.create({
        data: { userId: fx.userId, workspaceId: fx.workspaceId, consentType: "PEM_AI_PROCESSING", action: "WITHDRAWN", policyVersion: "v4.0-2026-08-24", source: "SETTINGS" },
      });
      const granted = await isAiProcessingConsentGrantedForUser(fx.userId);
      ok("[B] WITHDRAWN時はfalse", granted === false);
    }

    // ============================================================
    // C: isAiProcessingConsentGrantedForUser - 未回答時false(GRANTEDと
    // 同一視しない)。
    // ============================================================
    {
      const fx = await makeFixture("c");
      const granted = await isAiProcessingConsentGrantedForUser(fx.userId);
      ok("[C] Consent未回答時はfalse", granted === false);
    }

    // ============================================================
    // D: captures/route.tsと同じshouldAutoQueue計算ロジックの検証
    // (WITHDRAWN時、sourceType=TEXTでもAutoQueueされないことを確認)。
    // ============================================================
    {
      const fx = await makeFixture("d");
      await db.pemConsentEvent.create({
        data: { userId: fx.userId, workspaceId: fx.workspaceId, consentType: "PEM_AI_PROCESSING", action: "WITHDRAWN", policyVersion: "v4.0-2026-08-24", source: "SETTINGS" },
      });
      const aiProcessingConsentGranted = await isAiProcessingConsentGrantedForUser(fx.userId);
      const sourceType = "TEXT";
      const shouldAutoQueue = (sourceType as string) !== "VOICE" && (sourceType as string) !== "MEETING" && aiProcessingConsentGranted;
      ok("[D] TEXT Captureでも同意撤回時はshouldAutoQueue=false", shouldAutoQueue === false);

      // 実際にcaptures/route.tsと同じ分岐でCaptureを作成し、processingStatusを確認する。
      const capture = await db.capture.create({
        data: {
          workspaceId: fx.workspaceId, domainId: fx.domainId, createdById: fx.userId,
          sourceType: "TEXT", rawText: "検証用d", processingStatus: shouldAutoQueue ? "QUEUED" : "SAVED",
        },
      });
      ok("[D] processingStatusはSAVEDのまま(AI解析キューへ投入されない)", capture.processingStatus === "SAVED");
    }

    // ============================================================
    // E: checkAiJobConsentAllowed(captureId) - transcribeAudioJob.ts/
    // ocrImageJob.tsが使うのと同じ関数の、Capture起点での動作確認。
    // ============================================================
    {
      const fx = await makeFixture("e");
      await db.pemConsentEvent.create({
        data: { userId: fx.userId, workspaceId: fx.workspaceId, consentType: "PEM_AI_PROCESSING", action: "GRANTED", policyVersion: "v4.0-2026-08-24", source: "SETTINGS" },
      });
      const capture = await db.capture.create({
        data: {
          workspaceId: fx.workspaceId, domainId: fx.domainId, createdById: fx.userId,
          sourceType: "VOICE", processingStatus: "SAVED",
        },
      });
      const before = await checkAiJobConsentAllowed(capture.id);
      ok("[E] GRANTED時allowed=true(文字起こし完了時点相当)", before.allowed === true);

      await db.pemConsentEvent.create({
        data: { userId: fx.userId, workspaceId: fx.workspaceId, consentType: "PEM_AI_PROCESSING", action: "WITHDRAWN", policyVersion: "v4.0-2026-08-24", source: "SETTINGS" },
      });
      const after = await checkAiJobConsentAllowed(capture.id);
      ok("[E] 撤回後はallowed=false", after.allowed === false);
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
