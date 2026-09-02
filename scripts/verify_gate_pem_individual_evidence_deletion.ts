#!/usr/bin/env node
/**
 * scripts/verify_gate_pem_individual_evidence_deletion.ts
 *
 * PEM 個別Evidence削除(DELETE /pem/observations/{id})の実DB受入証跡。
 * 出典: PEMサブシステム統合正本仕様書v4.0 16.3節・16.4節、DOC-09(Consent・
 * Data Governance仕様書) 9章「deletion graphの全nodeが完了または明示retain
 * reasonを持つ」。
 *
 * AI providerへの実通信は行わない(このGateはAI呼び出しを一切含まない)。
 *
 * 実行方法:
 *   cd ~/projects/ismay/app
 *   npx tsx ../scripts/verify_gate_pem_individual_evidence_deletion.ts
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
const EMAIL_PREFIX = "gate-pem-evidence-del-verify-";

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
  const { deleteObservationEvidence } = await import("../app/src/lib/pem/evidenceDeletionService");
  const { getDeletedEvidenceIds } = await import("../app/src/lib/pem/evidenceDeletion");

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
    await db.auditLog.deleteMany({ where: { actorUserId: userId } }).catch(() => null);
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
      data: { email, passwordHash: "not-a-real-hash-for-db-only-test", displayName: `PEM EvidenceDel ${suffix}` },
    });
    userIds.push(user.id);
    return { userId: user.id };
  }

  try {
    // ============================================================
    // A: OBSERVATION削除→関連するHypothesisが失効、WeeklyReviewが削除される。
    // ============================================================
    {
      const fx = await makeFixture("a");
      const metricKey = `metric-${RUN_ID}-a`;
      const observation = await db.pemObservation.create({
        data: { userId: fx.userId, observationType: "OBSERVATION", payload: { metric: metricKey, value: 42 } },
      });
      const hypothesis = await db.pemHypothesis.create({
        data: {
          userId: fx.userId, statement: "検証用仮説a", sampleSize: 10,
          windowFrom: new Date("2026-08-01"), windowTo: new Date("2026-08-31"),
          confidence: 0.8, sourceMetric: metricKey, userVerdict: "UNREVIEWED",
        },
      });
      await db.pemWeeklyReview.create({
        data: {
          userId: fx.userId, weekStart: new Date("2026-08-24"), weekEnd: new Date("2026-08-31"),
          summaryJson: { fulfilledCount: 1, stalledCount: 0, estimateErrorPercent: 0, strengthStatement: "x", experimentSuggestion: "y", generatedByAi: true },
        },
      });

      const result = await deleteObservationEvidence({ userId: fx.userId, observationId: observation.id, reason: "検証用" });
      ok("[A] 削除成功", result.ok);
      if (result.ok && !result.alreadyDeleted) {
        ok("[A] alreadyDeleted=false(初回)", result.alreadyDeleted === false);
        ok("[A] hypothesesInvalidatedが1件", result.hypothesesInvalidated === 1);
        ok("[A] weeklyReviewsInvalidatedが1件", result.weeklyReviewsInvalidated === 1);
      }

      const deletedIds = await getDeletedEvidenceIds("PEM_OBSERVATION", fx.userId);
      ok("[A] 削除済みIDとして投影される", deletedIds.has(observation.id));

      const hypothesisAfter = await db.pemHypothesis.findUniqueOrThrow({ where: { id: hypothesis.id } });
      ok("[A] Hypothesisが失効する(validUntil設定・物理削除しない)", hypothesisAfter.validUntil !== null);
      ok("[A] Hypothesis自体は削除されない(insert-only精神)", hypothesisAfter.deletedAt === null);

      const reviewsAfter = await db.pemWeeklyReview.findMany({ where: { userId: fx.userId } });
      ok("[A] WeeklyReviewキャッシュが削除される(次回アクセスで再生成)", reviewsAfter.length === 0);

      const deletionEvent = await db.pemEvidenceDeletionEvent.findFirst({ where: { userId: fx.userId, targetId: observation.id } });
      ok("[A] PemEvidenceDeletionEventが記録される", deletionEvent !== null);
      ok("[A] deletionMode=EXCLUDED_FROM_USE", deletionEvent?.deletionMode === "EXCLUDED_FROM_USE");
      ok("[A] reasonが記録される", deletionEvent?.reason === "検証用");
    }

    // ============================================================
    // B: FACT削除(metricと無関係のためHypothesis cascadeは起きない)。
    // ============================================================
    {
      const fx = await makeFixture("b");
      const observation = await db.pemObservation.create({
        data: { userId: fx.userId, observationType: "FACT", payload: { text: "完了した" } },
      });
      const result = await deleteObservationEvidence({ userId: fx.userId, observationId: observation.id });
      ok("[B] FACT削除も成功", result.ok);
      if (result.ok && !result.alreadyDeleted) {
        ok("[B] FACTはmetricを持たないためhypothesesInvalidated=0", result.hypothesesInvalidated === 0);
      }
    }

    // ============================================================
    // C: 冪等性。同じObservationを2回削除すると2回目はalreadyDeleted=true。
    // ============================================================
    {
      const fx = await makeFixture("c");
      const observation = await db.pemObservation.create({
        data: { userId: fx.userId, observationType: "OBSERVATION", payload: { metric: `metric-${RUN_ID}-c` } },
      });
      const first = await deleteObservationEvidence({ userId: fx.userId, observationId: observation.id });
      const second = await deleteObservationEvidence({ userId: fx.userId, observationId: observation.id });
      ok("[C] 1回目成功・alreadyDeleted=false", first.ok && !first.alreadyDeleted);
      ok("[C] 2回目もok・alreadyDeleted=true", second.ok && second.alreadyDeleted === true);

      const eventCount = await db.pemEvidenceDeletionEvent.count({ where: { userId: fx.userId, targetId: observation.id } });
      ok("[C] 削除イベントは1件のみ(重複記録されない)", eventCount === 1);
    }

    // ============================================================
    // D: tenant越境。他ユーザーのObservationは削除できない。
    // ============================================================
    {
      const fxA = await makeFixture("d-a");
      const fxB = await makeFixture("d-b");
      const observation = await db.pemObservation.create({
        data: { userId: fxA.userId, observationType: "OBSERVATION", payload: { metric: `metric-${RUN_ID}-d` } },
      });
      const result = await deleteObservationEvidence({ userId: fxB.userId, observationId: observation.id });
      ok("[D] 他ユーザーの観察はNOT_FOUND", !result.ok && result.error === "NOT_FOUND");

      const stillActive = await db.pemObservation.findUniqueOrThrow({ where: { id: observation.id } });
      ok("[D] 対象は削除されず残る", stillActive !== null);
      const deletedIds = await getDeletedEvidenceIds("PEM_OBSERVATION", fxA.userId);
      ok("[D] 削除済みとして投影されない", !deletedIds.has(observation.id));
    }

    // ============================================================
    // E: 存在しないobservationIdはNOT_FOUND。
    // ============================================================
    {
      const fx = await makeFixture("e");
      const result = await deleteObservationEvidence({ userId: fx.userId, observationId: "00000000-0000-0000-0000-000000000000" });
      ok("[E] 存在しないIDはNOT_FOUND", !result.ok && result.error === "NOT_FOUND");
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
