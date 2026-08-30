#!/usr/bin/env node
/**
 * scripts/verify_gate_m1c_split_correction_acceptance.ts
 *
 * Gate M1-C(Split Correction、統合正本§11.4)の受入証跡。
 * AI providerへの実通信は一切行わない(aiNetworkDenyGuard必須)。
 *
 * 対象:
 *   1. splitFormationCandidate(splitCorrection.ts): 正常な分解(2件以上のparts)。
 *      元候補にSPLIT decision、子候補群がRevision 1として生成され、それぞれに
 *      Atomicity Assessmentも算出されること。
 *   2. INVALID_SPLIT_PARTS(1件のみ・title空)。
 *   3. REVISION_CONFLICT・ALREADY_DECIDED・INVALID_SESSION_STATE。
 *   4. recordCandidateDecision(通常decide経路)がSPLIT/MERGEDを拒否すること
 *      (materialize.ts是正の回帰確認)。
 *   5. [2026-08-30追加・M1-C2C] formation_candidate_lineagesへの記録、実
 *      Source Anchorの子候補への継承。
 *   6. [2026-08-30追加・M1-C2C] 破損proposedFieldsはCORRUPTED_CANDIDATE_DATAで
 *      明示的に失敗すること(旧: 架空[0,1]のevidenceSpansで握りつぶしていた。
 *      さらに初回実装ではparseチェックの位置がdecisionEvent書き込みの後にあり、
 *      「失敗を返したのにdecisionEventだけcommitされる」不整合を実機検証で
 *      検出・是正した)。
 *   5. 分解後、子候補は通常のACCEPT/REJECTの対象として扱えること
 *      (Question Policy再評価を経由しない設計の確認)。
 *
 * 実行方法:
 *   cd ~/projects/ismay/app
 *   npx tsx ../scripts/verify_gate_m1c_split_correction_acceptance.ts
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
const EMAIL_PREFIX = "gate-m1c-split-verify-";

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
  const { splitFormationCandidate } = await import("../app/src/lib/formation/splitCorrection");
  const { recordCandidateDecision } = await import("../app/src/lib/formation/materialize");

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

  const userIds: string[] = [];

  async function makeFixture(suffix: string) {
    const email = `${EMAIL_PREFIX}${RUN_ID}-${suffix}@example.invalid`;
    const user = await db.user.create({
      data: { email, passwordHash: "not-a-real-hash-for-db-only-test", displayName: `Gate M1C Split ${suffix}` },
    });
    const workspace = await db.workspace.create({ data: { name: `Gate M1C Split Workspace ${suffix}` } });
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

  async function seedReviewReadySession(fx: { workspaceId: string; domainId: string; userId: string }, captureId: string, key: string) {
    return db.formationSession.create({
      data: { workspaceId: fx.workspaceId, domainId: fx.domainId, subjectUserId: fx.userId, captureId, clientSessionKey: key, state: "REVIEW_READY" },
    });
  }

  async function seedCandidate(fx: { workspaceId: string }, sessionId: string, key: string, title: string) {
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
        },
        confidence: 0.9,
        schemaVersion: "1.0",
      },
    });
    return identity;
  }

  try {
    // ============================================================
    // 1. 正常な分解(2 parts)
    // ============================================================
    let splitCandidateId = "";
    let splitSessionId = "";
    {
      const fx = await makeFixture("s1split");
      const cap = await makeCapture(fx, "見積画面を完成させる");
      const session = await seedReviewReadySession(fx, cap.id, "s1");
      const identity = await seedCandidate(fx, session.id, "c1", "見積画面を完成させる");

      const result = await splitFormationCandidate({
        sessionId: session.id,
        workspaceId: fx.workspaceId,
        candidateId: identity.id,
        expectedRevision: 1,
        parts: [
          { type: "TASK", title: "見積明細の税計算を実装する" },
          { type: "TASK", title: "見積書PDFのレイアウトを確認する" },
        ],
        actorUserId: fx.userId,
      });
      ok("[M1C.1] 正常な分解(2 parts)が成功する", result.ok === true, JSON.stringify(result));
      if (result.ok) {
        ok("[M1C.2] newCandidatesが2件返る", result.newCandidates.length === 2, String(result.newCandidates.length));
      }

      const decisionEvent = await db.formationCandidateDecisionEvent.findFirst({ where: { candidateId: identity.id, workspaceId: fx.workspaceId } });
      ok("[M1C.3] 元候補にSPLIT decisionが記録される", decisionEvent?.decision === "SPLIT", decisionEvent?.decision);

      const childIdentities = await db.formationCandidateIdentity.findMany({ where: { sessionId: session.id, workspaceId: fx.workspaceId, candidateKey: { startsWith: "c1-split-" } } });
      ok("[M1C.4] DB上に子候補2件が実在する", childIdentities.length === 2, String(childIdentities.length));

      for (const child of childIdentities) {
        const childRevision = await db.formationCandidateRevision.findFirst({ where: { candidateId: child.id, workspaceId: fx.workspaceId, revision: 1 } });
        ok(`[M1C.5・${child.candidateKey}] 子候補のRevision confidenceが1(本人確定)`, childRevision ? Number(childRevision.confidence) === 1 : false);
        const childAssessment = childRevision
          ? await db.formationAtomicityAssessment.findFirst({ where: { revisionId: childRevision.id, workspaceId: fx.workspaceId } })
          : null;
        ok(`[M1C.6・${child.candidateKey}] 子候補にAtomicity Assessmentが算出されている`, childAssessment !== null);
      }

      // ---- 分解後、子候補は通常のACCEPT対象として扱える ----
      const firstChild = childIdentities[0];
      const acceptResult = await recordCandidateDecision({
        sessionId: session.id,
        workspaceId: fx.workspaceId,
        candidateId: firstChild.id,
        expectedRevision: 1,
        decision: "ACCEPTED",
        actorUserId: fx.userId,
      });
      ok("[M1C.7] 分解後、子候補は通常のACCEPT対象として扱える(Question Policy再評価なし)", acceptResult.ok === true, JSON.stringify(acceptResult));

      // ---- 元候補は既にSPLIT決定済みのため、再度decideできない ----
      const reDecide = await recordCandidateDecision({
        sessionId: session.id,
        workspaceId: fx.workspaceId,
        candidateId: identity.id,
        expectedRevision: 1,
        decision: "ACCEPTED",
        actorUserId: fx.userId,
      });
      ok("[M1C.8] SPLIT済みの元候補への再decideはALREADY_DECIDED", reDecide.ok === false && (reDecide as { error: string }).error === "ALREADY_DECIDED", JSON.stringify(reDecide));
    }

    // ============================================================
    // 2. INVALID_SPLIT_PARTS(1件のみ)
    // ============================================================
    {
      const fx = await makeFixture("s2onepart");
      const cap = await makeCapture(fx, "1件だけで分解を試みる");
      const session = await seedReviewReadySession(fx, cap.id, "s2");
      const identity = await seedCandidate(fx, session.id, "c1", "何かの作業");

      const result = await splitFormationCandidate({
        sessionId: session.id,
        workspaceId: fx.workspaceId,
        candidateId: identity.id,
        expectedRevision: 1,
        parts: [{ type: "TASK", title: "唯一の部分" }],
        actorUserId: fx.userId,
      });
      ok("[M1C.9] parts1件のみはINVALID_SPLIT_PARTS", result.ok === false && (result as { error: string }).error === "INVALID_SPLIT_PARTS", JSON.stringify(result));

      const decisionEventCount = await db.formationCandidateDecisionEvent.count({ where: { candidateId: identity.id, workspaceId: fx.workspaceId } });
      ok("[M1C.10] INVALID_SPLIT_PARTS拒否後、Decision Eventは作られない", decisionEventCount === 0, String(decisionEventCount));
    }

    // ============================================================
    // 3. REVISION_CONFLICT / ALREADY_DECIDED / INVALID_SESSION_STATE
    // ============================================================
    {
      const fx = await makeFixture("s3conflicts");
      const cap = await makeCapture(fx, "競合系の検証");
      const session = await seedReviewReadySession(fx, cap.id, "s3");
      const identity = await seedCandidate(fx, session.id, "c1", "対象作業");

      const wrongRevision = await splitFormationCandidate({
        sessionId: session.id,
        workspaceId: fx.workspaceId,
        candidateId: identity.id,
        expectedRevision: 999,
        parts: [
          { type: "TASK", title: "A" },
          { type: "TASK", title: "B" },
        ],
        actorUserId: fx.userId,
      });
      ok("[M1C.11] 誤ったexpectedRevisionはREVISION_CONFLICT", wrongRevision.ok === false && (wrongRevision as { error: string }).error === "REVISION_CONFLICT", JSON.stringify(wrongRevision));

      // 先にACCEPTしてからSPLITを試みる -> ALREADY_DECIDED
      await recordCandidateDecision({ sessionId: session.id, workspaceId: fx.workspaceId, candidateId: identity.id, expectedRevision: 1, decision: "ACCEPTED", actorUserId: fx.userId });
      const afterAccept = await splitFormationCandidate({
        sessionId: session.id,
        workspaceId: fx.workspaceId,
        candidateId: identity.id,
        expectedRevision: 1,
        parts: [
          { type: "TASK", title: "A" },
          { type: "TASK", title: "B" },
        ],
        actorUserId: fx.userId,
      });
      ok("[M1C.12] 既にACCEPTED済みの候補へのSPLIT試行はALREADY_DECIDED", afterAccept.ok === false && (afterAccept as { error: string }).error === "ALREADY_DECIDED", JSON.stringify(afterAccept));

      // DRAFT状態のSessionへのSPLIT試行
      const cap2 = await makeCapture(fx, "DRAFT session");
      const draftSession = await db.formationSession.create({
        data: { workspaceId: fx.workspaceId, domainId: fx.domainId, subjectUserId: fx.userId, captureId: cap2.id, clientSessionKey: "s3-draft", state: "DRAFT" },
      });
      const draftIdentity = await seedCandidate(fx, draftSession.id, "c2", "DRAFT中の候補");
      const draftSplit = await splitFormationCandidate({
        sessionId: draftSession.id,
        workspaceId: fx.workspaceId,
        candidateId: draftIdentity.id,
        expectedRevision: 1,
        parts: [
          { type: "TASK", title: "A" },
          { type: "TASK", title: "B" },
        ],
        actorUserId: fx.userId,
      });
      ok("[M1C.13] DRAFT状態のSessionへのSPLIT試行はINVALID_SESSION_STATE", draftSplit.ok === false && (draftSplit as { error: string }).error === "INVALID_SESSION_STATE", JSON.stringify(draftSplit));
    }

    // ============================================================
    // 4. recordCandidateDecisionがSPLIT/MERGEDを直接受理しないことの回帰確認
    // ============================================================
    {
      const fx = await makeFixture("s4guardsplit");
      const cap = await makeCapture(fx, "SPLIT直接指定のguard確認");
      const session = await seedReviewReadySession(fx, cap.id, "s4");
      const identity = await seedCandidate(fx, session.id, "c1", "対象作業");

      const directSplit = await recordCandidateDecision({
        sessionId: session.id,
        workspaceId: fx.workspaceId,
        candidateId: identity.id,
        expectedRevision: 1,
        decision: "SPLIT",
        actorUserId: fx.userId,
      });
      ok(
        "[M1C.14・重要な回帰確認] 通常decide経路へのdecision=SPLIT直接指定はINVALID_DECISION_VALUEで拒否される(splitCorrection.ts専用経路の強制)",
        directSplit.ok === false && (directSplit as { error: string }).error === "INVALID_DECISION_VALUE",
        JSON.stringify(directSplit),
      );

      const directMerge = await recordCandidateDecision({
        sessionId: session.id,
        workspaceId: fx.workspaceId,
        candidateId: identity.id,
        expectedRevision: 1,
        decision: "MERGED",
        actorUserId: fx.userId,
      });
      ok(
        "[M1C.15] 通常decide経路へのdecision=MERGED直接指定もINVALID_DECISION_VALUEで拒否される",
        directMerge.ok === false && (directMerge as { error: string }).error === "INVALID_DECISION_VALUE",
        JSON.stringify(directMerge),
      );

      const decisionEventCount = await db.formationCandidateDecisionEvent.count({ where: { candidateId: identity.id, workspaceId: fx.workspaceId } });
      ok("[M1C.16] guardで拒否された結果、Decision Eventは0件のまま", decisionEventCount === 0, String(decisionEventCount));
    }

    // ============================================================
    // 5. [2026-08-30新設・M1-C2C] Splitの正本整合
    //    (formation_candidate_lineages記録、実Source Anchor継承、
    //    架空evidenceSpans fallback廃止)
    // ============================================================
    {
      const fx = await makeFixture("s5lineageanchor");
      const cap = await makeCapture(fx, "見積書を作って送付する作業");
      const session = await seedReviewReadySession(fx, cap.id, "s5");
      const identity = await seedCandidate(fx, session.id, "c1", "見積書を作って送付する");

      // 親candidateへ実Source Anchorを1件付与する(既存seedCandidateは
      // Anchorを作らないため、この検証用に追加で作成する)。
      const parentRevision = await db.formationCandidateRevision.findFirstOrThrow({
        where: { candidateId: identity.id, workspaceId: fx.workspaceId, revision: 1 },
      });
      const { createHash } = await import("node:crypto");
      await db.formationSourceAnchor.create({
        data: {
          workspaceId: fx.workspaceId,
          revisionId: parentRevision.id,
          sourceKind: "TEXT_OFFSET",
          captureId: cap.id,
          startOffset: 0,
          endOffset: 8,
          excerptHash: createHash("sha256").update("見積書を作って送付する").digest("hex"),
          piiClassification: "NONE",
        },
      });

      const result = await splitFormationCandidate({
        sessionId: session.id,
        workspaceId: fx.workspaceId,
        candidateId: identity.id,
        expectedRevision: 1,
        parts: [
          { type: "TASK", title: "見積書を作る" },
          { type: "TASK", title: "見積書を送付する" },
        ],
        actorUserId: fx.userId,
      });
      ok("[M1C2C.1] Anchor有り親候補の分解が成功する", result.ok === true, JSON.stringify(result));

      if (result.ok) {
        const lineageRows = await db.formationCandidateLineage.findMany({
          where: { parentIdentityId: identity.id, workspaceId: fx.workspaceId },
        });
        ok("[M1C2C.2・DBで照会可能なlineage] formation_candidate_lineagesに子2件分が記録される", lineageRows.length === 2, String(lineageRows.length));
        ok("[M1C2C.3] lineageのcorrectionKindはSPLIT", lineageRows.every((l) => l.correctionKind === "SPLIT"));
        ok(
          "[M1C2C.4] lineageのparentRevisionIdが分解時点の親Revisionを指す",
          lineageRows.every((l) => l.parentRevisionId === parentRevision.id),
        );

        for (const child of result.newCandidates) {
          const childAnchors = await db.formationSourceAnchor.findMany({
            where: { revisionId: child.revisionId, workspaceId: fx.workspaceId },
          });
          ok(`[M1C2C.5・${child.candidateKey}] 子候補が親の実Source Anchorを継承する(1件)`, childAnchors.length === 1, String(childAnchors.length));
        }
      }
    }

    // ============================================================
    // 6. [2026-08-30新設・M1-C2C] 破損proposedFieldsはCORRUPTED_CANDIDATE_DATA
    //    (架空evidenceSpans fallbackで握りつぶさない。かつdecisionEventが
    //    一切commitされないこと=正しいtransaction順序の確認)
    // ============================================================
    {
      const fx = await makeFixture("s6corrupted");
      const cap = await makeCapture(fx, "破損データ検証");
      const session = await seedReviewReadySession(fx, cap.id, "s6");
      const identity = await db.formationCandidateIdentity.create({
        data: { workspaceId: fx.workspaceId, sessionId: session.id, candidateKey: "c1", currentRevision: 1 },
      });
      // 意図的にResponsibilityCandidateSchemaへparseできない壊れたproposedFieldsを
      // 直接書き込む(evidenceSpans自体が欠落している)。
      await db.formationCandidateRevision.create({
        data: {
          workspaceId: fx.workspaceId,
          candidateId: identity.id,
          revision: 1,
          type: "TASK",
          title: "破損データの候補",
          proposedFields: { candidateId: "c1", type: "TASK", title: "破損データの候補" },
          confidence: 0.9,
          schemaVersion: "1.0",
        },
      });

      const result = await splitFormationCandidate({
        sessionId: session.id,
        workspaceId: fx.workspaceId,
        candidateId: identity.id,
        expectedRevision: 1,
        parts: [
          { type: "TASK", title: "A" },
          { type: "TASK", title: "B" },
        ],
        actorUserId: fx.userId,
      });
      ok(
        "[M1C2C.6・重要な是正確認] 破損proposedFieldsはCORRUPTED_CANDIDATE_DATAで明示的に失敗する(旧: 架空[0,1]で握りつぶしていた)",
        result.ok === false && (result as { error: string }).error === "CORRUPTED_CANDIDATE_DATA",
        JSON.stringify(result),
      );

      const childCount = await db.formationCandidateIdentity.count({
        where: { sessionId: session.id, workspaceId: fx.workspaceId, candidateKey: { startsWith: "c1-split-" } },
      });
      ok("[M1C2C.7] CORRUPTED_CANDIDATE_DATA後、子候補は作られていない", childCount === 0, String(childCount));

      const decisionEventCount = await db.formationCandidateDecisionEvent.count({ where: { candidateId: identity.id, workspaceId: fx.workspaceId } });
      ok(
        "[M1C2C.8・transaction順序是正の確認] CORRUPTED_CANDIDATE_DATA後、元候補にもSPLIT decisionは記録されていない(parseチェックを書き込み前へ移動した是正の裏付け)",
        decisionEventCount === 0,
        String(decisionEventCount),
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
