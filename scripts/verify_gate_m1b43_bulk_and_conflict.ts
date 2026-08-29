#!/usr/bin/env node
/**
 * scripts/verify_gate_m1b43_bulk_and_conflict.ts
 *
 * Gate M1-B4.3(HANDOFF_2026-08-29_B4.1_B4.2.md §4の残課題1〜3への対応)の受入証跡。
 * AI providerへの実通信は一切行わない(aiNetworkDenyGuard必須、DI stub必須)。
 *
 * 対象:
 *   1. Materialize/Finalizeボタンの動作確認 -> UIのクリック操作そのものは
 *      本scriptの対象外(ブラウザ操作はomega-dev2実機で目視確認する必要がある)
 *      が、その裏にあるサーバ側ロジック(bulk ACCEPTした候補がmaterializeで
 *      実際にResponsibility行として生成されること)をDBレベルで確証する。
 *   2. Bulk ACCEPT/REJECT: `recordCandidateDecisionsBulk`(materialize.ts新設)。
 *   3. legacy/Formation競合表示: `computeCandidateConflict`
 *      (legacyProjectionResolver.ts新設)。
 *
 * 実行方法:
 *   cd ~/projects/ismay/app
 *   npx tsx ../scripts/verify_gate_m1b43_bulk_and_conflict.ts
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
const EMAIL_PREFIX = "gate-m1b43-verify-";

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
  const { recordCandidateDecision, recordCandidateDecisionsBulk, materializeFormationSession } = await import(
    "../app/src/lib/formation/materialize"
  );
  const { computeCandidateConflict } = await import("../app/src/lib/formation/legacyProjectionResolver");

  const orphans = await db.user.findMany({
    where: { email: { startsWith: EMAIL_PREFIX, endsWith: "@example.invalid" } },
    select: { id: true },
  });
  if (orphans.length > 0) {
    console.log(`[SWEEP] 過去実行の孤立テストユーザー${orphans.length}件を削除します...`);
    for (const o of orphans) {
      const result = await cleanupFormationVerifyUser(db, o.id);
      if (result.errors.length > 0) {
        console.log(`  [SWEEP] userId=${o.id} cleanup中に例外: ${result.errors.map((e) => e.step).join(",")}`);
      }
    }
  }

  const embedStub = async () => ({ ok: true as const });
  const stubbedDeps = { embedAndStoreResponsibility: embedStub };
  const materialize = (params: Parameters<typeof materializeFormationSession>[0]) =>
    materializeFormationSession(params, stubbedDeps);

  const userIds: string[] = [];

  async function makeFixture(suffix: string) {
    const email = `${EMAIL_PREFIX}${RUN_ID}-${suffix}@example.invalid`;
    const user = await db.user.create({
      data: { email, passwordHash: "not-a-real-hash-for-db-only-test", displayName: `Gate M1B43 ${suffix}` },
    });
    const workspace = await db.workspace.create({ data: { name: `Gate M1B43 Workspace ${suffix}` } });
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

  async function seedFormationSession(
    fx: { workspaceId: string; domainId: string; userId: string },
    captureId: string,
    clientSessionKey: string,
  ) {
    return db.formationSession.create({
      data: { workspaceId: fx.workspaceId, domainId: fx.domainId, subjectUserId: fx.userId, captureId, clientSessionKey, state: "REVIEW_READY" },
    });
  }

  async function seedCandidate(fx: { workspaceId: string }, sessionId: string, key: string, title: string) {
    const identity = await db.formationCandidateIdentity.create({
      data: { workspaceId: fx.workspaceId, sessionId, candidateKey: key, currentRevision: 1 },
    });
    await db.formationCandidateRevision.create({
      data: {
        workspaceId: fx.workspaceId, candidateId: identity.id, revision: 1, type: "TASK", title,
        proposedFields: { candidateId: key, type: "TASK", title, evidenceSpans: [{ start: 0, end: 4 }], confidence: 0.9, dateMentions: [], unknowns: [], blockedByCandidateIds: [], suggestedTags: [] },
        confidence: 0.9, schemaVersion: "1.0",
      },
    });
    return identity;
  }

  try {
    // ============================================================
    // 1. Bulk ACCEPT/REJECT(受入項目9)
    // ============================================================
    const fx1 = await makeFixture("s1bulk");
    const cap1 = await makeCapture(fx1, "A/B/Cをまとめて処理する");
    const session1 = await seedFormationSession(fx1, cap1.id, "s1");
    const candA = await seedCandidate(fx1, session1.id, "A", "Aを実施する");
    const candB = await seedCandidate(fx1, session1.id, "B", "Bを実施する");
    const candC = await seedCandidate(fx1, session1.id, "C", "Cを却下する");

    const bulk1 = await recordCandidateDecisionsBulk({
      sessionId: session1.id,
      workspaceId: fx1.workspaceId,
      actorUserId: fx1.userId,
      items: [
        { candidateId: candA.id, expectedRevision: 1, decision: "ACCEPTED" },
        { candidateId: candB.id, expectedRevision: 1, decision: "ACCEPTED" },
        { candidateId: candC.id, expectedRevision: 1, decision: "REJECTED" },
      ],
    });
    ok(
      "[B4.3.1] bulk-decisionsが3件とも成功する(A ACCEPTED / B ACCEPTED / C REJECTED)",
      bulk1.length === 3 && bulk1.every((r) => r.result.ok === true),
      JSON.stringify(bulk1.map((r) => ({ candidateId: r.candidateId, ok: r.result.ok }))),
    );

    // ------------------------------------------------------------
    // 1a. Materialize/Finalizeの動作確認(受入項目1の裏付け):
    // bulk ACCEPTした候補が、materializeで実際にResponsibility行として
    // 生成されることをDBレベルで確証する(ブラウザ上のクリック確認自体は
    // omega-dev2実機での目視が必要、本scriptはサーバ側ロジックの証跡)。
    // ------------------------------------------------------------
    const session1v1 = await db.formationSession.findUniqueOrThrow({ where: { id: session1.id } });
    const mat1 = await materialize({
      sessionId: session1.id,
      workspaceId: fx1.workspaceId,
      operationId: "op-b43-s1",
      expectedVersion: session1v1.version,
      actorUserId: fx1.userId,
    });
    ok(
      "[B4.3.1・受入項目1裏付け] bulk ACCEPTした2件(A,B)がmaterializeで実際に2件のResponsibilityとして生成される",
      mat1.ok === true && mat1.items.length === 2,
      JSON.stringify(mat1),
    );
    if (mat1.ok) {
      const responsibilityIds = mat1.items.map((i) => i.responsibilityId);
      const createdResponsibilities = await db.responsibility.findMany({
        where: { id: { in: responsibilityIds }, workspaceId: fx1.workspaceId },
      });
      ok(
        "[B4.3.1・受入項目1裏付け] 生成されたResponsibility行がDBに実在し、titleがそれぞれA/Bの候補titleと一致する",
        createdResponsibilities.length === 2 &&
          createdResponsibilities.some((r) => r.title === "Aを実施する") &&
          createdResponsibilities.some((r) => r.title === "Bを実施する"),
        JSON.stringify(createdResponsibilities.map((r) => r.title)),
      );
    }
    const session1v2 = await db.formationSession.findUniqueOrThrow({ where: { id: session1.id } });
    ok("[B4.3.1] 全候補決定済み・materialize済みでSession=CONFIRMEDへ遷移する", session1v2.state === "CONFIRMED", session1v2.state);

    // ------------------------------------------------------------
    // 1b. bulk内の部分失敗(revision不一致1件を混在させる)
    // ------------------------------------------------------------
    const fx2 = await makeFixture("s2partialfail");
    const cap2 = await makeCapture(fx2, "D/Eの一部だけ失敗させる");
    const session2 = await seedFormationSession(fx2, cap2.id, "s2");
    const candD = await seedCandidate(fx2, session2.id, "D", "Dを実施する");
    const candE = await seedCandidate(fx2, session2.id, "E", "Eを実施する");

    const bulk2 = await recordCandidateDecisionsBulk({
      sessionId: session2.id,
      workspaceId: fx2.workspaceId,
      actorUserId: fx2.userId,
      items: [
        { candidateId: candD.id, expectedRevision: 1, decision: "ACCEPTED" },
        { candidateId: candE.id, expectedRevision: 999, decision: "ACCEPTED" }, // 意図的に不正なrevision
      ],
    });
    const dResult2 = bulk2.find((r) => r.candidateId === candD.id);
    const eResult2 = bulk2.find((r) => r.candidateId === candE.id);
    ok(
      "[B4.3.2] bulk内の1件がrevision不一致でも、他の正常な候補は独立して成功する(all-or-nothingではない)",
      dResult2?.result.ok === true && eResult2?.result.ok === false && eResult2?.result.error === "REVISION_CONFLICT",
      JSON.stringify({ d: dResult2?.result, e: eResult2?.result }),
    );

    // ------------------------------------------------------------
    // 1c. bulk内で同一candidateIdを2回指定(順序依存の挙動を正直に検証)
    // ------------------------------------------------------------
    const fx3 = await makeFixture("s3dup");
    const cap3 = await makeCapture(fx3, "Fを二重指定する");
    const session3 = await seedFormationSession(fx3, cap3.id, "s3");
    const candF = await seedCandidate(fx3, session3.id, "F", "Fを実施する");
    const bulk3 = await recordCandidateDecisionsBulk({
      sessionId: session3.id,
      workspaceId: fx3.workspaceId,
      actorUserId: fx3.userId,
      items: [
        { candidateId: candF.id, expectedRevision: 1, decision: "ACCEPTED" },
        { candidateId: candF.id, expectedRevision: 1, decision: "ACCEPTED" },
      ],
    });
    ok(
      "[B4.3.3] 同一candidateIdをbulk内で2回指定すると、1回目は成功・2回目はALREADY_DECIDEDになる(順番に処理する設計通り)",
      bulk3[0]?.result.ok === true && bulk3[1]?.result.ok === false && bulk3[1]?.result.error === "ALREADY_DECIDED",
      JSON.stringify(bulk3.map((r) => r.result)),
    );

    // ============================================================
    // 2. legacy/Formation競合検出(受入項目6、computeCandidateConflict)
    // ============================================================
    ok(
      "[B4.3.4] legacyEntryが無ければconflictは無い",
      computeCandidateConflict({ legacyEntry: null, formationDecision: { decision: "ACCEPTED" } }) === null,
    );
    ok(
      "[B4.3.5] legacy ACCEPTED・Responsibilityあり・Formation決定なし: conflictなし",
      computeCandidateConflict({
        legacyEntry: { decision: "ACCEPTED", responsibilityId: "resp-1" },
        formationDecision: null,
      }) === null,
    );
    ok(
      "[B4.3.6] legacy ACCEPTEDなのにResponsibilityが無い(破損): LEGACY_PROJECTION_CONFLICT(Formation決定の有無に関わらず最優先)",
      computeCandidateConflict({
        legacyEntry: { decision: "ACCEPTED", responsibilityId: null },
        formationDecision: { decision: "REJECTED" },
      }) === "LEGACY_PROJECTION_CONFLICT",
    );
    ok(
      "[B4.3.7・受入項目6の核心] legacy ACCEPTED(Responsibilityあり)なのにFormationがREJECTED: DECISION_MISMATCH",
      computeCandidateConflict({
        legacyEntry: { decision: "ACCEPTED", responsibilityId: "resp-2" },
        formationDecision: { decision: "REJECTED" },
      }) === "DECISION_MISMATCH",
    );
    ok(
      "[B4.3.8・受入項目6の核心] legacy REJECTEDなのにFormationがACCEPTED: DECISION_MISMATCH",
      computeCandidateConflict({
        legacyEntry: { decision: "REJECTED", responsibilityId: null },
        formationDecision: { decision: "ACCEPTED" },
      }) === "DECISION_MISMATCH",
    );
    ok(
      "[B4.3.9] legacy PENDING・Formation ACCEPTED: 両立する状態のためconflictなし(3.3節でFormation側決定を許可する対象そのもの)",
      computeCandidateConflict({
        legacyEntry: { decision: "PENDING", responsibilityId: null },
        formationDecision: { decision: "ACCEPTED" },
      }) === null,
    );
    ok(
      "[B4.3.10] legacy ACCEPTED(Responsibilityあり)・Formation ACCEPTED: 意味が一致するためconflictなし",
      computeCandidateConflict({
        legacyEntry: { decision: "ACCEPTED", responsibilityId: "resp-3" },
        formationDecision: { decision: "ACCEPTED" },
      }) === null,
    );

    // recordCandidateDecision自体が既存guard(ALREADY_DECIDED_BY_LEGACY等)で
    // legacy REJECTED/HELD後のFormation ACCEPTEDを未然に止めることの再確認
    // (=本番運用ではDECISION_MISMATCHへ到達する経路はcutover guard導入前の
    // 残存データ等に限られる、という設計上の位置づけを裏付ける)。
    const fx4 = await makeFixture("s4guardstillblocks");
    const cap4 = await makeCapture(fx4, "guardが先に止める確認");
    const aiRun4 = await db.aiRun.create({
      data: { captureId: cap4.id, provider: "anthropic", model: "claude-haiku-4-5-20251001", promptVersion: "test", schemaVersion: "1.0", status: "SUCCEEDED" },
    });
    await db.aiInference.create({
      data: {
        captureId: cap4.id, aiRunId: aiRun4.id, inferenceType: "RESPONSIBILITY",
        evidenceSpans: [{ start: 0, end: 4 }], decision: "REJECTED",
        payload: { candidateId: "G", type: "TASK", title: "Gを実施する", evidenceSpans: [{ start: 0, end: 4 }], confidence: 0.9, dateMentions: [], unknowns: [], blockedByCandidateIds: [], suggestedTags: [] },
        confidence: 0.9,
      },
    });
    const session4 = await db.formationSession.create({
      data: { workspaceId: fx4.workspaceId, domainId: fx4.domainId, subjectUserId: fx4.userId, captureId: cap4.id, clientSessionKey: "s4", state: "REVIEW_READY" },
    });
    await db.formationSessionEvent.create({
      data: { workspaceId: fx4.workspaceId, sessionId: session4.id, sequence: 1, eventType: "ANALYSIS_REQUESTED", actorType: "SYSTEM", payload: { aiRunId: aiRun4.id } },
    });
    const candG = await seedCandidate(fx4, session4.id, "G", "Gを実施する");
    const guardedResult = await recordCandidateDecision({
      sessionId: session4.id, workspaceId: fx4.workspaceId, candidateId: candG.id, expectedRevision: 1, decision: "ACCEPTED", actorUserId: fx4.userId,
    });
    ok(
      "[B4.3.11] legacy REJECTED済みの候補へFormation ACCEPTEDを試みると、既存guardがALREADY_DECIDED_BY_LEGACYで先に止める(DECISION_MISMATCHという状態そのものが新規には作られない設計であることの確認)",
      guardedResult.ok === false && guardedResult.error === "ALREADY_DECIDED_BY_LEGACY",
      JSON.stringify(guardedResult),
    );

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
    ok("[cleanup] cleanup処理中に例外が0件である", cleanupErrors.length === 0, cleanupErrors.map((e) => e.step).join(","));
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
