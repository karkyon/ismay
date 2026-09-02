#!/usr/bin/env node
/**
 * scripts/verify_gate_m1c3b_responsibility_merge.ts
 *
 * Gate M1-C3B(Materialized Responsibility Merge Correction)の非課金DB受入証跡。
 * 出典: 統合正本仕様書v5.0 §12.8、§11.4の統合方向適用。
 *
 * AI providerへの実通信は一切行わない(aiNetworkDenyGuard必須)。
 *
 * 実行方法:
 *   cd ~/projects/ismay/app
 *   npx tsx ../scripts/verify_gate_m1c3b_responsibility_merge.ts
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
const EMAIL_PREFIX = "gate-m1c3b-merge-verify-";

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
  const { mergeResponsibilities } = await import("../app/src/lib/formation/responsibilityCorrection");

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
      data: { email, passwordHash: "not-a-real-hash-for-db-only-test", displayName: `Gate M1-C3B ${suffix}` },
    });
    const workspace = await db.workspace.create({ data: { name: `Gate M1-C3B Workspace ${suffix}` } });
    await db.workspaceMember.create({ data: { workspaceId: workspace.id, userId: user.id, role: "OWNER" } });
    const domain = await db.domain.create({ data: { workspaceId: workspace.id, name: "個人", kind: "PERSONAL" } });
    userIds.push(user.id);
    return { userId: user.id, workspaceId: workspace.id, domainId: domain.id };
  }

  async function seedResponsibility(
    fx: { workspaceId: string; domainId: string; userId: string },
    key: string,
    overrides?: { withRecurrence?: boolean; domainId?: string; importance?: number },
  ) {
    const capture = await db.capture.create({
      data: { workspaceId: fx.workspaceId, domainId: fx.domainId, createdById: fx.userId, sourceType: "TEXT", rawText: `検証用${key}`, processingStatus: "READY" },
    });
    const resp = await db.responsibility.create({
      data: {
        workspaceId: fx.workspaceId,
        domainId: overrides?.domainId ?? fx.domainId,
        originCaptureId: capture.id,
        type: "TASK",
        title: `統合対象${key}`,
        status: "INBOX",
        importance: overrides?.importance ?? 3,
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
    // A: 正常merge。Tag/Relation(自己参照除外)/ProjectContextLinkが統合され、
    //    全sourceは物理削除されずsupersededByMergeReceiptIdのみ設定される。
    // ============================================================
    {
      const fx = await makeFixture("a");
      const s1 = await seedResponsibility(fx, "a-1", { importance: 2 });
      const s2 = await seedResponsibility(fx, "a-2", { importance: 5 });

      const tag1 = await db.tag.create({ data: { workspaceId: fx.workspaceId, name: `tag-${RUN_ID}-a1` } });
      const tag2 = await db.tag.create({ data: { workspaceId: fx.workspaceId, name: `tag-${RUN_ID}-a2` } });
      await db.responsibilityTag.create({ data: { responsibilityId: s1.id, tagId: tag1.id } });
      await db.responsibilityTag.create({ data: { responsibilityId: s2.id, tagId: tag2.id } });

      // s1↔s2間のRelation(統合後は自己参照になるため複製されないはず)。
      await db.responsibilityRelation.create({
        data: { fromId: s1.id, toId: s2.id, relationType: "BLOCKS", status: "CONFIRMED", sourceKind: "USER" },
      });
      // 外部Responsibilityとのrelation(複製されるはず)。
      const outsider = await seedResponsibility(fx, "a-outsider");
      await db.responsibilityRelation.create({
        data: { fromId: s2.id, toId: outsider.id, relationType: "DEPENDS_ON", status: "CONFIRMED", sourceKind: "USER" },
      });

      const context = await db.projectContext.create({
        data: { workspaceId: fx.workspaceId, domainId: fx.domainId, ownerSubjectUserId: fx.userId, name: `ctx-${RUN_ID}-a`, createdById: fx.userId },
      });
      const link1 = await db.projectContextLink.create({
        data: { workspaceId: fx.workspaceId, contextId: context.id, responsibilityId: s1.id, role: "SUPPORTING", sourceKind: "USER" },
      });
      await db.projectContextLinkEvent.create({
        data: {
          workspaceId: fx.workspaceId, contextId: context.id, responsibilityId: s1.id, eventType: "LINK", role: "SUPPORTING",
          afterSnapshot: { role: "SUPPORTING", sourceKind: link1.sourceKind, linkedAt: link1.linkedAt.toISOString() },
          actorType: "USER", actorUserId: fx.userId, idempotencyKey: `seed-${RUN_ID}-a1-link`, requestPayloadHash: "seed",
        },
      });

      const result = await mergeResponsibilities({
        workspaceId: fx.workspaceId,
        sources: [
          { responsibilityId: s1.id, expectedVersion: 0 },
          { responsibilityId: s2.id, expectedVersion: 0 },
        ],
        newType: "TASK",
        newTitle: "統合後タイトル",
        actorUserId: fx.userId,
        idempotencyKey: `client-${RUN_ID}-a`,
        requestPayloadHash: "hash-a",
      });
      ok("[A] merge成功", result.ok);
      if (result.ok) {
        const merged = await db.responsibility.findUniqueOrThrow({ where: { id: result.newResponsibilityId } });
        ok("[A] importanceは最大値(5)を採用", merged.importance === 5);

        const s1After = await db.responsibility.findUniqueOrThrow({ where: { id: s1.id } });
        const s2After = await db.responsibility.findUniqueOrThrow({ where: { id: s2.id } });
        ok("[A] source1は物理削除されない", s1After.deletedAt === null);
        ok("[A] source1のsupersededByMergeReceiptIdが設定される", s1After.supersededByMergeReceiptId === result.receiptId);
        ok("[A] source2のsupersededByMergeReceiptIdが設定される", s2After.supersededByMergeReceiptId === result.receiptId);
        ok("[A] source1のversionが1つ進む", s1After.version === 1);

        const tagCount1 = await db.responsibilityTag.count({ where: { responsibilityId: result.newResponsibilityId, tagId: tag1.id } });
        const tagCount2 = await db.responsibilityTag.count({ where: { responsibilityId: result.newResponsibilityId, tagId: tag2.id } });
        ok("[A] source1のTagが統合される", tagCount1 === 1);
        ok("[A] source2のTagが統合される", tagCount2 === 1);

        const selfRelCount = await db.responsibilityRelation.count({
          where: { OR: [{ fromId: result.newResponsibilityId, toId: result.newResponsibilityId }] },
        });
        ok("[A] source間の自己参照Relationは複製されない", selfRelCount === 0);

        const outsiderRelCount = await db.responsibilityRelation.count({
          where: { fromId: result.newResponsibilityId, toId: outsider.id, relationType: "DEPENDS_ON" },
        });
        ok("[A] 外部とのRelationは複製される", outsiderRelCount === 1);

        const linkCount = await db.projectContextLink.count({ where: { workspaceId: fx.workspaceId, contextId: context.id, responsibilityId: result.newResponsibilityId, unlinkedAt: null } });
        ok("[A] ProjectContextLinkが統合される", linkCount === 1);
      }
    }

    // ============================================================
    // B: PRIMARY Link競合。複数sourceが別ContextへPRIMARYを持つ場合、
    //    最初の1件のみPRIMARYを維持し、以降はSUPPORTINGへ格下げされる。
    // ============================================================
    {
      const fx = await makeFixture("b");
      const s1 = await seedResponsibility(fx, "b-1");
      const s2 = await seedResponsibility(fx, "b-2");
      const ctx1 = await db.projectContext.create({
        data: { workspaceId: fx.workspaceId, domainId: fx.domainId, ownerSubjectUserId: fx.userId, name: `ctx-${RUN_ID}-b1`, createdById: fx.userId },
      });
      const ctx2 = await db.projectContext.create({
        data: { workspaceId: fx.workspaceId, domainId: fx.domainId, ownerSubjectUserId: fx.userId, name: `ctx-${RUN_ID}-b2`, createdById: fx.userId },
      });
      const l1 = await db.projectContextLink.create({ data: { workspaceId: fx.workspaceId, contextId: ctx1.id, responsibilityId: s1.id, role: "PRIMARY", sourceKind: "USER" } });
      await db.projectContextLinkEvent.create({ data: { workspaceId: fx.workspaceId, contextId: ctx1.id, responsibilityId: s1.id, eventType: "LINK", role: "PRIMARY", afterSnapshot: { role: "PRIMARY", sourceKind: l1.sourceKind, linkedAt: l1.linkedAt.toISOString() }, actorType: "USER", actorUserId: fx.userId, idempotencyKey: `seed-${RUN_ID}-b1`, requestPayloadHash: "seed" } });
      const l2 = await db.projectContextLink.create({ data: { workspaceId: fx.workspaceId, contextId: ctx2.id, responsibilityId: s2.id, role: "PRIMARY", sourceKind: "USER" } });
      await db.projectContextLinkEvent.create({ data: { workspaceId: fx.workspaceId, contextId: ctx2.id, responsibilityId: s2.id, eventType: "LINK", role: "PRIMARY", afterSnapshot: { role: "PRIMARY", sourceKind: l2.sourceKind, linkedAt: l2.linkedAt.toISOString() }, actorType: "USER", actorUserId: fx.userId, idempotencyKey: `seed-${RUN_ID}-b2`, requestPayloadHash: "seed" } });

      const result = await mergeResponsibilities({
        workspaceId: fx.workspaceId,
        sources: [
          { responsibilityId: s1.id, expectedVersion: 0 },
          { responsibilityId: s2.id, expectedVersion: 0 },
        ],
        newType: "TASK",
        newTitle: "PRIMARY競合統合",
        actorUserId: fx.userId,
        idempotencyKey: `client-${RUN_ID}-b`,
        requestPayloadHash: "hash-b",
      });
      ok("[B] merge成功", result.ok);
      if (result.ok) {
        const primaryCount = await db.projectContextLink.count({ where: { workspaceId: fx.workspaceId, responsibilityId: result.newResponsibilityId, role: "PRIMARY", unlinkedAt: null } });
        ok("[B] active PRIMARYは最大1件のみ", primaryCount === 1);
        const totalLinkCount = await db.projectContextLink.count({ where: { workspaceId: fx.workspaceId, responsibilityId: result.newResponsibilityId, unlinkedAt: null } });
        ok("[B] 両Contextとも統合される(1件はPRIMARY、1件はSUPPORTINGへ格下げ)", totalLinkCount === 2);
        const ctx1Link = await db.projectContextLink.findFirst({ where: { workspaceId: fx.workspaceId, contextId: ctx1.id, responsibilityId: result.newResponsibilityId, unlinkedAt: null } });
        ok("[B] 最初に処理されたsource(s1)のContextがPRIMARYを維持", ctx1Link?.role === "PRIMARY");
        const ctx2Link = await db.projectContextLink.findFirst({ where: { workspaceId: fx.workspaceId, contextId: ctx2.id, responsibilityId: result.newResponsibilityId, unlinkedAt: null } });
        ok("[B] 2番目のContextはSUPPORTINGへ格下げ", ctx2Link?.role === "SUPPORTING");
      }
    }

    // ============================================================
    // C: sourceが1件のみはINVALID_MERGE_SOURCESで拒否。
    // ============================================================
    {
      const fx = await makeFixture("c");
      const s1 = await seedResponsibility(fx, "c-1");
      const result = await mergeResponsibilities({
        workspaceId: fx.workspaceId,
        sources: [{ responsibilityId: s1.id, expectedVersion: 0 }],
        newType: "TASK",
        newTitle: "単独",
        actorUserId: fx.userId,
        idempotencyKey: `client-${RUN_ID}-c`,
        requestPayloadHash: "hash-c",
      });
      ok("[C] source1件はINVALID_MERGE_SOURCESで拒否", !result.ok && result.error === "INVALID_MERGE_SOURCES");
    }

    // ============================================================
    // D: domainId不一致はDOMAIN_MISMATCH。
    // ============================================================
    {
      const fx = await makeFixture("d");
      const otherDomain = await db.domain.create({ data: { workspaceId: fx.workspaceId, name: "別ドメイン", kind: "WORK" } });
      const s1 = await seedResponsibility(fx, "d-1");
      const s2 = await seedResponsibility(fx, "d-2", { domainId: otherDomain.id });
      const result = await mergeResponsibilities({
        workspaceId: fx.workspaceId,
        sources: [
          { responsibilityId: s1.id, expectedVersion: 0 },
          { responsibilityId: s2.id, expectedVersion: 0 },
        ],
        newType: "TASK",
        newTitle: "ドメイン不一致",
        actorUserId: fx.userId,
        idempotencyKey: `client-${RUN_ID}-d`,
        requestPayloadHash: "hash-d",
      });
      ok("[D] domainId不一致はDOMAIN_MISMATCH", !result.ok && result.error === "DOMAIN_MISMATCH");
    }

    // ============================================================
    // E: RecurrenceRuleを持つsourceは拒否。
    // ============================================================
    {
      const fx = await makeFixture("e");
      const s1 = await seedResponsibility(fx, "e-1", { withRecurrence: true });
      const s2 = await seedResponsibility(fx, "e-2");
      const result = await mergeResponsibilities({
        workspaceId: fx.workspaceId,
        sources: [
          { responsibilityId: s1.id, expectedVersion: 0 },
          { responsibilityId: s2.id, expectedVersion: 0 },
        ],
        newType: "TASK",
        newTitle: "定期含む",
        actorUserId: fx.userId,
        idempotencyKey: `client-${RUN_ID}-e`,
        requestPayloadHash: "hash-e",
      });
      ok("[E] RecurrenceRule保有はHAS_RECURRENCE_RULEで拒否", !result.ok && result.error === "HAS_RECURRENCE_RULE");
    }

    // ============================================================
    // F: 冪等再送(同一key・同一payload)は同じReceiptを返し、二重生成しない。
    // ============================================================
    {
      const fx = await makeFixture("f");
      const s1 = await seedResponsibility(fx, "f-1");
      const s2 = await seedResponsibility(fx, "f-2");
      const key = `client-${RUN_ID}-f`;
      const args = {
        workspaceId: fx.workspaceId,
        sources: [
          { responsibilityId: s1.id, expectedVersion: 0 },
          { responsibilityId: s2.id, expectedVersion: 0 },
        ],
        newType: "TASK" as const,
        newTitle: "冪等統合",
        actorUserId: fx.userId,
        idempotencyKey: key,
        requestPayloadHash: "hash-f",
      };
      const first = await mergeResponsibilities(args);
      const second = await mergeResponsibilities(args);
      ok("[F] 1回目成功", first.ok);
      ok("[F] 2回目も成功(replay)", second.ok && second.replay === true);
      if (first.ok && second.ok) {
        ok("[F] 同一receiptId/newResponsibilityIdを返す", first.receiptId === second.receiptId && first.newResponsibilityId === second.newResponsibilityId);
      }
      const totalMerged = await db.responsibility.count({ where: { workspaceId: fx.workspaceId, title: "冪等統合" } });
      ok("[F] 二重生成されない(統合後Responsibilityは1件のみ)", totalMerged === 1);
    }

    // ============================================================
    // G: 既にsplit済みのResponsibilityをmerge対象にするとALREADY_SPLIT_OR_MERGED。
    // ============================================================
    {
      const { splitResponsibility } = await import("../app/src/lib/formation/responsibilityCorrection");
      const fx = await makeFixture("g");
      const s1 = await seedResponsibility(fx, "g-1");
      const s2 = await seedResponsibility(fx, "g-2");
      const splitResult = await splitResponsibility({
        workspaceId: fx.workspaceId,
        sourceResponsibilityId: s1.id,
        expectedVersion: 0,
        parts: [{ type: "TASK", title: "p1" }, { type: "TASK", title: "p2" }],
        actorUserId: fx.userId,
        idempotencyKey: `client-${RUN_ID}-g-split`,
        requestPayloadHash: "hash-g-split",
      });
      ok("[G] 前提: split成功", splitResult.ok);
      const mergeResult = await mergeResponsibilities({
        workspaceId: fx.workspaceId,
        sources: [
          { responsibilityId: s1.id, expectedVersion: 1 },
          { responsibilityId: s2.id, expectedVersion: 0 },
        ],
        newType: "TASK",
        newTitle: "split済みを統合しようとする",
        actorUserId: fx.userId,
        idempotencyKey: `client-${RUN_ID}-g-merge`,
        requestPayloadHash: "hash-g-merge",
      });
      ok("[G] split済みsourceのmergeはALREADY_SPLIT_OR_MERGED", !mergeResult.ok && mergeResult.error === "ALREADY_SPLIT_OR_MERGED");
    }

    // ============================================================
    // H: tenant越境。他workspaceのresponsibilityIdを含むとNOT_FOUND。
    // ============================================================
    {
      const fxA = await makeFixture("h-a");
      const fxB = await makeFixture("h-b");
      const sInA = await seedResponsibility(fxA, "h-1");
      const sInB = await seedResponsibility(fxB, "h-2");
      const result = await mergeResponsibilities({
        workspaceId: fxB.workspaceId,
        sources: [
          { responsibilityId: sInA.id, expectedVersion: 0 },
          { responsibilityId: sInB.id, expectedVersion: 0 },
        ],
        newType: "TASK",
        newTitle: "tenant越境",
        actorUserId: fxB.userId,
        idempotencyKey: `client-${RUN_ID}-h`,
        requestPayloadHash: "hash-h",
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
