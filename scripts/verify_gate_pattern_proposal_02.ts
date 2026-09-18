#!/usr/bin/env node
/**
 * scripts/verify_gate_pattern_proposal_02.ts
 *
 * PATTERN-PROPOSAL-02(ActionSlotからversion付きdecomposition proposalを
 * 生成する実DB受入試験)。
 * 出典: Claude向け_ISMAY_d68e9bf以降_ActionSlot正本準拠・CasePattern実分解
 * 完遂・残工程連続実装指示_2026-09-17.md P1「6. PATTERN-PROPOSAL-02」。
 *
 * 検証内容:
 *   - ActionSlot学習済みPatternへMATCHEDした場合、decompositionProposalが
 *     kind="ACTION_SLOT_PROPOSAL"・hasData=true・学習済みslotと一致する
 *     parts(typicalOrder昇順)を持つ
 *   - ActionSlot未学習のPatternへMATCHEDした場合、hasData=false・parts=[]
 *     という明示的な欠損状態になる(空配列と欠損を区別する)
 *   - 2回目のSuggestion生成(revision 2)で、ActionSlotの更新が
 *     decompositionProposalへ反映される(SUGGESTION_REVISED)
 *   - owner/workspace分離、cleanup、AI network遮断
 *
 * 実行方法:
 *   cd ~/projects/ismay/app
 *   npx tsx ../scripts/verify_gate_pattern_proposal_02.ts
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
const EMAIL_PREFIX = "gate-pattern-proposal-02-verify-";
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
    await db.casePatternFeedbackEvent.deleteMany({ where: { workspaceId } }).catch(() => null);
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
      data: { email, passwordHash: "not-a-real-hash-for-db-only-test", displayName: `PATTERN-PROPOSAL-02 ${suffix}` },
    });
    const workspace = await db.workspace.create({ data: { name: `PATTERN-PROPOSAL-02 Workspace ${suffix}` } });
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

  /** ACTIVE状態のPattern(embedding付き)を直接構成する(既存verify_gate_pattern_suggest_01a.tsと同じ直接構成の慣行)。 */
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
  /** SPLIT対象となる親candidate(未決定)を1件作る(Gate 5 verify scriptと同じ)。 */
  async function makeSplittableCandidate(fx: { workspaceId: string; domainId: string; userId: string }, title: string) {
    seq++;
    const key = `parent${seq}`;
    const capture = await db.capture.create({
      data: { workspaceId: fx.workspaceId, domainId: fx.domainId, createdById: fx.userId, sourceType: "TEXT", rawText: `[PATTERN-PROPOSAL-02 verify ${key}] ${title}`, processingStatus: "READY" },
    });
    const session = await db.formationSession.create({
      data: { workspaceId: fx.workspaceId, domainId: fx.domainId, subjectUserId: fx.userId, captureId: capture.id, clientSessionKey: `pattern-proposal-02:${RUN_ID}:${key}`, state: "REVIEW_READY" },
    });
    const identity = await db.formationCandidateIdentity.create({
      data: { workspaceId: fx.workspaceId, sessionId: session.id, candidateKey: "c1", currentRevision: 1 },
    });
    await db.formationCandidateRevision.create({
      data: {
        workspaceId: fx.workspaceId, candidateId: identity.id, revision: 1, type: "TASK", title, description: null,
        proposedFields: {
          candidateId: "c1", type: "TASK", title, completionCondition: "検証用の完了条件",
          evidenceSpans: [{ start: 0, end: 4 }], confidence: 0.9, dateMentions: [], unknowns: [], blockedByCandidateIds: [], suggestedTags: [],
        },
        confidence: 0.9, schemaVersion: "1.0",
      },
    });
    return { sessionId: session.id, candidateId: identity.id };
  }

  /** Suggestion照合対象となる未決定candidateを1件作る。 */
  async function makeSuggestionCandidate(fx: { workspaceId: string; domainId: string; userId: string }, title: string) {
    seq++;
    const key = `sugg${seq}`;
    const capture = await db.capture.create({
      data: { workspaceId: fx.workspaceId, domainId: fx.domainId, createdById: fx.userId, sourceType: "TEXT", rawText: `[PATTERN-PROPOSAL-02 verify ${key}] ${title}`, processingStatus: "READY" },
    });
    const session = await db.formationSession.create({
      data: { workspaceId: fx.workspaceId, domainId: fx.domainId, subjectUserId: fx.userId, captureId: capture.id, clientSessionKey: `pattern-proposal-02-sugg:${RUN_ID}:${key}`, state: "REVIEW_READY" },
    });
    const identity = await db.formationCandidateIdentity.create({
      data: { workspaceId: fx.workspaceId, sessionId: session.id, candidateKey: `sk-${key}`, currentRevision: 1 },
    });
    await db.formationCandidateRevision.create({
      data: {
        workspaceId: fx.workspaceId, candidateId: identity.id, revision: 1, type: "TASK", title, description: null,
        proposedFields: {
          candidateId: `sk-${key}`, type: "TASK", title, completionCondition: "検証用の完了条件",
          evidenceSpans: [], confidence: 0.9, dateMentions: [], unknowns: [], blockedByCandidateIds: [], suggestedTags: [],
        },
        confidence: 0.9, schemaVersion: "1.0",
      },
    });
    return identity.id;
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
    if (!result.ok) throw new Error(`splitFormationCandidate failed: ${JSON.stringify(result)}`);
  }

  try {
    console.log("=== PATTERN-PROPOSAL-02 実DB受入試験 ===");

    const fx = await makeFixture("main");

    // ================================================================
    // [対照group] owner/workspace分離の対照(ActionSlot未学習パターンへの
    // 照合、hasData=falseの確認を兼ねる)。
    // ================================================================
    const fxOther = await makeFixture("isolation-control");
    const patternOtherEmpty = await makeActivePattern(fxOther, "対照Pattern(未学習)", vectorA());
    const suggCandOther = await makeSuggestionCandidate(fxOther, "対照suggestion候補");
    const providerOther = makeFakeEmbeddingProvider({ vectorsByText: new Map([[candidateTextFor("TASK: 対照suggestion候補"), vectorA()]]) });
    const outcomeOther = await generateCaseSuggestionForCandidate(
      { workspaceId: fxOther.workspaceId, ownerSubjectUserId: fxOther.userId, candidateId: suggCandOther },
      { getProvider: async () => providerOther },
    );
    ok("[前提] 対照group: MATCHEDでSUGGESTION_CREATEDになる", outcomeOther.outcome === "SUGGESTION_CREATED", JSON.stringify(outcomeOther));

    // ================================================================
    // [1] ActionSlot未学習Patternへの照合: decompositionProposalは
    // hasData=false・parts=[]という明示的な欠損状態になる(空配列と
    // 「まだ学習データが無い」を区別する)。
    // ================================================================
    if (outcomeOther.outcome === "SUGGESTION_CREATED") {
      const revOther = await db.casePatternSuggestionRevision.findUniqueOrThrow({ where: { id: outcomeOther.suggestionRevisionId } });
      const proposalOther = revOther.decompositionProposal as { kind: string; hasData: boolean; parts: unknown[] };
      ok("[1] kind=ACTION_SLOT_PROPOSAL", proposalOther.kind === "ACTION_SLOT_PROPOSAL", JSON.stringify(proposalOther));
      ok("[1] ActionSlot未学習PatternはhasData=falseになる", proposalOther.hasData === false, JSON.stringify(proposalOther));
      ok("[1] partsは空配列になる", Array.isArray(proposalOther.parts) && proposalOther.parts.length === 0, JSON.stringify(proposalOther));
    }
    void patternOtherEmpty;

    // ================================================================
    // [2] ActionSlot学習済みPatternへの照合: decompositionProposalが
    // 学習済みslotと一致するparts(typicalOrder昇順)を持つ。
    // ================================================================
    const pattern = await makeActivePattern(fx, "検証用Pattern", vectorA());

    const parent1 = await makeSplittableCandidate(fx, "親candidate1");
    await doSplit(fx, parent1.sessionId, parent1.candidateId, [
      { type: "TASK", title: "確認する" },
      { type: "TASK", title: "提出する" },
    ], pattern.patternId);
    const parent2 = await makeSplittableCandidate(fx, "親candidate2");
    await doSplit(fx, parent2.sessionId, parent2.candidateId, [
      { type: "TASK", title: "確認する" },
      { type: "TASK", title: "提出する" },
    ], pattern.patternId);
    await runActionSlotLearningForPattern(fx.workspaceId, pattern.patternId);

    const learnedSlots = await db.casePatternActionSlot.findMany({ where: { workspaceId: fx.workspaceId, patternId: pattern.patternId } });
    ok("[前提] 2 slot(確認する・提出する)が学習される", learnedSlots.length === 2, `count=${learnedSlots.length}`);

    const suggCand1 = await makeSuggestionCandidate(fx, "suggestion候補1");
    const provider1 = makeFakeEmbeddingProvider({ vectorsByText: new Map([[candidateTextFor("TASK: suggestion候補1"), vectorA()]]) });
    const outcome1 = await generateCaseSuggestionForCandidate(
      { workspaceId: fx.workspaceId, ownerSubjectUserId: fx.userId, candidateId: suggCand1 },
      { getProvider: async () => provider1 },
    );
    ok("[2] SUGGESTION_CREATEDになる", outcome1.outcome === "SUGGESTION_CREATED", JSON.stringify(outcome1));

    if (outcome1.outcome === "SUGGESTION_CREATED") {
      const rev1 = await db.casePatternSuggestionRevision.findUniqueOrThrow({ where: { id: outcome1.suggestionRevisionId } });
      const proposal1 = rev1.decompositionProposal as {
        kind: string;
        hasData: boolean;
        parts: { slotKey: string; typicalOrder: number; suggestedType: string; titleExample: string; occurrenceProbability: number; rawSampleSize: number; predecessorSlotKeys: string[]; sourceActionSlotRevisionId: string }[];
      };
      ok("[2] hasData=trueになる", proposal1.hasData === true, JSON.stringify(proposal1));
      ok("[2] parts数は2(確認する・提出する)", proposal1.parts.length === 2, JSON.stringify(proposal1));
      ok("[2] partsはtypicalOrder昇順", proposal1.parts[0]!.typicalOrder <= proposal1.parts[1]!.typicalOrder, JSON.stringify(proposal1.parts.map((p) => p.typicalOrder)));
      ok("[2] 1番目partのtitleExampleは「確認する」", proposal1.parts[0]!.titleExample === "確認する", JSON.stringify(proposal1.parts[0]));
      ok("[2] 2番目partのtitleExampleは「提出する」", proposal1.parts[1]!.titleExample === "提出する", JSON.stringify(proposal1.parts[1]));
      ok("[2] partsのslotKeyは学習済みslotのslotKeyと一致する", proposal1.parts.every((p) => learnedSlots.some((s) => s.slotKey === p.slotKey)), JSON.stringify(proposal1.parts.map((p) => p.slotKey)));
      ok("[2] occurrenceProbabilityは0..1範囲", proposal1.parts.every((p) => p.occurrenceProbability >= 0 && p.occurrenceProbability <= 1), JSON.stringify(proposal1.parts.map((p) => p.occurrenceProbability)));
      ok("[2] rawSampleSizeは2(2 split instance)", proposal1.parts.every((p) => p.rawSampleSize === 2), JSON.stringify(proposal1.parts.map((p) => p.rawSampleSize)));
      ok("[2] sourceActionSlotRevisionIdは各slotの現行revisionのidと一致する(根拠の遡及可能性)", proposal1.parts.every((p) => typeof p.sourceActionSlotRevisionId === "string" && p.sourceActionSlotRevisionId.length > 0), JSON.stringify(proposal1.parts.map((p) => p.sourceActionSlotRevisionId)));
    }

    // ================================================================
    // [3] revision 2: ActionSlotの更新(3件目のSPLIT)がdecompositionProposal
    // へ反映される(SUGGESTION_REVISED)。
    // ================================================================
    const parent3 = await makeSplittableCandidate(fx, "親candidate3");
    await doSplit(fx, parent3.sessionId, parent3.candidateId, [
      { type: "TASK", title: "確認する" },
      { type: "TASK", title: "提出する" },
      { type: "TASK", title: "報告する" },
    ], pattern.patternId);
    await runActionSlotLearningForPattern(fx.workspaceId, pattern.patternId);

    const provider2 = makeFakeEmbeddingProvider({ vectorsByText: new Map([[candidateTextFor("TASK: suggestion候補1"), vectorA()]]) });
    const outcome2 = await generateCaseSuggestionForCandidate(
      { workspaceId: fx.workspaceId, ownerSubjectUserId: fx.userId, candidateId: suggCand1 },
      { getProvider: async () => provider2 },
    );
    ok("[3] 2回目はSUGGESTION_REVISEDになる", outcome2.outcome === "SUGGESTION_REVISED", JSON.stringify(outcome2));

    if (outcome2.outcome === "SUGGESTION_REVISED") {
      const rev2 = await db.casePatternSuggestionRevision.findUniqueOrThrow({ where: { id: outcome2.suggestionRevisionId } });
      const proposal2 = rev2.decompositionProposal as { hasData: boolean; parts: { titleExample: string }[] };
      ok("[3] parts数は3(確認する・提出する・報告する)", proposal2.parts.length === 3, JSON.stringify(proposal2));
      ok("[3] 「報告する」がpartsに含まれる(更新反映)", proposal2.parts.some((p) => p.titleExample === "報告する"), JSON.stringify(proposal2.parts));

      const identityAfter = await db.casePatternSuggestionIdentity.findFirstOrThrow({ where: { workspaceId: fx.workspaceId, candidateId: suggCand1 } });
      ok("[3] currentRevisionが2になる", identityAfter.currentRevision === 2, JSON.stringify(identityAfter));
    }

    // ================================================================
    // [4] owner/workspace分離: fxOtherのSuggestionは一連のfx側の操作で
    // 影響を受けない。
    // ================================================================
    const otherFinal = await db.casePatternSuggestionIdentity.findFirstOrThrow({ where: { workspaceId: fxOther.workspaceId, candidateId: suggCandOther } });
    ok("[4] 対照group(fxOther)のSuggestion currentRevisionは1のまま", otherFinal.currentRevision === 1, JSON.stringify(otherFinal));
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
