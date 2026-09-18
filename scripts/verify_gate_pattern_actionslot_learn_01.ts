#!/usr/bin/env node
/**
 * scripts/verify_gate_pattern_actionslot_learn_01.ts
 *
 * PATTERN-ACTIONSLOT-LEARN-01(SPLIT属性付与→ActionSlot学習queue→学習
 * アルゴリズムの実DB受入試験)。
 * 出典: Claude向け_ISMAY_d68e9bf以降_ActionSlot正本準拠・CasePattern実分解
 * 完遂・残工程連続実装指示_2026-09-17.md Gate 5。
 *
 * 検証内容:
 *   - splitFormationCandidateにattributedCasePatternIdを渡すと、
 *     decisionEventへ記録され、CasePatternActionSlotLearnJobが
 *     同一transaction内でenqueueされる
 *   - exact matchによるgrouping(誤結合よりslot分離を優先、"確認する"と
 *     "確認"は別slot)
 *   - occurrenceProbability・typicalOrder(中央値)・predecessorSlotKeys
 *     (最小sample2・閾値0.3)・atomicityDistributionの算出
 *   - 冪等再実行(内容不変ならSLOT_UNCHANGED、新revisionを作らない)
 *   - generation stale時のrollback
 *   - owner/workspace分離、cleanup、AI network遮断
 *
 * 実行方法:
 *   cd ~/projects/ismay/app
 *   npx tsx ../scripts/verify_gate_pattern_actionslot_learn_01.ts
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
const EMAIL_PREFIX = "gate-pattern-actionslot-learn-01-verify-";

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
  const { installAiNetworkDenyGuard } = await import("./lib/aiNetworkDenyGuard");
  const guard = installAiNetworkDenyGuard();

  const { db } = await import("../app/src/lib/db");
  const { cleanupFormationVerifyUser } = await import("./lib/formationVerifyCleanup");
  const { createCasePatternIdentity } = await import("../app/src/lib/patterns/casePatternRevisionService");
  const { splitFormationCandidate } = await import("../app/src/lib/formation/splitCorrection");
  const {
    claimCaseActionSlotLearnJobs,
    completeCaseActionSlotLearnJob,
    requeueCaseActionSlotLearnJobForStaleGeneration,
    enqueueCaseActionSlotLearn,
    CaseActionSlotLearnJobGenerationStaleError,
  } = await import("../app/src/lib/patterns/caseActionSlotLearnQueue");
  const { runActionSlotLearningForPattern, computeActionSlotGroupingKey } = await import(
    "../app/src/lib/patterns/casePatternActionSlotLearnService"
  );

  const createdFixtures: { userId: string; workspaceId: string }[] = [];

  async function cleanupCasePatternRowsByWorkspace(workspaceId: string): Promise<void> {
    // [FK順序] formation_candidate_decision_events.attributed_case_pattern_idが
    // case_patternsを参照するため、case_patterns削除前にこの参照を必ず
    // 断ち切る(cleanupFormationVerifyUserの内部削除順序に依存しない)。
    await db.formationCandidateDecisionEvent.updateMany({ where: { workspaceId, attributedCasePatternId: { not: null } }, data: { attributedCasePatternId: null } }).catch(() => null);
    // [FK順序] case_pattern_suggest_jobs.candidate_idがformation_candidate_identitiesを
    // 参照する(既存PATTERN-SUGGEST機能、splitFormationCandidateが子candidateへ
    // enqueueCaseSuggestionMatchを呼ぶ既存の挙動により本テストでも作成される)。
    // cleanupFormationVerifyUserがformationCandidateIdentityを削除する前に
    // 必ず断ち切る。
    await db.casePatternSuggestJob.deleteMany({ where: { workspaceId } }).catch(() => null);
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
      data: { email, passwordHash: "not-a-real-hash-for-db-only-test", displayName: `PATTERN-ACTIONSLOT-LEARN-01 ${suffix}` },
    });
    const workspace = await db.workspace.create({ data: { name: `PATTERN-ACTIONSLOT-LEARN-01 Workspace ${suffix}` } });
    await db.workspaceMember.create({ data: { workspaceId: workspace.id, userId: user.id, role: "OWNER" } });
    const domain = await db.domain.create({ data: { workspaceId: workspace.id, name: "個人", kind: "PERSONAL" } });
    createdFixtures.push({ userId: user.id, workspaceId: workspace.id });
    return { userId: user.id, workspaceId: workspace.id, domainId: domain.id };
  }

  async function makePattern(fx: { workspaceId: string; userId: string }, title: string) {
    return createCasePatternIdentity({
      workspaceId: fx.workspaceId,
      ownerSubjectUserId: fx.userId,
      title,
      representativeText: title,
      decompositionTemplate: null,
      thresholds: { windowCycles: 12 },
      schemaVersion: "1.0",
    });
  }

  let seq = 0;
  /** SPLIT対象となる親candidate(未決定)を1件作る。 */
  async function makeSplittableCandidate(fx: { workspaceId: string; domainId: string; userId: string }, title: string) {
    seq++;
    const key = `parent${seq}`;
    const capture = await db.capture.create({
      data: { workspaceId: fx.workspaceId, domainId: fx.domainId, createdById: fx.userId, sourceType: "TEXT", rawText: `[PATTERN-ACTIONSLOT-LEARN-01 verify ${key}] ${title}`, processingStatus: "READY" },
    });
    const session = await db.formationSession.create({
      data: { workspaceId: fx.workspaceId, domainId: fx.domainId, subjectUserId: fx.userId, captureId: capture.id, clientSessionKey: `pattern-actionslot-learn-01:${RUN_ID}:${key}`, state: "REVIEW_READY" },
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

  async function doSplit(
    fx: { workspaceId: string; userId: string },
    sessionId: string,
    candidateId: string,
    parts: { type: string; title: string }[],
    attributedCasePatternId?: string,
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
    return result;
  }

  const WORKER_ID = `verify-actionslot-learn-01-worker-${RUN_ID}`;

  try {
    console.log("=== PATTERN-ACTIONSLOT-LEARN-01 実DB受入試験 ===");

    const fx = await makeFixture("main");
    const pattern = await makePattern(fx, "検証用Pattern");

    // ================================================================
    // [対照group] owner/workspace分離の対照。
    // ================================================================
    const fxOther = await makeFixture("isolation-control");
    const patternOther = await makePattern(fxOther, "対照Pattern");
    const parentOther = await makeSplittableCandidate(fxOther, "対照親candidate");
    await doSplit(fxOther, parentOther.sessionId, parentOther.candidateId, [
      { type: "TASK", title: "確認する" },
      { type: "TASK", title: "提出する" },
    ], patternOther.patternId);
    await runActionSlotLearningForPattern(fxOther.workspaceId, patternOther.patternId);
    const slotsOtherBefore = await db.casePatternActionSlot.count({ where: { workspaceId: fxOther.workspaceId, patternId: patternOther.patternId } });
    ok("[前提] 対照group(fxOther)で2 slotが学習される", slotsOtherBefore === 2, `count=${slotsOtherBefore}`);

    // ================================================================
    // [1] attributedCasePatternId付きSPLITはdecisionEventへ記録され、
    // 同一tx内でCasePatternActionSlotLearnJobがenqueueされる。
    // ================================================================
    const parent1 = await makeSplittableCandidate(fx, "親candidate1");
    const split1 = await doSplit(fx, parent1.sessionId, parent1.candidateId, [
      { type: "TASK", title: "確認する" },
      { type: "TASK", title: "提出する" },
    ], pattern.patternId);
    const decisionEvent1 = await db.formationCandidateDecisionEvent.findUniqueOrThrow({ where: { id: split1.decisionEventId } });
    ok("[1] decisionEvent.attributedCasePatternIdが記録される", decisionEvent1.attributedCasePatternId === pattern.patternId, JSON.stringify(decisionEvent1));

    const jobAfterSplit1 = await db.casePatternActionSlotLearnJob.findFirstOrThrow({
      where: { workspaceId: fx.workspaceId, patternId: pattern.patternId, status: { in: ["PENDING", "PROCESSING"] } },
      orderBy: { createdAt: "desc" },
    });
    ok("[1] CasePatternActionSlotLearnJobがreasonCode=SPLIT_ATTRIBUTEDでenqueueされる", jobAfterSplit1.reasonCode === "SPLIT_ATTRIBUTED", JSON.stringify(jobAfterSplit1));

    // ================================================================
    // [同一要求再送] 2件目・3件目のSPLITでも同じJob行がcoalesceされる
    // (新規Job行が増えない)ことを確認する。
    // ================================================================
    const parent2 = await makeSplittableCandidate(fx, "親candidate2");
    await doSplit(fx, parent2.sessionId, parent2.candidateId, [
      { type: "TASK", title: "確認する" },
      { type: "TASK", title: "提出する" },
    ], pattern.patternId);

    const parent3 = await makeSplittableCandidate(fx, "親candidate3");
    // "確認"(接尾辞なし)は"確認する"とは別groupingKeyになるはず(exact match、誤結合よりslot分離を優先)。
    await doSplit(fx, parent3.sessionId, parent3.candidateId, [
      { type: "TASK", title: "確認" },
      { type: "TASK", title: "提出する" },
    ], pattern.patternId);

    const jobRowCount = await db.casePatternActionSlotLearnJob.count({ where: { workspaceId: fx.workspaceId, patternId: pattern.patternId } });
    ok("[同一要求再送] 3回のSPLITでもJob行は1件のまま(coalesced)", jobRowCount === 1, `count=${jobRowCount}`);

    ok(
      "[前提] groupingKey計算は決定論的(同一入力→同一key)",
      computeActionSlotGroupingKey("TASK", "確認する") === computeActionSlotGroupingKey("TASK", "確認する") &&
        computeActionSlotGroupingKey("TASK", "確認する") !== computeActionSlotGroupingKey("TASK", "確認"),
      "",
    );

    // ================================================================
    // [2] queueを通した学習処理の実行(claim→学習→complete)。
    // ================================================================
    const claimed = await claimCaseActionSlotLearnJobs(WORKER_ID, 20);
    const job1 = claimed.find((j) => j.workspaceId === fx.workspaceId && j.patternId === pattern.patternId);
    if (!job1) throw new Error("[verify script bug] Jobをclaimできなかった");
    const outcomes1 = await runActionSlotLearningForPattern(fx.workspaceId, pattern.patternId, { jobId: job1.id, generation: job1.generation });
    const completeResult1 = await completeCaseActionSlotLearnJob(job1.id, job1.generation);
    ok("[2] 学習処理後、Jobがdoneで完了する", completeResult1.status === "DONE", JSON.stringify(completeResult1));
    ok("[2] 3 slot(確認する・提出する・確認)がSLOT_CREATEDとして学習される", outcomes1.filter((o) => o.outcome === "SLOT_CREATED").length === 3, JSON.stringify(outcomes1));

    // ================================================================
    // [grouping] "確認する"と"確認"は別slotとして分離される。
    // ================================================================
    const slots = await db.casePatternActionSlot.findMany({ where: { workspaceId: fx.workspaceId, patternId: pattern.patternId } });
    ok("[grouping] 3 slotが存在する(確認する・提出する・確認)", slots.length === 3, `count=${slots.length}`);

    const groupingKeyKakuninSuru = computeActionSlotGroupingKey("TASK", "確認する");
    const groupingKeyTeishutsuSuru = computeActionSlotGroupingKey("TASK", "提出する");
    const groupingKeyKakunin = computeActionSlotGroupingKey("TASK", "確認");

    const slotKakuninSuru = slots.find((s) => s.groupingKey === groupingKeyKakuninSuru);
    const slotTeishutsuSuru = slots.find((s) => s.groupingKey === groupingKeyTeishutsuSuru);
    const slotKakunin = slots.find((s) => s.groupingKey === groupingKeyKakunin);
    ok("[grouping] 3種のgroupingKeyそれぞれに対応するslotが存在する", !!slotKakuninSuru && !!slotTeishutsuSuru && !!slotKakunin, JSON.stringify(slots.map((s) => s.groupingKey)));

    // ================================================================
    // [3] occurrenceProbability・typicalOrder・predecessorSlotKeysの算出確認。
    // 総split instance数=3。"確認する"=2/3件、"提出する"=3/3件、"確認"=1/3件。
    // ================================================================
    const revKakuninSuru = await db.casePatternActionSlotRevision.findFirstOrThrow({ where: { workspaceId: fx.workspaceId, slotId: slotKakuninSuru!.id, revision: 1 } });
    const revTeishutsuSuru = await db.casePatternActionSlotRevision.findFirstOrThrow({ where: { workspaceId: fx.workspaceId, slotId: slotTeishutsuSuru!.id, revision: 1 } });
    const revKakunin = await db.casePatternActionSlotRevision.findFirstOrThrow({ where: { workspaceId: fx.workspaceId, slotId: slotKakunin!.id, revision: 1 } });

    ok("[3] 「確認する」のoccurrenceProbability=2/3", Math.abs(Number(revKakuninSuru.occurrenceProbability) - 2 / 3) < 0.001, revKakuninSuru.occurrenceProbability.toString());
    ok("[3] 「提出する」のoccurrenceProbability=3/3=1.0", Math.abs(Number(revTeishutsuSuru.occurrenceProbability) - 1) < 0.001, revTeishutsuSuru.occurrenceProbability.toString());
    ok("[3] 「確認」のoccurrenceProbability=1/3", Math.abs(Number(revKakunin.occurrenceProbability) - 1 / 3) < 0.001, revKakunin.occurrenceProbability.toString());

    ok("[3] 「確認する」のtypicalOrder=0(常に1番目)", Number(revKakuninSuru.typicalOrder) === 0, revKakuninSuru.typicalOrder.toString());
    ok("[3] 「提出する」のtypicalOrder=1(常に2番目)", Number(revTeishutsuSuru.typicalOrder) === 1, revTeishutsuSuru.typicalOrder.toString());

    ok("[3] 「確認する」のpredecessorSlotKeysは空(先頭のため)", revKakuninSuru.predecessorSlotKeys.length === 0, JSON.stringify(revKakuninSuru.predecessorSlotKeys));
    ok(
      "[3] 「提出する」のpredecessorSlotKeysは「確認する」と「確認」の両方を含む(それぞれ2/3・1/3で閾値0.3以上)",
      revTeishutsuSuru.predecessorSlotKeys.length === 2 &&
        revTeishutsuSuru.predecessorSlotKeys.includes(slotKakuninSuru!.slotKey) &&
        revTeishutsuSuru.predecessorSlotKeys.includes(slotKakunin!.slotKey),
      JSON.stringify(revTeishutsuSuru.predecessorSlotKeys),
    );
    ok(
      "[3] 「確認」のpredecessorSlotKeysは空(rawSampleSize=1<最小sample2のため)",
      revKakunin.predecessorSlotKeys.length === 0,
      JSON.stringify(revKakunin.predecessorSlotKeys),
    );

    // ================================================================
    // [4] atomicityDistribution: 保存済みFormationAtomicityAssessmentから算出される。
    // ================================================================
    const atomicityTeishutsuSuru = revTeishutsuSuru.atomicityDistribution as { sampleSize: number; byAssessment: Record<string, number>; algorithmVersions: string[] };
    ok("[4] 「提出する」のatomicityDistribution.sampleSizeは3(3childすべてにAssessmentがある)", atomicityTeishutsuSuru.sampleSize === 3, JSON.stringify(atomicityTeishutsuSuru));
    ok("[4] atomicityDistribution.algorithmVersionsが1件以上存在する", atomicityTeishutsuSuru.algorithmVersions.length >= 1, JSON.stringify(atomicityTeishutsuSuru));

    const durationKakuninSuru = revKakuninSuru.durationDistribution as { status: string; sampleSize: number };
    ok("[4] durationDistributionはv1固定でNOT_ENOUGH_DATA", durationKakuninSuru.status === "NOT_ENOUGH_DATA" && durationKakuninSuru.sampleSize === 0, JSON.stringify(durationKakuninSuru));

    // ================================================================
    // [5] SourceInstance: 各childRevisionにつき1件ずつ記録される。
    // ================================================================
    const sourceInstanceCount = await db.casePatternActionSlotSourceInstance.count({ where: { workspaceId: fx.workspaceId } });
    ok("[5] SourceInstanceは合計6件(3 split × 2 parts)", sourceInstanceCount === 6, `count=${sourceInstanceCount}`);

    // ================================================================
    // [6] 冪等再実行: 新規データが無い状態で再実行すると、全slotが
    // SLOT_UNCHANGEDになり、新しいrevisionは作られない。
    // ================================================================
    const outcomes2 = await runActionSlotLearningForPattern(fx.workspaceId, pattern.patternId);
    ok("[6] 変化なしの再実行は全slotがSLOT_UNCHANGEDになる", outcomes2.every((o) => o.outcome === "SLOT_UNCHANGED"), JSON.stringify(outcomes2));
    const revisionCountAfterRerun = await db.casePatternActionSlotRevision.count({ where: { workspaceId: fx.workspaceId } });
    ok("[6] 再実行後もrevision総数は3のまま(新規revisionが作られない)", revisionCountAfterRerun === 3, `count=${revisionCountAfterRerun}`);
    const sourceInstanceCountAfterRerun = await db.casePatternActionSlotSourceInstance.count({ where: { workspaceId: fx.workspaceId } });
    ok("[6] 再実行後もSourceInstance総数は6のまま(重複記録されない)", sourceInstanceCountAfterRerun === 6, `count=${sourceInstanceCountAfterRerun}`);

    // ================================================================
    // [7] generation stale時のrollback: 4件目のSPLITでJobをenqueueし、
    // claim後に別のenqueueでgenerationを進めてから、古いgenerationで学習を
    // 試みるとCaseActionSlotLearnJobGenerationStaleErrorが投げられ、
    // 副作用がcommitされないことを確認する。
    // ================================================================
    const parent4 = await makeSplittableCandidate(fx, "親candidate4");
    await doSplit(fx, parent4.sessionId, parent4.candidateId, [
      { type: "TASK", title: "確認する" },
      { type: "TASK", title: "提出する" },
    ], pattern.patternId);

    const claimed2 = await claimCaseActionSlotLearnJobs(WORKER_ID, 20);
    const job2 = claimed2.find((j) => j.workspaceId === fx.workspaceId && j.patternId === pattern.patternId);
    if (!job2) throw new Error("[verify script bug] 2回目のJobをclaimできなかった");

    // claim後、別の要求でgenerationを進める(coalescing)。
    await enqueueCaseActionSlotLearn(db, { workspaceId: fx.workspaceId, patternId: pattern.patternId, reasonCode: "SPLIT_ATTRIBUTED" });

    let staleErr: unknown = null;
    try {
      await runActionSlotLearningForPattern(fx.workspaceId, pattern.patternId, { jobId: job2.id, generation: job2.generation });
    } catch (err) {
      staleErr = err;
    }
    ok("[7] stale generationでの学習はCaseActionSlotLearnJobGenerationStaleErrorを投げる", staleErr instanceof CaseActionSlotLearnJobGenerationStaleError, String(staleErr));

    const revKakuninSuruAfterStale = await db.casePatternActionSlotRevision.findUniqueOrThrow({ where: { id: revKakuninSuru.id } });
    ok("[7] stale rollback後も既存revisionの内容は変化しない(occurrenceProbabilityは2/3のまま)", Math.abs(Number(revKakuninSuruAfterStale.occurrenceProbability) - 2 / 3) < 0.001, revKakuninSuruAfterStale.occurrenceProbability.toString());
    const revisionCountAfterStale = await db.casePatternActionSlotRevision.count({ where: { workspaceId: fx.workspaceId } });
    ok("[7] stale rollback後もrevision総数は3のまま(4件目分がcommitされていない)", revisionCountAfterStale === 3, `count=${revisionCountAfterStale}`);

    await requeueCaseActionSlotLearnJobForStaleGeneration(job2.id);
    const claimed3 = await claimCaseActionSlotLearnJobs(WORKER_ID, 20);
    const job3 = claimed3.find((j) => j.workspaceId === fx.workspaceId && j.patternId === pattern.patternId);
    if (!job3) throw new Error("[verify script bug] 3回目のJobをclaimできなかった");
    const outcomes3 = await runActionSlotLearningForPattern(fx.workspaceId, pattern.patternId, { jobId: job3.id, generation: job3.generation });
    await completeCaseActionSlotLearnJob(job3.id, job3.generation);
    ok(
      "[7] 正しいgenerationでの再実行後、「確認する」「提出する」がSLOT_REVISEDになる(4件目の反映)",
      outcomes3.some((o) => o.slotKey === slotKakuninSuru!.slotKey && o.outcome === "SLOT_REVISED") &&
        outcomes3.some((o) => o.slotKey === slotTeishutsuSuru!.slotKey && o.outcome === "SLOT_REVISED"),
      JSON.stringify(outcomes3),
    );
    const revKakuninSuruFinal = await db.casePatternActionSlotRevision.findFirstOrThrow({ where: { workspaceId: fx.workspaceId, slotId: slotKakuninSuru!.id, revision: 2 } });
    ok("[7] 4件目反映後、「確認する」のoccurrenceProbabilityは3/4", Math.abs(Number(revKakuninSuruFinal.occurrenceProbability) - 3 / 4) < 0.001, revKakuninSuruFinal.occurrenceProbability.toString());

    // ================================================================
    // [8] owner/workspace分離: 一連の操作を通じて対照group(fxOther)は影響を受けない。
    // ================================================================
    const slotsOtherFinal = await db.casePatternActionSlot.count({ where: { workspaceId: fxOther.workspaceId, patternId: patternOther.patternId } });
    ok("[8] 対照group(fxOther)のslot数は2のまま(fx側の操作で増えていない)", slotsOtherFinal === 2, `count=${slotsOtherFinal}`);
    const jobsOtherFinal = await db.casePatternActionSlotLearnJob.count({ where: { workspaceId: fxOther.workspaceId } });
    ok("[8] 対照group(fxOther)のJobは1件のまま", jobsOtherFinal === 1, `count=${jobsOtherFinal}`);
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
