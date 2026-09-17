#!/usr/bin/env node
/**
 * scripts/verify_gate_pattern_integrity_03d.ts
 *
 * PATTERN-INTEGRITY-03D(03Cの追加境界試験: 複数source途中coalescingの
 * 収束性、Aggregate transaction境界でのstale検出)。
 * 出典: Claude向け_ISMAY_d68e9bf以降_ActionSlot正本準拠・CasePattern実分解
 * 完遂・残工程連続実装指示_2026-09-17.md Gate 2「PATTERN-INTEGRITY-03D」。
 *
 * [背景] 03C(assertCaseDetectJobGenerationCurrent)は「1sourceのDB確定
 * transaction」「Aggregate 1件のtransaction」それぞれの先頭でgeneration
 * lockを行うが、Job全体を単一transactionにはしていない。そのため
 * runCasePatternDetectionForOwner()が複数sourceを順次処理する構成では、
 * 「1件目commit後・2件目確定前にcoalescingが起きた場合、1件目の結果は
 * 残ったまま2件目のみrollbackされ、Job全体はPENDINGへ差し戻され、次回
 * 再実行で1件目はReceipt digest一致によりSKIPされ2件目のみ再処理される」
 * という「再実行による収束」設計になっている。本scriptはこの収束性を
 * 実DBで証明する(欠陥が見つかった場合のみ実装変更が必要、指示書Gate 2)。
 *
 * 検証内容:
 *   1. eligible source 2件、1件目commit後・2件目確定前にcoalescing
 *      → 1件目の結果は保持されたまま2件目のみrollbackされ、Job全体が
 *      PENDINGへ差し戻ること
 *   2. 新generationでの再実行後、1件目はSKIP(digest一致)・2件目は正常
 *      処理され、最終的に両方とも正しくcommitされること(収束性)
 *   3. 同一sourceのactive SourceLinkが常に高々1件
 *   4. Aggregate transaction直前のcoalescingでも、Aggregateが未更新の
 *      ままstaleを検出し、正しいgenerationでの再実行後にactive SourceLink
 *      集合と一致するAggregateへ収束すること
 *   5. 他workspace/owner非干渉、cleanup後孤立データ0件、AI network実通信0
 *
 * 実行方法:
 *   cd ~/projects/ismay/app
 *   npx tsx ../scripts/verify_gate_pattern_integrity_03d.ts
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
const EMAIL_PREFIX = "gate-pattern-integrity-03d-verify-";
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
  const { computeAndPersistCasePatternAggregatesForOwner, computeAndPersistCasePatternAggregate } = await import(
    "../app/src/lib/patterns/casePatternAggregation"
  );
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
    onEmbedCall?: (callIndex: number) => Promise<void>;
  }
  function makeFakeEmbeddingProvider(opts: FakeEmbeddingProviderOptions) {
    let callIndex = 0;
    return {
      providerName: "fake",
      modelName: "fake-embed-v1",
      dimensions: DIMENSIONS,
      async embed(input: { text: string }) {
        callIndex++;
        if (opts.onEmbedCall) await opts.onEmbedCall(callIndex);
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
      data: { email, passwordHash: "not-a-real-hash-for-db-only-test", displayName: `PATTERN-INTEGRITY-03D ${suffix}` },
    });
    const workspace = await db.workspace.create({ data: { name: `PATTERN-INTEGRITY-03D Workspace ${suffix}` } });
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
      data: { workspaceId: fx.workspaceId, domainId: fx.domainId, createdById: fx.userId, sourceType: "TEXT", rawText: `[PATTERN-INTEGRITY-03D verify ${key}] ${title}`, processingStatus: "READY" },
    });
    const session = await db.formationSession.create({
      data: { workspaceId: fx.workspaceId, domainId: fx.domainId, subjectUserId: fx.userId, captureId: capture.id, clientSessionKey: `pattern-integrity-03d:${RUN_ID}:${key}`, state: "REVIEW_READY" },
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

  const WORKER_ID = `verify-03d-worker-${RUN_ID}`;

  async function claimOwn(workspaceId: string, ownerSubjectUserId: string) {
    const claimed = await claimCaseDetectJobs(WORKER_ID, 20);
    const job = claimed.find((j) => j.workspaceId === workspaceId && j.ownerSubjectUserId === ownerSubjectUserId);
    if (!job) throw new Error("[verify script bug] claimCaseDetectJobsで対象Jobをclaimできなかった");
    return job;
  }

  try {
    console.log("=== PATTERN-INTEGRITY-03D 実DB受入試験(03C追加境界検証) ===");

    // ================================================================
    // [対照group] owner/workspace分離の対照。
    // ================================================================
    const fxOther = await makeFixture("isolation-control");
    const ctxOther = await makeContext(fxOther, "main");
    const occOther = await makeEligibleOccurrence(fxOther, ctxOther.id, "対照group occurrence");
    await enqueueCaseDetect(db, { workspaceId: fxOther.workspaceId, ownerSubjectUserId: fxOther.userId, reasonCode: "PRIMARY_LINKED" });
    {
      const job = await claimOwn(fxOther.workspaceId, fxOther.userId);
      const provider = makeFakeEmbeddingProvider({ vectorsByText: new Map([[candidateTextFor("TASK: 対照group occurrence"), vectorA()]]) });
      await runCasePatternDetectionForOwner(fxOther.workspaceId, fxOther.userId, { getProvider: async () => provider }, { jobId: job.id, generation: job.generation });
      await computeAndPersistCasePatternAggregatesForOwner(fxOther.workspaceId, fxOther.userId, { jobId: job.id, generation: job.generation });
      const result = await completeCaseDetectJob(job.id, job.generation);
      ok("[前提] 対照group(fxOther)は正常にDONEで完了する", result.status === "DONE", JSON.stringify(result));
    }

    // ================================================================
    // [1〜3] メインfixture: eligible source 2件、1件目commit後・2件目確定前に
    // coalescingを注入する。
    // ================================================================
    const fx = await makeFixture("multi-source-coalescing");
    const ctxA = await makeContext(fx, "a");
    const occA = await makeEligibleOccurrence(fx, ctxA.id, "多重source A");
    const ctxB = await makeContext(fx, "b");
    const occB = await makeEligibleOccurrence(fx, ctxB.id, "多重source B");

    await enqueueCaseDetect(db, { workspaceId: fx.workspaceId, ownerSubjectUserId: fx.userId, reasonCode: "PRIMARY_LINKED" });
    const job1 = await claimOwn(fx.workspaceId, fx.userId);
    ok("[前提] claim直後のgenerationは1", job1.generation === 1, JSON.stringify(job1));

    let coalesceInjected = false;
    const providerWithMidCoalescing = makeFakeEmbeddingProvider({
      vectorsByText: new Map([
        [candidateTextFor("TASK: 多重source A"), vectorA()],
        [candidateTextFor("TASK: 多重source B"), vectorB()],
      ]),
      onEmbedCall: async (callIndex) => {
        // 1件目(occA)のembed呼出しはそのまま通す。2件目(occB)のembed呼出し
        // (=1件目のDB確定transactionが既にcommitされた後)でcoalescingを注入する。
        if (callIndex === 2 && !coalesceInjected) {
          coalesceInjected = true;
          await enqueueCaseDetect(db, { workspaceId: fx.workspaceId, ownerSubjectUserId: fx.userId, reasonCode: "RESPONSIBILITY_CORRECTED" });
        }
      },
    });

    let staleErr: unknown = null;
    try {
      await runCasePatternDetectionForOwner(fx.workspaceId, fx.userId, { getProvider: async () => providerWithMidCoalescing }, { jobId: job1.id, generation: job1.generation });
    } catch (err) {
      staleErr = err;
    }
    ok("[1] 2件目確定直前のcoalescingでCaseDetectJobGenerationStaleErrorが伝播する", staleErr instanceof CaseDetectJobGenerationStaleError, String(staleErr));

    const linkAAfterMidStale = await db.casePatternSourceLink.findFirst({ where: { workspaceId: fx.workspaceId, sourceEventId: occA.materializationReceiptItemId } });
    ok("[1] 1件目(occA)の結果はstaleの影響を受けず保持される(active SourceLink 1件)", linkAAfterMidStale != null && linkAAfterMidStale.excludedAt == null, JSON.stringify(linkAAfterMidStale));
    const receiptAAfterMidStale = await db.casePatternDetectionReceipt.findFirst({ where: { workspaceId: fx.workspaceId, sourceEventId: occA.materializationReceiptItemId } });
    ok("[1] 1件目(occA)のReceiptも保持される", receiptAAfterMidStale != null, JSON.stringify(receiptAAfterMidStale));
    const linkBAfterMidStale = await db.casePatternSourceLink.findFirst({ where: { workspaceId: fx.workspaceId, sourceEventId: occB.materializationReceiptItemId } });
    ok("[1] 2件目(occB)のSourceLinkはrollbackされ存在しない", linkBAfterMidStale == null, JSON.stringify(linkBAfterMidStale));
    const receiptBAfterMidStale = await db.casePatternDetectionReceipt.findFirst({ where: { workspaceId: fx.workspaceId, sourceEventId: occB.materializationReceiptItemId } });
    ok("[1] 2件目(occB)のReceiptもrollbackされ存在しない", receiptBAfterMidStale == null, JSON.stringify(receiptBAfterMidStale));

    // Job全体はまだPROCESSING(caseDetectQueueJob側の即時PENDING化前)。
    const jobAfterMidStale = await db.casePatternDetectJob.findUniqueOrThrow({ where: { id: job1.id } });
    ok("[1] coalescingを起こしたenqueueCaseDetect自体はgenerationを正常に進める(2)", jobAfterMidStale.generation === 2, JSON.stringify(jobAfterMidStale));

    await requeueCaseDetectJobForStaleGeneration(job1.id);
    const jobAfterRequeue = await db.casePatternDetectJob.findUniqueOrThrow({ where: { id: job1.id } });
    ok("[1] 即時PENDING化でstatusがPENDINGへ戻る(generationは2のまま)", jobAfterRequeue.status === "PENDING" && jobAfterRequeue.generation === 2, JSON.stringify(jobAfterRequeue));

    // ================================================================
    // [2] 新generationで再実行: occAはdigest一致でSKIP(embed呼出しなし)・
    // occBのみ処理される(収束性の証明)。
    // ================================================================
    const job2 = await claimOwn(fx.workspaceId, fx.userId);
    ok("[2] 再claim後のgenerationは2(coalescing分を引き継ぐ)", job2.generation === 2, JSON.stringify(job2));

    let embedCallCountOnRetry = 0;
    const providerClean = makeFakeEmbeddingProvider({
      vectorsByText: new Map([
        [candidateTextFor("TASK: 多重source A"), vectorA()],
        [candidateTextFor("TASK: 多重source B"), vectorB()],
      ]),
      onEmbedCall: async () => {
        embedCallCountOnRetry++;
      },
    });
    const outcomesRetry = await runCasePatternDetectionForOwner(fx.workspaceId, fx.userId, { getProvider: async () => providerClean }, { jobId: job2.id, generation: job2.generation });
    ok("[2] 再実行時、embed呼出しは1回のみ(occAはSKIP、occBのみ処理される)", embedCallCountOnRetry === 1, `embedCallCount=${embedCallCountOnRetry}`);
    const outcomeA = outcomesRetry.find((o) => o.sourceEventId === occA.materializationReceiptItemId);
    ok("[2] occAの再実行結果はSKIPPED(ALREADY_PROCESSED)", outcomeA?.outcome === "SKIPPED" && outcomeA.reasonCode === "ALREADY_PROCESSED", JSON.stringify(outcomeA));
    const outcomeB = outcomesRetry.find((o) => o.sourceEventId === occB.materializationReceiptItemId);
    ok("[2] occBの再実行結果はNEW_PATTERN_CREATED(正常処理される)", outcomeB?.outcome === "NEW_PATTERN_CREATED", JSON.stringify(outcomeB));

    // ================================================================
    // [3] 同一sourceのactive SourceLinkは常に高々1件。
    // ================================================================
    const activeLinksA = await db.casePatternSourceLink.count({ where: { workspaceId: fx.workspaceId, sourceEventId: occA.materializationReceiptItemId, excludedAt: null } });
    ok("[3] occAのactive SourceLinkは1件のみ", activeLinksA === 1, `count=${activeLinksA}`);
    const activeLinksB = await db.casePatternSourceLink.count({ where: { workspaceId: fx.workspaceId, sourceEventId: occB.materializationReceiptItemId, excludedAt: null } });
    ok("[3] occBのactive SourceLinkは1件のみ(retry後に正常作成される)", activeLinksB === 1, `count=${activeLinksB}`);

    // ================================================================
    // [4] Aggregate transaction直前のcoalescing。detection成功後、Aggregate
    // 確定前にgenerationを進め、stale検出とAggregate未更新を確認する。
    // ================================================================
    const patternA = await db.casePattern.findFirstOrThrow({
      where: { workspaceId: fx.workspaceId, ownerSubjectUserId: fx.userId, revisions: { some: { sourceLinks: { some: { sourceEventId: occA.materializationReceiptItemId } } } } },
    });
    const revisionA = await db.casePatternRevision.findFirstOrThrow({ where: { workspaceId: fx.workspaceId, patternId: patternA.id, revision: patternA.currentRevision } });
    const aggABeforeStaleAttempt = await db.casePatternEvidenceAggregate.findFirst({ where: { workspaceId: fx.workspaceId, revisionId: revisionA.id } });

    // job2はこの時点でまだPROCESSING(detectionは成功したがcompleteCaseDetectJob
    // 未呼出し)。ここでAggregate確定前にcoalescingを注入する。
    await enqueueCaseDetect(db, { workspaceId: fx.workspaceId, ownerSubjectUserId: fx.userId, reasonCode: "RESPONSIBILITY_CORRECTED" });
    const jobAfterAggCoalesce = await db.casePatternDetectJob.findUniqueOrThrow({ where: { id: job2.id } });
    ok("[4] Aggregate確定前のcoalescingでgenerationが3へ進む", jobAfterAggCoalesce.generation === 3, JSON.stringify(jobAfterAggCoalesce));

    let aggStaleErr: unknown = null;
    try {
      // job2.generation(=2、既にstale)のままAggregateを確定しようとする。
      await computeAndPersistCasePatternAggregatesForOwner(fx.workspaceId, fx.userId, { jobId: job2.id, generation: job2.generation });
    } catch (err) {
      aggStaleErr = err;
    }
    ok("[4] stale generationでのAggregate確定はCaseDetectJobGenerationStaleErrorを投げる", aggStaleErr instanceof CaseDetectJobGenerationStaleError, String(aggStaleErr));

    const aggAAfterStaleAttempt = await db.casePatternEvidenceAggregate.findFirst({ where: { workspaceId: fx.workspaceId, revisionId: revisionA.id } });
    ok(
      "[4] stale Aggregate確定はAggregate.computedAtを更新しない",
      aggAAfterStaleAttempt?.computedAt?.getTime() === aggABeforeStaleAttempt?.computedAt?.getTime(),
      `before=${aggABeforeStaleAttempt?.computedAt?.toISOString()} after=${aggAAfterStaleAttempt?.computedAt?.toISOString()}`,
    );

    await requeueCaseDetectJobForStaleGeneration(job2.id);

    // 正しいgenerationで再実行し、収束することを確認する。
    const job3 = await claimOwn(fx.workspaceId, fx.userId);
    ok("[4] 再claim後のgenerationは3", job3.generation === 3, JSON.stringify(job3));
    let embedCallCountOnFinalRetry = 0;
    const providerFinal = makeFakeEmbeddingProvider({
      vectorsByText: new Map([
        [candidateTextFor("TASK: 多重source A"), vectorA()],
        [candidateTextFor("TASK: 多重source B"), vectorB()],
      ]),
      onEmbedCall: async () => {
        embedCallCountOnFinalRetry++;
      },
    });
    await runCasePatternDetectionForOwner(fx.workspaceId, fx.userId, { getProvider: async () => providerFinal }, { jobId: job3.id, generation: job3.generation });
    ok("[4] 最終再実行時、occA/occBともdigest一致でSKIPされembed呼出し0回", embedCallCountOnFinalRetry === 0, `embedCallCount=${embedCallCountOnFinalRetry}`);
    await computeAndPersistCasePatternAggregatesForOwner(fx.workspaceId, fx.userId, { jobId: job3.id, generation: job3.generation });
    const completeResult3 = await completeCaseDetectJob(job3.id, job3.generation);
    ok("[4] 正しいgenerationでの最終再実行はDONEで完了する", completeResult3.status === "DONE", JSON.stringify(completeResult3));

    const aggAFinal = await db.casePatternEvidenceAggregate.findFirst({ where: { workspaceId: fx.workspaceId, revisionId: revisionA.id } });
    ok("[4] 最終的にAggregate(P_A)のrawSampleSizeはactive SourceLink集合(1件)と一致する", aggAFinal?.rawSampleSize === 1, JSON.stringify(aggAFinal));

    const patternB = await db.casePattern.findFirstOrThrow({
      where: { workspaceId: fx.workspaceId, ownerSubjectUserId: fx.userId, revisions: { some: { sourceLinks: { some: { sourceEventId: occB.materializationReceiptItemId } } } } },
    });
    const revisionB = await db.casePatternRevision.findFirstOrThrow({ where: { workspaceId: fx.workspaceId, patternId: patternB.id, revision: patternB.currentRevision } });
    const aggBFinal = await db.casePatternEvidenceAggregate.findFirst({ where: { workspaceId: fx.workspaceId, revisionId: revisionB.id } });
    ok("[4] 最終的にAggregate(P_B)のrawSampleSizeもactive SourceLink集合(1件)と一致する", aggBFinal?.rawSampleSize === 1, JSON.stringify(aggBFinal));
    ok("[前提] P_AとP_Bは別Pattern", patternA.id !== patternB.id, `A=${patternA.id} B=${patternB.id}`);

    // ================================================================
    // [5] owner/workspace分離: 対照group(fxOther)は一連の操作で一切影響を
    // 受けていないこと。
    // ================================================================
    const linkOtherFinal = await db.casePatternSourceLink.findMany({ where: { workspaceId: fxOther.workspaceId, sourceEventId: occOther.materializationReceiptItemId } });
    ok("[5] 対照group(fxOther)のSourceLinkは1件・activeのまま", linkOtherFinal.length === 1 && linkOtherFinal[0]!.excludedAt == null, JSON.stringify(linkOtherFinal));
    const jobsOtherFinal = await db.casePatternDetectJob.findMany({ where: { workspaceId: fxOther.workspaceId, ownerSubjectUserId: fxOther.userId } });
    ok("[5] 対照group(fxOther)のJobはDONEのまま(再enqueueされていない)", jobsOtherFinal.length === 1 && jobsOtherFinal[0]!.status === "DONE", JSON.stringify(jobsOtherFinal));
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
