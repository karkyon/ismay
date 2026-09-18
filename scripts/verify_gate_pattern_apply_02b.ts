#!/usr/bin/env node
/**
 * scripts/verify_gate_pattern_apply_02b.ts
 *
 * PATTERN-APPLY-02B(Preview確定からsplitFormationCandidateへの原子的接続、
 * ACCEPT/PARTIAL_ACCEPT Feedbackの同一transaction確定)の実DB受入試験。
 * 出典: Claude向け_ISMAY_d68e9bf以降_ActionSlot正本準拠・CasePattern実分解
 * 完遂・残工程連続実装指示_2026-09-17.md P1「8. PATTERN-APPLY-02B」。
 *
 * 検証内容:
 *   - 提案partsと完全一致する内容でSplit確定するとverdict=ACCEPTになる
 *   - partsを編集して確定するとverdict=PARTIAL_ACCEPTになる
 *   - attributedCasePatternIdとSuggestionの照合先Patternが食い違う場合、
 *     SUGGESTION_PATTERN_MISMATCHで拒否され、Split自体もcommitされない
 *     (原子性、decisionEvent/子candidateが一切作られない)
 *   - Idempotency-Key再利用(異なるpayload)はSUGGESTION_IDEMPOTENCY_KEY_REUSED
 *     で拒否され、Split自体もcommitされない
 *   - suggestionFeedback省略時(通常Split)は従来通り成功する(後方互換)
 *   - owner/workspace分離、cleanup、AI network遮断
 *
 * 実行方法:
 *   cd ~/projects/ismay/app
 *   npx tsx ../scripts/verify_gate_pattern_apply_02b.ts
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { createHash } from "node:crypto";

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
const EMAIL_PREFIX = "gate-pattern-apply-02b-verify-";
const DIMENSIONS = 1536;

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

function vectorA(): number[] {
  const v = new Array(DIMENSIONS).fill(0);
  v[0] = 1;
  return v;
}
function vectorB(): number[] {
  const v = new Array(DIMENSIONS).fill(0);
  v[1] = 1;
  return v;
}
function toVectorLiteral(v: number[]): string {
  return `[${v.join(",")}]`;
}
function computeRequestPayloadHash(payload: unknown): string {
  return createHash("sha256").update(JSON.stringify(payload)).digest("hex");
}

async function main(): Promise<void> {
  const { installAiNetworkDenyGuard } = await import("./lib/aiNetworkDenyGuard");
  const guard = installAiNetworkDenyGuard();

  const { db } = await import("../app/src/lib/db");
  const { cleanupFormationVerifyUser } = await import("./lib/formationVerifyCleanup");
  const { createCasePatternIdentity } = await import("../app/src/lib/patterns/casePatternRevisionService");
  const { splitFormationCandidate } = await import("../app/src/lib/formation/splitCorrection");
  const { runActionSlotLearningForPattern } = await import("../app/src/lib/patterns/casePatternActionSlotLearnService");
  const { storeCasePatternEmbedding } = await import("../app/src/lib/patterns/casePatternMatching");
  const { generateCaseSuggestionForCandidate } = await import("../app/src/lib/patterns/casePatternSuggestionGenerationService");
  const { buildCasePatternEmbeddingText } = await import("../app/src/lib/patterns/casePatternEmbeddingText");
  const { PEM_CONSENT_POLICY_VERSION } = await import("../app/src/lib/pem/consent");

  function candidateTextFor(representativeText: string): string {
    return buildCasePatternEmbeddingText({ representativeText, decompositionTemplate: null });
  }

  interface FakeEmbeddingProviderOptions {
    vectorsByText: Map<string, number[]>;
  }
  function makeFakeEmbeddingProvider(opts: FakeEmbeddingProviderOptions) {
    return {
      providerName: "fake",
      modelName: "fake-embed-v1",
      dimensions: DIMENSIONS,
      async embed(input: { text: string }) {
        const vector = opts.vectorsByText.get(input.text);
        if (!vector) {
          throw new Error(`[verify script bug] fake providerに未登録のテキストが渡された: ${JSON.stringify(input.text)}`);
        }
        return { ok: true as const, vector, dimensions: DIMENSIONS, usage: { inputTokens: 0, latencyMs: 0 } };
      },
    };
  }

  const createdFixtures: { userId: string; workspaceId: string }[] = [];

  async function cleanupCasePatternRowsByWorkspace(workspaceId: string): Promise<void> {
    await db.formationCandidateDecisionEvent.updateMany({ where: { workspaceId, attributedCasePatternId: { not: null } }, data: { attributedCasePatternId: null } }).catch(() => null);
    await db.casePatternSuggestJob.deleteMany({ where: { workspaceId } }).catch(() => null);
    await db.casePatternFeedbackEvent.deleteMany({ where: { workspaceId } }).catch(() => null);
    await db.casePatternSuggestionRevision.deleteMany({ where: { workspaceId } }).catch(() => null);
    await db.casePatternSuggestionIdentity.deleteMany({ where: { workspaceId } }).catch(() => null);
    await db.casePatternActionSlotSourceInstance.deleteMany({ where: { workspaceId } }).catch(() => null);
    await db.casePatternActionSlotRevision.deleteMany({ where: { workspaceId } }).catch(() => null);
    await db.casePatternActionSlot.deleteMany({ where: { workspaceId } }).catch(() => null);
    await db.casePatternActionSlotLearnJob.deleteMany({ where: { workspaceId } }).catch(() => null);
    await db.casePatternDetectionReceipt.deleteMany({ where: { workspaceId } }).catch(() => null);
    await db.casePatternDetectJob.deleteMany({ where: { workspaceId } }).catch(() => null);
    await db.casePatternSourceLink.deleteMany({ where: { workspaceId } }).catch(() => null);
    await db.casePatternEvidenceAggregate.deleteMany({ where: { workspaceId } }).catch(() => null);
    await db.casePatternEmbedding.deleteMany({ where: { workspaceId } }).catch(() => null);
    await db.casePatternRevision.deleteMany({ where: { workspaceId } }).catch(() => null);
    await db.casePattern.deleteMany({ where: { workspaceId } }).catch(() => null);
  }

  async function cleanupTestUser(userId: string, knownWorkspaceId: string | null): Promise<void> {
    let workspaceId = knownWorkspaceId;
    if (!workspaceId) {
      const membership = await db.workspaceMember.findFirst({ where: { userId }, select: { workspaceId: true } }).catch(() => null);
      workspaceId = membership?.workspaceId ?? null;
    }
    if (!workspaceId) {
      const capture = await db.capture.findFirst({ where: { createdById: userId }, select: { workspaceId: true } }).catch(() => null);
      workspaceId = capture?.workspaceId ?? null;
    }
    if (workspaceId) await cleanupCasePatternRowsByWorkspace(workspaceId);
    await db.pemConsentEvent.deleteMany({ where: { userId } }).catch(() => null);

    const result = await cleanupFormationVerifyUser(db, userId);
    if (result.errors.length > 0) {
      console.log(`  [cleanup警告] userId=${userId} errors=${result.errors.length}:`);
      for (const e of result.errors) console.log(`    - ${e.step}: ${String(e.error)}`);
    }
  }

  const orphans = await db.user.findMany({
    where: { email: { startsWith: EMAIL_PREFIX, endsWith: "@example.invalid" } },
    select: { id: true },
  });
  if (orphans.length > 0) {
    console.log(`[SWEEP] 過去実行の孤立テストユーザー${orphans.length}件を削除します...`);
    for (const o of orphans) await cleanupTestUser(o.id, null);
  }

  async function makeFixture(suffix: string) {
    const email = `${EMAIL_PREFIX}${RUN_ID}-${suffix}@example.invalid`;
    const user = await db.user.create({
      data: { email, passwordHash: "not-a-real-hash-for-db-only-test", displayName: `PATTERN-APPLY-02B ${suffix}` },
    });
    const workspace = await db.workspace.create({ data: { name: `PATTERN-APPLY-02B Workspace ${suffix}` } });
    await db.workspaceMember.create({ data: { workspaceId: workspace.id, userId: user.id, role: "OWNER" } });
    const domain = await db.domain.create({ data: { workspaceId: workspace.id, name: "個人", kind: "PERSONAL" } });
    await db.pemConsentEvent.create({
      data: {
        userId: user.id,
        workspaceId: workspace.id,
        consentType: "CASE_PATTERN_LEARNING",
        action: "GRANTED",
        policyVersion: PEM_CONSENT_POLICY_VERSION,
        source: "SETTINGS",
      },
    });
    createdFixtures.push({ userId: user.id, workspaceId: workspace.id });
    return { userId: user.id, workspaceId: workspace.id, domainId: domain.id };
  }

  async function makeActivePattern(fx: { workspaceId: string; userId: string }, title: string, vector: number[]) {
    const identity = await createCasePatternIdentity({
      workspaceId: fx.workspaceId,
      ownerSubjectUserId: fx.userId,
      title,
      representativeText: title,
      decompositionTemplate: null,
      thresholds: { windowCycles: 12 },
      schemaVersion: "1.0",
    });
    await db.casePattern.update({ where: { id: identity.patternId }, data: { status: "ACTIVE" } });
    await storeCasePatternEmbedding(db, {
      workspaceId: fx.workspaceId,
      revisionId: identity.revisionId,
      vectorLiteral: toVectorLiteral(vector),
      model: "fake-embed-v1",
      dimensions: DIMENSIONS,
    });
    return identity;
  }

  let seq = 0;
  async function makeSplittableCandidate(fx: { workspaceId: string; domainId: string; userId: string }, title: string) {
    seq++;
    const key = `c${seq}`;
    const capture = await db.capture.create({
      data: { workspaceId: fx.workspaceId, domainId: fx.domainId, createdById: fx.userId, sourceType: "TEXT", rawText: `[PATTERN-APPLY-02B verify ${key}] ${title}`, processingStatus: "READY" },
    });
    const session = await db.formationSession.create({
      data: { workspaceId: fx.workspaceId, domainId: fx.domainId, subjectUserId: fx.userId, captureId: capture.id, clientSessionKey: `pattern-apply-02b:${RUN_ID}:${key}`, state: "REVIEW_READY" },
    });
    const identity = await db.formationCandidateIdentity.create({
      data: { workspaceId: fx.workspaceId, sessionId: session.id, candidateKey: `k-${key}`, currentRevision: 1 },
    });
    await db.formationCandidateRevision.create({
      data: {
        workspaceId: fx.workspaceId, candidateId: identity.id, revision: 1, type: "TASK", title, description: null,
        proposedFields: {
          candidateId: `k-${key}`, type: "TASK", title, completionCondition: "検証用の完了条件",
          evidenceSpans: [{ start: 0, end: 4 }], confidence: 0.9, dateMentions: [], unknowns: [], blockedByCandidateIds: [], suggestedTags: [],
        },
        confidence: 0.9, schemaVersion: "1.0",
      },
    });
    return { sessionId: session.id, candidateId: identity.id };
  }

  async function doSplit(
    fx: { workspaceId: string; userId: string },
    sessionId: string,
    candidateId: string,
    parts: { type: string; title: string }[],
    attributedCasePatternId: string,
  ) {
    const result = await splitFormationCandidate({
      sessionId,
      workspaceId: fx.workspaceId,
      candidateId,
      expectedRevision: 1,
      parts,
      actorUserId: fx.userId,
      attributedCasePatternId,
    });
    if (!result.ok) throw new Error(`[fixture setup] splitFormationCandidate failed: ${JSON.stringify(result)}`);
  }

  try {
    console.log("=== PATTERN-APPLY-02B 実DB受入試験 ===");

    const fx = await makeFixture("main");

    // ================================================================
    // [前提] 対照group(owner/workspace分離)。
    // ================================================================
    const fxOther = await makeFixture("isolation-control");
    const patternOther = await makeActivePattern(fxOther, "対照Pattern", vectorA());
    const parentOther1 = await makeSplittableCandidate(fxOther, "対照親1");
    await doSplit(fxOther, parentOther1.sessionId, parentOther1.candidateId, [
      { type: "TASK", title: "確認する" },
      { type: "TASK", title: "提出する" },
    ], patternOther.patternId);
    await runActionSlotLearningForPattern(fxOther.workspaceId, patternOther.patternId);

    // ================================================================
    // [前提] fx: Pattern A(学習済み)・Pattern B(照合先不一致テスト用)を用意する。
    // ================================================================
    const patternA = await makeActivePattern(fx, "検証用PatternA", vectorA());
    const patternB = await makeActivePattern(fx, "検証用PatternB", vectorB());

    const seedParent1 = await makeSplittableCandidate(fx, "学習用親1");
    await doSplit(fx, seedParent1.sessionId, seedParent1.candidateId, [
      { type: "TASK", title: "確認する" },
      { type: "TASK", title: "提出する" },
    ], patternA.patternId);
    const seedParent2 = await makeSplittableCandidate(fx, "学習用親2");
    await doSplit(fx, seedParent2.sessionId, seedParent2.candidateId, [
      { type: "TASK", title: "確認する" },
      { type: "TASK", title: "提出する" },
    ], patternA.patternId);
    await runActionSlotLearningForPattern(fx.workspaceId, patternA.patternId);

    // ================================================================
    // [1] ACCEPT: 提案partsと完全一致する内容でSplit確定。
    // ================================================================
    const target1 = await makeSplittableCandidate(fx, "対象candidate1");
    const provider1 = makeFakeEmbeddingProvider({ vectorsByText: new Map([[candidateTextFor("TASK: 対象candidate1"), vectorA()]]) });
    const suggOutcome1 = await generateCaseSuggestionForCandidate(
      { workspaceId: fx.workspaceId, ownerSubjectUserId: fx.userId, candidateId: target1.candidateId },
      { getProvider: async () => provider1 },
    );
    if (suggOutcome1.outcome !== "SUGGESTION_CREATED") throw new Error(`[fixture setup] suggestion generation failed: ${JSON.stringify(suggOutcome1)}`);
    const suggRev1 = await db.casePatternSuggestionRevision.findUniqueOrThrow({ where: { id: suggOutcome1.suggestionRevisionId } });
    const proposal1 = suggRev1.decompositionProposal as { parts: { suggestedType: string; titleExample: string }[] };
    ok("[前提] target1のsuggestionはPatternAへMATCHEDし、2partsのproposalを持つ", proposal1.parts.length === 2, JSON.stringify(proposal1));

    const feedbackPayload1 = { suggestionId: suggOutcome1.suggestionId, expectedSuggestionRevision: 1 };
    const result1 = await splitFormationCandidate({
      sessionId: target1.sessionId,
      workspaceId: fx.workspaceId,
      candidateId: target1.candidateId,
      expectedRevision: 1,
      parts: proposal1.parts.map((p) => ({ type: p.suggestedType, title: p.titleExample })),
      actorUserId: fx.userId,
      attributedCasePatternId: patternA.patternId,
      suggestionFeedback: { ...feedbackPayload1, idempotencyKey: `idem-accept-${RUN_ID}`, requestPayloadHash: computeRequestPayloadHash(feedbackPayload1) },
    });
    ok("[1] 提案完全一致でのSplitは成功する", result1.ok === true, JSON.stringify(result1));
    if (result1.ok) {
      const feedbackEvent1 = await db.casePatternFeedbackEvent.findFirstOrThrow({ where: { workspaceId: fx.workspaceId, suggestionId: suggOutcome1.suggestionId } });
      ok("[1] verdict=ACCEPTが記録される", feedbackEvent1.verdict === "ACCEPT", JSON.stringify(feedbackEvent1));
      const suggestionAfter1 = await db.casePatternSuggestionIdentity.findUniqueOrThrow({ where: { id: suggOutcome1.suggestionId } });
      ok("[1] Suggestion.stateがACCEPTになる", suggestionAfter1.state === "ACCEPT", JSON.stringify(suggestionAfter1));
      const learnJobAfter1 = await db.casePatternActionSlotLearnJob.findFirst({ where: { workspaceId: fx.workspaceId, patternId: patternA.patternId } });
      ok("[1] ActionSlot学習Jobも同一Split操作でenqueueされる", learnJobAfter1 !== null, JSON.stringify(learnJobAfter1));
    }

    // ================================================================
    // [2] PARTIAL_ACCEPT: partsを編集して確定。
    // ================================================================
    const target2 = await makeSplittableCandidate(fx, "対象candidate2");
    const provider2 = makeFakeEmbeddingProvider({ vectorsByText: new Map([[candidateTextFor("TASK: 対象candidate2"), vectorA()]]) });
    const suggOutcome2 = await generateCaseSuggestionForCandidate(
      { workspaceId: fx.workspaceId, ownerSubjectUserId: fx.userId, candidateId: target2.candidateId },
      { getProvider: async () => provider2 },
    );
    if (suggOutcome2.outcome !== "SUGGESTION_CREATED") throw new Error(`[fixture setup] suggestion generation failed: ${JSON.stringify(suggOutcome2)}`);

    const feedbackPayload2 = { suggestionId: suggOutcome2.suggestionId, expectedSuggestionRevision: 1 };
    const result2 = await splitFormationCandidate({
      sessionId: target2.sessionId,
      workspaceId: fx.workspaceId,
      candidateId: target2.candidateId,
      expectedRevision: 1,
      // titleを編集(提案の「確認する」→「内容を確認する」)。
      parts: [
        { type: "TASK", title: "内容を確認する" },
        { type: "TASK", title: "提出する" },
      ],
      actorUserId: fx.userId,
      attributedCasePatternId: patternA.patternId,
      suggestionFeedback: { ...feedbackPayload2, idempotencyKey: `idem-partial-${RUN_ID}`, requestPayloadHash: computeRequestPayloadHash(feedbackPayload2) },
    });
    ok("[2] 編集後のSplitも成功する", result2.ok === true, JSON.stringify(result2));
    if (result2.ok) {
      const feedbackEvent2 = await db.casePatternFeedbackEvent.findFirstOrThrow({ where: { workspaceId: fx.workspaceId, suggestionId: suggOutcome2.suggestionId } });
      ok("[2] verdict=PARTIAL_ACCEPTが記録される(提案とtitleが異なるため)", feedbackEvent2.verdict === "PARTIAL_ACCEPT", JSON.stringify(feedbackEvent2));
    }

    // ================================================================
    // [3] SUGGESTION_PATTERN_MISMATCH: attributedCasePatternIdとSuggestionの
    // 照合先Patternが食い違う場合、拒否されSplit自体もcommitされない(原子性)。
    // ================================================================
    const target3 = await makeSplittableCandidate(fx, "対象candidate3");
    const provider3 = makeFakeEmbeddingProvider({ vectorsByText: new Map([[candidateTextFor("TASK: 対象candidate3"), vectorA()]]) });
    const suggOutcome3 = await generateCaseSuggestionForCandidate(
      { workspaceId: fx.workspaceId, ownerSubjectUserId: fx.userId, candidateId: target3.candidateId },
      { getProvider: async () => provider3 },
    );
    if (suggOutcome3.outcome !== "SUGGESTION_CREATED") throw new Error(`[fixture setup] suggestion generation failed: ${JSON.stringify(suggOutcome3)}`);

    const feedbackPayload3 = { suggestionId: suggOutcome3.suggestionId, expectedSuggestionRevision: 1 };
    const result3 = await splitFormationCandidate({
      sessionId: target3.sessionId,
      workspaceId: fx.workspaceId,
      candidateId: target3.candidateId,
      expectedRevision: 1,
      parts: [
        { type: "TASK", title: "確認する" },
        { type: "TASK", title: "提出する" },
      ],
      actorUserId: fx.userId,
      // Suggestion自体はPatternAへMATCHEDしているが、ここではPatternBを
      // 指定する不正な組み合わせ。
      attributedCasePatternId: patternB.patternId,
      suggestionFeedback: { ...feedbackPayload3, idempotencyKey: `idem-mismatch-${RUN_ID}`, requestPayloadHash: computeRequestPayloadHash(feedbackPayload3) },
    });
    ok("[3] Pattern不一致はSUGGESTION_PATTERN_MISMATCHで拒否される", !result3.ok && result3.error === "SUGGESTION_PATTERN_MISMATCH", JSON.stringify(result3));

    const decisionEvent3 = await db.formationCandidateDecisionEvent.findFirst({ where: { workspaceId: fx.workspaceId, candidateId: target3.candidateId } });
    ok("[3] 原子性: Split自体もcommitされない(decisionEventが作られない)", decisionEvent3 === null, JSON.stringify(decisionEvent3));
    const feedbackEvent3 = await db.casePatternFeedbackEvent.findFirst({ where: { workspaceId: fx.workspaceId, suggestionId: suggOutcome3.suggestionId } });
    ok("[3] 原子性: Feedbackイベントも作られない", feedbackEvent3 === null, JSON.stringify(feedbackEvent3));
    const currentRevision3 = await db.formationCandidateIdentity.findUniqueOrThrow({ where: { id: target3.candidateId } });
    ok("[3] 原子性: 元candidateのcurrentRevisionも1のまま(子candidateが作られていない)", currentRevision3.currentRevision === 1, JSON.stringify(currentRevision3));

    // ================================================================
    // [4] SUGGESTION_IDEMPOTENCY_KEY_REUSED: 同一キーで異なるpayloadを
    // 送信した場合、拒否されSplit自体もcommitされない。
    // ================================================================
    const target4 = await makeSplittableCandidate(fx, "対象candidate4");
    const provider4 = makeFakeEmbeddingProvider({ vectorsByText: new Map([[candidateTextFor("TASK: 対象candidate4"), vectorA()]]) });
    const suggOutcome4 = await generateCaseSuggestionForCandidate(
      { workspaceId: fx.workspaceId, ownerSubjectUserId: fx.userId, candidateId: target4.candidateId },
      { getProvider: async () => provider4 },
    );
    if (suggOutcome4.outcome !== "SUGGESTION_CREATED") throw new Error(`[fixture setup] suggestion generation failed: ${JSON.stringify(suggOutcome4)}`);

    const reusedKey = `idem-accept-${RUN_ID}`; // [1]で既に別payloadで使用済みのkey。
    const feedbackPayload4 = { suggestionId: suggOutcome4.suggestionId, expectedSuggestionRevision: 1 };
    const result4 = await splitFormationCandidate({
      sessionId: target4.sessionId,
      workspaceId: fx.workspaceId,
      candidateId: target4.candidateId,
      expectedRevision: 1,
      parts: [
        { type: "TASK", title: "確認する" },
        { type: "TASK", title: "提出する" },
      ],
      actorUserId: fx.userId,
      attributedCasePatternId: patternA.patternId,
      suggestionFeedback: { ...feedbackPayload4, idempotencyKey: reusedKey, requestPayloadHash: computeRequestPayloadHash(feedbackPayload4) },
    });
    ok("[4] Idempotency-Key再利用(異なるpayload)はSUGGESTION_IDEMPOTENCY_KEY_REUSEDで拒否される", !result4.ok && result4.error === "SUGGESTION_IDEMPOTENCY_KEY_REUSED", JSON.stringify(result4));
    const decisionEvent4 = await db.formationCandidateDecisionEvent.findFirst({ where: { workspaceId: fx.workspaceId, candidateId: target4.candidateId } });
    ok("[4] 原子性: Split自体もcommitされない", decisionEvent4 === null, JSON.stringify(decisionEvent4));

    // ================================================================
    // [5] 後方互換: suggestionFeedback省略時(通常Split)は従来通り成功する。
    // ================================================================
    const target5 = await makeSplittableCandidate(fx, "対象candidate5");
    const result5 = await splitFormationCandidate({
      sessionId: target5.sessionId,
      workspaceId: fx.workspaceId,
      candidateId: target5.candidateId,
      expectedRevision: 1,
      parts: [
        { type: "TASK", title: "任意の部分1" },
        { type: "TASK", title: "任意の部分2" },
      ],
      actorUserId: fx.userId,
    });
    ok("[5] suggestionFeedback省略時の通常Splitは従来通り成功する", result5.ok === true, JSON.stringify(result5));

    // ================================================================
    // [6] owner/workspace分離: 一連の操作を通じて対照group(fxOther)は
    // 影響を受けない。
    // ================================================================
    const feedbackEventsOtherFinal = await db.casePatternFeedbackEvent.count({ where: { workspaceId: fxOther.workspaceId } });
    ok("[6] 対照group(fxOther)にFeedbackイベントは1件も作られない(通常Splitのみ実施したため)", feedbackEventsOtherFinal === 0, `count=${feedbackEventsOtherFinal}`);
  } finally {
    console.log("--- cleanup ---");
    for (const fx of createdFixtures) {
      await cleanupTestUser(fx.userId, fx.workspaceId);
    }
    const remaining = await db.user.count({ where: { email: { startsWith: EMAIL_PREFIX, endsWith: "@example.invalid" } } });
    ok("[cleanup] cleanup後、専用fixtureユーザーの残存0件", remaining === 0, `remaining=${remaining}`);

    guard.restore();
    ok("[AI network] AI networkへの実通信試行は0回", guard.deniedCallAttempts.length === 0, `attempts=${JSON.stringify(guard.deniedCallAttempts)}`);

    await db.$disconnect();
  }

  console.log(`\n=== 結果: ${passed} passed / ${failed} failed ===`);
  if (failed > 0) {
    console.log("失敗一覧:");
    for (const f of failures) console.log(`  - ${f}`);
    process.exit(1);
  }
}

main().catch((err) => {
  console.error("[verify script fatal error]", err);
  process.exit(1);
});
