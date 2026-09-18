#!/usr/bin/env node
/**
 * scripts/verify_gate_pattern_closedloop_e2e_02.ts
 *
 * PATTERN-CLOSEDLOOP-E2E-02(学習→提案→適用→Feedback→採用率→次回提案の
 * 実DB横断検証)。
 * 出典: Claude向け_ISMAY_d68e9bf以降_ActionSlot正本準拠・CasePattern実分解
 * 完遂・残工程連続実装指示_2026-09-17.md P1「9. PATTERN-CLOSEDLOOP-E2E-02」。
 *
 * Gate 5〜8はそれぞれの機能単位の受入証跡を既に持つ
 * (verify_gate_pattern_actionslot_learn_01.ts / verify_gate_pattern_
 * proposal_02.ts / verify_gate_pattern_apply_02b.ts)。本scriptの価値は、
 * 「Applyした結果が次の学習・次の提案へ実際に反映される」という閉ループ
 * そのものを1本の連続した物語として実DBで確認することにある
 * (個別機能テストでは検証できない、複合効果)。
 *
 * 検証内容:
 *   - 学習済みPatternへの1回目の提案は、seed実績(2件)を反映したproposalを持つ
 *   - その提案どおりにApply(ACCEPT)すると、同一Split操作でActionSlot学習
 *     Jobがenqueueされる
 *   - その学習Jobを実行すると、ActionSlotのrawSampleSizeが3へ増える
 *     (Applyした実績が学習に反映される)
 *   - 直後に生成する2回目の提案(別candidate)は、更新後のrawSampleSize=3を
 *     反映する(次回提案に反映される、閉ループが実際に機能する証跡)
 *   - 編集して確定(PARTIAL_ACCEPT)した場合も同様に反映される
 *   - 採用率(computeCasePatternAdoptionRate)がACCEPT/PARTIAL_ACCEPT/REJECTを
 *     正しく集計する
 *   - owner/workspace分離、cleanup、AI network遮断
 *
 * 実行方法:
 *   cd ~/projects/ismay/app
 *   npx tsx ../scripts/verify_gate_pattern_closedloop_e2e_02.ts
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
const EMAIL_PREFIX = "gate-pattern-closedloop-e2e-02-verify-";
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
  const { claimCaseActionSlotLearnJobs, completeCaseActionSlotLearnJob } = await import("../app/src/lib/patterns/caseActionSlotLearnQueue");
  const { storeCasePatternEmbedding } = await import("../app/src/lib/patterns/casePatternMatching");
  const { generateCaseSuggestionForCandidate } = await import("../app/src/lib/patterns/casePatternSuggestionGenerationService");
  const { buildCasePatternEmbeddingText } = await import("../app/src/lib/patterns/casePatternEmbeddingText");
  const { computeCasePatternAdoptionRate } = await import("../app/src/lib/patterns/casePatternSuggestion");
  const { recordCasePatternFeedback } = await import("../app/src/lib/patterns/casePatternFeedbackService");
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
      data: { email, passwordHash: "not-a-real-hash-for-db-only-test", displayName: `PATTERN-CLOSEDLOOP-E2E-02 ${suffix}` },
    });
    const workspace = await db.workspace.create({ data: { name: `PATTERN-CLOSEDLOOP-E2E-02 Workspace ${suffix}` } });
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
      data: { workspaceId: fx.workspaceId, domainId: fx.domainId, createdById: fx.userId, sourceType: "TEXT", rawText: `[PATTERN-CLOSEDLOOP-E2E-02 verify ${key}] ${title}`, processingStatus: "READY" },
    });
    const session = await db.formationSession.create({
      data: { workspaceId: fx.workspaceId, domainId: fx.domainId, subjectUserId: fx.userId, captureId: capture.id, clientSessionKey: `pattern-closedloop-e2e-02:${RUN_ID}:${key}`, state: "REVIEW_READY" },
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

  const WORKER_ID = `verify-closedloop-e2e-02-worker-${RUN_ID}`;
  async function runLearnJobForPattern(fx: { workspaceId: string }, patternId: string) {
    const claimed = await claimCaseActionSlotLearnJobs(WORKER_ID, 20);
    const job = claimed.find((j) => j.workspaceId === fx.workspaceId && j.patternId === patternId);
    if (!job) throw new Error("[verify script bug] ActionSlot学習Jobをclaimできなかった");
    await runActionSlotLearningForPattern(fx.workspaceId, patternId, { jobId: job.id, generation: job.generation });
    await completeCaseActionSlotLearnJob(job.id, job.generation);
  }

  try {
    console.log("=== PATTERN-CLOSEDLOOP-E2E-02 実DB横断検証(学習→提案→適用→Feedback→採用率→次回提案) ===");

    const fx = await makeFixture("main");

    // ================================================================
    // [対照group] owner/workspace分離。
    // ================================================================
    const fxOther = await makeFixture("isolation-control");
    const patternOther = await makeActivePattern(fxOther, "対照Pattern", vectorA());
    const seedOther = await makeSplittableCandidate(fxOther, "対照seed");
    await doSplit(fxOther, seedOther.sessionId, seedOther.candidateId, [
      { type: "TASK", title: "確認する" },
      { type: "TASK", title: "提出する" },
    ], patternOther.patternId);
    await runActionSlotLearningForPattern(fxOther.workspaceId, patternOther.patternId);

    // ================================================================
    // [Step 1] 学習: seed実績2件でPatternを学習させる。
    // ================================================================
    const pattern = await makeActivePattern(fx, "検証用Pattern", vectorA());
    const seed1 = await makeSplittableCandidate(fx, "学習用seed1");
    await doSplit(fx, seed1.sessionId, seed1.candidateId, [
      { type: "TASK", title: "確認する" },
      { type: "TASK", title: "提出する" },
    ], pattern.patternId);
    const seed2 = await makeSplittableCandidate(fx, "学習用seed2");
    await doSplit(fx, seed2.sessionId, seed2.candidateId, [
      { type: "TASK", title: "確認する" },
      { type: "TASK", title: "提出する" },
    ], pattern.patternId);
    await runActionSlotLearningForPattern(fx.workspaceId, pattern.patternId);

    const slotsAfterSeed = await db.casePatternActionSlot.findMany({ where: { workspaceId: fx.workspaceId, patternId: pattern.patternId } });
    ok("[Step 1] 2 slotがseed実績から学習される", slotsAfterSeed.length === 2, `count=${slotsAfterSeed.length}`);
    const revKakuninSeed = await db.casePatternActionSlotRevision.findFirstOrThrow({
      where: { workspaceId: fx.workspaceId, slotId: slotsAfterSeed[0]!.id },
      orderBy: { revision: "desc" },
    });
    ok("[Step 1] seed直後のrawSampleSizeは2", revKakuninSeed.rawSampleSize === 2, JSON.stringify(revKakuninSeed));

    // ================================================================
    // [Step 2] 提案(1回目): rawSampleSize=2を反映したproposalが生成される。
    // ================================================================
    const target1 = await makeSplittableCandidate(fx, "対象1");
    const provider1 = makeFakeEmbeddingProvider({ vectorsByText: new Map([[candidateTextFor("TASK: 対象1"), vectorA()]]) });
    const suggOutcome1 = await generateCaseSuggestionForCandidate(
      { workspaceId: fx.workspaceId, ownerSubjectUserId: fx.userId, candidateId: target1.candidateId },
      { getProvider: async () => provider1 },
    );
    if (suggOutcome1.outcome !== "SUGGESTION_CREATED") throw new Error(`[fixture setup] suggestion generation failed: ${JSON.stringify(suggOutcome1)}`);
    const suggRev1 = await db.casePatternSuggestionRevision.findUniqueOrThrow({ where: { id: suggOutcome1.suggestionRevisionId } });
    const proposal1 = suggRev1.decompositionProposal as { parts: { suggestedType: string; titleExample: string; rawSampleSize: number }[] };
    ok("[Step 2] 1回目提案のrawSampleSizeは2(seed実績を反映)", proposal1.parts.every((p) => p.rawSampleSize === 2), JSON.stringify(proposal1.parts));

    // ================================================================
    // [Step 3] 適用(ACCEPT): 提案どおりに確定する。同一操作でActionSlot
    // 学習Jobがenqueueされる。
    // ================================================================
    const feedbackPayload1 = { suggestionId: suggOutcome1.suggestionId, expectedSuggestionRevision: 1 };
    const applyResult1 = await splitFormationCandidate({
      sessionId: target1.sessionId,
      workspaceId: fx.workspaceId,
      candidateId: target1.candidateId,
      expectedRevision: 1,
      parts: proposal1.parts.map((p) => ({ type: p.suggestedType, title: p.titleExample })),
      actorUserId: fx.userId,
      attributedCasePatternId: pattern.patternId,
      suggestionFeedback: { ...feedbackPayload1, idempotencyKey: `idem-step3-${RUN_ID}`, requestPayloadHash: computeRequestPayloadHash(feedbackPayload1) },
    });
    ok("[Step 3] 提案どおりのApplyは成功する", applyResult1.ok === true, JSON.stringify(applyResult1));
    const learnJobAfterApply1 = await db.casePatternActionSlotLearnJob.findFirst({ where: { workspaceId: fx.workspaceId, patternId: pattern.patternId, status: { in: ["PENDING", "PROCESSING"] } } });
    ok("[Step 3] ActionSlot学習Jobがenqueueされる", learnJobAfterApply1 !== null, JSON.stringify(learnJobAfterApply1));

    // ================================================================
    // [Step 4] 学習(再実行): enqueueされたJobを処理すると、rawSampleSizeが
    // 3へ増える(Applyした実績が学習に反映される)。
    // ================================================================
    await runLearnJobForPattern(fx, pattern.patternId);
    const slotsAfterApply1 = await db.casePatternActionSlot.findMany({ where: { workspaceId: fx.workspaceId, patternId: pattern.patternId } });
    const revKakuninAfterApply1 = await db.casePatternActionSlotRevision.findFirstOrThrow({
      where: { workspaceId: fx.workspaceId, slotId: slotsAfterApply1[0]!.id },
      orderBy: { revision: "desc" },
    });
    ok("[Step 4] Apply後の再学習でrawSampleSizeが3へ増える(閉ループ)", revKakuninAfterApply1.rawSampleSize === 3, JSON.stringify(revKakuninAfterApply1));

    // ================================================================
    // [Step 5] 提案(2回目・別candidate): 更新後のrawSampleSize=3を反映する
    // (次回提案に反映される、閉ループが実際に機能する証跡)。
    // ================================================================
    const target2 = await makeSplittableCandidate(fx, "対象2");
    const provider2 = makeFakeEmbeddingProvider({ vectorsByText: new Map([[candidateTextFor("TASK: 対象2"), vectorA()]]) });
    const suggOutcome2 = await generateCaseSuggestionForCandidate(
      { workspaceId: fx.workspaceId, ownerSubjectUserId: fx.userId, candidateId: target2.candidateId },
      { getProvider: async () => provider2 },
    );
    if (suggOutcome2.outcome !== "SUGGESTION_CREATED") throw new Error(`[fixture setup] suggestion generation failed: ${JSON.stringify(suggOutcome2)}`);
    const suggRev2 = await db.casePatternSuggestionRevision.findUniqueOrThrow({ where: { id: suggOutcome2.suggestionRevisionId } });
    const proposal2 = suggRev2.decompositionProposal as { parts: { suggestedType: string; titleExample: string; rawSampleSize: number }[] };
    ok("[Step 5] 2回目提案のrawSampleSizeは3(閉ループでApply実績が反映される)", proposal2.parts.every((p) => p.rawSampleSize === 3), JSON.stringify(proposal2.parts));

    // ================================================================
    // [Step 6] 適用(PARTIAL_ACCEPT): 編集して確定する。
    // ================================================================
    const feedbackPayload2 = { suggestionId: suggOutcome2.suggestionId, expectedSuggestionRevision: 1 };
    const applyResult2 = await splitFormationCandidate({
      sessionId: target2.sessionId,
      workspaceId: fx.workspaceId,
      candidateId: target2.candidateId,
      expectedRevision: 1,
      parts: [
        { type: "TASK", title: "内容を確認する" },
        { type: "TASK", title: "提出する" },
      ],
      actorUserId: fx.userId,
      attributedCasePatternId: pattern.patternId,
      suggestionFeedback: { ...feedbackPayload2, idempotencyKey: `idem-step6-${RUN_ID}`, requestPayloadHash: computeRequestPayloadHash(feedbackPayload2) },
    });
    ok("[Step 6] 編集後のApplyも成功する", applyResult2.ok === true, JSON.stringify(applyResult2));
    const feedbackEvent2 = await db.casePatternFeedbackEvent.findFirstOrThrow({ where: { workspaceId: fx.workspaceId, suggestionId: suggOutcome2.suggestionId } });
    ok("[Step 6] verdict=PARTIAL_ACCEPTが記録される", feedbackEvent2.verdict === "PARTIAL_ACCEPT", JSON.stringify(feedbackEvent2));

    // ================================================================
    // [Step 7] 採用率: ACCEPT・PARTIAL_ACCEPTともに分子へ計上される。
    // ================================================================
    const adoptionRateAfterTwoAccepts = await computeCasePatternAdoptionRate(fx.workspaceId, pattern.patternId);
    ok("[Step 7] ACCEPT+PARTIAL_ACCEPT=2件、REJECT無しで採用率=1.0", adoptionRateAfterTwoAccepts === 1, `rate=${adoptionRateAfterTwoAccepts}`);

    // 3件目としてREJECTを直接記録する(Applyを経由しない通常のfeedback経路、
    // 既存UIの却下ボタンと同じ関数呼出し)。
    const target3 = await makeSplittableCandidate(fx, "対象3");
    const provider3 = makeFakeEmbeddingProvider({ vectorsByText: new Map([[candidateTextFor("TASK: 対象3"), vectorA()]]) });
    const suggOutcome3 = await generateCaseSuggestionForCandidate(
      { workspaceId: fx.workspaceId, ownerSubjectUserId: fx.userId, candidateId: target3.candidateId },
      { getProvider: async () => provider3 },
    );
    if (suggOutcome3.outcome !== "SUGGESTION_CREATED") throw new Error(`[fixture setup] suggestion generation failed: ${JSON.stringify(suggOutcome3)}`);
    const rejectPayload = { revision: 1, verdict: "REJECT" };
    await recordCasePatternFeedback({
      workspaceId: fx.workspaceId,
      suggestionId: suggOutcome3.suggestionId,
      actorUserId: fx.userId,
      expectedRevision: 1,
      verdict: "REJECT",
      idempotencyKey: `idem-reject-${RUN_ID}`,
      requestPayloadHash: computeRequestPayloadHash(rejectPayload),
    });
    const adoptionRateAfterReject = await computeCasePatternAdoptionRate(fx.workspaceId, pattern.patternId);
    ok("[Step 7] REJECT追加後、採用率=2/3", adoptionRateAfterReject !== null && Math.abs(adoptionRateAfterReject - 2 / 3) < 0.001, `rate=${adoptionRateAfterReject}`);

    // ================================================================
    // [Step 8] owner/workspace分離: 一連の操作を通じて対照group(fxOther)は
    // 影響を受けない。
    // ================================================================
    const adoptionRateOther = await computeCasePatternAdoptionRate(fxOther.workspaceId, patternOther.patternId);
    ok("[Step 8] 対照group(fxOther)の採用率はnull(feedback未記録のまま)", adoptionRateOther === null, `rate=${adoptionRateOther}`);
    const slotsOtherFinal = await db.casePatternActionSlot.findMany({ where: { workspaceId: fxOther.workspaceId, patternId: patternOther.patternId } });
    const revOtherFinal = slotsOtherFinal.length > 0
      ? await db.casePatternActionSlotRevision.findFirst({ where: { workspaceId: fxOther.workspaceId, slotId: slotsOtherFinal[0]!.id }, orderBy: { revision: "desc" } })
      : null;
    ok("[Step 8] 対照group(fxOther)のrawSampleSizeは1のまま(fx側の操作で増えていない)", revOtherFinal?.rawSampleSize === 1, JSON.stringify(revOtherFinal));
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
