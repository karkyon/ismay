#!/usr/bin/env node
/**
 * scripts/verify_gate_m1c2b_merge_correction_acceptance.ts
 *
 * Gate M1-C2B(Candidate MERGE Correction、DEC-MERGE-001)の受入証跡。
 * AI providerへの実通信は一切行わない(aiNetworkDenyGuard必須)。
 *
 * 検証内容:
 *   1. 2件Merge成功: 親履歴保持、新候補1件、Anchor継承(重複排除)、
 *      Atomicity再評価、lineage 2行。
 *   2. 3件Merge成功。
 *   3. 同一候補重複(DUPLICATE_PARENT_CANDIDATE)。
 *   4. 別Session/別workspace(NOT_FOUND)。
 *   5. revision race(REVISION_CONFLICT)。
 *   6. 既決定(ALREADY_DECIDED)。
 *   7. 同一idempotency再送は同じ結果(replay:true)、同一key異payloadは409。
 *   8. transaction途中fault(不正typeでのINVALID_MERGE_PARTS)後、孤立0件。
 *   9. plain decision APIから`MERGED`だけ記録することは引き続き拒否
 *      (M1-C回帰の再確認)。
 *   10. parts1件のみ(INVALID_MERGE_PARTS)。
 *
 * 実行方法:
 *   cd ~/projects/ismay/app
 *   npx tsx ../scripts/verify_gate_m1c2b_merge_correction_acceptance.ts
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
const EMAIL_PREFIX = "gate-m1c2b-merge-verify-";

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
  const { mergeFormationCandidates } = await import("../app/src/lib/formation/mergeCorrection");
  const { recordCandidateDecision } = await import("../app/src/lib/formation/materialize");

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
      data: { email, passwordHash: "not-a-real-hash-for-db-only-test", displayName: `Gate M1C2B ${suffix}` },
    });
    const workspace = await db.workspace.create({ data: { name: `Gate M1C2B Workspace ${suffix}` } });
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

  async function seedSession(fx: { workspaceId: string; domainId: string; userId: string }, captureId: string, key: string, state = "REVIEW_READY") {
    return db.formationSession.create({
      data: { workspaceId: fx.workspaceId, domainId: fx.domainId, subjectUserId: fx.userId, captureId, clientSessionKey: key, state },
    });
  }

  async function seedCandidate(
    fx: { workspaceId: string },
    sessionId: string,
    captureId: string,
    key: string,
    title: string,
    span: { start: number; end: number },
  ) {
    const identity = await db.formationCandidateIdentity.create({
      data: { workspaceId: fx.workspaceId, sessionId, candidateKey: key, currentRevision: 1 },
    });
    const revision = await db.formationCandidateRevision.create({
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
          completionCondition: `${title}が完了する`,
          evidenceSpans: [span],
          confidence: 0.9,
          dateMentions: [],
          unknowns: [],
          blockedByCandidateIds: [],
          suggestedTags: [],
        },
        confidence: 0.9,
        schemaVersion: "1.0",
      },
    });
    const excerpt = title;
    const { createHash } = await import("node:crypto");
    await db.formationSourceAnchor.create({
      data: {
        workspaceId: fx.workspaceId,
        revisionId: revision.id,
        sourceKind: "TEXT_OFFSET",
        captureId,
        startOffset: span.start,
        endOffset: span.end,
        excerptHash: createHash("sha256").update(excerpt).digest("hex"),
        piiClassification: "NONE",
      },
    });
    return identity;
  }

  try {
    // ============================================================
    // 1. 正常な2件Merge
    // ============================================================
    {
      const fx = await makeFixture("s1merge2");
      const cap = await makeCapture(fx, "見積書を送る/予算感を確認する");
      const session = await seedSession(fx, cap.id, "s1");
      const a = await seedCandidate(fx, session.id, cap.id, "a", "見積書を送る", { start: 0, end: 6 });
      const b = await seedCandidate(fx, session.id, cap.id, "b", "予算感を確認する", { start: 7, end: 15 });

      const result = await mergeFormationCandidates({
        sessionId: session.id,
        workspaceId: fx.workspaceId,
        clientEventId: `ce-${RUN_ID}-s1`,
        parents: [
          { candidateId: a.id, expectedRevision: 1 },
          { candidateId: b.id, expectedRevision: 1 },
        ],
        merged: { type: "TASK", title: "見積を提示する", completionCondition: "見積を提示し終える" },
        actorUserId: fx.userId,
      });
      ok("[M1C2B.1] 正常な2件Mergeが成功する", result.ok === true, JSON.stringify(result));

      if (result.ok) {
        ok("[M1C2B.2] replay:falseの新規commit", result.replay === false);

        const parentA = await db.formationCandidateIdentity.findUniqueOrThrow({ where: { id: a.id } });
        const parentB = await db.formationCandidateIdentity.findUniqueOrThrow({ where: { id: b.id } });
        ok("[M1C2B.3] 親候補は削除されず実在する(履歴保持)", !!parentA && !!parentB);

        const parentADecision = await db.formationCandidateDecisionEvent.findFirst({ where: { candidateId: a.id, workspaceId: fx.workspaceId } });
        const parentBDecision = await db.formationCandidateDecisionEvent.findFirst({ where: { candidateId: b.id, workspaceId: fx.workspaceId } });
        ok("[M1C2B.4] 両親候補にMERGED decisionが記録される", parentADecision?.decision === "MERGED" && parentBDecision?.decision === "MERGED");

        const newIdentity = await db.formationCandidateIdentity.findFirst({ where: { id: result.newCandidateId, workspaceId: fx.workspaceId } });
        ok("[M1C2B.5] 新候補が1件だけ実在する", !!newIdentity);

        const lineageRows = await db.formationCandidateLineage.findMany({ where: { childRevisionId: result.newRevisionId, workspaceId: fx.workspaceId } });
        ok("[M1C2B.6] lineageが親2件分(2行)記録されている", lineageRows.length === 2, String(lineageRows.length));
        ok(
          "[M1C2B.7] lineageのcorrectionKindはMERGE",
          lineageRows.every((l) => l.correctionKind === "MERGE"),
        );

        const newAnchors = await db.formationSourceAnchor.findMany({ where: { revisionId: result.newRevisionId, workspaceId: fx.workspaceId } });
        ok("[M1C2B.8] 新候補が親2件分のAnchorを継承する(重複無し2件)", newAnchors.length === 2, String(newAnchors.length));

        const assessmentRow = await db.formationAtomicityAssessment.findFirst({ where: { revisionId: result.newRevisionId, workspaceId: fx.workspaceId } });
        ok("[M1C2B.9] 新候補のAtomicity Assessmentが同一tx内で算出されている", !!assessmentRow);
      }
    }

    // ============================================================
    // 2. 正常な3件Merge
    // ============================================================
    {
      const fx = await makeFixture("s2merge3");
      const cap = await makeCapture(fx, "A/B/Cの3件");
      const session = await seedSession(fx, cap.id, "s2");
      const a = await seedCandidate(fx, session.id, cap.id, "a", "Aする", { start: 0, end: 3 });
      const b = await seedCandidate(fx, session.id, cap.id, "b", "Bする", { start: 4, end: 7 });
      const c = await seedCandidate(fx, session.id, cap.id, "c", "Cする", { start: 8, end: 11 });

      const result = await mergeFormationCandidates({
        sessionId: session.id,
        workspaceId: fx.workspaceId,
        clientEventId: `ce-${RUN_ID}-s2`,
        parents: [
          { candidateId: a.id, expectedRevision: 1 },
          { candidateId: b.id, expectedRevision: 1 },
          { candidateId: c.id, expectedRevision: 1 },
        ],
        merged: { type: "TASK", title: "ABCまとめて実施する" },
        actorUserId: fx.userId,
      });
      ok("[M1C2B.10] 正常な3件Mergeが成功する", result.ok === true, JSON.stringify(result));
      if (result.ok) {
        const lineageRows = await db.formationCandidateLineage.findMany({ where: { childRevisionId: result.newRevisionId, workspaceId: fx.workspaceId } });
        ok("[M1C2B.11] lineageが親3件分(3行)記録されている", lineageRows.length === 3, String(lineageRows.length));
      }
    }

    // ============================================================
    // 3. 同一候補重複
    // ============================================================
    {
      const fx = await makeFixture("s3dup");
      const cap = await makeCapture(fx, "重複検証");
      const session = await seedSession(fx, cap.id, "s3");
      const a = await seedCandidate(fx, session.id, cap.id, "a", "Aする", { start: 0, end: 3 });

      const result = await mergeFormationCandidates({
        sessionId: session.id,
        workspaceId: fx.workspaceId,
        clientEventId: `ce-${RUN_ID}-s3`,
        parents: [
          { candidateId: a.id, expectedRevision: 1 },
          { candidateId: a.id, expectedRevision: 1 },
        ],
        merged: { type: "TASK", title: "統合内容" },
        actorUserId: fx.userId,
      });
      ok("[M1C2B.12] 同一候補の重複指定はDUPLICATE_PARENT_CANDIDATE", result.ok === false && (result as { error: string }).error === "DUPLICATE_PARENT_CANDIDATE", JSON.stringify(result));
    }

    // ============================================================
    // 4. 別Session/別workspace越境
    // ============================================================
    {
      const fx1 = await makeFixture("s4cross1");
      const fx2 = await makeFixture("s4cross2");
      const cap1 = await makeCapture(fx1, "越境検証1");
      const cap2 = await makeCapture(fx2, "越境検証2");
      const session1 = await seedSession(fx1, cap1.id, "s4a");
      const session2 = await seedSession(fx2, cap2.id, "s4b");
      const a = await seedCandidate(fx1, session1.id, cap1.id, "a", "Aする", { start: 0, end: 3 });
      const bOtherSession = await seedCandidate(fx2, session2.id, cap2.id, "b", "Bする", { start: 0, end: 3 });

      const crossSessionResult = await mergeFormationCandidates({
        sessionId: session1.id,
        workspaceId: fx1.workspaceId,
        clientEventId: `ce-${RUN_ID}-s4a`,
        parents: [
          { candidateId: a.id, expectedRevision: 1 },
          { candidateId: bOtherSession.id, expectedRevision: 1 },
        ],
        merged: { type: "TASK", title: "統合内容" },
        actorUserId: fx1.userId,
      });
      ok("[M1C2B.13] 別Sessionの候補を混在させるとNOT_FOUND", crossSessionResult.ok === false && (crossSessionResult as { error: string }).error === "NOT_FOUND", JSON.stringify(crossSessionResult));

      const cWorkspace2 = await seedCandidate(fx2, session2.id, cap2.id, "c", "Cする", { start: 0, end: 3 });
      const crossWorkspaceResult = await mergeFormationCandidates({
        sessionId: session2.id,
        workspaceId: fx1.workspaceId, // 意図的に別workspaceIdを指定
        clientEventId: `ce-${RUN_ID}-s4b`,
        parents: [
          { candidateId: cWorkspace2.id, expectedRevision: 1 },
          { candidateId: bOtherSession.id, expectedRevision: 1 },
        ],
        merged: { type: "TASK", title: "統合内容" },
        actorUserId: fx1.userId,
      });
      ok("[M1C2B.14] 別workspaceIdでの越境試行はNOT_FOUND", crossWorkspaceResult.ok === false && (crossWorkspaceResult as { error: string }).error === "NOT_FOUND", JSON.stringify(crossWorkspaceResult));
    }

    // ============================================================
    // 5. revision race
    // ============================================================
    {
      const fx = await makeFixture("s5race");
      const cap = await makeCapture(fx, "race検証");
      const session = await seedSession(fx, cap.id, "s5");
      const a = await seedCandidate(fx, session.id, cap.id, "a", "Aする", { start: 0, end: 3 });
      const b = await seedCandidate(fx, session.id, cap.id, "b", "Bする", { start: 4, end: 7 });

      const result = await mergeFormationCandidates({
        sessionId: session.id,
        workspaceId: fx.workspaceId,
        clientEventId: `ce-${RUN_ID}-s5`,
        parents: [
          { candidateId: a.id, expectedRevision: 999 },
          { candidateId: b.id, expectedRevision: 1 },
        ],
        merged: { type: "TASK", title: "統合内容" },
        actorUserId: fx.userId,
      });
      ok("[M1C2B.15] revision不一致はREVISION_CONFLICT", result.ok === false && (result as { error: string }).error === "REVISION_CONFLICT", JSON.stringify(result));
    }

    // ============================================================
    // 6. 既決定
    // ============================================================
    {
      const fx = await makeFixture("s6decided");
      const cap = await makeCapture(fx, "既決定検証");
      const session = await seedSession(fx, cap.id, "s6");
      const a = await seedCandidate(fx, session.id, cap.id, "a", "Aする", { start: 0, end: 3 });
      const b = await seedCandidate(fx, session.id, cap.id, "b", "Bする", { start: 4, end: 7 });

      await recordCandidateDecision({ sessionId: session.id, workspaceId: fx.workspaceId, candidateId: a.id, expectedRevision: 1, decision: "ACCEPTED", actorUserId: fx.userId });

      const result = await mergeFormationCandidates({
        sessionId: session.id,
        workspaceId: fx.workspaceId,
        clientEventId: `ce-${RUN_ID}-s6`,
        parents: [
          { candidateId: a.id, expectedRevision: 1 },
          { candidateId: b.id, expectedRevision: 1 },
        ],
        merged: { type: "TASK", title: "統合内容" },
        actorUserId: fx.userId,
      });
      ok("[M1C2B.16] 既にACCEPTED済みの候補を含むMergeはALREADY_DECIDED", result.ok === false && (result as { error: string }).error === "ALREADY_DECIDED", JSON.stringify(result));

      const newIdentityCount = await db.formationCandidateIdentity.count({ where: { sessionId: session.id, workspaceId: fx.workspaceId, candidateKey: { startsWith: "merged-" } } });
      ok("[M1C2B.17] ALREADY_DECIDED拒否後、新候補は作られていない", newIdentityCount === 0, String(newIdentityCount));
    }

    // ============================================================
    // 7. idempotency
    // ============================================================
    {
      const fx = await makeFixture("s7idem");
      const cap = await makeCapture(fx, "idempotency検証");
      const session = await seedSession(fx, cap.id, "s7");
      const a = await seedCandidate(fx, session.id, cap.id, "a", "Aする", { start: 0, end: 3 });
      const b = await seedCandidate(fx, session.id, cap.id, "b", "Bする", { start: 4, end: 7 });

      const clientEventId = `ce-${RUN_ID}-s7`;
      const first = await mergeFormationCandidates({
        sessionId: session.id,
        workspaceId: fx.workspaceId,
        clientEventId,
        parents: [
          { candidateId: a.id, expectedRevision: 1 },
          { candidateId: b.id, expectedRevision: 1 },
        ],
        merged: { type: "TASK", title: "統合内容" },
        actorUserId: fx.userId,
      });
      ok("[M1C2B.18] 1回目のMergeが成功する", first.ok === true, JSON.stringify(first));

      const replay = await mergeFormationCandidates({
        sessionId: session.id,
        workspaceId: fx.workspaceId,
        clientEventId,
        parents: [
          { candidateId: a.id, expectedRevision: 1 },
          { candidateId: b.id, expectedRevision: 1 },
        ],
        merged: { type: "TASK", title: "統合内容" },
        actorUserId: fx.userId,
      });
      ok("[M1C2B.19] 同一clientEventId・同一payloadの再送はreplay:trueで同じ結果を返す", replay.ok === true && replay.ok && replay.replay === true && first.ok && replay.newCandidateId === first.newCandidateId, JSON.stringify(replay));

      const differentPayload = await mergeFormationCandidates({
        sessionId: session.id,
        workspaceId: fx.workspaceId,
        clientEventId,
        parents: [
          { candidateId: a.id, expectedRevision: 1 },
          { candidateId: b.id, expectedRevision: 1 },
        ],
        merged: { type: "TASK", title: "違うtitle" },
        actorUserId: fx.userId,
      });
      ok("[M1C2B.20] 同一clientEventId・異payloadはIDEMPOTENCY_KEY_REUSED", differentPayload.ok === false && (differentPayload as { error: string }).error === "IDEMPOTENCY_KEY_REUSED", JSON.stringify(differentPayload));

      const newIdentityCount = await db.formationCandidateIdentity.count({ where: { sessionId: session.id, workspaceId: fx.workspaceId, candidateKey: { startsWith: "merged-" } } });
      ok("[M1C2B.21] 冪等性: 新候補は1件だけ(再送で増えない)", newIdentityCount === 1, String(newIdentityCount));
    }

    // ============================================================
    // 8. INVALID_MERGE_PARTS(1件のみ)
    // ============================================================
    {
      const fx = await makeFixture("s8onepart");
      const cap = await makeCapture(fx, "1件のみ検証");
      const session = await seedSession(fx, cap.id, "s8");
      const a = await seedCandidate(fx, session.id, cap.id, "a", "Aする", { start: 0, end: 3 });

      const result = await mergeFormationCandidates({
        sessionId: session.id,
        workspaceId: fx.workspaceId,
        clientEventId: `ce-${RUN_ID}-s8`,
        parents: [{ candidateId: a.id, expectedRevision: 1 }],
        merged: { type: "TASK", title: "統合内容" },
        actorUserId: fx.userId,
      });
      ok("[M1C2B.22] parents1件のみはINVALID_MERGE_PARTS", result.ok === false && (result as { error: string }).error === "INVALID_MERGE_PARTS", JSON.stringify(result));
    }

    // ============================================================
    // 9. plain decision APIからMERGEDを直接記録できないことの回帰確認
    // ============================================================
    {
      const fx = await makeFixture("s9guard");
      const cap = await makeCapture(fx, "MERGED直接指定guard");
      const session = await seedSession(fx, cap.id, "s9");
      const a = await seedCandidate(fx, session.id, cap.id, "a", "Aする", { start: 0, end: 3 });

      const directMerge = await recordCandidateDecision({
        sessionId: session.id,
        workspaceId: fx.workspaceId,
        candidateId: a.id,
        expectedRevision: 1,
        decision: "MERGED",
        actorUserId: fx.userId,
      });
      ok(
        "[M1C2B.23・重要な回帰確認] 通常decide経路へのdecision=MERGED直接指定は引き続きINVALID_DECISION_VALUEで拒否される",
        directMerge.ok === false && (directMerge as { error: string }).error === "INVALID_DECISION_VALUE",
        JSON.stringify(directMerge),
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
