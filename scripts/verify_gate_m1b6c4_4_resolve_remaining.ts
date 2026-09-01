#!/usr/bin/env node
/**
 * scripts/verify_gate_m1b6c4_4_resolve_remaining.ts
 *
 * Gate M1-B6C-4 §6.4(resolve remaining)の非課金DB受入証跡。
 * 出典: Claude向け ISMAY c503e72以降 M1-B6C・全残件連続実装指示(2026-08-31) §6.4。
 *
 * 実行方法:
 *   cd ~/projects/ismay/app
 *   npx tsx ../scripts/verify_gate_m1b6c4_4_resolve_remaining.ts
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
const EMAIL_PREFIX = "gate-m1b6c4-4-resolve-verify-";

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
  const { resolveRemainingCandidates } = await import("../app/src/lib/formation/resolveRemaining");

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
      data: { email, passwordHash: "not-a-real-hash-for-db-only-test", displayName: `Gate M1-B6C-4-4 ${suffix}` },
    });
    const workspace = await db.workspace.create({ data: { name: `Gate M1-B6C-4-4 Workspace ${suffix}` } });
    await db.workspaceMember.create({ data: { workspaceId: workspace.id, userId: user.id, role: "OWNER" } });
    const domain = await db.domain.create({ data: { workspaceId: workspace.id, name: "個人", kind: "PERSONAL" } });
    userIds.push(user.id);
    return { userId: user.id, workspaceId: workspace.id, domainId: domain.id };
  }

  /** PARTIALLY_CONFIRMEDのSession + 決定済み候補1件(materialize相当) + pending候補numPending件をseedする。 */
  async function seedPartiallyConfirmedSession(
    fx: { workspaceId: string; domainId: string; userId: string },
    suffix: string,
    numPending: number,
  ) {
    const capture = await db.capture.create({
      data: { workspaceId: fx.workspaceId, domainId: fx.domainId, createdById: fx.userId, sourceType: "TEXT", rawText: `検証用${suffix}`, processingStatus: "READY" },
    });
    const session = await db.formationSession.create({
      data: { workspaceId: fx.workspaceId, domainId: fx.domainId, subjectUserId: fx.userId, captureId: capture.id, clientSessionKey: `resolve-${suffix}`, state: "PARTIALLY_CONFIRMED", version: 0 },
    });

    async function seedCandidate(key: string, title: string, decided: boolean) {
      const identity = await db.formationCandidateIdentity.create({
        data: { workspaceId: fx.workspaceId, sessionId: session.id, candidateKey: key, currentRevision: 1 },
      });
      const revision = await db.formationCandidateRevision.create({
        data: {
          workspaceId: fx.workspaceId,
          candidateId: identity.id,
          revision: 1,
          type: "TASK",
          title,
          proposedFields: { candidateId: key, type: "TASK", title, evidenceSpans: [{ start: 0, end: 5 }], confidence: 0.9, dateMentions: [], unknowns: [], blockedByCandidateIds: [], suggestedTags: [] },
          confidence: 0.9,
          schemaVersion: "1.0",
        },
      });
      if (decided) {
        await db.formationCandidateDecisionEvent.create({
          data: { workspaceId: fx.workspaceId, candidateId: identity.id, revisionId: revision.id, decision: "ACCEPTED", actorUserId: fx.userId },
        });
      }
      return identity;
    }

    // 既にmaterialize相当で決定済みの候補を1件(PARTIALLY_CONFIRMEDの前提)。
    await seedCandidate(`${suffix}-decided`, "既に確定済みの候補", true);

    const pending: { id: string }[] = [];
    for (let i = 0; i < numPending; i++) {
      pending.push(await seedCandidate(`${suffix}-pending-${i}`, `未決定の候補${i}`, false));
    }
    return { session, pending };
  }

  try {
    // ============================================================
    // A: 全件DEFERRED → CONFIRMED(設計判断: 全件deferならaccepted側close-out)。
    // ============================================================
    {
      const fx = await makeFixture("a");
      const { session, pending } = await seedPartiallyConfirmedSession(fx, "a", 2);

      const result = await resolveRemainingCandidates({
        sessionId: session.id,
        workspaceId: fx.workspaceId,
        clientEventId: `ce-${RUN_ID}-a`,
        expectedVersion: session.version,
        actorUserId: fx.userId,
        items: pending.map((p) => ({ candidateId: p.id, expectedRevision: 1, resolution: "DEFERRED" })),
      });
      ok("[A.1] 全件DEFERREDの解決が成功する", result.ok === true, JSON.stringify(result));
      if (result.ok) {
        ok("[A.2・是正の核心] 全件DEFERREDはCONFIRMEDへ遷移する", result.toState === "CONFIRMED", result.toState);
      }
      const sessionAfter = await db.formationSession.findUniqueOrThrow({ where: { id: session.id } });
      ok("[A.3] DB上もCONFIRMED", sessionAfter.state === "CONFIRMED", sessionAfter.state);
      ok("[A.4] versionがincrementされる", sessionAfter.version === session.version + 1);

      const decisionEvents = await db.formationCandidateDecisionEvent.findMany({ where: { candidateId: { in: pending.map((p) => p.id) } } });
      ok("[A.5] 両方のpending候補にDEFERRED decisionが記録される", decisionEvents.length === 2 && decisionEvents.every((d: any) => d.decision === "DEFERRED"), JSON.stringify(decisionEvents.map((d: any) => d.decision)));

      const timelineEvent = await db.formationSessionEvent.findFirst({ where: { sessionId: session.id, eventType: "SESSION_CONFIRMED" } });
      ok("[A.6] SESSION_CONFIRMED timeline eventが記録される", !!timelineEvent);
    }

    // ============================================================
    // B: 1件でもDO_NOT_MATERIALIZEが含まれる → DISMISSED。
    // ============================================================
    {
      const fx = await makeFixture("b");
      const { session, pending } = await seedPartiallyConfirmedSession(fx, "b", 2);

      const result = await resolveRemainingCandidates({
        sessionId: session.id,
        workspaceId: fx.workspaceId,
        clientEventId: `ce-${RUN_ID}-b`,
        expectedVersion: session.version,
        actorUserId: fx.userId,
        items: [
          { candidateId: pending[0]!.id, expectedRevision: 1, resolution: "DEFERRED" },
          { candidateId: pending[1]!.id, expectedRevision: 1, resolution: "DO_NOT_MATERIALIZE" },
        ],
      });
      ok("[B.1] 混在解決が成功する", result.ok === true, JSON.stringify(result));
      if (result.ok) {
        ok("[B.2・是正の核心] 1件でもDO_NOT_MATERIALIZEがあればDISMISSEDへ遷移する", result.toState === "DISMISSED", result.toState);
      }
      const sessionAfter = await db.formationSession.findUniqueOrThrow({ where: { id: session.id } });
      ok("[B.3] DB上もDISMISSED", sessionAfter.state === "DISMISSED", sessionAfter.state);
      const timelineEvent = await db.formationSessionEvent.findFirst({ where: { sessionId: session.id, eventType: "SESSION_DISMISSED" } });
      ok("[B.4] SESSION_DISMISSED timeline eventが記録される", !!timelineEvent);
    }

    // ============================================================
    // C: pending候補を黙って捨てない — 1件でも未指定ならMISSING_PENDING_CANDIDATES。
    // ============================================================
    {
      const fx = await makeFixture("c");
      const { session, pending } = await seedPartiallyConfirmedSession(fx, "c", 2);

      const result = await resolveRemainingCandidates({
        sessionId: session.id,
        workspaceId: fx.workspaceId,
        clientEventId: `ce-${RUN_ID}-c`,
        expectedVersion: session.version,
        actorUserId: fx.userId,
        items: [{ candidateId: pending[0]!.id, expectedRevision: 1, resolution: "DEFERRED" }], // 2件目を指定しない
      });
      ok(
        "[C.1・是正の核心] pending候補の一部を指定しないとMISSING_PENDING_CANDIDATESで拒否される",
        result.ok === false && (result as { error: string }).error === "MISSING_PENDING_CANDIDATES",
        JSON.stringify(result),
      );
      if (!result.ok && result.error === "MISSING_PENDING_CANDIDATES") {
        ok("[C.2] missingCandidateIdsに未指定の候補が含まれる", result.missingCandidateIds.includes(pending[1]!.id), JSON.stringify(result.missingCandidateIds));
      }
      const sessionAfter = await db.formationSession.findUniqueOrThrow({ where: { id: session.id } });
      ok("[C.3] 拒否時、Session状態は変化しない(PARTIALLY_CONFIRMEDのまま)", sessionAfter.state === "PARTIALLY_CONFIRMED", sessionAfter.state);
      const decisionEvents = await db.formationCandidateDecisionEvent.findMany({ where: { candidateId: { in: pending.map((p) => p.id) } } });
      ok("[C.4] 拒否時、候補のdecisionは1件も記録されない(全体rollback)", decisionEvents.length === 0, String(decisionEvents.length));
    }

    // ============================================================
    // D: version conflict。
    // ============================================================
    {
      const fx = await makeFixture("d");
      const { session, pending } = await seedPartiallyConfirmedSession(fx, "d", 1);
      const result = await resolveRemainingCandidates({
        sessionId: session.id,
        workspaceId: fx.workspaceId,
        clientEventId: `ce-${RUN_ID}-d`,
        expectedVersion: session.version + 999,
        actorUserId: fx.userId,
        items: [{ candidateId: pending[0]!.id, expectedRevision: 1, resolution: "DEFERRED" }],
      });
      ok("[D.1] 不一致なexpectedVersionはVERSION_CONFLICTで拒否される", result.ok === false && (result as { error: string }).error === "VERSION_CONFLICT", JSON.stringify(result));
    }

    // ============================================================
    // E: idempotent replay。
    // ============================================================
    {
      const fx = await makeFixture("e");
      const { session, pending } = await seedPartiallyConfirmedSession(fx, "e", 1);
      const clientEventId = `ce-${RUN_ID}-e`;
      const items = [{ candidateId: pending[0]!.id, expectedRevision: 1, resolution: "DEFERRED" as const }];

      const first = await resolveRemainingCandidates({ sessionId: session.id, workspaceId: fx.workspaceId, clientEventId, expectedVersion: session.version, actorUserId: fx.userId, items });
      ok("[E.1前提] 初回解決成功", first.ok === true && first.ok && first.replay === false, JSON.stringify(first));

      const replay = await resolveRemainingCandidates({ sessionId: session.id, workspaceId: fx.workspaceId, clientEventId, expectedVersion: session.version, actorUserId: fx.userId, items });
      ok("[E.2・是正の核心] 同一内容の再送はreplay=trueで同じ結果を返す", replay.ok === true && replay.ok && replay.replay === true && replay.toState === "CONFIRMED", JSON.stringify(replay));

      const decisionEvents = await db.formationCandidateDecisionEvent.findMany({ where: { candidateId: pending[0]!.id } });
      ok("[E.3] replayでdecision eventは重複しない(1件のまま)", decisionEvents.length === 1, String(decisionEvents.length));

      const mismatched = await resolveRemainingCandidates({
        sessionId: session.id,
        workspaceId: fx.workspaceId,
        clientEventId,
        expectedVersion: session.version,
        actorUserId: fx.userId,
        items: [{ candidateId: pending[0]!.id, expectedRevision: 1, resolution: "DO_NOT_MATERIALIZE" }],
      });
      ok("[E.4] 同一clientEventId・異なる内容はIDEMPOTENCY_KEY_REUSEDで拒否される", mismatched.ok === false && (mismatched as { error: string }).error === "IDEMPOTENCY_KEY_REUSED", JSON.stringify(mismatched));
    }

    // ============================================================
    // F: state guard — PARTIALLY_CONFIRMED以外はINVALID_SESSION_STATE。
    // ============================================================
    {
      const fx = await makeFixture("f");
      const capture = await db.capture.create({
        data: { workspaceId: fx.workspaceId, domainId: fx.domainId, createdById: fx.userId, sourceType: "TEXT", rawText: "検証用f", processingStatus: "READY" },
      });
      const session = await db.formationSession.create({
        data: { workspaceId: fx.workspaceId, domainId: fx.domainId, subjectUserId: fx.userId, captureId: capture.id, clientSessionKey: "resolve-f", state: "REVIEW_READY" },
      });
      const identity = await db.formationCandidateIdentity.create({
        data: { workspaceId: fx.workspaceId, sessionId: session.id, candidateKey: "f-1", currentRevision: 1 },
      });
      const result = await resolveRemainingCandidates({
        sessionId: session.id,
        workspaceId: fx.workspaceId,
        clientEventId: `ce-${RUN_ID}-f`,
        expectedVersion: session.version,
        actorUserId: fx.userId,
        items: [{ candidateId: identity.id, expectedRevision: 1, resolution: "DEFERRED" }],
      });
      ok("[F.1・state guard] REVIEW_READY状態はINVALID_SESSION_STATEで拒否される", result.ok === false && (result as { error: string }).error === "INVALID_SESSION_STATE", JSON.stringify(result));
    }

    // ============================================================
    // G: 未知/決定済みcandidateIdの指定はUNKNOWN_CANDIDATEで拒否される。
    // ============================================================
    {
      const fx = await makeFixture("g");
      const { session, pending } = await seedPartiallyConfirmedSession(fx, "g", 1);
      const result = await resolveRemainingCandidates({
        sessionId: session.id,
        workspaceId: fx.workspaceId,
        clientEventId: `ce-${RUN_ID}-g`,
        expectedVersion: session.version,
        actorUserId: fx.userId,
        items: [
          { candidateId: pending[0]!.id, expectedRevision: 1, resolution: "DEFERRED" },
          { candidateId: "00000000-0000-4000-8000-000000000000", expectedRevision: 1, resolution: "DEFERRED" },
        ],
      });
      ok("[G.1] 存在しないcandidateIdの指定はUNKNOWN_CANDIDATEで拒否される", result.ok === false && (result as { error: string }).error === "UNKNOWN_CANDIDATE", JSON.stringify(result));
      const sessionAfter = await db.formationSession.findUniqueOrThrow({ where: { id: session.id } });
      ok("[G.2] 拒否時、Session状態は変化しない", sessionAfter.state === "PARTIALLY_CONFIRMED", sessionAfter.state);
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
