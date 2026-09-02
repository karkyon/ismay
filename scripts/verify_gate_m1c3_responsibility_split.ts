#!/usr/bin/env node
/**
 * scripts/verify_gate_m1c3_responsibility_split.ts
 *
 * Gate M1-C3(Materialized Responsibility Split Correction)の非課金DB受入証跡。
 * 出典: 統合正本仕様書v5.0 §11.4「分解Transaction」、EVAL・受入テスト仕様書
 *       EV-A-004「split transaction | relation/source/receipt整合、部分失敗0」。
 *
 * AI providerへの実通信は一切行わない(aiNetworkDenyGuard必須。このGateはAI呼び出しを
 * 一切含まないためbaseline以外の拒否試行が発生しないことも確認する)。
 *
 * 実行方法:
 *   cd ~/projects/ismay/app
 *   npx tsx ../scripts/verify_gate_m1c3_responsibility_split.ts
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
const EMAIL_PREFIX = "gate-m1c3-split-verify-";

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
  // [2026-09-02バグ修正・実DB検証で発覚] selfTestAiNetworkDenyGuard自体が意図的に
  // 1回のfetch拒否を発生させるため、denyGuard.deniedCallAttempts.lengthはこの時点で
  // 既に1になっている。verify_gate_m1b6b_session_lifecycle.ts等の既存パターン
  // (deniedBaseline)を踏襲せず単純に===0で比較していたため、コード自体は正しいのに
  // このチェックだけが常にNGになるverify script側のバグだった。self-test直後の値を
  // baselineとして保存し、以降増えていないことだけを検証する。
  const deniedBaseline = denyGuard.deniedCallAttempts.length;
  if (!guardSelfTestPassed) {
    denyGuard.restore();
    console.log(`\n合計: ${passed} passed, ${failed} failed`);
    process.exitCode = 1;
    return;
  }

  const { db } = await import("../app/src/lib/db");
  const { splitResponsibility } = await import("../app/src/lib/formation/responsibilityCorrection");

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
      data: { email, passwordHash: "not-a-real-hash-for-db-only-test", displayName: `Gate M1-C3 ${suffix}` },
    });
    const workspace = await db.workspace.create({ data: { name: `Gate M1-C3 Workspace ${suffix}` } });
    await db.workspaceMember.create({ data: { workspaceId: workspace.id, userId: user.id, role: "OWNER" } });
    const domain = await db.domain.create({ data: { workspaceId: workspace.id, name: "個人", kind: "PERSONAL" } });
    userIds.push(user.id);
    return { userId: user.id, workspaceId: workspace.id, domainId: domain.id };
  }

  async function seedResponsibility(
    fx: { workspaceId: string; domainId: string; userId: string },
    key: string,
    overrides?: { withRecurrence?: boolean },
  ) {
    const capture = await db.capture.create({
      data: { workspaceId: fx.workspaceId, domainId: fx.domainId, createdById: fx.userId, sourceType: "TEXT", rawText: `検証用${key}`, processingStatus: "READY" },
    });
    const resp = await db.responsibility.create({
      data: {
        workspaceId: fx.workspaceId,
        domainId: fx.domainId,
        originCaptureId: capture.id,
        type: "TASK",
        title: `分割対象${key}`,
        status: "INBOX",
        importance: 3,
        sourceKind: "USER",
        createdById: fx.userId,
        updatedById: fx.userId,
      },
    });
    if (overrides?.withRecurrence) {
      await db.recurrenceRule.create({
        data: { responsibilityId: resp.id, frequency: "WEEKLY", interval: 1, carryoverPolicy: "CARRY" },
      });
    }
    return resp;
  }

  try {
    // ============================================================
    // A: 正常split。Tag/Relation(両方向)/ProjectContextLinkが全子へ複製され、
    //    元Responsibilityは削除されずsupersededByReceiptIdのみ設定される。
    // ============================================================
    {
      const fx = await makeFixture("a");
      const source = await seedResponsibility(fx, "a");

      const tag = await db.tag.create({ data: { workspaceId: fx.workspaceId, name: `tag-${RUN_ID}-a` } });
      await db.responsibilityTag.create({ data: { responsibilityId: source.id, tagId: tag.id } });

      const other = await seedResponsibility(fx, "a-other");
      await db.responsibilityRelation.create({
        data: { fromId: source.id, toId: other.id, relationType: "BLOCKS", status: "CONFIRMED", sourceKind: "USER" },
      });
      const other2 = await seedResponsibility(fx, "a-other2");
      await db.responsibilityRelation.create({
        data: { fromId: other2.id, toId: source.id, relationType: "DEPENDS_ON", status: "CONFIRMED", sourceKind: "USER" },
      });

      const context = await db.projectContext.create({
        data: { workspaceId: fx.workspaceId, domainId: fx.domainId, ownerSubjectUserId: fx.userId, name: `ctx-${RUN_ID}-a`, createdById: fx.userId },
      });
      const link = await db.projectContextLink.create({
        data: { workspaceId: fx.workspaceId, contextId: context.id, responsibilityId: source.id, role: "PRIMARY", sourceKind: "USER" },
      });
      await db.projectContextLinkEvent.create({
        data: {
          workspaceId: fx.workspaceId, contextId: context.id, responsibilityId: source.id, eventType: "LINK", role: "PRIMARY",
          afterSnapshot: { role: "PRIMARY", sourceKind: link.sourceKind, linkedAt: link.linkedAt.toISOString() },
          actorType: "USER", actorUserId: fx.userId, idempotencyKey: `seed-${RUN_ID}-a-link`, requestPayloadHash: "seed",
        },
      });

      const result = await splitResponsibility({
        workspaceId: fx.workspaceId,
        sourceResponsibilityId: source.id,
        expectedVersion: 0,
        parts: [
          { type: "TASK", title: "part1" },
          { type: "DECISION", title: "part2" },
        ],
        actorUserId: fx.userId,
        idempotencyKey: `client-${RUN_ID}-a`,
        requestPayloadHash: "hash-a",
      });
      ok("[A] split成功", result.ok);
      if (result.ok) {
        ok("[A] 新規Responsibility 2件生成", result.newResponsibilities.length === 2, JSON.stringify(result.newResponsibilities));
        ok("[A] part2の初期statusがDECISION用(OPEN)", result.newResponsibilities[1]?.status === "OPEN");
        ok("[A] part1の初期statusがCOMMON用(INBOX)", result.newResponsibilities[0]?.status === "INBOX");

        const updatedSource = await db.responsibility.findUniqueOrThrow({ where: { id: source.id } });
        ok("[A] 元Responsibilityは物理削除されない(deletedAt=null)", updatedSource.deletedAt === null);
        ok("[A] 元ResponsibilityのsupersededByReceiptIdが設定される", updatedSource.supersededByReceiptId === result.receiptId);
        ok("[A] 元ResponsibilityのstatusはINBOXのまま変更されない", updatedSource.status === "INBOX");
        ok("[A] 元Responsibilityのversionが1つ進む", updatedSource.version === 1);

        for (const child of result.newResponsibilities) {
          const tagCount = await db.responsibilityTag.count({ where: { responsibilityId: child.id, tagId: tag.id } });
          ok(`[A] 子${child.type}へTag複製`, tagCount === 1);

          const fromRel = await db.responsibilityRelation.count({ where: { fromId: child.id, toId: other.id, relationType: "BLOCKS" } });
          ok(`[A] 子${child.type}へBLOCKS(from方向)複製`, fromRel === 1);
          const toRel = await db.responsibilityRelation.count({ where: { fromId: other2.id, toId: child.id, relationType: "DEPENDS_ON" } });
          ok(`[A] 子${child.type}へDEPENDS_ON(to方向)複製`, toRel === 1);

          const linkCount = await db.projectContextLink.count({ where: { workspaceId: fx.workspaceId, contextId: context.id, responsibilityId: child.id, unlinkedAt: null } });
          ok(`[A] 子${child.type}へProjectContextLink複製`, linkCount === 1);
          const linkEventCount = await db.projectContextLinkEvent.count({ where: { workspaceId: fx.workspaceId, contextId: context.id, responsibilityId: child.id, eventType: "LINK" } });
          ok(`[A] 子${child.type}へProjectContextLinkEvent(LINK)記録`, linkEventCount === 1);
        }

        const resultItemCount = await db.responsibilityCorrectionResultItem.count({ where: { receiptId: result.receiptId } });
        ok("[A] ResultItemが子の数だけ記録される", resultItemCount === 2);
      }
    }

    // ============================================================
    // B: parts不足(1件のみ)は拒否される。
    // ============================================================
    {
      const fx = await makeFixture("b");
      const source = await seedResponsibility(fx, "b");
      const result = await splitResponsibility({
        workspaceId: fx.workspaceId,
        sourceResponsibilityId: source.id,
        expectedVersion: 0,
        parts: [{ type: "TASK", title: "only-one" }],
        actorUserId: fx.userId,
        idempotencyKey: `client-${RUN_ID}-b`,
        requestPayloadHash: "hash-b",
      });
      ok("[B] parts1件はINVALID_SPLIT_PARTSで拒否", !result.ok && result.error === "INVALID_SPLIT_PARTS");
    }

    // ============================================================
    // C: version不一致はVERSION_CONFLICT。
    // ============================================================
    {
      const fx = await makeFixture("c");
      const source = await seedResponsibility(fx, "c");
      const result = await splitResponsibility({
        workspaceId: fx.workspaceId,
        sourceResponsibilityId: source.id,
        expectedVersion: 99,
        parts: [{ type: "TASK", title: "p1" }, { type: "TASK", title: "p2" }],
        actorUserId: fx.userId,
        idempotencyKey: `client-${RUN_ID}-c`,
        requestPayloadHash: "hash-c",
      });
      ok("[C] version不一致はVERSION_CONFLICT", !result.ok && result.error === "VERSION_CONFLICT");
    }

    // ============================================================
    // D: RecurrenceRuleを持つResponsibilityは分割不可。
    // ============================================================
    {
      const fx = await makeFixture("d");
      const source = await seedResponsibility(fx, "d", { withRecurrence: true });
      const result = await splitResponsibility({
        workspaceId: fx.workspaceId,
        sourceResponsibilityId: source.id,
        expectedVersion: 0,
        parts: [{ type: "TASK", title: "p1" }, { type: "TASK", title: "p2" }],
        actorUserId: fx.userId,
        idempotencyKey: `client-${RUN_ID}-d`,
        requestPayloadHash: "hash-d",
      });
      ok("[D] RecurrenceRule保有はHAS_RECURRENCE_RULEで拒否", !result.ok && result.error === "HAS_RECURRENCE_RULE");
    }

    // ============================================================
    // E: 冪等再送(同一key・同一payload)は同じReceiptを返し、二重生成しない。
    // ============================================================
    {
      const fx = await makeFixture("e");
      const source = await seedResponsibility(fx, "e");
      const key = `client-${RUN_ID}-e`;
      const first = await splitResponsibility({
        workspaceId: fx.workspaceId, sourceResponsibilityId: source.id, expectedVersion: 0,
        parts: [{ type: "TASK", title: "p1" }, { type: "TASK", title: "p2" }],
        actorUserId: fx.userId, idempotencyKey: key, requestPayloadHash: "hash-e",
      });
      const second = await splitResponsibility({
        workspaceId: fx.workspaceId, sourceResponsibilityId: source.id, expectedVersion: 0,
        parts: [{ type: "TASK", title: "p1" }, { type: "TASK", title: "p2" }],
        actorUserId: fx.userId, idempotencyKey: key, requestPayloadHash: "hash-e",
      });
      ok("[E] 1回目成功", first.ok);
      ok("[E] 2回目も成功(replay)", second.ok && second.replay === true);
      if (first.ok && second.ok) {
        ok("[E] 同一receiptIdを返す", first.receiptId === second.receiptId);
      }
      const totalChildren = await db.responsibility.count({ where: { workspaceId: fx.workspaceId, title: { in: ["p1", "p2"] } } });
      ok("[E] 二重生成されない(子は2件のまま)", totalChildren === 2);
    }

    // ============================================================
    // F: 同一key・異payloadはIDEMPOTENCY_KEY_REUSED(409)。
    // ============================================================
    {
      const fx = await makeFixture("f");
      const source = await seedResponsibility(fx, "f");
      const key = `client-${RUN_ID}-f`;
      const first = await splitResponsibility({
        workspaceId: fx.workspaceId, sourceResponsibilityId: source.id, expectedVersion: 0,
        parts: [{ type: "TASK", title: "p1" }, { type: "TASK", title: "p2" }],
        actorUserId: fx.userId, idempotencyKey: key, requestPayloadHash: "hash-f-1",
      });
      const second = await splitResponsibility({
        workspaceId: fx.workspaceId, sourceResponsibilityId: source.id, expectedVersion: 0,
        parts: [{ type: "TASK", title: "p1" }, { type: "TASK", title: "p2" }],
        actorUserId: fx.userId, idempotencyKey: key, requestPayloadHash: "hash-f-2-different",
      });
      ok("[F] 1回目成功", first.ok);
      ok("[F] 異payload再送はIDEMPOTENCY_KEY_REUSED", !second.ok && second.error === "IDEMPOTENCY_KEY_REUSED");
    }

    // ============================================================
    // G: 既に分割済みのResponsibilityへ別keyで再度splitはALREADY_SPLIT。
    // ============================================================
    {
      const fx = await makeFixture("g");
      const source = await seedResponsibility(fx, "g");
      const first = await splitResponsibility({
        workspaceId: fx.workspaceId, sourceResponsibilityId: source.id, expectedVersion: 0,
        parts: [{ type: "TASK", title: "p1" }, { type: "TASK", title: "p2" }],
        actorUserId: fx.userId, idempotencyKey: `client-${RUN_ID}-g-1`, requestPayloadHash: "hash-g-1",
      });
      ok("[G] 1回目成功", first.ok);
      const second = await splitResponsibility({
        workspaceId: fx.workspaceId, sourceResponsibilityId: source.id, expectedVersion: 1,
        parts: [{ type: "TASK", title: "p3" }, { type: "TASK", title: "p4" }],
        actorUserId: fx.userId, idempotencyKey: `client-${RUN_ID}-g-2`, requestPayloadHash: "hash-g-2",
      });
      ok("[G] 別keyでの再splitはALREADY_SPLIT", !second.ok && second.error === "ALREADY_SPLIT");
    }

    // ============================================================
    // H: tenant越境。他workspaceのresponsibilityIdはNOT_FOUND。
    // ============================================================
    {
      const fxA = await makeFixture("h-a");
      const fxB = await makeFixture("h-b");
      const sourceInA = await seedResponsibility(fxA, "h");
      const result = await splitResponsibility({
        workspaceId: fxB.workspaceId, sourceResponsibilityId: sourceInA.id, expectedVersion: 0,
        parts: [{ type: "TASK", title: "p1" }, { type: "TASK", title: "p2" }],
        actorUserId: fxB.userId, idempotencyKey: `client-${RUN_ID}-h`, requestPayloadHash: "hash-h",
      });
      ok("[H] tenant越境はNOT_FOUND", !result.ok && result.error === "NOT_FOUND");
    }
  } finally {
    console.log("[CLEANUP] テスト用データを削除します...");
    let cleanupErrorCount = 0;
    for (const uid of userIds) {
      const result = await cleanupFormationVerifyUser(db, uid);
      cleanupErrorCount += result.errors.length;
      for (const e of result.errors) {
        console.log(`  [CLEANUP ERROR] ${e.step}: ${String(e.error)}`);
      }
    }
    const leftover = await assertNoLeftoverFormationVerifyUsers(db, EMAIL_PREFIX);
    ok("[cleanup] test用Userが1件も残っていない", leftover.clean, leftover.remainingUserIds.join(","));
    ok("[cleanup] cleanup自体が例外を起こしていない", cleanupErrorCount === 0, `errors=${cleanupErrorCount}`);

    const deniedAfter = denyGuard.deniedCallAttempts.length;
    ok(
      "[非課金guard] このGateはAI呼び出しを一切行わない(self-test以外の拒否試行0件)",
      deniedAfter === deniedBaseline,
      `deniedCallAttempts=${deniedAfter} baseline=${deniedBaseline}`,
    );
    denyGuard.restore();
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
