#!/usr/bin/env node
/**
 * scripts/verify_gate_r1_audit_remediation.ts
 *
 * Gate R1(監査是正)のうち、このPatchで是正したR1-01(Merge架空Evidence廃止)・
 * R1-02(Atomicity Override fail-closed/idempotency)の非課金DB受入証跡。
 * 出典: Claude向け ISMAY 69b5a87以降 監査是正・M1-B6完遂・PEM-0連続実装指示
 *       (2026-08-31) §3 Gate R1。
 *
 * R1-03(DB不変条件)・R1-04(Event語彙)・R1-05(PII UNCLASSIFIED)はこのPatchの
 * 対象外(次のPatchで扱う)。
 *
 * AI providerへの実通信は一切行わない(aiNetworkDenyGuard必須)。
 *
 * 実行方法:
 *   cd ~/projects/ismay/app
 *   npx tsx ../scripts/verify_gate_r1_audit_remediation.ts
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
const EMAIL_PREFIX = "gate-r1-verify-";

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
  const { recordCandidateDecision } = await import("../app/src/lib/formation/materialize");
  const { recordAtomicityOverride } = await import("../app/src/lib/formation/atomicityOverride");
  const { mergeFormationCandidates } = await import("../app/src/lib/formation/mergeCorrection");
  const { splitFormationCandidate } = await import("../app/src/lib/formation/splitCorrection");

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
      data: { email, passwordHash: "not-a-real-hash-for-db-only-test", displayName: `Gate R1 ${suffix}` },
    });
    const workspace = await db.workspace.create({ data: { name: `Gate R1 Workspace ${suffix}` } });
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

  async function seedSession(
    fx: { workspaceId: string; domainId: string; userId: string },
    captureId: string,
    key: string,
    state: string = "REVIEW_READY",
  ) {
    return db.formationSession.create({
      data: { workspaceId: fx.workspaceId, domainId: fx.domainId, subjectUserId: fx.userId, captureId, clientSessionKey: key, state },
    });
  }

  async function seedValidCandidate(
    fx: { workspaceId: string },
    sessionId: string,
    key: string,
    title: string,
    extra: Record<string, unknown> = {},
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
    return { identity, revision };
  }

  /** [R1-01/R1-02の核心fixture] ResponsibilityCandidateSchemaでparse不能な
   * proposedFieldsを持つRevisionを直接seedする(想像上のbugではなく、実際に
   * DB上でparse不能な行が存在し得ることの再現。旧経路データ・手動投入・
   * 将来のschema変更等)。*/
  async function seedCorruptedCandidate(fx: { workspaceId: string }, sessionId: string, key: string) {
    const identity = await db.formationCandidateIdentity.create({
      data: { workspaceId: fx.workspaceId, sessionId, candidateKey: key, currentRevision: 1 },
    });
    const revision = await db.formationCandidateRevision.create({
      data: {
        workspaceId: fx.workspaceId,
        candidateId: identity.id,
        revision: 1,
        type: "TASK",
        title: "壊れた候補",
        // [意図的] evidenceSpans/dateMentions等の必須fieldを欠落させ、
        // ResponsibilityCandidateSchema.safeParseが必ず失敗するJSONにする。
        proposedFields: { garbage: true, nested: { x: 1 } },
        confidence: 0.5,
        schemaVersion: "1.0",
      },
    });
    return { identity, revision };
  }

  try {
    // ============================================================
    // R1-02.A: parse失敗はCORRUPTED_CANDIDATE_DATAへ拒否され、PROBABLY_ATOMIC
    //          フォールバック行を作らない(是正前の中核バグ)。
    // ============================================================
    {
      const fx = await makeFixture("r102a");
      const cap = await makeCapture(fx, "壊れたproposedFieldsのTASK");
      const session = await seedSession(fx, cap.id, "r102a");
      const { identity } = await seedCorruptedCandidate(fx, session.id, "c1");

      const result = await recordAtomicityOverride({
        sessionId: session.id,
        workspaceId: fx.workspaceId,
        candidateId: identity.id,
        expectedRevision: 1,
        reasonCode: "TEST",
        actorUserId: fx.userId,
        clientEventId: `client-${RUN_ID}-r102a`,
      });
      ok(
        "[R1-02.1・是正の核心] parse不能な候補へのoverrideはCORRUPTED_CANDIDATE_DATAで拒否される(PROBABLY_ATOMICへ倒さない)",
        result.ok === false && (result as { error: string }).error === "CORRUPTED_CANDIDATE_DATA",
        JSON.stringify(result),
      );

      const assessmentCount = await db.formationAtomicityAssessment.count({ where: { workspaceId: fx.workspaceId } });
      ok(
        "[R1-02.2] 拒否後、誤ったFormationAtomicityAssessment行(PROBABLY_ATOMIC/PARSE_FAILED_FALLBACK)が1件も作られない",
        assessmentCount === 0,
        String(assessmentCount),
      );
      const overrideCount = await db.formationAtomicityOverride.count({ where: { workspaceId: fx.workspaceId } });
      ok("[R1-02.3] 拒否後、FormationAtomicityOverride行が1件も作られない", overrideCount === 0, String(overrideCount));
    }

    // ============================================================
    // R1-02.B: clientEventId idempotency(同一key・同一内容は再送安全、
    //          内容が違えばIDEMPOTENCY_KEY_REUSED)。
    // ============================================================
    {
      const fx = await makeFixture("r102b");
      const cap = await makeCapture(fx, "複数期限のTASK");
      const session = await seedSession(fx, cap.id, "r102b");
      const { identity } = await seedValidCandidate(fx, session.id, "c1", "複雑な作業", {
        completionCondition: "全て完了する",
        dateMentions: [
          { rawExpression: "来週", meaning: "HARD_DEADLINE", timezone: "Asia/Tokyo", confidence: 0.9 },
          { rawExpression: "月末", meaning: "HARD_DEADLINE", timezone: "Asia/Tokyo", confidence: 0.9 },
        ],
      });
      const clientEventId = `client-${RUN_ID}-r102b`;

      const first = await recordAtomicityOverride({
        sessionId: session.id,
        workspaceId: fx.workspaceId,
        candidateId: identity.id,
        expectedRevision: 1,
        reasonCode: "REASON_A",
        actorUserId: fx.userId,
        clientEventId,
      });
      ok("[R1-02.4] 初回override成功(replay=false)", first.ok === true && first.ok && first.replay === false, JSON.stringify(first));

      const replay = await recordAtomicityOverride({
        sessionId: session.id,
        workspaceId: fx.workspaceId,
        candidateId: identity.id,
        expectedRevision: 1,
        reasonCode: "REASON_A",
        actorUserId: fx.userId,
        clientEventId,
      });
      ok(
        "[R1-02.5・idempotency核心] 同一clientEventId・同一内容の再送は同じoverrideIdをreplay=trueで返す",
        replay.ok === true && first.ok === true && replay.ok && first.ok && replay.overrideId === first.overrideId && replay.replay === true,
        JSON.stringify(replay),
      );

      const mismatched = await recordAtomicityOverride({
        sessionId: session.id,
        workspaceId: fx.workspaceId,
        candidateId: identity.id,
        expectedRevision: 1,
        reasonCode: "REASON_B_DIFFERENT",
        actorUserId: fx.userId,
        clientEventId,
      });
      ok(
        "[R1-02.6] 同一clientEventId・異なる内容(reasonCode違い)はIDEMPOTENCY_KEY_REUSEDで拒否される",
        mismatched.ok === false && (mismatched as { error: string }).error === "IDEMPOTENCY_KEY_REUSED",
        JSON.stringify(mismatched),
      );

      const overrideRowCount = await db.formationAtomicityOverride.count({ where: { workspaceId: fx.workspaceId } });
      ok("[R1-02.7] 3回の呼出しでもFormationAtomicityOverride行は1件のまま(重複作成なし)", overrideRowCount === 1, String(overrideRowCount));
    }

    // ============================================================
    // R1-02.C: Session state guard(DRAFT/CLARIFYING等はINVALID_SESSION_STATE)。
    // ============================================================
    {
      const fx = await makeFixture("r102c");
      const cap = await makeCapture(fx, "未完了SessionのTASK");
      const session = await seedSession(fx, cap.id, "r102c", "CLARIFYING");
      const { identity } = await seedValidCandidate(fx, session.id, "c1", "単純な作業", { completionCondition: "完了する" });

      const result = await recordAtomicityOverride({
        sessionId: session.id,
        workspaceId: fx.workspaceId,
        candidateId: identity.id,
        expectedRevision: 1,
        reasonCode: "TEST",
        actorUserId: fx.userId,
        clientEventId: `client-${RUN_ID}-r102c`,
      });
      ok(
        "[R1-02.8新設] CLARIFYING状態のSessionへのoverride試行はINVALID_SESSION_STATEで拒否される",
        result.ok === false && (result as { error: string; sessionState?: string }).error === "INVALID_SESSION_STATE",
        JSON.stringify(result),
      );
    }

    // ============================================================
    // R1-02.D: reasonCode空白禁止・ALREADY_DECIDED guard。
    // ============================================================
    {
      const fx = await makeFixture("r102d");
      const cap = await makeCapture(fx, "決定済みTASK");
      const session = await seedSession(fx, cap.id, "r102d");
      const { identity } = await seedValidCandidate(fx, session.id, "c1", "単純な作業", { completionCondition: "完了する" });

      const blank = await recordAtomicityOverride({
        sessionId: session.id,
        workspaceId: fx.workspaceId,
        candidateId: identity.id,
        expectedRevision: 1,
        reasonCode: "   ",
        actorUserId: fx.userId,
        clientEventId: `client-${RUN_ID}-r102d-blank`,
      });
      ok(
        "[R1-02.9新設] 空白のみのreasonCodeはINVALID_REASON_CODEで拒否される",
        blank.ok === false && (blank as { error: string }).error === "INVALID_REASON_CODE",
        JSON.stringify(blank),
      );

      // [実機検証で発覚(2026-08-31)・是正] ACCEPTED決定はoverrideの前提条件
      // であり拒否理由ではない(verify_gate_m1c2a M1C2A.11「SHOULD_DECOMPOSE
      // 候補もACCEPT自体は成功する(Guardはmaterialize時のみ)」と同じ正規flow)。
      // ATOMICな候補をACCEPTした後のoverride試行はOVERRIDE_NOT_APPLICABLE
      // (ACCEPTEDそのものではALREADY_DECIDEDにならない)。
      const decision = await recordCandidateDecision({
        sessionId: session.id,
        workspaceId: fx.workspaceId,
        candidateId: identity.id,
        expectedRevision: 1,
        decision: "ACCEPTED",
        actorUserId: fx.userId,
      });
      ok("[R1-02.10前提] 候補のACCEPT自体は成功する", decision.ok === true, JSON.stringify(decision));

      const afterAccepted = await recordAtomicityOverride({
        sessionId: session.id,
        workspaceId: fx.workspaceId,
        candidateId: identity.id,
        expectedRevision: 1,
        reasonCode: "TEST",
        actorUserId: fx.userId,
        clientEventId: `client-${RUN_ID}-r102d-accepted`,
      });
      ok(
        "[R1-02.11是正・回帰確認の核心] ACCEPTED決定済みでもoverride試行はALREADY_DECIDEDにならない(ACCEPT→override→materializeが正規flow)",
        !(afterAccepted.ok === false && (afterAccepted as { error: string }).error === "ALREADY_DECIDED"),
        JSON.stringify(afterAccepted),
      );
      ok(
        "[R1-02.12] このcandidateはATOMICのためOVERRIDE_NOT_APPLICABLEが返る",
        afterAccepted.ok === false && (afterAccepted as { error: string; assessment?: string }).error === "OVERRIDE_NOT_APPLICABLE",
        JSON.stringify(afterAccepted),
      );
    }

    // ============================================================
    // R1-02.E: REJECTED等、ACCEPTED以外の確定的決定はALREADY_DECIDEDで拒否
    //          (ACCEPTEDのみoverride前提として許容する境界の確認)。
    // ============================================================
    {
      const fx = await makeFixture("r102e");
      const cap = await makeCapture(fx, "却下済みTASK");
      const session = await seedSession(fx, cap.id, "r102e");
      const { identity } = await seedValidCandidate(fx, session.id, "c1", "不要な作業", { completionCondition: "完了する" });

      const rejected = await recordCandidateDecision({
        sessionId: session.id,
        workspaceId: fx.workspaceId,
        candidateId: identity.id,
        expectedRevision: 1,
        decision: "REJECTED",
        actorUserId: fx.userId,
      });
      ok("[R1-02.13前提] 候補のREJECTは成功する", rejected.ok === true, JSON.stringify(rejected));

      const afterRejected = await recordAtomicityOverride({
        sessionId: session.id,
        workspaceId: fx.workspaceId,
        candidateId: identity.id,
        expectedRevision: 1,
        reasonCode: "TEST",
        actorUserId: fx.userId,
        clientEventId: `client-${RUN_ID}-r102e-rejected`,
      });
      ok(
        "[R1-02.14新設] REJECTED決定済みの候補へのoverride試行はALREADY_DECIDED(existingDecision=REJECTED)で拒否される",
        afterRejected.ok === false &&
          (afterRejected as { error: string; existingDecision?: string }).error === "ALREADY_DECIDED" &&
          (afterRejected as { existingDecision?: string }).existingDecision === "REJECTED",
        JSON.stringify(afterRejected),
      );
    }

    // ============================================================
    // R1-01.A: Merge時、親の1件がparse不能ならCORRUPTED_CANDIDATE_DATAで拒否され、
    //          DecisionEvent/Identity/Revision/lineage/MergeEventが1件も残らない
    //          (fault test)。
    // ============================================================
    {
      const fx = await makeFixture("r101a");
      const cap = await makeCapture(fx, "A(正常)/B(破損) 2件のTASK");
      const session = await seedSession(fx, cap.id, "r101a");
      const good = await seedValidCandidate(fx, session.id, "a", "Aを実施する", { completionCondition: "Aが完了する" });
      const corrupted = await seedCorruptedCandidate(fx, session.id, "b");

      const beforeDecisionEvents = await db.formationCandidateDecisionEvent.count({ where: { workspaceId: fx.workspaceId } });
      const beforeIdentities = await db.formationCandidateIdentity.count({ where: { workspaceId: fx.workspaceId } });
      const beforeLineages = await db.formationCandidateLineage.count({ where: { workspaceId: fx.workspaceId } });
      const beforeMergeEvents = await db.formationCandidateMergeEvent.count({ where: { workspaceId: fx.workspaceId } });

      const result = await mergeFormationCandidates({
        sessionId: session.id,
        workspaceId: fx.workspaceId,
        clientEventId: `client-${RUN_ID}-r101a`,
        parents: [
          { candidateId: good.identity.id, expectedRevision: 1 },
          { candidateId: corrupted.identity.id, expectedRevision: 1 },
        ],
        merged: { type: "TASK", title: "統合後のタイトル", completionCondition: "統合後完了" },
        actorUserId: fx.userId,
      });
      ok(
        "[R1-01.1・是正の核心] 親の1件がparse不能ならMergeはCORRUPTED_CANDIDATE_DATAで拒否される(架空Evidence[0,1]を生成しない)",
        result.ok === false && (result as { error: string }).error === "CORRUPTED_CANDIDATE_DATA",
        JSON.stringify(result),
      );

      const afterDecisionEvents = await db.formationCandidateDecisionEvent.count({ where: { workspaceId: fx.workspaceId } });
      const afterIdentities = await db.formationCandidateIdentity.count({ where: { workspaceId: fx.workspaceId } });
      const afterLineages = await db.formationCandidateLineage.count({ where: { workspaceId: fx.workspaceId } });
      const afterMergeEvents = await db.formationCandidateMergeEvent.count({ where: { workspaceId: fx.workspaceId } });

      ok(
        "[R1-01.2・fault test] 拒否後、新しいDecisionEventが1件も増えていない(親2件のDecisionEventも含め0件のまま)",
        afterDecisionEvents === beforeDecisionEvents,
        `before=${beforeDecisionEvents} after=${afterDecisionEvents}`,
      );
      ok(
        "[R1-01.3・fault test] 拒否後、新しいCandidateIdentity(統合後候補)が作られていない",
        afterIdentities === beforeIdentities,
        `before=${beforeIdentities} after=${afterIdentities}`,
      );
      ok(
        "[R1-01.4・fault test] 拒否後、FormationCandidateLineageが1件も作られていない",
        afterLineages === beforeLineages,
        `before=${beforeLineages} after=${afterLineages}`,
      );
      ok(
        "[R1-01.5・fault test] 拒否後、FormationCandidateMergeEventが1件も作られていない",
        afterMergeEvents === beforeMergeEvents,
        `before=${beforeMergeEvents} after=${afterMergeEvents}`,
      );
    }

    // ============================================================
    // R1-01.B: 正常系Merge(全親parse成功)は実Evidenceを引き継ぎ、
    //          架空値[{start:0,end:1}]を含まない(回帰確認)。
    // ============================================================
    {
      const fx = await makeFixture("r101b");
      const cap = await makeCapture(fx, "A/B 2件の正常TASK");
      const session = await seedSession(fx, cap.id, "r101b");
      const a = await seedValidCandidate(fx, session.id, "a", "Aを実施する", {
        completionCondition: "Aが完了する",
        evidenceSpans: [{ start: 10, end: 25 }],
      });
      const b = await seedValidCandidate(fx, session.id, "b", "Bを実施する", {
        completionCondition: "Bが完了する",
        evidenceSpans: [{ start: 30, end: 45 }],
      });

      const result = await mergeFormationCandidates({
        sessionId: session.id,
        workspaceId: fx.workspaceId,
        clientEventId: `client-${RUN_ID}-r101b`,
        parents: [
          { candidateId: a.identity.id, expectedRevision: 1 },
          { candidateId: b.identity.id, expectedRevision: 1 },
        ],
        merged: { type: "TASK", title: "統合後のタイトル2", completionCondition: "統合後完了2" },
        actorUserId: fx.userId,
      });
      ok("[R1-01.6] 正常系Mergeは成功する", result.ok === true, JSON.stringify(result));

      if (result.ok) {
        const newRevision = await db.formationCandidateRevision.findUniqueOrThrow({ where: { id: result.newRevisionId } });
        const proposed = newRevision.proposedFields as { evidenceSpans?: { start: number; end: number }[] };
        const spans = proposed.evidenceSpans ?? [];
        ok(
          "[R1-01.7・回帰確認] 統合後候補のevidenceSpansは架空値[{start:0,end:1}]ではなく親の実evidenceを引き継ぐ",
          spans.length > 0 && !(spans.length === 1 && spans[0].start === 0 && spans[0].end === 1),
          JSON.stringify(spans),
        );
        const isRealParentSpan = spans.some((s) => (s.start === 10 && s.end === 25) || (s.start === 30 && s.end === 45));
        ok("[R1-01.8] evidenceSpansは実在する親(A or B)のevidenceと一致する", isRealParentSpan, JSON.stringify(spans));
      }
    }

    // ============================================================
    // R1-03.A: newCandidateKeyがrequestHash由来で安定・Session内衝突しない
    //          (以前は先頭3候補名連結だったため、異なる構成の別Mergeで
    //          衝突し得た)。
    // ============================================================
    {
      const fx = await makeFixture("r103a");
      const cap = await makeCapture(fx, "同じ先頭候補名を持つ2組のMerge");
      const session = await seedSession(fx, cap.id, "r103a");
      const a1 = await seedValidCandidate(fx, session.id, "same", "同名候補群1のA");
      const b1 = await seedValidCandidate(fx, session.id, "same-b1", "同名候補群1のB");
      const a2 = await seedValidCandidate(fx, session.id, "same2", "同名候補群2のA");
      const b2 = await seedValidCandidate(fx, session.id, "same2-b2", "同名候補群2のB");

      const merge1 = await mergeFormationCandidates({
        sessionId: session.id,
        workspaceId: fx.workspaceId,
        clientEventId: `client-${RUN_ID}-r103a-1`,
        parents: [
          { candidateId: a1.identity.id, expectedRevision: 1 },
          { candidateId: b1.identity.id, expectedRevision: 1 },
        ],
        merged: { type: "TASK", title: "統合1" },
        actorUserId: fx.userId,
      });
      const merge2 = await mergeFormationCandidates({
        sessionId: session.id,
        workspaceId: fx.workspaceId,
        clientEventId: `client-${RUN_ID}-r103a-2`,
        parents: [
          { candidateId: a2.identity.id, expectedRevision: 1 },
          { candidateId: b2.identity.id, expectedRevision: 1 },
        ],
        merged: { type: "TASK", title: "統合2" },
        actorUserId: fx.userId,
      });
      ok("[R1-03.1前提] 1件目のMergeが成功する", merge1.ok === true, JSON.stringify(merge1));
      ok(
        "[R1-03.2・是正の核心] 同一Session内の別Merge操作が異なるnewCandidateKeyを持つ(先頭3候補名連結による衝突が解消)",
        merge2.ok === true && merge1.ok === true && merge2.ok && merge1.ok && merge2.newCandidateKey !== merge1.newCandidateKey,
        JSON.stringify({ merge1, merge2 }),
      );
      if (merge1.ok) {
        ok("[R1-03.3] newCandidateKeyはrequestHash由来のprefixを持つ", merge1.newCandidateKey.startsWith("merged-"), merge1.newCandidateKey);
      }
    }

    // ============================================================
    // R1-03.B: Anchor dedupe keyがcaptureId/imageRegionを含む
    //          (異なるCaptureの同一offset範囲を誤って同一視しない)。
    // ============================================================
    {
      const fx = await makeFixture("r103b");
      const capA = await makeCapture(fx, "CaptureA: 同じoffset範囲のテキスト");
      const capB = await makeCapture(fx, "CaptureB: 同じoffset範囲のテキスト");
      const session = await seedSession(fx, capA.id, "r103b");

      async function seedCandidateWithAnchor(key: string, title: string, captureId: string) {
        const { identity, revision } = await seedValidCandidate(fx, session.id, key, title);
        await db.formationSourceAnchor.create({
          data: {
            workspaceId: fx.workspaceId,
            revisionId: revision.id,
            sourceKind: "TEXT_OFFSET",
            captureId,
            startOffset: 0,
            endOffset: 8,
            excerptHash: "same-excerpt-hash-for-test",
            piiClassification: "NONE",
          },
        });
        return identity;
      }

      const a = await seedCandidateWithAnchor("a", "A(CaptureA由来)", capA.id);
      const b = await seedCandidateWithAnchor("b", "B(CaptureB由来・同じoffset/hash)", capB.id);

      const result = await mergeFormationCandidates({
        sessionId: session.id,
        workspaceId: fx.workspaceId,
        clientEventId: `client-${RUN_ID}-r103b`,
        parents: [
          { candidateId: a.id, expectedRevision: 1 },
          { candidateId: b.id, expectedRevision: 1 },
        ],
        merged: { type: "TASK", title: "統合後" },
        actorUserId: fx.userId,
      });
      ok("[R1-03.4前提] Mergeが成功する", result.ok === true, JSON.stringify(result));
      if (result.ok) {
        const inheritedAnchors = await db.formationSourceAnchor.count({ where: { revisionId: result.newRevisionId, workspaceId: fx.workspaceId } });
        ok(
          "[R1-03.5・是正の核心] captureIdが異なる2件のAnchor(offset/hashは偶然同一)は誤って重複排除されず両方継承される",
          inheritedAnchors === 2,
          String(inheritedAnchors),
        );
      }
    }

    // ============================================================
    // R1-04.A: SPLIT/MERGED決定がSession timeline上で専用code(CANDIDATE_SPLIT/
    //          CANDIDATE_MERGED)として記録される(以前はCANDIDATE_DEFERREDへ
    //          丸められていた)。
    // ============================================================
    {
      const fx = await makeFixture("r104a");
      const cap = await makeCapture(fx, "分解対象TASK");
      const session = await seedSession(fx, cap.id, "r104a");
      const { identity } = await seedValidCandidate(fx, session.id, "c1", "複合作業", { completionCondition: "全て完了する" });

      const splitResult = await splitFormationCandidate({
        sessionId: session.id,
        workspaceId: fx.workspaceId,
        candidateId: identity.id,
        expectedRevision: 1,
        parts: [
          { type: "TASK", title: "部分1", completionCondition: "部分1が完了する" },
          { type: "TASK", title: "部分2", completionCondition: "部分2が完了する" },
        ],
        actorUserId: fx.userId,
      });
      ok("[R1-04.1前提] Splitが成功する", splitResult.ok === true, JSON.stringify(splitResult));

      const splitEvent = await db.formationSessionEvent.findFirst({
        where: { workspaceId: fx.workspaceId, sessionId: session.id, eventType: { in: ["CANDIDATE_SPLIT", "CANDIDATE_DEFERRED"] } },
        orderBy: { sequence: "desc" },
      });
      ok(
        "[R1-04.2・是正の核心] SPLIT決定のSession EventはCANDIDATE_SPLIT(CANDIDATE_DEFERREDへ丸められない)",
        splitEvent?.eventType === "CANDIDATE_SPLIT",
        JSON.stringify(splitEvent),
      );
    }

    {
      const fx = await makeFixture("r104b");
      const cap = await makeCapture(fx, "統合対象TASK2件");
      const session = await seedSession(fx, cap.id, "r104b");
      const a = await seedValidCandidate(fx, session.id, "a", "Aを実施する", { completionCondition: "Aが完了する" });
      const b = await seedValidCandidate(fx, session.id, "b", "Bを実施する", { completionCondition: "Bが完了する" });

      const mergeResult = await mergeFormationCandidates({
        sessionId: session.id,
        workspaceId: fx.workspaceId,
        clientEventId: `client-${RUN_ID}-r104b`,
        parents: [
          { candidateId: a.identity.id, expectedRevision: 1 },
          { candidateId: b.identity.id, expectedRevision: 1 },
        ],
        merged: { type: "TASK", title: "統合後" },
        actorUserId: fx.userId,
      });
      ok("[R1-04.3前提] Mergeが成功する", mergeResult.ok === true, JSON.stringify(mergeResult));

      const mergeEvent = await db.formationSessionEvent.findFirst({
        where: { workspaceId: fx.workspaceId, sessionId: session.id, eventType: { in: ["CANDIDATE_MERGED", "CANDIDATE_DEFERRED"] } },
        orderBy: { sequence: "desc" },
      });
      ok(
        "[R1-04.4・是正の核心] MERGED決定のSession EventはCANDIDATE_MERGED(CANDIDATE_DEFERREDへ丸められない)",
        mergeEvent?.eventType === "CANDIDATE_MERGED",
        JSON.stringify(mergeEvent),
      );
    }

    // ============================================================
    // R1-04.B: 旧CANDIDATE_DEFERRED行の読み取り互換(履歴改変しない、
    //          DB CHECK制約が引き続きCANDIDATE_DEFERREDを許容する)。
    // ============================================================
    {
      const fx = await makeFixture("r104c");
      const cap = await makeCapture(fx, "旧形式イベントの再現");
      const session = await seedSession(fx, cap.id, "r104c");

      // [意図的] R1-04是正前の挙動を模した「旧SPLIT決定がCANDIDATE_DEFERREDとして
      // 記録された」行を直接seedする(過去に実際に書き込まれた行の再現)。
      const legacyEvent = await db.formationSessionEvent.create({
        data: {
          workspaceId: fx.workspaceId,
          sessionId: session.id,
          sequence: 1,
          eventType: "CANDIDATE_DEFERRED",
          actorType: "USER",
          actorUserId: fx.userId,
          payload: { legacyNote: "R1-04是正前に記録された旧SPLIT/MERGED丸め行の再現" },
        },
      });
      ok(
        "[R1-04.5・読み取り互換] 旧CANDIDATE_DEFERRED行はDB CHECK制約変更後も書込み・読み取りとも成功する(履歴改変しない)",
        legacyEvent.eventType === "CANDIDATE_DEFERRED",
        legacyEvent.eventType,
      );
      const reread = await db.formationSessionEvent.findUniqueOrThrow({ where: { id: legacyEvent.id } });
      ok("[R1-04.6] 旧CANDIDATE_DEFERRED行を再読込しても例外なく取得できる", reread.eventType === "CANDIDATE_DEFERRED", reread.eventType);
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
