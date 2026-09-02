#!/usr/bin/env node
/**
 * scripts/verify_gate_m1a4_external_reference_conflict.ts
 *
 * Gate M1-A4(External Reference Conflict Queue)の実DB受入証跡。
 * 出典: DOC-04(Project Context・外部連携境界仕様書) 4章「conflict queueがある
 * 場合のみ…last-write-winsしない」、EVAL・受入テスト仕様書 EV-C-005
 * 「external snapshot conflict | conflict queue、LWW 0」。
 *
 * 従来このTest IDは、外部Connector別scope/credential/replay防止(統合正本
 * 仕様書29章6項)が未確定のため、想像実装によるPASS偽装を避けてBLOCKEDとして
 * 記録されていた(verify_gate_m1a_acceptance.ts冒頭コメント参照)。本スクリプトは
 * 「conflict検出・queue化・本人解決」という、外部通信を伴わない契約部分のみを
 * 実DBで検証し、EV-C-005を正式にPASSへ移す。
 *
 * AI providerへの実通信は行わない(このGateはAI呼び出しを一切含まない)。
 *
 * 実行方法:
 *   cd ~/projects/ismay/app
 *   npx tsx ../scripts/verify_gate_m1a4_external_reference_conflict.ts
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
const EMAIL_PREFIX = "gate-m1a4-conflict-verify-";

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

/**
 * [独自cleanup・重要] 既存の複数スクリプトに重複コピーされているcleanupTestUser
 * (verify_gate_m1a_acceptance.ts等)は、externalContextReference.deleteManyを
 * projectContextSnapshotRevision/externalReferenceConflictより先に実行しており、
 * これらのテーブルが実際にデータを持つ場合FK違反になる(これまでSnapshotRevisionを
 * 誰も作成していなかったため顕在化していなかった欠陥)。このスクリプトでは
 * SnapshotRevision/Conflictを実際に作成するため、正しいFK順序
 * (conflicts→snapshotRevisions→externalContextReferences→projectContext本体)の
 * 専用cleanupを新たに実装する(既存5ファイルの重複コピー自体を正すのは本Gateの
 * スコープ外とし、想像で不要な範囲まで広げない)。
 */
async function cleanupTestUser(
  db: Awaited<ReturnType<typeof importDb>>["db"],
  params: { userId: string; workspaceId: string | null },
): Promise<void> {
  const { userId, workspaceId } = params;
  if (workspaceId) {
    const contexts = await db.projectContext
      .findMany({ where: { workspaceId }, select: { id: true } })
      .catch(() => [] as { id: string }[]);
    const contextIds = contexts.map((c: { id: string }) => c.id);
    if (contextIds.length > 0) {
      const references = await db.externalContextReference
        .findMany({ where: { contextId: { in: contextIds } }, select: { id: true } })
        .catch(() => [] as { id: string }[]);
      const referenceIds = references.map((r: { id: string }) => r.id);
      if (referenceIds.length > 0) {
        await db.externalReferenceConflict.deleteMany({ where: { referenceId: { in: referenceIds } } }).catch(() => null);
        await db.projectContextSnapshotRevision.deleteMany({ where: { referenceId: { in: referenceIds } } }).catch(() => null);
      }
      await db.projectContextLinkEvent.deleteMany({ where: { contextId: { in: contextIds } } }).catch(() => null);
      await db.projectContextLink.deleteMany({ where: { contextId: { in: contextIds } } }).catch(() => null);
      await db.externalContextReference.deleteMany({ where: { contextId: { in: contextIds } } }).catch(() => null);
      await db.projectContextEmbedding.deleteMany({ where: { contextId: { in: contextIds } } }).catch(() => null);
      await db.eventLog.deleteMany({ where: { aggregateId: { in: contextIds } } }).catch(() => null);
      await db.outboxEvent.deleteMany({ where: { aggregateId: { in: contextIds } } }).catch(() => null);
      await db.projectContext.deleteMany({ where: { id: { in: contextIds } } }).catch(() => null);
    }
  }
  // [FK] ExternalReferenceConflict.resolvedById → users。resolve実行者として
  // このtest userを使うため、workspace配下のcleanupより後、user削除より前に
  // 念のため再度掃討する(上のcontextIds経由で全て消えているはずだが、他workspace
  // 経由で誤って作られた孤立行が無いことの保険)。
  await db.externalReferenceConflict.deleteMany({ where: { resolvedById: userId } }).catch(() => null);
  await db.workspaceMember.deleteMany({ where: { userId } }).catch(() => null);
  if (workspaceId) {
    await db.workspace.deleteMany({ where: { id: workspaceId } }).catch(() => null);
  }
  await db.userSession.deleteMany({ where: { userId } }).catch(() => null);
  await db.user.deleteMany({ where: { id: userId } }).catch(() => null);
}

