#!/usr/bin/env node
/**
 * scripts/verify_gate_pem_session_timeout.ts
 *
 * PEM-SESSION-TIMEOUT(Execution Session timeout Worker)の実DB受入証跡。
 * 出典: ISMAY_PEMサブシステム_統合正本仕様書_v4.0 7.1節「timeoutは
 * `CLOSED_UNCONFIRMED`としてSessionだけを閉じ、責任状態を変えない」。
 * ISMAY全機能仕様一覧のPEM-SESSION行「Activity Evidence、timeout、Correction、
 * Conflict Queue、checkpoint/rebuildは未完成」のうち、timeoutを閉じる。
 *
 * DOC-05(Execution Event・Session Projection仕様書) 14.2節
 * 「SESSION_TIMEOUT_CLOSEをExecution Ledgerへ保存しない」も検証する
 * (ResponsibilityExecutionEventが増えないこと)。
 *
 * AI providerへの実通信は行わない(このGateはAI呼び出しを一切含まない)。
 *
 * 実行方法:
 *   cd ~/projects/ismay/app
 *   npx tsx ../scripts/verify_gate_pem_session_timeout.ts
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
const EMAIL_PREFIX = "gate-pem-session-timeout-verify-";

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
  const { closeTimedOutSessions } = await import("../app/src/lib/pem/sessionPersistence");

  const orphans = await db.user.findMany({
    where: { email: { startsWith: EMAIL_PREFIX, endsWith: "@example.invalid" } },
    select: { id: true },
  });

  const userIds: string[] = [];
  const workspaceIds: string[] = [];

  async function cleanupTestUser(userId: string, workspaceId: string | null): Promise<void> {
    if (workspaceId) {
      const responsibilities = await db.responsibility
        .findMany({ where: { workspaceId }, select: { id: true } })
        .catch(() => [] as { id: string }[]);
      const responsibilityIds = responsibilities.map((r: { id: string }) => r.id);
      if (responsibilityIds.length > 0) {
        const identities = await db.executionSessionIdentity
          .findMany({ where: { responsibilityId: { in: responsibilityIds } }, select: { id: true } })
          .catch(() => [] as { id: string }[]);
        const identityIds = identities.map((i: { id: string }) => i.id);
        if (identityIds.length > 0) {
          await db.executionSessionRevision.deleteMany({ where: { sessionIdentityId: { in: identityIds } } }).catch(() => null);
          await db.executionSessionIdentity.deleteMany({ where: { id: { in: identityIds } } }).catch(() => null);
        }
        await db.responsibilityExecutionEvent.deleteMany({ where: { responsibilityId: { in: responsibilityIds } } }).catch(() => null);
        await db.eventLog.deleteMany({ where: { aggregateId: { in: responsibilityIds } } }).catch(() => null);
        await db.outboxEvent.deleteMany({ where: { aggregateId: { in: responsibilityIds } } }).catch(() => null);
        await db.responsibility.deleteMany({ where: { id: { in: responsibilityIds } } }).catch(() => null);
      }
      const captures = await db.capture.findMany({ where: { workspaceId }, select: { id: true } }).catch(() => [] as { id: string }[]);
      const captureIds = captures.map((c: { id: string }) => c.id);
      if (captureIds.length > 0) {
        await db.capture.deleteMany({ where: { id: { in: captureIds } } }).catch(() => null);
      }
    }
    await db.pemConsentEvent.deleteMany({ where: { userId } }).catch(() => null);
    await db.pemMetricConsentEvent.deleteMany({ where: { userId } }).catch(() => null);
    await db.workspaceMember.deleteMany({ where: { userId } }).catch(() => null);
    if (workspaceId) {
      await db.workspace.deleteMany({ where: { id: workspaceId } }).catch(() => null);
    }
    await db.userSession.deleteMany({ where: { userId } }).catch(() => null);
    await db.user.deleteMany({ where: { id: userId } }).catch(() => null);
  }

  if (orphans.length > 0) {
    console.log(`[SWEEP] 過去実行の孤立テストユーザー${orphans.length}件を削除します...`);
    for (const o of orphans) {
      const membership = await db.workspaceMember.findFirst({ where: { userId: o.id }, select: { workspaceId: true } });
      await cleanupTestUser(o.id, membership?.workspaceId ?? null);
    }
  }

  async function makeFixture(suffix: string) {
    const email = `${EMAIL_PREFIX}${RUN_ID}-${suffix}@example.invalid`;
    const user = await db.user.create({
      data: { email, passwordHash: "not-a-real-hash-for-db-only-test", displayName: `PEM Session Timeout ${suffix}` },
    });
    const workspace = await db.workspace.create({ data: { name: `PEM Session Timeout Workspace ${suffix}` } });
    await db.workspaceMember.create({ data: { workspaceId: workspace.id, userId: user.id, role: "OWNER" } });
    const domain = await db.domain.create({ data: { workspaceId: workspace.id, name: "個人", kind: "PERSONAL" } });
    userIds.push(user.id);
    workspaceIds.push(workspace.id);
    return { userId: user.id, workspaceId: workspace.id, domainId: domain.id };
  }

  async function seedResponsibility(fx: { workspaceId: string; domainId: string; userId: string }, key: string) {
    const capture = await db.capture.create({
      data: { workspaceId: fx.workspaceId, domainId: fx.domainId, createdById: fx.userId, sourceType: "TEXT", rawText: `検証用${key}`, processingStatus: "READY" },
    });
    return db.responsibility.create({
      data: {
        workspaceId: fx.workspaceId, domainId: fx.domainId, originCaptureId: capture.id,
        type: "TASK", title: `timeout検証${key}`, status: "IN_PROGRESS", importance: 3,
        sourceKind: "USER", createdById: fx.userId, updatedById: fx.userId,
      },
    });
  }

  async function seedOpenSession(fx: { workspaceId: string; userId: string }, resp: { id: string }, startedAt: Date) {
    const identity = await db.executionSessionIdentity.create({
      data: {
        workspaceId: fx.workspaceId, subjectUserId: fx.userId, responsibilityId: resp.id,
        startEventId: `dummy-start-event-${RUN_ID}-${Math.random().toString(36).slice(2, 8)}`,
      },
    });
    await db.executionSessionRevision.create({
      data: {
        sessionIdentityId: identity.id, revision: 1, derivationVersion: "v1", status: "OPEN",
        startedAt, endedAt: null, endReason: null, rawElapsedSeconds: 0, correctedActiveSeconds: null,
        measurementMode: "EXECUTION_LEDGER_ONLY", measurementQuality: "HIGH", qualityReasonCodes: [],
        timeZoneId: null, utcOffsetMinutes: null, supersedesRevisionId: null,
      },
    });
    return identity;
  }

  try {
    const TIMEOUT_MS = 60 * 60 * 1000; // 1時間(テスト用の閾値)

    // ============================================================
    // A: 閾値を超えたOPEN Sessionはtimeoutでクローズされる。
    // ============================================================
    {
      const fx = await makeFixture("a");
      const resp = await seedResponsibility(fx, "a");
      const now = new Date("2026-09-02T12:00:00Z");
      const startedAt = new Date(now.getTime() - TIMEOUT_MS - 5 * 60 * 1000); // 閾値+5分前
      const identity = await seedOpenSession(fx, resp, startedAt);

      const respBefore = await db.responsibility.findUniqueOrThrow({ where: { id: resp.id } });
      const eventCountBefore = await db.responsibilityExecutionEvent.count({ where: { responsibilityId: resp.id } });

      const result = await closeTimedOutSessions(TIMEOUT_MS, now);
      ok("[A] 少なくとも1件処理される", result.closedCount >= 1, `closedCount=${result.closedCount}`);

      const latestRevision = await db.executionSessionRevision.findFirst({
        where: { sessionIdentityId: identity.id }, orderBy: { revision: "desc" },
      });
      ok("[A] revisionが2に増える(insert-only)", latestRevision?.revision === 2);
      ok("[A] statusがCLOSED_UNCONFIRMEDになる", latestRevision?.status === "CLOSED_UNCONFIRMED");
      ok("[A] endReasonがTIMEOUT", latestRevision?.endReason === "TIMEOUT");
      ok(
        "[A] endedAtがstartedAt+timeoutMsに固定される(決定論性)",
        latestRevision?.endedAt?.getTime() === startedAt.getTime() + TIMEOUT_MS,
      );
      ok("[A] rawElapsedSecondsがtimeoutMs通り", latestRevision?.rawElapsedSeconds === TIMEOUT_MS / 1000);
      ok(
        "[A] qualityReasonCodesに統合正本16.7節の正式語彙AUTO_TIMEOUT_ESTIMATEが入る",
        JSON.stringify(latestRevision?.qualityReasonCodes) === JSON.stringify(["AUTO_TIMEOUT_ESTIMATE"]),
      );
      ok("[A] measurementQualityがLOW(推定終了)", latestRevision?.measurementQuality === "LOW");
      ok("[A] supersedesRevisionIdが前revisionを指す", latestRevision?.supersedesRevisionId !== null);

      const respAfter = await db.responsibility.findUniqueOrThrow({ where: { id: resp.id } });
      ok(
        "[A] DOC-04/v4.0 7.1節「責任状態を変えない」: Responsibility.statusは不変",
        respAfter.status === respBefore.status,
      );
      const eventCountAfter = await db.responsibilityExecutionEvent.count({ where: { responsibilityId: resp.id } });
      ok(
        "[A] DOC-05 14.2節「SESSION_TIMEOUT_CLOSEをExecution Ledgerへ保存しない」: Execution Event件数不変",
        eventCountAfter === eventCountBefore,
      );
    }

    // ============================================================
    // B: 閾値未満のOPEN Sessionは対象外(クローズされない)。
    // ============================================================
    {
      const fx = await makeFixture("b");
      const resp = await seedResponsibility(fx, "b");
      const now = new Date("2026-09-02T12:00:00Z");
      const startedAt = new Date(now.getTime() - 10 * 60 * 1000); // 10分前(閾値未満)
      const identity = await seedOpenSession(fx, resp, startedAt);

      await closeTimedOutSessions(TIMEOUT_MS, now);

      const latestRevision = await db.executionSessionRevision.findFirst({
        where: { sessionIdentityId: identity.id }, orderBy: { revision: "desc" },
      });
      ok("[B] 閾値未満のSessionはOPENのまま(revision増えない)", latestRevision?.revision === 1 && latestRevision?.status === "OPEN");
    }

    // ============================================================
    // C: 既にCLOSED_CONFIRMEDのSessionは対象外。
    // ============================================================
    {
      const fx = await makeFixture("c");
      const resp = await seedResponsibility(fx, "c");
      const now = new Date("2026-09-02T12:00:00Z");
      const startedAt = new Date(now.getTime() - TIMEOUT_MS - 5 * 60 * 1000);
      const identity = await db.executionSessionIdentity.create({
        data: { workspaceId: fx.workspaceId, subjectUserId: fx.userId, responsibilityId: resp.id, startEventId: `dummy-${RUN_ID}-c` },
      });
      await db.executionSessionRevision.create({
        data: {
          sessionIdentityId: identity.id, revision: 1, derivationVersion: "v1", status: "CLOSED_CONFIRMED",
          startedAt, endedAt: new Date(startedAt.getTime() + 30 * 60 * 1000), endReason: "COMPLETE",
          rawElapsedSeconds: 1800, correctedActiveSeconds: null, measurementMode: "EXECUTION_LEDGER_ONLY",
          measurementQuality: "HIGH", qualityReasonCodes: [], timeZoneId: null, utcOffsetMinutes: null, supersedesRevisionId: null,
        },
      });

      await closeTimedOutSessions(TIMEOUT_MS, now);

      const latestRevision = await db.executionSessionRevision.findFirst({
        where: { sessionIdentityId: identity.id }, orderBy: { revision: "desc" },
      });
      ok("[C] 既にCLOSED_CONFIRMEDのSessionはtimeout対象外(revision増えない)", latestRevision?.revision === 1);
    }

    // ============================================================
    // D: 2回連続呼び出しでも冪等(既にCLOSED_UNCONFIRMEDになったものは再処理しない)。
    // ============================================================
    {
      const fx = await makeFixture("d");
      const resp = await seedResponsibility(fx, "d");
      const now = new Date("2026-09-02T12:00:00Z");
      const startedAt = new Date(now.getTime() - TIMEOUT_MS - 5 * 60 * 1000);
      const identity = await seedOpenSession(fx, resp, startedAt);

      const first = await closeTimedOutSessions(TIMEOUT_MS, now);
      const second = await closeTimedOutSessions(TIMEOUT_MS, now);
      ok("[D] 1回目でクローズされる", first.closedCount >= 1);
      ok("[D] 2回目は同一Sessionを再処理しない", second.closedCount === 0);

      const latestRevision = await db.executionSessionRevision.findFirst({
        where: { sessionIdentityId: identity.id }, orderBy: { revision: "desc" },
      });
      ok("[D] revisionは2のまま(重複追記されない)", latestRevision?.revision === 2);
    }

    // ============================================================
    // E: timeoutMsが不正(0以下)ならエラー。
    // ============================================================
    {
      let threw = false;
      try {
        await closeTimedOutSessions(0);
      } catch {
        threw = true;
      }
      ok("[E] timeoutMs<=0はエラー", threw);
    }
  } finally {
    console.log("[CLEANUP] テスト用データを削除します...");
    for (let i = 0; i < userIds.length; i++) {
      await cleanupTestUser(userIds[i]!, workspaceIds[i] ?? null);
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
