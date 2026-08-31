#!/usr/bin/env node
/**
 * scripts/verify_gate_m1c2a_state_semantics_and_atomicity_guard.ts
 *
 * Gate M1-C2A(DEC-STATE-001 + Atomicity Materialize Guard)の受入証跡。
 * AI providerへの実通信は一切行わない(aiNetworkDenyGuard必須)。
 *
 * 検証内容:
 *   1. ACCEPT decisionだけではSession状態はREVIEW_READYのまま(Responsibility 0件)。
 *   2. Materializeで一部だけ解決した場合だけPARTIALLY_CONFIRMED、Receipt Item>=1、pending>=1。
 *   3. 全解決時だけCONFIRMED。
 *   4. SHOULD_DECOMPOSEな候補(HARD_DEADLINE2件)はoverride無しでMaterialize拒否(ATOMICITY_BLOCKED)。
 *   5. overrideを記録した後は同じ候補がMaterialize成功する。
 *   6. OVERRIDE_NOT_APPLICABLE(既にATOMIC/PROBABLY_ATOMICな候補へのoverride試行)。
 *   7. NEEDS_CLARIFICATIONだが未解決質問が無い候補はMaterialize許可される
 *      (completionCondition欠落のみ、対応するFormationQuestionが無い直接seed)。
 *
 * 実行方法:
 *   cd ~/projects/ismay/app
 *   npx tsx ../scripts/verify_gate_m1c2a_state_semantics_and_atomicity_guard.ts
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
const EMAIL_PREFIX = "gate-m1c2a-verify-";

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
  const { recordCandidateDecision, materializeFormationSession } = await import("../app/src/lib/formation/materialize");
  const { recordAtomicityOverride } = await import("../app/src/lib/formation/atomicityOverride");

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
      data: { email, passwordHash: "not-a-real-hash-for-db-only-test", displayName: `Gate M1C2A ${suffix}` },
    });
    const workspace = await db.workspace.create({ data: { name: `Gate M1C2A Workspace ${suffix}` } });
    await db.workspaceMember.create({ data: { workspaceId: workspace.id, userId: user.id, role: "OWNER" } });
    const domain = await db.domain.create({ data: { workspaceId: workspace.id, name: "個人", kind: "PERSONAL" } });
    userIds.push(user.id);
    return { userId: user.id, workspaceId: workspace.id, domainId: domain.id };
  }

  async function makeCapture(fx: { workspaceId: string; domainId: string; userId: string }, rawText: string) {
    return db.capture.create({
      data: {
        workspaceId: fx.workspaceId,
        domainId: fx.domainId,
        createdById: fx.userId,
        sourceType: "TEXT",
        rawText,
        processingStatus: "READY",
      },
    });
  }

  async function seedSession(fx: { workspaceId: string; domainId: string; userId: string }, captureId: string, key: string) {
    return db.formationSession.create({
      data: { workspaceId: fx.workspaceId, domainId: fx.domainId, subjectUserId: fx.userId, captureId, clientSessionKey: key, state: "REVIEW_READY" },
    });
  }

  async function seedCandidate(
    fx: { workspaceId: string },
    sessionId: string,
    key: string,
    title: string,
    extra: Record<string, unknown> = {},
  ) {
    const identity = await db.formationCandidateIdentity.create({
      data: { workspaceId: fx.workspaceId, sessionId, candidateKey: key, currentRevision: 1 },
    });
    await db.formationCandidateRevision.create({
      data: {
        workspaceId: fx.workspaceId,
        candidateId: identity.id,
        revision: 1,
        type: "TASK",
        title,
        proposedFields: {
          candidateId: key,
          type: "TASK",
          title,
          evidenceSpans: [{ start: 0, end: 8 }],
          confidence: 0.9,
          dateMentions: [],
          unknowns: [],
          blockedByCandidateIds: [],
          suggestedTags: [],
          ...extra,
        },
        confidence: 0.9,
        schemaVersion: "1.0",
      },
    });
    return identity;
  }

  try {
    // ============================================================
    // 1〜3: 状態意味論(DEC-STATE-001)
    // ============================================================
    {
      const fx = await makeFixture("s1state");
      const cap = await makeCapture(fx, "A/B 2件のTASK");
      const session = await seedSession(fx, cap.id, "s1");
      const a = await seedCandidate(fx, session.id, "a", "Aを実施する", { completionCondition: "Aが完了する" });
      const b = await seedCandidate(fx, session.id, "b", "Bを実施する", { completionCondition: "Bが完了する" });

      const decA = await recordCandidateDecision({ sessionId: session.id, workspaceId: fx.workspaceId, candidateId: a.id, expectedRevision: 1, decision: "ACCEPTED", actorUserId: fx.userId });
      ok("[M1C2A.1] AのACCEPTが成功する", decA.ok === true);
      if (decA.ok) {
        ok(
          "[M1C2A.2・DEC-STATE-001の核心] ACCEPT直後もSession状態はREVIEW_READYのまま(Responsibility/Receipt作成なし)",
          decA.sessionState === "REVIEW_READY",
          decA.sessionState,
        );
      }
      const respCountAfterDecideOnly = await db.responsibility.count({ where: { originCaptureId: cap.id } });
      ok("[M1C2A.3] ACCEPT直後、Responsibilityは0件", respCountAfterDecideOnly === 0, String(respCountAfterDecideOnly));

      const sessionAfterDecide = await db.formationSession.findUniqueOrThrow({ where: { id: session.id } });
      const mat1 = await materializeFormationSession({
        sessionId: session.id,
        workspaceId: fx.workspaceId,
        operationId: `op-${RUN_ID}-s1-a`,
        expectedVersion: sessionAfterDecide.version,
        actorUserId: fx.userId,
      });
      ok("[M1C2A.4] Aのみmaterialize成功", mat1.ok === true && mat1.ok && mat1.items.length === 1, JSON.stringify(mat1));
      const sessionAfterMat1 = await db.formationSession.findUniqueOrThrow({ where: { id: session.id } });
      ok(
        "[M1C2A.5] Bが未決定のまま残るため、Materialize後だけSession=PARTIALLY_CONFIRMED",
        sessionAfterMat1.state === "PARTIALLY_CONFIRMED",
        sessionAfterMat1.state,
      );
      const receiptItemCount1 = await db.materializationReceiptItem.count({ where: { workspaceId: fx.workspaceId, candidateId: a.id } });
      ok("[M1C2A.6] PARTIALLY_CONFIRMED状態でReceipt Itemが実在する(>=1)", receiptItemCount1 >= 1, String(receiptItemCount1));

      const decB = await recordCandidateDecision({ sessionId: session.id, workspaceId: fx.workspaceId, candidateId: b.id, expectedRevision: 1, decision: "ACCEPTED", actorUserId: fx.userId });
      ok("[M1C2A.7] BのACCEPTも成功する(PARTIALLY_CONFIRMEDのSessionへの決定は許可される)", decB.ok === true, JSON.stringify(decB));
      if (decB.ok) {
        ok("[M1C2A.8] BのACCEPT後もSession状態はPARTIALLY_CONFIRMEDのまま(decideだけでは変わらない)", decB.sessionState === "PARTIALLY_CONFIRMED", decB.sessionState);
      }

      const sessionAfterDecideB = await db.formationSession.findUniqueOrThrow({ where: { id: session.id } });
      const mat2 = await materializeFormationSession({
        sessionId: session.id,
        workspaceId: fx.workspaceId,
        operationId: `op-${RUN_ID}-s1-b`,
        expectedVersion: sessionAfterDecideB.version,
        actorUserId: fx.userId,
      });
      ok("[M1C2A.9] Bのmaterializeも成功する", mat2.ok === true, JSON.stringify(mat2));
      const sessionAfterMat2 = await db.formationSession.findUniqueOrThrow({ where: { id: session.id } });
      ok("[M1C2A.10] 全候補解決後だけSession=CONFIRMED", sessionAfterMat2.state === "CONFIRMED", sessionAfterMat2.state);
    }

    // ============================================================
    // 4〜6: Atomicity Materialize Guard
    // ============================================================
    {
      const fx = await makeFixture("s2guard");
      const cap = await makeCapture(fx, "複数期限のTASK");
      const session = await seedSession(fx, cap.id, "s2");
      const decompose = await seedCandidate(fx, session.id, "c1", "複雑な作業", {
        completionCondition: "全て完了する",
        dateMentions: [
          { rawExpression: "来週", meaning: "HARD_DEADLINE", timezone: "Asia/Tokyo", confidence: 0.9 },
          { rawExpression: "月末", meaning: "HARD_DEADLINE", timezone: "Asia/Tokyo", confidence: 0.9 },
        ],
      });

      const dec = await recordCandidateDecision({ sessionId: session.id, workspaceId: fx.workspaceId, candidateId: decompose.id, expectedRevision: 1, decision: "ACCEPTED", actorUserId: fx.userId });
      ok("[M1C2A.11] SHOULD_DECOMPOSE候補もACCEPT自体は成功する(Guardはmaterialize時のみ)", dec.ok === true, JSON.stringify(dec));

      const sessionAfterDec = await db.formationSession.findUniqueOrThrow({ where: { id: session.id } });
      const blockedMat = await materializeFormationSession({
        sessionId: session.id,
        workspaceId: fx.workspaceId,
        operationId: `op-${RUN_ID}-s2-blocked`,
        expectedVersion: sessionAfterDec.version,
        actorUserId: fx.userId,
      });
      ok(
        "[M1C2A.12・Guard核心] SHOULD_DECOMPOSEな候補はoverride無しでMaterialize拒否(ATOMICITY_BLOCKED)",
        blockedMat.ok === false && (blockedMat as { error: string }).error === "ATOMICITY_BLOCKED",
        JSON.stringify(blockedMat),
      );
      const respCountAfterBlocked = await db.responsibility.count({ where: { originCaptureId: cap.id } });
      ok("[M1C2A.13] ATOMICITY_BLOCKED後もResponsibilityは0件(transaction全体がrollback)", respCountAfterBlocked === 0, String(respCountAfterBlocked));

      const notApplicable = await recordAtomicityOverride({
        sessionId: session.id,
        workspaceId: fx.workspaceId,
        candidateId: decompose.id,
        expectedRevision: 1,
        reasonCode: "TEST_OVERRIDE",
        actorUserId: fx.userId,
        clientEventId: `client-${RUN_ID}-s2-override`,
      });
      // decomposeはSHOULD_DECOMPOSEなのでOVERRIDE_NOT_APPLICABLEにはならない(次の別候補で検証する)
      ok("[M1C2A.14] SHOULD_DECOMPOSE候補へのoverride記録は成功する", notApplicable.ok === true, JSON.stringify(notApplicable));

      const sessionAfterOverride = await db.formationSession.findUniqueOrThrow({ where: { id: session.id } });
      const allowedMat = await materializeFormationSession({
        sessionId: session.id,
        workspaceId: fx.workspaceId,
        operationId: `op-${RUN_ID}-s2-allowed`,
        expectedVersion: sessionAfterOverride.version,
        actorUserId: fx.userId,
      });
      ok("[M1C2A.15・override核心] override後は同じ候補がMaterialize成功する", allowedMat.ok === true, JSON.stringify(allowedMat));

      // ---- ATOMIC候補へのoverride試行はOVERRIDE_NOT_APPLICABLE ----
      const fxAtomic = await makeFixture("s2atomic");
      const capAtomic = await makeCapture(fxAtomic, "単純TASK");
      const sessionAtomic = await seedSession(fxAtomic, capAtomic.id, "s2atomic");
      const atomicCandidate = await seedCandidate(fxAtomic, sessionAtomic.id, "c1", "単純な作業", { completionCondition: "完了する" });
      const overrideAtomic = await recordAtomicityOverride({
        sessionId: sessionAtomic.id,
        workspaceId: fxAtomic.workspaceId,
        candidateId: atomicCandidate.id,
        expectedRevision: 1,
        reasonCode: "TEST",
        actorUserId: fxAtomic.userId,
        clientEventId: `client-${RUN_ID}-s2atomic-override`,
      });
      ok(
        "[M1C2A.16] 既にATOMICな候補へのoverride試行はOVERRIDE_NOT_APPLICABLE",
        overrideAtomic.ok === false && (overrideAtomic as { error: string }).error === "OVERRIDE_NOT_APPLICABLE",
        JSON.stringify(overrideAtomic),
      );
    }

    // ============================================================
    // 7: NEEDS_CLARIFICATIONだが未解決質問が無い候補は許可される
    // ============================================================
    {
      const fx = await makeFixture("s3needsclar");
      const cap = await makeCapture(fx, "完了条件未確定のTASK");
      const session = await seedSession(fx, cap.id, "s3");
      // completionCondition欠落 = NEEDS_CLARIFICATION相当だが、直接seedのため
      // 対応するFormationQuestionは1件も無い(=未解決質問0件)。
      const candidate = await seedCandidate(fx, session.id, "c1", "完了条件不明な作業");

      const dec = await recordCandidateDecision({ sessionId: session.id, workspaceId: fx.workspaceId, candidateId: candidate.id, expectedRevision: 1, decision: "ACCEPTED", actorUserId: fx.userId });
      ok("[M1C2A.17] NEEDS_CLARIFICATION相当の候補もACCEPTは成功する", dec.ok === true);

      const sessionAfterDec = await db.formationSession.findUniqueOrThrow({ where: { id: session.id } });
      const mat = await materializeFormationSession({
        sessionId: session.id,
        workspaceId: fx.workspaceId,
        operationId: `op-${RUN_ID}-s3`,
        expectedVersion: sessionAfterDec.version,
        actorUserId: fx.userId,
      });
      ok(
        "[M1C2A.18] NEEDS_CLARIFICATIONでも未解決質問が0件ならMaterialize許可される",
        mat.ok === true,
        JSON.stringify(mat),
      );

      const assessmentRow = await db.formationAtomicityAssessment.findFirst({ where: { workspaceId: fx.workspaceId } });
      ok(
        "[M1C2A.19・自己修復の確認] 直接seedで未評価だった候補も、materialize時にAssessmentが自動算出・保存される",
        assessmentRow?.assessment === "NEEDS_CLARIFICATION",
        assessmentRow?.assessment,
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