async function importDb() {
  return await import("../app/src/lib/db");
}

async function main(): Promise<void> {
  const { db } = await importDb();
  const { registerExternalSnapshot, resolveExternalReferenceConflict } = await import(
    "../app/src/lib/projectContext/externalReferenceSync"
  );

  const orphans = await db.user.findMany({
    where: { email: { startsWith: EMAIL_PREFIX, endsWith: "@example.invalid" } },
    select: { id: true },
  });
  if (orphans.length > 0) {
    console.log(`[SWEEP] 過去実行の孤立テストユーザー${orphans.length}件を削除します...`);
    for (const o of orphans) {
      const membership = await db.workspaceMember.findFirst({ where: { userId: o.id }, select: { workspaceId: true } });
      await cleanupTestUser(db, { userId: o.id, workspaceId: membership?.workspaceId ?? null });
    }
  }

  const userIds: { userId: string; workspaceId: string }[] = [];

  async function makeFixture(suffix: string) {
    const email = `${EMAIL_PREFIX}${RUN_ID}-${suffix}@example.invalid`;
    const user = await db.user.create({
      data: { email, passwordHash: "not-a-real-hash-for-db-only-test", displayName: `Gate M1-A4 ${suffix}` },
    });
    const workspace = await db.workspace.create({ data: { name: `Gate M1-A4 Workspace ${suffix}` } });
    await db.workspaceMember.create({ data: { workspaceId: workspace.id, userId: user.id, role: "OWNER" } });
    const domain = await db.domain.create({ data: { workspaceId: workspace.id, name: "個人", kind: "PERSONAL" } });
    userIds.push({ userId: user.id, workspaceId: workspace.id });
    return { userId: user.id, workspaceId: workspace.id, domainId: domain.id };
  }

  async function seedReference(fx: { workspaceId: string; domainId: string; userId: string }, key: string) {
    const context = await db.projectContext.create({
      data: {
        workspaceId: fx.workspaceId,
        domainId: fx.domainId,
        ownerSubjectUserId: fx.userId,
        name: `ctx-${RUN_ID}-${key}`,
        createdById: fx.userId,
      },
    });
    const reference = await db.externalContextReference.create({
      data: {
        workspaceId: fx.workspaceId,
        contextId: context.id,
        provider: "MERIDIAN",
        externalWorkspaceKey: `ws-${RUN_ID}-${key}`,
        externalProjectKey: `proj-${RUN_ID}-${key}`,
        direction: "EXTERNAL_TO_ISMAY",
        syncPolicy: "MANUAL",
        status: "ACTIVE",
      },
    });
    return { context, reference };
  }

  try {
    // ============================================================
    // A: 初回登録はconflictにならず、lastObservedVersionが設定される。
    // ============================================================
    {
      const fx = await makeFixture("a");
      const { reference } = await seedReference(fx, "a");

      const first = await registerExternalSnapshot({
        workspaceId: fx.workspaceId,
        referenceId: reference.id,
        sourceVersion: "v1",
        payload: { status: "in_progress" },
        actorUserId: fx.userId,
      });
      ok("[A] 初回登録は成功", first.ok);
      if (first.ok) {
        ok("[A] 初回登録はconflictにならない", first.conflict === false);
        ok("[A] revisionは1", first.revision === 1);
      }
      const afterFirst = await db.externalContextReference.findUniqueOrThrow({ where: { id: reference.id } });
      ok("[A] lastObservedVersionがv1に設定される", afterFirst.lastObservedVersion === "v1");
      ok("[A] lastSyncedAtが設定される", afterFirst.lastSyncedAt !== null);

      // 同一versionの再登録はconflictにならない(想定通りの進行)。
      const second = await registerExternalSnapshot({
        workspaceId: fx.workspaceId,
        referenceId: reference.id,
        sourceVersion: "v1",
        payload: { status: "in_progress", note: "同じversionの再確認" },
        actorUserId: fx.userId,
      });
      ok("[A] 同一version再登録は成功", second.ok);
      if (second.ok) {
        ok("[A] 同一version再登録はconflictにならない", second.conflict === false);
        ok("[A] revisionは単調増加(2)", second.revision === 2);
      }
    }

    // ============================================================
    // B: 異なるversionが来るとconflict検出、LWWしない(lastObservedVersion不変)。
    // ============================================================
    {
      const fx = await makeFixture("b");
      const { reference } = await seedReference(fx, "b");

      await registerExternalSnapshot({
        workspaceId: fx.workspaceId,
        referenceId: reference.id,
        sourceVersion: "v1",
        payload: { status: "in_progress" },
        actorUserId: fx.userId,
      });

      const conflictResult = await registerExternalSnapshot({
        workspaceId: fx.workspaceId,
        referenceId: reference.id,
        sourceVersion: "v2-external-changed",
        payload: { status: "blocked" },
        actorUserId: fx.userId,
      });
      ok("[B] conflict登録自体は成功(Snapshotは記録される)", conflictResult.ok);
      if (conflictResult.ok) {
        ok("[B] conflictフラグが立つ", conflictResult.conflict === true);
      }

      const afterConflict = await db.externalContextReference.findUniqueOrThrow({ where: { id: reference.id } });
      ok("[B] LWWしない: lastObservedVersionはv1のまま", afterConflict.lastObservedVersion === "v1");

      const conflicts = await db.externalReferenceConflict.findMany({ where: { referenceId: reference.id } });
      ok("[B] ExternalReferenceConflictが1件作成される", conflicts.length === 1);
      ok("[B] conflict.statusはPENDING", conflicts[0]?.status === "PENDING");
      ok("[B] conflict.previousObservedVersionはv1", conflicts[0]?.previousObservedVersion === "v1");
      ok("[B] conflict.newSourceVersionはv2-external-changed", conflicts[0]?.newSourceVersion === "v2-external-changed");

      // ------------------------------------------------------------
      // resolve: APPLY_REMOTEで新しい値を採用する。
      // ------------------------------------------------------------
      if (conflictResult.ok && conflictResult.conflict) {
        const resolved = await resolveExternalReferenceConflict({
          workspaceId: fx.workspaceId,
          conflictId: conflictResult.conflictId,
          action: "APPLY_REMOTE",
          actorUserId: fx.userId,
        });
        ok("[B] resolve(APPLY_REMOTE)成功", resolved.ok);
        if (resolved.ok) {
          ok("[B] resolve後lastObservedVersionが新値に更新される", resolved.referenceLastObservedVersion === "v2-external-changed");
        }
        const afterResolve = await db.externalReferenceConflict.findUniqueOrThrow({ where: { id: conflictResult.conflictId } });
        ok("[B] conflict.statusがRESOLVEDになる", afterResolve.status === "RESOLVED");
        ok("[B] conflict.resolutionActionがAPPLY_REMOTE", afterResolve.resolutionAction === "APPLY_REMOTE");
        ok("[B] conflict.resolvedByIdが記録される", afterResolve.resolvedById === fx.userId);

        // 再度同じconflictを解決しようとするとALREADY_RESOLVED。
        const reResolve = await resolveExternalReferenceConflict({
          workspaceId: fx.workspaceId,
          conflictId: conflictResult.conflictId,
          action: "KEEP_LOCAL",
          actorUserId: fx.userId,
        });
        ok("[B] 解決済みconflictの再解決はALREADY_RESOLVED", !reResolve.ok && reResolve.error === "ALREADY_RESOLVED");
      }
    }

    // ============================================================
    // C: KEEP_LOCALで解決した場合、lastObservedVersionは変わらない。
    // ============================================================
    {
      const fx = await makeFixture("c");
      const { reference } = await seedReference(fx, "c");

      await registerExternalSnapshot({
        workspaceId: fx.workspaceId,
        referenceId: reference.id,
        sourceVersion: "v1",
        payload: {},
        actorUserId: fx.userId,
      });
      const conflictResult = await registerExternalSnapshot({
        workspaceId: fx.workspaceId,
        referenceId: reference.id,
        sourceVersion: "v2-should-not-apply",
        payload: {},
        actorUserId: fx.userId,
      });

      if (conflictResult.ok && conflictResult.conflict) {
        const resolved = await resolveExternalReferenceConflict({
          workspaceId: fx.workspaceId,
          conflictId: conflictResult.conflictId,
          action: "KEEP_LOCAL",
          actorUserId: fx.userId,
        });
        ok("[C] resolve(KEEP_LOCAL)成功", resolved.ok);
        if (resolved.ok) {
          ok("[C] KEEP_LOCAL選択時lastObservedVersionは変わらずv1のまま", resolved.referenceLastObservedVersion === "v1");
        }
      } else {
        ok("[C] 前提条件(conflict検出)が満たされる", false, "conflictResultがconflictを返さなかった");
      }
    }

    // ============================================================
    // D: PENDING一覧に未解決のみ表示される想定のクエリ整合(サービス層で直接確認)。
    // ============================================================
    {
      const fx = await makeFixture("d");
      const { reference } = await seedReference(fx, "d");
      await registerExternalSnapshot({
        workspaceId: fx.workspaceId, referenceId: reference.id, sourceVersion: "v1", payload: {}, actorUserId: fx.userId,
      });
      const c1 = await registerExternalSnapshot({
        workspaceId: fx.workspaceId, referenceId: reference.id, sourceVersion: "v2", payload: {}, actorUserId: fx.userId,
      });
      const c2 = await registerExternalSnapshot({
        workspaceId: fx.workspaceId, referenceId: reference.id, sourceVersion: "v3", payload: {}, actorUserId: fx.userId,
      });
      ok("[D] 複数回のconflictがqueueへ積み重なる", c1.ok && c1.conflict && c2.ok && c2.conflict);
      const pendingCount = await db.externalReferenceConflict.count({ where: { referenceId: reference.id, status: "PENDING" } });
      ok("[D] PENDING conflictが2件蓄積される", pendingCount === 2);
    }

    // ============================================================
    // E: tenant越境。他workspaceのreferenceIdはNOT_FOUND。
    // ============================================================
    {
      const fxA = await makeFixture("e-a");
      const fxB = await makeFixture("e-b");
      const { reference: refInA } = await seedReference(fxA, "e");
      const snapshotResult = await registerExternalSnapshot({
        workspaceId: fxB.workspaceId,
        referenceId: refInA.id,
        sourceVersion: "v1",
        payload: {},
        actorUserId: fxB.userId,
      });
      ok("[E] tenant越境はNOT_FOUND", !snapshotResult.ok && snapshotResult.error === "NOT_FOUND");

      const resolveTenantCross = await resolveExternalReferenceConflict({
        workspaceId: fxB.workspaceId,
        conflictId: "00000000-0000-0000-0000-000000000000",
        action: "KEEP_LOCAL",
        actorUserId: fxB.userId,
      });
      ok("[E] 存在しないconflictIdはNOT_FOUND", !resolveTenantCross.ok && resolveTenantCross.error === "NOT_FOUND");
    }
  } finally {
    console.log("[CLEANUP] テスト用データを削除します...");
    for (const { userId, workspaceId } of userIds) {
      await cleanupTestUser(db, { userId, workspaceId });
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
