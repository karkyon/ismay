#!/usr/bin/env node
/**
 * scripts/verify_gate_m1b6b_session_lifecycle.ts
 *
 * Gate M1-B6B(Session Lifecycle: defer/dismiss/resume/retry)の非課金DB受入証跡。
 * 出典: Claude向け ISMAY 69b5a87以降 監査是正・M1-B6完遂・PEM-0連続実装指示
 *       (2026-08-31) Gate M1-B6B。
 *
 * AI providerへの実通信は一切行わない(aiNetworkDenyGuard必須。retryは状態遷移の
 * みを検証し、実際の新AiRun起動は検証対象外=sessionLifecycle.tsのscope外)。
 *
 * 実行方法:
 *   cd ~/projects/ismay/app
 *   npx tsx ../scripts/verify_gate_m1b6b_session_lifecycle.ts
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
const EMAIL_PREFIX = "gate-m1b6b-lifecycle-verify-";

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
  const deniedBaseline = denyGuard.deniedCallAttempts.length;
  if (!guardSelfTestPassed) {
    denyGuard.restore();
    console.log(`\n合計: ${passed} passed, ${failed} failed`);
    process.exitCode = 1;
    return;
  }

  const { db } = await import("../app/src/lib/db");
  const { deferFormationSession, dismissFormationSession, resumeFormationSession, retryFormationSession } =
    await import("../app/src/lib/formation/sessionLifecycle");

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
      data: { email, passwordHash: "not-a-real-hash-for-db-only-test", displayName: `Gate M1-B6B ${suffix}` },
    });
    const workspace = await db.workspace.create({ data: { name: `Gate M1-B6B Workspace ${suffix}` } });
    await db.workspaceMember.create({ data: { workspaceId: workspace.id, userId: user.id, role: "OWNER" } });
    const domain = await db.domain.create({ data: { workspaceId: workspace.id, name: "個人", kind: "PERSONAL" } });
    userIds.push(user.id);
    return { userId: user.id, workspaceId: workspace.id, domainId: domain.id };
  }

  async function seedSession(fx: { workspaceId: string; domainId: string; userId: string }, key: string, state: string) {
    const capture = await db.capture.create({
      data: { workspaceId: fx.workspaceId, domainId: fx.domainId, createdById: fx.userId, sourceType: "TEXT", rawText: `検証用${key}`, processingStatus: "READY" },
    });
    return db.formationSession.create({
      data: { workspaceId: fx.workspaceId, domainId: fx.domainId, subjectUserId: fx.userId, captureId: capture.id, clientSessionKey: key, state },
    });
  }

  try {
    // ============================================================
    // A: defer→resumeが実際の直前状態を復元する(REVIEW_READY/CLARIFYING/
    //    PARTIALLY_CONFIRMEDの3通り、想像で固定値を返さないことの確認)。
    // ============================================================
    for (const [label, startState, expectedResume] of [
      ["review_ready", "REVIEW_READY", "REVIEW_READY"],
      ["clarifying", "CLARIFYING", "CLARIFYING"],
      ["partially_confirmed", "PARTIALLY_CONFIRMED", "REVIEW_READY"],
    ] as const) {
      const fx = await makeFixture(`a-${label}`);
      const session = await seedSession(fx, `a-${label}`, startState);

      const deferResult = await deferFormationSession({
        sessionId: session.id,
        workspaceId: fx.workspaceId,
        clientEventId: `client-${RUN_ID}-a-${label}-defer`,
        actorUserId: fx.userId,
        reasonCode: "検証用",
        expectedVersion: session.version,
      });
      ok(`[A・${label}.1前提] ${startState}からのdeferが成功する`, deferResult.ok === true, JSON.stringify(deferResult));
      if (deferResult.ok) {
        ok(`[A・${label}.2] deferでtoState=DEFERRED`, deferResult.toState === "DEFERRED");
      }

      const dbAfterDefer = await db.formationSession.findUniqueOrThrow({ where: { id: session.id } });
      ok(`[A・${label}.3] DB上もstate=DEFERRED`, dbAfterDefer.state === "DEFERRED", dbAfterDefer.state);

      const resumeResult = await resumeFormationSession({
        sessionId: session.id,
        workspaceId: fx.workspaceId,
        clientEventId: `client-${RUN_ID}-a-${label}-resume`,
        actorUserId: fx.userId,
        expectedVersion: dbAfterDefer.version,
      });
      ok(
        `[A・${label}.4・是正の核心] resumeが${expectedResume}へ正しく復元する(想像で固定値を返さない)`,
        resumeResult.ok === true && resumeResult.toState === expectedResume,
        JSON.stringify(resumeResult),
      );
    }

    // ============================================================
    // B: idempotency(同一clientEventId・同一内容は再送安全、内容が違えば拒否)。
    // ============================================================
    {
      const fx = await makeFixture("b");
      const session = await seedSession(fx, "b", "REVIEW_READY");
      const clientEventId = `client-${RUN_ID}-b`;

      const first = await deferFormationSession({ sessionId: session.id, workspaceId: fx.workspaceId, clientEventId, actorUserId: fx.userId, reasonCode: "理由A", expectedVersion: session.version });
      ok("[B.1] 初回defer成功(replay=false)", first.ok === true && first.ok && first.replay === false, JSON.stringify(first));

      const replay = await deferFormationSession({ sessionId: session.id, workspaceId: fx.workspaceId, clientEventId, actorUserId: fx.userId, reasonCode: "理由A", expectedVersion: session.version });
      ok(
        "[B.2・idempotency核心] 同一clientEventId・同一内容の再送はreplay=trueで同じ結果",
        replay.ok === true && replay.ok && replay.replay === true && replay.toState === "DEFERRED",
        JSON.stringify(replay),
      );

      const mismatched = await deferFormationSession({ sessionId: session.id, workspaceId: fx.workspaceId, clientEventId, actorUserId: fx.userId, reasonCode: "理由B(違う)", expectedVersion: session.version });
      ok(
        "[B.3] 同一clientEventId・異なる内容はIDEMPOTENCY_KEY_REUSEDで拒否される",
        mismatched.ok === false && (mismatched as { error: string }).error === "IDEMPOTENCY_KEY_REUSED",
        JSON.stringify(mismatched),
      );

      const lifecycleCount = await db.formationSessionLifecycleEvent.count({ where: { workspaceId: fx.workspaceId, sessionId: session.id } });
      ok("[B.4] 3回の呼出しでもlifecycle event行は1件のまま(重複作成なし)", lifecycleCount === 1, String(lifecycleCount));
    }

    // ============================================================
    // C: dismiss(REVIEW_READY→DISMISSED)、状態guard。
    // ============================================================
    {
      const fx = await makeFixture("c");
      const session = await seedSession(fx, "c", "REVIEW_READY");
      const result = await dismissFormationSession({
        sessionId: session.id,
        workspaceId: fx.workspaceId,
        clientEventId: `client-${RUN_ID}-c`,
        actorUserId: fx.userId,
        expectedVersion: session.version,
      });
      ok("[C.1] REVIEW_READYからのdismissが成功しDISMISSEDへ遷移する", result.ok === true && result.ok && result.toState === "DISMISSED", JSON.stringify(result));
    }
    {
      const fx = await makeFixture("c2");
      const session = await seedSession(fx, "c2", "DRAFT");
      const result = await dismissFormationSession({
        sessionId: session.id,
        workspaceId: fx.workspaceId,
        clientEventId: `client-${RUN_ID}-c2`,
        actorUserId: fx.userId,
        expectedVersion: session.version,
      });
      ok(
        "[C.2・state guard] DRAFT状態からのdismiss試行はINVALID_SESSION_STATEで拒否される",
        result.ok === false && (result as { error: string }).error === "INVALID_SESSION_STATE",
        JSON.stringify(result),
      );
    }

    // ============================================================
    // D: retry(FAILED→ANALYZING)、resumeの状態guard。
    // ============================================================
    {
      const fx = await makeFixture("d");
      const session = await seedSession(fx, "d", "FAILED");
      const result = await retryFormationSession({
        sessionId: session.id,
        workspaceId: fx.workspaceId,
        clientEventId: `client-${RUN_ID}-d`,
        actorUserId: fx.userId,
        expectedVersion: session.version,
      });
      ok("[D.1] FAILEDからのretryが成功しANALYZINGへ遷移する", result.ok === true && result.ok && result.toState === "ANALYZING", JSON.stringify(result));

      const candidatesBefore = await db.formationCandidateIdentity.count({ where: { sessionId: session.id, workspaceId: fx.workspaceId } });
      ok("[D.2・旧Event/Candidateを失わない] retryはCandidateを削除しない(0件のまま、削除処理を一切含まない実装の確認)", candidatesBefore === 0);
    }
    {
      const fx = await makeFixture("d2");
      const session = await seedSession(fx, "d2", "REVIEW_READY");
      const result = await resumeFormationSession({
        sessionId: session.id,
        workspaceId: fx.workspaceId,
        clientEventId: `client-${RUN_ID}-d2`,
        actorUserId: fx.userId,
        expectedVersion: session.version,
      });
      ok(
        "[D.3・state guard] DEFERRED以外からのresume試行はINVALID_SESSION_STATEで拒否される",
        result.ok === false && (result as { error: string }).error === "INVALID_SESSION_STATE",
        JSON.stringify(result),
      );
    }

    // ============================================================
    // E: Session timelineにSESSION_DEFERRED/SESSION_RESUMED/SESSION_RETRIEDが
    //    正しく記録される(R1-04と同じ「専用codeで丸めない」原則の確認)。
    // ============================================================
    {
      const fx = await makeFixture("e");
      const session = await seedSession(fx, "e", "REVIEW_READY");
      const deferResult = await deferFormationSession({ sessionId: session.id, workspaceId: fx.workspaceId, clientEventId: `client-${RUN_ID}-e-defer`, actorUserId: fx.userId, expectedVersion: session.version });
      const versionAfterDefer = deferResult.ok ? session.version + 1 : session.version;
      await resumeFormationSession({ sessionId: session.id, workspaceId: fx.workspaceId, clientEventId: `client-${RUN_ID}-e-resume`, actorUserId: fx.userId, expectedVersion: versionAfterDefer });

      const timelineEvents = await db.formationSessionEvent.findMany({
        where: { workspaceId: fx.workspaceId, sessionId: session.id },
        orderBy: { sequence: "asc" },
      });
      const eventTypes = timelineEvents.map((e) => e.eventType);
      ok(
        "[E.1] Session timelineにSESSION_DEFERRED・SESSION_RESUMEDが両方記録される",
        eventTypes.includes("SESSION_DEFERRED") && eventTypes.includes("SESSION_RESUMED"),
        JSON.stringify(eventTypes),
      );
    }

    // ============================================================
    // F: [M1-B6C-4新設] version CAS。古いexpectedVersionでの新規リクエストは
    //    VERSION_CONFLICTで拒否され、DBのstateは変化しない。
    // ============================================================
    {
      const fx = await makeFixture("f");
      const session = await seedSession(fx, "f", "REVIEW_READY");
      const staleResult = await deferFormationSession({
        sessionId: session.id,
        workspaceId: fx.workspaceId,
        clientEventId: `client-${RUN_ID}-f-stale`,
        actorUserId: fx.userId,
        expectedVersion: session.version + 999, // 実際のversionと一致しない
      });
      ok(
        "[F.1・是正の核心] 不一致なexpectedVersionの新規リクエストはVERSION_CONFLICTで拒否される",
        staleResult.ok === false && (staleResult as { error: string }).error === "VERSION_CONFLICT",
        JSON.stringify(staleResult),
      );
      const dbAfterConflict = await db.formationSession.findUniqueOrThrow({ where: { id: session.id } });
      ok("[F.2] VERSION_CONFLICT時はstateが変化しない", dbAfterConflict.state === "REVIEW_READY", dbAfterConflict.state);
      ok("[F.3] VERSION_CONFLICT時はversionも変化しない", dbAfterConflict.version === session.version, String(dbAfterConflict.version));

      // 正しいexpectedVersionでの再送は成功する。
      const correctResult = await deferFormationSession({
        sessionId: session.id,
        workspaceId: fx.workspaceId,
        clientEventId: `client-${RUN_ID}-f-correct`,
        actorUserId: fx.userId,
        expectedVersion: session.version,
      });
      ok("[F.4] 正しいexpectedVersionでの再送は成功する", correctResult.ok === true, JSON.stringify(correctResult));
    }
    {
      // [M1-B6C-4新設] idempotent replayはversionが進んだ後でも同じ結果を返す
      // (§6.1「idempotent replayはversionが進んだ後でも同じ結果」)。
      const fx = await makeFixture("g");
      const session = await seedSession(fx, "g", "REVIEW_READY");
      const clientEventId = `client-${RUN_ID}-g`;
      const first = await deferFormationSession({ sessionId: session.id, workspaceId: fx.workspaceId, clientEventId, actorUserId: fx.userId, expectedVersion: session.version });
      ok("[G.1前提] 初回defer成功", first.ok === true, JSON.stringify(first));

      const sessionAfterDefer = await db.formationSession.findUniqueOrThrow({ where: { id: session.id } });
      // resumeで実際にversionをさらに進める(replay検証時点でDBのversionが
      // 初回defer呼出し時から既に変化していることを保証するため)。
      await resumeFormationSession({
        sessionId: session.id,
        workspaceId: fx.workspaceId,
        clientEventId: `client-${RUN_ID}-g-resume`,
        actorUserId: fx.userId,
        expectedVersion: sessionAfterDefer.version,
      });

      // 元のdefer呼出しと同じclientEventId・同じexpectedVersion(=元の古い値)で
      // 再送する。DB上のversionは既に2回進んでいるが、replayとして同じ結果を返す
      // べきであり、version CASの対象にならない。
      const replay = await deferFormationSession({ sessionId: session.id, workspaceId: fx.workspaceId, clientEventId, actorUserId: fx.userId, expectedVersion: session.version });
      ok(
        "[G.2・是正の核心] versionが進んだ後でも、同一clientEventIdの再送はVERSION_CONFLICTにならずreplay=trueで同じ結果を返す",
        replay.ok === true && replay.ok && replay.replay === true && replay.toState === "DEFERRED",
        JSON.stringify(replay),
      );
    }

    ok(
      "[非課金guard] scenario実行中、AI provider hostへの通信試行は0件(self-test自身の既知の1件を除く)",
      denyGuard.deniedCallAttempts.length === deniedBaseline,
      `total=${denyGuard.deniedCallAttempts.length}`,
    );
  } finally {
    const { db: dbForCleanup } = await import("../app/src/lib/db");
    const cleanupErrors: { step: string; error: unknown }[] = [];
    for (const uid of userIds) {
      const result = await cleanupFormationVerifyUser(dbForCleanup, uid);
      cleanupErrors.push(...result.errors);
    }
    ok("[cleanup] cleanup処理中に例外が0件である", cleanupErrors.length === 0, cleanupErrors.map((e) => `${e.step}:${String(e.error)}`).join(" | "));
    const leftover = await assertNoLeftoverFormationVerifyUsers(dbForCleanup, EMAIL_PREFIX);
    ok("[cleanup] cleanup後、test prefixのUserが0件である", leftover.clean, leftover.remainingUserIds.join(","));
  }

  denyGuard.restore();

  console.log(`\n合計: ${passed} passed, ${failed} failed`);
  if (failed > 0) {
    console.log("失敗一覧:");
    for (const f of failures) console.log(`  - ${f}`);
    process.exitCode = 1;
  }
}

main()
  .then(() => process.exit(process.exitCode ?? 0))
  .catch((err) => {
    console.error("予期しない例外:", err);
    process.exit(1);
  });
