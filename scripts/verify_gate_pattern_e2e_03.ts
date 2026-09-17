#!/usr/bin/env node
/**
 * scripts/verify_gate_pattern_e2e_03.ts
 *
 * PATTERN-E2E-03: PATTERN-INTEGRITY-03A(PRIMARY解除)・03B(title訂正・
 * 再有効化)・03C(generation原子性)を横断する実DB受入試験。
 * 出典: ISMAY_ハンドオフ資料_2026-09-05_続き3.md §5「未着手:
 * PATTERN-INTEGRITY-E2E-03」。
 *
 * 検証シナリオ(指示書記載どおり、1本の連続した物語として一つの
 * occurrenceへ連鎖させる):
 *   - PRIMARY解除
 *   - title変更で別Patternへ移動
 *   - title変更後も同じPatternへ一致
 *   - worker処理中coalescing
 *   - 同一要求再送
 *   - owner/workspace分離
 *   - cleanup後の孤立データ0件
 *
 * 03A/03B/03Cはそれぞれ個別のverify scriptで機能単位の受入証跡を既に
 * 持つ(verify_gate_pattern_integrity_03{a,b,c}.ts)。本scriptの価値は、
 * これらを「実際のqueue(enqueue→claim→generation lock付き検出→complete)を
 * 通して連続実行した際に、機能同士の組み合わせで壊れないこと」を検証する
 * ことにある(例: title訂正が引き起こす再検出の最中にcoalescingが起きた
 * 場合でも、03Bの除外/再有効化ロジックと03Cのgeneration lockが正しく
 * 協調するか)。
 *
 * AI providerへの実通信は行わない(installAiNetworkDenyGuardで機械的に保証)。
 *
 * 実行方法:
 *   cd ~/projects/ismay/app
 *   npx tsx ../scripts/verify_gate_pattern_e2e_03.ts
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
const EMAIL_PREFIX = "gate-pattern-e2e-03-verify-";
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

async function main(): Promise<void> {
  const { installAiNetworkDenyGuard } = await import("./lib/aiNetworkDenyGuard");
  const guard = installAiNetworkDenyGuard();

  const { db } = await import("../app/src/lib/db");
  const { cleanupFormationVerifyUser } = await import("./lib/formationVerifyCleanup");
  const { recordCandidateDecision, materializeFormationSession: materializeFormationSessionReal } = await import(
    "../app/src/lib/formation/materialize"
  );
  const { runCasePatternDetectionForOwner } = await import("../app/src/lib/patterns/casePatternDetectionService");
  const { computeAndPersistCasePatternAggregatesForOwner } = await import("../app/src/lib/patterns/casePatternAggregation");
  const { enqueueCaseDetectForResponsibilityCorrection } = await import("../app/src/lib/patterns/casePatternTriggers");
  const { excludeCasePatternSourceLinksForResponsibility } = await import("../app/src/lib/patterns/sourceLinkService");
  const {
    enqueueCaseDetect,
    claimCaseDetectJobs,
    completeCaseDetectJob,
    requeueCaseDetectJobForStaleGeneration,
    CaseDetectJobGenerationStaleError,
  } = await import("../app/src/lib/patterns/caseDetectQueue");
  const { PEM_CONSENT_POLICY_VERSION } = await import("../app/src/lib/pem/consent");
  const { buildCasePatternEmbeddingText } = await import("../app/src/lib/patterns/casePatternEmbeddingText");

  async function materializeFormationSession(params: Parameters<typeof materializeFormationSessionReal>[0]) {
    const embedStub = async () => {
      throw new Error("embedAndStoreResponsibility should not be called in this Gate (AI-free verify script)");
    };
    return materializeFormationSessionReal(params, { embedAndStoreResponsibility: embedStub as never });
  }

  function candidateTextFor(representativeText: string): string {
    return buildCasePatternEmbeddingText({ representativeText, decompositionTemplate: null });
  }

  interface FakeEmbeddingProviderOptions {
    vectorsByText: Map<string, number[]>;
    onEmbedCall?: () => Promise<void>;
  }
  function makeFakeEmbeddingProvider(opts: FakeEmbeddingProviderOptions) {
    return {
      providerName: "fake",
      modelName: "fake-embed-v1",
      dimensions: DIMENSIONS,
      async embed(input: { text: string }) {
        if (opts.onEmbedCall) await opts.onEmbedCall();
        const vector = opts.vectorsByText.get(input.text);
        if (!vector) {
          throw new Error(`[verify script bug] fake providerに未登録のテキストが渡された: ${JSON.stringify(input.text)}`);
        }
        return { ok: true as const, vector, dimensions: DIMENSIONS, usage: { inputTokens: 0, latencyMs: 0 } };
      },
    };
  }

  /**
   * caseDetectQueueJob.ts::processOneJob相当を、fake providerを差し込める形で
   * 再現する(既存verify script群と同じ慣行、AI呼出しを実通信させないため)。
   * generation stale検出時は即時PENDIN化(backoff・attempt増加なし)まで行う。
   */
  async function runWorkerCycleOnce(params: {
    workspaceId: string;
    ownerSubjectUserId: string;
    provider: ReturnType<typeof makeFakeEmbeddingProvider>;
  }): Promise<"done" | "requeued_stale" | "no_job"> {
    const claimed = await claimCaseDetectJobs(`verify-e2e03-worker-${RUN_ID}`, 20);
    const job = claimed.find((j) => j.workspaceId === params.workspaceId && j.ownerSubjectUserId === params.ownerSubjectUserId);
    if (!job) return "no_job";

    const jobContext = { jobId: job.id, generation: job.generation };
    try {
      await runCasePatternDetectionForOwner(params.workspaceId, params.ownerSubjectUserId, { getProvider: async () => params.provider }, jobContext);
      await computeAndPersistCasePatternAggregatesForOwner(params.workspaceId, params.ownerSubjectUserId, jobContext);
      const result = await completeCaseDetectJob(job.id, job.generation);
      return result.status === "DONE" ? "done" : "requeued_stale";
    } catch (err) {
      if (err instanceof CaseDetectJobGenerationStaleError) {
        await requeueCaseDetectJobForStaleGeneration(job.id);
        return "requeued_stale";
      }
      throw err;
    }
  }

  const createdFixtures: { userId: string; workspaceId: string }[] = [];

  async function cleanupCasePatternRowsByWorkspace(workspaceId: string): Promise<void> {
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
      if (!workspaceId) {
        const ctx = await db.projectContext
          .findFirst({ where: { OR: [{ ownerSubjectUserId: userId }, { createdById: userId }] }, select: { workspaceId: true } })
          .catch(() => null);
        workspaceId = ctx?.workspaceId ?? null;
      }
    }
    if (workspaceId) await cleanupCasePatternRowsByWorkspace(workspaceId);

    const ownedOrCreatedContexts = await db.projectContext
      .findMany({ where: { OR: [{ ownerSubjectUserId: userId }, { createdById: userId }] }, select: { id: true } })
      .catch(() => []);
    const contextIds = ownedOrCreatedContexts.map((c) => c.id);
    if (contextIds.length > 0) {
      await db.projectContextLinkEvent.deleteMany({ where: { contextId: { in: contextIds } } }).catch(() => null);
      await db.projectContextLink.deleteMany({ where: { contextId: { in: contextIds } } }).catch(() => null);
      await db.eventLog.deleteMany({ where: { aggregateId: { in: contextIds } } }).catch(() => null);
      await db.outboxEvent.deleteMany({ where: { aggregateId: { in: contextIds } } }).catch(() => null);
      await db.projectContext.deleteMany({ where: { id: { in: contextIds } } }).catch(() => null);
    }
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
      data: { email, passwordHash: "not-a-real-hash-for-db-only-test", displayName: `PATTERN-E2E-03 ${suffix}` },
    });
    const workspace = await db.workspace.create({ data: { name: `PATTERN-E2E-03 Workspace ${suffix}` } });
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

  async function makeContext(fx: { workspaceId: string; domainId: string; userId: string }, key: string) {
    return db.projectContext.create({
      data: { workspaceId: fx.workspaceId, domainId: fx.domainId, ownerSubjectUserId: fx.userId, name: `ctx-${RUN_ID}-${key}`, createdById: fx.userId },
    });
  }

  let occSeq = 0;
  async function makeEligibleOccurrence(
    fx: { workspaceId: string; domainId: string; userId: string },
    contextId: string,
    title: string,
  ): Promise<{ responsibilityId: string; materializationReceiptItemId: string; linkId: string }> {
    occSeq++;
    const key = `occ${occSeq}`;
    const capture = await db.capture.create({
      data: { workspaceId: fx.workspaceId, domainId: fx.domainId, createdById: fx.userId, sourceType: "TEXT", rawText: `[PATTERN-E2E-03 verify ${key}] ${title}`, processingStatus: "READY" },
    });
    const session = await db.formationSession.create({
      data: { workspaceId: fx.workspaceId, domainId: fx.domainId, subjectUserId: fx.userId, captureId: capture.id, clientSessionKey: `pattern-e2e-03:${RUN_ID}:${key}`, state: "REVIEW_READY" },
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
    const decision = await recordCandidateDecision({ sessionId: session.id, workspaceId: fx.workspaceId, candidateId: identity.id, expectedRevision: 1, decision: "ACCEPTED", actorUserId: fx.userId });
    if (!decision.ok) throw new Error(`recordCandidateDecision failed: ${JSON.stringify(decision)}`);
    const materialized = await materializeFormationSession({ sessionId: session.id, workspaceId: fx.workspaceId, operationId: `op-${RUN_ID}-${key}`, expectedVersion: session.version, actorUserId: fx.userId });
    if (!materialized.ok) throw new Error(`materializeFormationSession failed: ${JSON.stringify(materialized)}`);
    const responsibilityId = materialized.items[0]!.responsibilityId;
    const receiptItem = await db.materializationReceiptItem.findFirstOrThrow({ where: { workspaceId: fx.workspaceId, candidateId: identity.id }, select: { id: true } });

    const link = await db.projectContextLink.create({
      data: { workspaceId: fx.workspaceId, contextId, responsibilityId, role: "PRIMARY", sourceKind: "USER" },
    });

    return { responsibilityId, materializationReceiptItemId: receiptItem.id, linkId: link.id };
  }

  /**
   * route.ts(project-contexts/[id]/links/[responsibilityId] DELETE)が
   * PATTERN-INTEGRITY-03A是正後に実際に行うのと同じtransaction内の手順を
   * 再現する(verify_gate_pattern_integrity_03a.tsと同じ慣行)。
   */
  async function unlinkPrimaryAndExclude(params: {
    workspaceId: string;
    contextOwnerSubjectUserId: string;
    responsibilityId: string;
    linkId: string;
  }): Promise<{ excludedCount: number; affectedOwnerIds: string[] }> {
    return db.$transaction(async (tx) => {
      await tx.projectContextLink.update({ where: { id: params.linkId }, data: { unlinkedAt: new Date() } });
      const { excludedCount, affectedOwnerIds } = await excludeCasePatternSourceLinksForResponsibility(tx, {
        workspaceId: params.workspaceId,
        responsibilityId: params.responsibilityId,
        reason: "PRIMARY_UNLINKED",
      });
      const owners = new Set<string>([params.contextOwnerSubjectUserId, ...affectedOwnerIds]);
      for (const ownerSubjectUserId of owners) {
        await enqueueCaseDetect(tx, { workspaceId: params.workspaceId, ownerSubjectUserId, reasonCode: "PRIMARY_UNLINKED" });
      }
      return { excludedCount, affectedOwnerIds };
    });
  }

  /** PATCH /api/v1/responsibilities/[id]がtitle実変化時に行うのと同じ手順を再現する。 */
  async function correctTitle(params: { workspaceId: string; responsibilityId: string; newTitle: string }): Promise<void> {
    await db.responsibility.update({ where: { id: params.responsibilityId }, data: { title: params.newTitle } });
    await enqueueCaseDetectForResponsibilityCorrection(db, { workspaceId: params.workspaceId, responsibilityId: params.responsibilityId });
  }

  try {
    console.log("=== PATTERN-E2E-03 横断実DB受入試験(03A+03B+03C) ===");

    // ================================================================
    // 前提: メイン検証用fixture(fxMain)と、owner/workspace分離を確認する
    // 対照fixture(fxOther)を並行して用意する。両方とも2つの独立Pattern
    // (P1/P2相当)を先に作っておく。
    // ================================================================
    const fxMain = await makeFixture("main");
    const ctxMainSeedA = await makeContext(fxMain, "seed-a");
    const seedMainA = await makeEligibleOccurrence(fxMain, ctxMainSeedA.id, "MAIN P1シード");
    const ctxMainSeedB = await makeContext(fxMain, "seed-b");
    const seedMainB = await makeEligibleOccurrence(fxMain, ctxMainSeedB.id, "MAIN P2シード");

    const fxOther = await makeFixture("isolation-control");
    const ctxOther = await makeContext(fxOther, "main");
    const occOther = await makeEligibleOccurrence(fxOther, ctxOther.id, "対照group occurrence");

    // seedMainA/Bをそれぞれ検出させ、P1/P2を確定させる(通常のworker cycle経由)。
    await enqueueCaseDetect(db, { workspaceId: fxMain.workspaceId, ownerSubjectUserId: fxMain.userId, reasonCode: "PRIMARY_LINKED" });
    const providerSeedA = makeFakeEmbeddingProvider({ vectorsByText: new Map([[candidateTextFor("TASK: MAIN P1シード"), vectorA()], [candidateTextFor("TASK: MAIN P2シード"), vectorB()]]) });
    const cycleSeed1 = await runWorkerCycleOnce({ workspaceId: fxMain.workspaceId, ownerSubjectUserId: fxMain.userId, provider: providerSeedA });
    ok("[前提] seed検出1回目のworker cycleはdoneで完了する", cycleSeed1 === "done", cycleSeed1);

    // 対照group(fxOther)も同時に検出させ、claimバッチに混在しても分離される
    // ことを後で確認できるようにしておく。
    await enqueueCaseDetect(db, { workspaceId: fxOther.workspaceId, ownerSubjectUserId: fxOther.userId, reasonCode: "PRIMARY_LINKED" });
    const providerOther = makeFakeEmbeddingProvider({ vectorsByText: new Map([[candidateTextFor("TASK: 対照group occurrence"), vectorA()]]) });
    const cycleOther1 = await runWorkerCycleOnce({ workspaceId: fxOther.workspaceId, ownerSubjectUserId: fxOther.userId, provider: providerOther });
    ok("[前提] 対照group(fxOther)のworker cycleもdoneで完了する", cycleOther1 === "done", cycleOther1);

    const patternP1 = await db.casePattern.findFirstOrThrow({
      where: { workspaceId: fxMain.workspaceId, ownerSubjectUserId: fxMain.userId, revisions: { some: { sourceLinks: { some: { sourceEventId: seedMainA.materializationReceiptItemId } } } } },
    });
    const patternP2 = await db.casePattern.findFirstOrThrow({
      where: { workspaceId: fxMain.workspaceId, ownerSubjectUserId: fxMain.userId, revisions: { some: { sourceLinks: { some: { sourceEventId: seedMainB.materializationReceiptItemId } } } } },
    });
    ok("[前提] P1とP2は別Pattern", patternP1.id !== patternP2.id, `P1=${patternP1.id} P2=${patternP2.id}`);
    const revisionP1 = await db.casePatternRevision.findFirstOrThrow({ where: { workspaceId: fxMain.workspaceId, patternId: patternP1.id, revision: patternP1.currentRevision } });
    const revisionP2 = await db.casePatternRevision.findFirstOrThrow({ where: { workspaceId: fxMain.workspaceId, patternId: patternP2.id, revision: patternP2.currentRevision } });

    // ================================================================
    // [1] メインoccurrenceをtitle=T1(P1一致)で作成し、PRIMARY link経由で
    // 通常のworker cycleでP1へlinkさせる。
    // ================================================================
    const ctxMain = await makeContext(fxMain, "main");
    const titleT1 = "横断検証対象 T1";
    const titleT2 = "横断検証対象 T2";
    const occMain = await makeEligibleOccurrence(fxMain, ctxMain.id, titleT1);
    await enqueueCaseDetect(db, { workspaceId: fxMain.workspaceId, ownerSubjectUserId: fxMain.userId, reasonCode: "PRIMARY_LINKED" });
    const providerT1Init = makeFakeEmbeddingProvider({ vectorsByText: new Map([[candidateTextFor(`TASK: ${titleT1}`), vectorA()]]) });
    const cycle1 = await runWorkerCycleOnce({ workspaceId: fxMain.workspaceId, ownerSubjectUserId: fxMain.userId, provider: providerT1Init });
    ok("[1] 初回worker cycleはdoneで完了する", cycle1 === "done", cycle1);

    const linkT1 = await db.casePatternSourceLink.findFirstOrThrow({ where: { workspaceId: fxMain.workspaceId, sourceEventId: occMain.materializationReceiptItemId } });
    ok("[1] 初回検出でP1のrevisionへlinkされる", linkT1.patternRevisionId === revisionP1.id, JSON.stringify(linkT1));

    // ================================================================
    // [PRIMARY解除] このoccurrenceのPRIMARY Linkを解除する(03A)。
    // ================================================================
    const cycleUnlinkPrep = await unlinkPrimaryAndExclude({
      workspaceId: fxMain.workspaceId,
      contextOwnerSubjectUserId: fxMain.userId,
      responsibilityId: occMain.responsibilityId,
      linkId: occMain.linkId,
    });
    ok("[PRIMARY解除] excludeCasePatternSourceLinksForResponsibilityが1件除外する", cycleUnlinkPrep.excludedCount === 1, JSON.stringify(cycleUnlinkPrep));

    const providerAfterUnlink = makeFakeEmbeddingProvider({ vectorsByText: new Map() });
    const cycleUnlink = await runWorkerCycleOnce({ workspaceId: fxMain.workspaceId, ownerSubjectUserId: fxMain.userId, provider: providerAfterUnlink });
    ok("[PRIMARY解除] unlink後のworker cycleもdoneで完了する(対象source無しでeligibleから外れるため、providerは一切呼ばれない)", cycleUnlink === "done", cycleUnlink);

    const linkT1AfterUnlink = await db.casePatternSourceLink.findUniqueOrThrow({ where: { id: linkT1.id } });
    ok("[PRIMARY解除] SourceLinkがexcludedAt非nullになる", linkT1AfterUnlink.excludedAt != null, JSON.stringify(linkT1AfterUnlink));
    const aggP1AfterUnlink = await db.casePatternEvidenceAggregate.findFirst({ where: { workspaceId: fxMain.workspaceId, revisionId: revisionP1.id } });
    ok("[PRIMARY解除] P1のrawSampleSizeが1(seedMainAのみ)へ減少する", aggP1AfterUnlink?.rawSampleSize === 1, JSON.stringify(aggP1AfterUnlink));

    // 新しいPRIMARY Linkを同じcontextへ再作成する(実運用でも「一度外して
    // 別contextへ付け直す」操作は新規Link行になる)。
    const linkT1Re = await db.projectContextLink.create({
      data: { workspaceId: fxMain.workspaceId, contextId: ctxMain.id, responsibilityId: occMain.responsibilityId, role: "PRIMARY", sourceKind: "USER" },
    });

    // ================================================================
    // [title変更で別Patternへ移動 + worker処理中coalescing] T1→T2に訂正し、
    // 新title(P2一致)での再検出中にcoalescing(同時に別の訂正が入った状況)を
    // 注入する。03Bの除外ロジックと03Cのgeneration lockが組み合わさって、
    // 1回目はstale rollback、2回目(再送後)で正しくP2へ着地することを確認する。
    // ================================================================
    await correctTitle({ workspaceId: fxMain.workspaceId, responsibilityId: occMain.responsibilityId, newTitle: titleT2 });
    const jobAfterCorrection = await db.casePatternDetectJob.findFirstOrThrow({ where: { workspaceId: fxMain.workspaceId, ownerSubjectUserId: fxMain.userId } });
    ok("[title変更] correctTitleはRESPONSIBILITY_CORRECTEDでenqueueする", jobAfterCorrection.reasonCode === "RESPONSIBILITY_CORRECTED", JSON.stringify(jobAfterCorrection));

    // [同一要求再送] 訂正確定直後、UIの二重送信等で同じ訂正enqueueがもう一度
    // 来た状況を模す(同一owner・同一reasonCode)。1行のみ・generationが
    // 進むことを確認する。
    const beforeDuplicateCount = await db.casePatternDetectJob.count({ where: { workspaceId: fxMain.workspaceId, ownerSubjectUserId: fxMain.userId } });
    const duplicateEnqueueResult = await enqueueCaseDetect(db, { workspaceId: fxMain.workspaceId, ownerSubjectUserId: fxMain.userId, reasonCode: "RESPONSIBILITY_CORRECTED" });
    const afterDuplicateCount = await db.casePatternDetectJob.count({ where: { workspaceId: fxMain.workspaceId, ownerSubjectUserId: fxMain.userId } });
    ok("[同一要求再送] 重複enqueueは新しいJob行を作らない(coalesced)", duplicateEnqueueResult.coalesced === true && afterDuplicateCount === beforeDuplicateCount, JSON.stringify({ duplicateEnqueueResult, beforeDuplicateCount, afterDuplicateCount }));

    let coalesceInjected = false;
    const providerT2WithCoalescing = makeFakeEmbeddingProvider({
      vectorsByText: new Map([[candidateTextFor(`TASK: ${titleT2}`), vectorB()]]),
      onEmbedCall: async () => {
        if (coalesceInjected) return;
        coalesceInjected = true;
        // [worker処理中coalescing] AI呼出し完了後・DB確定直前に、別の訂正
        // リクエストが同じJobへenqueueした状況を再現する。
        await enqueueCaseDetect(db, { workspaceId: fxMain.workspaceId, ownerSubjectUserId: fxMain.userId, reasonCode: "RESPONSIBILITY_CORRECTED" });
      },
    });
    const cycleT2Stale = await runWorkerCycleOnce({ workspaceId: fxMain.workspaceId, ownerSubjectUserId: fxMain.userId, provider: providerT2WithCoalescing });
    ok("[worker処理中coalescing] 1回目のworker cycleはstale検出によりrequeuedになる", cycleT2Stale === "requeued_stale", cycleT2Stale);

    // [注記] 旧P1向けSourceLinkの除外はcorrectTitle()(実体は
    // enqueueCaseDetectForResponsibilityCorrection)が、このworker cycleより
    // 前に別transactionとして既にcommit済み(03Bの除外は「title訂正時」に
    // 同期的に行われ、generation lock付きtransactionの内側ではない)。
    // そのためstale rollbackの影響は受けない。stale rollbackが防ぐのは
    // 「新title(P2)向けのSourceLink/Receipt確定」のみである。
    const linkT1ReAfterStaleCycle = await db.casePatternSourceLink.findUniqueOrThrow({ where: { id: linkT1.id } });
    ok("[worker処理中coalescing] 旧P1向けSourceLinkはcorrectTitle時点で既に除外済み(stale rollbackの影響範囲外)", linkT1ReAfterStaleCycle.excludedAt != null, JSON.stringify(linkT1ReAfterStaleCycle));
    const linkP2CountAfterStaleCycle = await db.casePatternSourceLink.count({ where: { workspaceId: fxMain.workspaceId, sourceEventId: occMain.materializationReceiptItemId, patternRevisionId: revisionP2.id } });
    ok("[worker処理中coalescing] stale rollbackにより、新P2向けSourceLinkはまだ作られない(取得済みEmbedding結果は破棄される)", linkP2CountAfterStaleCycle === 0, `count=${linkP2CountAfterStaleCycle}`);
    const activeLinksDuringStaleWindow = await db.casePatternSourceLink.count({ where: { workspaceId: fxMain.workspaceId, sourceEventId: occMain.materializationReceiptItemId, excludedAt: null } });
    ok("[worker処理中coalescing] retry完了までの一時窓では、このoccurrenceのactive SourceLinkは0件になり得る(re-detectionで自己修復される想定)", activeLinksDuringStaleWindow === 0, `activeCount=${activeLinksDuringStaleWindow}`);

    // 再送(coalescing後のgenerationで再claim・再実行)。今回はcoalescingを
    // 注入しないクリーンなproviderで正常completeさせる。
    const providerT2Clean = makeFakeEmbeddingProvider({ vectorsByText: new Map([[candidateTextFor(`TASK: ${titleT2}`), vectorB()]]) });
    const cycleT2Retry = await runWorkerCycleOnce({ workspaceId: fxMain.workspaceId, ownerSubjectUserId: fxMain.userId, provider: providerT2Clean });
    ok("[worker処理中coalescing] 再送後のworker cycleはdoneで完了する", cycleT2Retry === "done", cycleT2Retry);

    const linkT1ReAfterT2 = await db.casePatternSourceLink.findUniqueOrThrow({ where: { id: linkT1.id } });
    ok("[title変更で別Pattern] 再送成功後、旧P1向けSourceLinkは除外される", linkT1ReAfterT2.excludedAt != null, JSON.stringify(linkT1ReAfterT2));
    const linkP2 = await db.casePatternSourceLink.findFirstOrThrow({ where: { workspaceId: fxMain.workspaceId, sourceEventId: occMain.materializationReceiptItemId, patternRevisionId: revisionP2.id } });
    ok("[title変更で別Pattern] 新P2向けSourceLinkがactiveで存在する", linkP2.excludedAt == null, JSON.stringify(linkP2));

    // ================================================================
    // [title変更後も同じPatternへ一致] T2→T1(P1)へ戻す。旧title変更時に
    // 除外済みのlinkT1が、同一Patternへの再一致で再有効化されることを
    // 確認する(二重計上しない)。
    // ================================================================
    const sourceLinkCountBeforeRevert = await db.casePatternSourceLink.count({ where: { workspaceId: fxMain.workspaceId, sourceEventId: occMain.materializationReceiptItemId } });
    await correctTitle({ workspaceId: fxMain.workspaceId, responsibilityId: occMain.responsibilityId, newTitle: titleT1 });
    const providerT1Again = makeFakeEmbeddingProvider({ vectorsByText: new Map([[candidateTextFor(`TASK: ${titleT1}`), vectorA()]]) });
    const cycleT1Revert = await runWorkerCycleOnce({ workspaceId: fxMain.workspaceId, ownerSubjectUserId: fxMain.userId, provider: providerT1Again });
    ok("[title変更後も同じPatternへ一致] T1へ戻すworker cycleはdoneで完了する", cycleT1Revert === "done", cycleT1Revert);

    const sourceLinkCountAfterRevert = await db.casePatternSourceLink.count({ where: { workspaceId: fxMain.workspaceId, sourceEventId: occMain.materializationReceiptItemId } });
    ok("[title変更後も同じPatternへ一致] T1へ再一致してもSourceLink行数は増えない(再有効化)", sourceLinkCountAfterRevert === sourceLinkCountBeforeRevert, `before=${sourceLinkCountBeforeRevert} after=${sourceLinkCountAfterRevert}`);
    const linkT1Final = await db.casePatternSourceLink.findUniqueOrThrow({ where: { id: linkT1.id } });
    ok("[title変更後も同じPatternへ一致] 元のP1向けlinkが再有効化される(excludedAt:null)", linkT1Final.excludedAt == null, JSON.stringify(linkT1Final));
    const activeLinksForMain = await db.casePatternSourceLink.count({ where: { workspaceId: fxMain.workspaceId, sourceEventId: occMain.materializationReceiptItemId, excludedAt: null } });
    ok("[title変更後も同じPatternへ一致] このoccurrenceのactive SourceLinkは常に高々1件", activeLinksForMain === 1, `activeCount=${activeLinksForMain}`);

    // ================================================================
    // [owner/workspace分離] 一連の操作を通じて、対照group(fxOther)の
    // SourceLink/Jobには一切影響が及んでいないことを確認する。
    // ================================================================
    const sourceLinkOtherFinal = await db.casePatternSourceLink.findMany({ where: { workspaceId: fxOther.workspaceId, sourceEventId: occOther.materializationReceiptItemId } });
    ok("[owner/workspace分離] 対照group(fxOther)のSourceLinkは1件のまま(excludedAt:null)", sourceLinkOtherFinal.length === 1 && sourceLinkOtherFinal[0]!.excludedAt == null, JSON.stringify(sourceLinkOtherFinal));
    const jobsOtherFinal = await db.casePatternDetectJob.findMany({ where: { workspaceId: fxOther.workspaceId, ownerSubjectUserId: fxOther.userId } });
    ok("[owner/workspace分離] 対照group(fxOther)のJobはDONEのまま(fxMain側の一連の操作で再enqueueされていない)", jobsOtherFinal.every((j) => j.status === "DONE"), JSON.stringify(jobsOtherFinal));

    // ================================================================
    // 最終健全性チェック: linkT1(旧Link、unlink済み)+linkT1Re(現行Link)の
    // 2行が存在する状態で、有効なPRIMARY Linkは1件のみであること。
    // ================================================================
    const activePrimaryLinksForMain = await db.projectContextLink.count({ where: { workspaceId: fxMain.workspaceId, responsibilityId: occMain.responsibilityId, unlinkedAt: null } });
    ok("[整合性] 最終的に有効なPRIMARY Linkは1件のみ", activePrimaryLinksForMain === 1, `count=${activePrimaryLinksForMain} linkT1Re.id=${linkT1Re.id}`);
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
