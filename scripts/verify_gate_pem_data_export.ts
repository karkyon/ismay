#!/usr/bin/env node
/**
 * scripts/verify_gate_pem_data_export.ts
 *
 * PEM Machine-readable Data Export(GET /pem/export)の実DB受入証跡。
 * 出典: DOC-09(Consent・Data Governance仕様書) 9章「exportに原データ、
 * Event、同意、派生根拠、削除履歴が含まれる」、CHG-076。
 *
 * AI providerへの実通信は行わない(このGateはAI呼び出しを一切含まない)。
 *
 * 実行方法:
 *   cd ~/projects/ismay/app
 *   npx tsx ../scripts/verify_gate_pem_data_export.ts
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
const EMAIL_PREFIX = "gate-pem-data-export-verify-";

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
  const { db } = await import("../app/src/lib/db");
  const { buildPemDataExport } = await import("../app/src/lib/pem/dataExport");

  const orphans = await db.user.findMany({
    where: { email: { startsWith: EMAIL_PREFIX, endsWith: "@example.invalid" } },
    select: { id: true },
  });

  const userIds: string[] = [];

  async function cleanupTestUser(userId: string): Promise<void> {
    await db.pemEvidenceDeletionEvent.deleteMany({ where: { userId } }).catch(() => null);
    await db.pemHypothesis.deleteMany({ where: { userId } }).catch(() => null);
    await db.pemWeeklyReview.deleteMany({ where: { userId } }).catch(() => null);
    await db.pemObservation.deleteMany({ where: { userId } }).catch(() => null);
    await db.pemConsentEvent.deleteMany({ where: { userId } }).catch(() => null);
    await db.pemMetricConsentEvent.deleteMany({ where: { userId } }).catch(() => null);
    await db.auditLog.deleteMany({ where: { actorUserId: userId } }).catch(() => null);
    const memberships = await db.workspaceMember.findMany({ where: { userId }, select: { workspaceId: true } }).catch(() => [] as { workspaceId: string }[]);
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
      data: { email, passwordHash: "not-a-real-hash-for-db-only-test", displayName: `PEM DataExport ${suffix}` },
    });
    const workspace = await db.workspace.create({ data: { name: `PEM DataExport Workspace ${suffix}` } });
    await db.workspaceMember.create({ data: { workspaceId: workspace.id, userId: user.id, role: "OWNER" } });
    userIds.push(user.id);
    return { userId: user.id, workspaceId: workspace.id };
  }

  try {
    // ============================================================
    // A: 各データ種別を1件ずつ作成し、全て正しく取得できることを確認。
    // ============================================================
    {
      const fx = await makeFixture("a");
      const metricKey = `metric-${RUN_ID}-a`;

      await db.pemObservation.create({
        data: { userId: fx.userId, observationType: "FACT", payload: { text: "検証用FACT" } },
      });
      const observation = await db.pemObservation.create({
        data: { userId: fx.userId, observationType: "OBSERVATION", payload: { metric: metricKey, value: 1 } },
      });
      await db.pemConsentEvent.create({
        data: { userId: fx.userId, workspaceId: fx.workspaceId, consentType: "PEM_DATA_COLLECTION", action: "GRANTED", policyVersion: "v4.0-2026-08-24", source: "SETTINGS" },
      });
      await db.pemMetricConsentEvent.create({
        data: { userId: fx.userId, workspaceId: fx.workspaceId, metricKey, action: "GRANTED", policyVersion: "v4.0-2026-08-24", source: "SETTINGS" },
      });
      await db.pemHypothesis.create({
        data: {
          userId: fx.userId, statement: "検証用仮説", sampleSize: 5,
          windowFrom: new Date("2026-08-01"), windowTo: new Date("2026-08-31"),
          confidence: 0.7, sourceMetric: metricKey, userVerdict: "UNREVIEWED",
        },
      });
      await db.pemEvidenceDeletionEvent.create({
        data: { userId: fx.userId, targetType: "PEM_OBSERVATION", targetId: observation.id, deletionMode: "EXCLUDED_FROM_USE", reason: "検証用" },
      });
      await db.pemWeeklyReview.create({
        data: {
          userId: fx.userId, weekStart: new Date("2026-08-24"), weekEnd: new Date("2026-08-31"),
          summaryJson: { fulfilledCount: 1, stalledCount: 0, estimateErrorPercent: 0, strengthStatement: "x", experimentSuggestion: "y", generatedByAi: true },
        },
      });

      const result = await buildPemDataExport(fx.userId);
      ok("[A] userIdが一致する", result.userId === fx.userId);
      ok("[A] exportedAtがISO文字列", !Number.isNaN(new Date(result.exportedAt).getTime()));
      ok("[A] observationsに2件(FACT+OBSERVATION)含まれる", result.observations.length === 2);
      ok("[A] consentEventsに1件含まれる", result.consentEvents.length === 1);
      ok("[A] metricConsentEventsに1件含まれる", result.metricConsentEvents.length === 1);
      ok("[A] hypothesesに1件含まれる", result.hypotheses.length === 1);
      ok("[A] evidenceDeletionEventsに1件含まれる", result.evidenceDeletionEvents.length === 1);
      ok("[A] weeklyReviewsに1件含まれる", result.weeklyReviews.length === 1);
    }

    // ============================================================
    // B: tenant境界。他ユーザーのデータが混入しない。
    // ============================================================
    {
      const fxA = await makeFixture("b-a");
      const fxB = await makeFixture("b-b");
      await db.pemObservation.create({
        data: { userId: fxA.userId, observationType: "FACT", payload: { text: "Aのデータ" } },
      });
      await db.pemObservation.create({
        data: { userId: fxB.userId, observationType: "FACT", payload: { text: "Bのデータ" } },
      });

      const resultA = await buildPemDataExport(fxA.userId);
      const resultB = await buildPemDataExport(fxB.userId);
      ok("[B] Aのexportは1件のみ(Bのデータを含まない)", resultA.observations.length === 1);
      ok("[B] Bのexportは1件のみ(Aのデータを含まない)", resultB.observations.length === 1);
    }

    // ============================================================
    // C: データが1件も無いユーザーは、全項目が空配列で返る。
    // ============================================================
    {
      const fx = await makeFixture("c");
      const result = await buildPemDataExport(fx.userId);
      ok("[C] observationsは空配列", result.observations.length === 0);
      ok("[C] consentEventsは空配列", result.consentEvents.length === 0);
      ok("[C] hypothesesは空配列", result.hypotheses.length === 0);
      ok("[C] evidenceDeletionEventsは空配列", result.evidenceDeletionEvents.length === 0);
    }
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
