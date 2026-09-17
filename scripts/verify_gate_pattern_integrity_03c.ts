#!/usr/bin/env node
/**
 * scripts/verify_gate_pattern_integrity_03c.ts
 *
 * PATTERN-INTEGRITY-03C(generation原子性: DB確定直前のgeneration
 * lock・stale時rollback・即時PENDING再送)の実DB受入証跡。
 * 出典: ISMAY_ハンドオフ資料_2026-09-05_続き3.md §4「未着手:
 * PATTERN-INTEGRITY-03C」、§4.3 受入条件。
 *
 * [背景・是正内容] caseDetectQueueJob.tsのprocessOneJobは、従来
 * runDetection()(全DB書込み)を実行後にcompleteCaseDetectJobでgenerationを
 * 検証していたため、処理中にcoalescing(enqueueCaseDetectによるgeneration
 * 増加)が起きても、既にcommit済みの副作用(Pattern/Revision/Embedding/
 * SourceLink/Aggregate/Receipt)は残ってしまっていた。本Gateは、
 * assertCaseDetectJobGenerationCurrent(SELECT...FOR UPDATE)を各source・各
 * Aggregate確定の直前でtransaction先頭に置き、不一致時はtransaction全体を
 * rollbackさせ、CaseDetectJobGenerationStaleErrorとして呼び出し元へ伝播
 * させる。caseDetectQueueJob.ts側はこの例外を通常失敗と区別し、backoff・
 * attempt増加なしで即座にJobをPENDINGへ戻す。
 *
 * 受入条件(ハンドオフ資料§4.3):
 *   1. generationが処理中に更新された場合、旧generationによる
 *      Pattern/Revision/Embedding/SourceLink/Aggregate/Receiptの副作用を
 *      commitしない
 *   2. 単にcompleteCaseDetectJobでPENDINGへ戻すだけでは不合格
 *      (→本Gateはtransaction rollbackで実際に副作用が残らないことを検証する)
 *   3. AI/Embeddingはtransaction外でよいが、DB確定直前にgenerationをlock
 *      付きで再確認する
 *   4. generation確認と全DB副作用を同一transaction内で確定する
 *   5. 外部通信を長時間transactionへ含めない
 *   6. 旧generation失効時は取得済みEmbedding結果を破棄し、新generationで
 *      再実行する(→再claim後の再実行が正常completion に至ることを検証する)
 *
 * AI providerへの実通信は行わない(installAiNetworkDenyGuardで機械的に保証)。
 *
 * 実行方法:
 *   cd ~/projects/ismay/app
 *   npx tsx ../scripts/verify_gate_pattern_integrity_03c.ts
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
const EMAIL_PREFIX = "gate-pattern-integrity-03c-verify-";
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

function baseVector(): number[] {
  const v = new Array(DIMENSIONS).fill(0);
  v[0] = 1;
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
  const { computeAndPersistCasePatternAggregate, computeAndPersistCasePatternAggregatesForOwner } = await import(
    "../app/src/lib/patterns/casePatternAggregation"
  );
  const {
    enqueueCaseDetect,
    claimCaseDetectJobs,
    completeCaseDetectJob,
    requeueCaseDetectJobForStaleGeneration,
    assertCaseDetectJobGenerationCurrent,
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
      data: { email, passwordHash: "not-a-real-hash-for-db-only-test", displayName: `PATTERN-INTEGRITY-03C ${suffix}` },
    });
    const workspace = await db.workspace.create({ data: { name: `PATTERN-INTEGRITY-03C Workspace ${suffix}` } });
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
      data: { workspaceId: fx.workspaceId, domainId: fx.domainId, createdById: fx.userId, sourceType: "TEXT", rawText: `[PATTERN-INTEGRITY-03C verify ${key}] ${title}`, processingStatus: "READY" },
    });
    const session = await db.formationSession.create({
      data: { workspaceId: fx.workspaceId, domainId: fx.domainId, subjectUserId: fx.userId, captureId: capture.id, clientSessionKey: `pattern-integrity-03c:${RUN_ID}:${key}`, state: "REVIEW_READY" },
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

  const WORKER_ID = `verify-03c-worker-${RUN_ID}`;

  try {
    console.log("=== PATTERN-INTEGRITY-03C 実DB受入試験 ===");

    // ================================================================
    // [A] assertCaseDetectJobGenerationCurrentの単体挙動: 一致すれば通過、
    // 不一致ならCaseDetectJobGenerationStaleErrorを投げ、同一tx内の後続
    // 書込みもrollbackされる。
    // ================================================================
    const fxA = await makeFixture("assert-unit");
    const jobA = await db.casePatternDetectJob.create({
      data: { workspaceId: fxA.workspaceId, ownerSubjectUserId: fxA.userId, status: "PROCESSING", generation: 5, attempt: 1, nextAttemptAt: new Date(), reasonCode: "PRIMARY_LINKED" },
    });

    await db.$transaction(async (tx) => {
      await assertCaseDetectJobGenerationCurrent(tx, jobA.id, 5);
    });
    ok("[A-1] generation一致時はassertCaseDetectJobGenerationCurrentが通過する", true);

    let staleThrown = false;
    try {
      await db.$transaction(async (tx) => {
        await assertCaseDetectJobGenerationCurrent(tx, jobA.id, 4);
        // 到達しないはずの書込み(rollbackされることを後で確認する)。
        await tx.casePatternDetectJob.update({ where: { id: jobA.id }, data: { reasonCode: "PRIMARY_UNLINKED" } });
      });
    } catch (err) {
      staleThrown = err instanceof CaseDetectJobGenerationStaleError;
    }
    ok("[A-2] generation不一致時はCaseDetectJobGenerationStaleErrorを投げる", staleThrown);

    const jobAAfter = await db.casePatternDetectJob.findUniqueOrThrow({ where: { id: jobA.id } });
    ok("[A-3] stale検出時、同一tx内の後続書込みはrollbackされる(reasonCode変化なし)", jobAAfter.reasonCode === "PRIMARY_LINKED", JSON.stringify(jobAAfter));

    // ================================================================
    // [B] runCasePatternDetectionForOwner: 処理中のcoalescing(generation
    // 増加)をembed()呼出しの副作用として注入し、DB確定直前のlockで検出
    // させる。副作用が一切commitされないこと、その後の即時再送→再実行で
    // 正常completeすることを確認する。
    // ================================================================
    const fxB = await makeFixture("stale-e2e");
    const ctxB = await makeContext(fxB, "main");
    const occB = await makeEligibleOccurrence(fxB, ctxB.id, "stale generation対象occurrence");

    const enqueueResult = await enqueueCaseDetect(db, { workspaceId: fxB.workspaceId, ownerSubjectUserId: fxB.userId, reasonCode: "PRIMARY_LINKED" });
    const claimed1 = await claimCaseDetectJobs(WORKER_ID, 10);
    const claimedJobB = claimed1.find((j) => j.id === enqueueResult.id);
    if (!claimedJobB) throw new Error("[verify script bug] claimCaseDetectJobsでJobをclaimできなかった");
    ok("[B-0] claim直後のgenerationは1", claimedJobB.generation === 1, JSON.stringify(claimedJobB));

    let coalesceInjected = false;
    const providerWithCoalescing = makeFakeEmbeddingProvider({
      vectorsByText: new Map([[candidateTextFor("TASK: stale generation対象occurrence"), baseVector()]]),
      onEmbedCall: async () => {
        if (coalesceInjected) return;
        coalesceInjected = true;
        // [race再現] AI呼出し完了後・DB確定直前に、別リクエスト(title訂正等)が
        // 同じJobへenqueueCaseDetectしてgenerationをcoalesceさせた状況を再現する。
        await enqueueCaseDetect(db, { workspaceId: fxB.workspaceId, ownerSubjectUserId: fxB.userId, reasonCode: "RESPONSIBILITY_CORRECTED" });
      },
    });

    let staleErrorFromDetection: unknown = null;
    try {
      await runCasePatternDetectionForOwner(
        fxB.workspaceId,
        fxB.userId,
        { getProvider: async () => providerWithCoalescing },
        { jobId: claimedJobB.id, generation: claimedJobB.generation },
      );
    } catch (err) {
      staleErrorFromDetection = err;
    }
    ok("[B-1] coalescing発生時、runCasePatternDetectionForOwnerがCaseDetectJobGenerationStaleErrorを投げる", staleErrorFromDetection instanceof CaseDetectJobGenerationStaleError, String(staleErrorFromDetection));

    const sourceLinkAfterStale = await db.casePatternSourceLink.findFirst({ where: { workspaceId: fxB.workspaceId, sourceEventId: occB.materializationReceiptItemId } });
    ok("[B-2] stale検出時、SourceLinkは一切commitされない", sourceLinkAfterStale == null, JSON.stringify(sourceLinkAfterStale));
    const receiptAfterStale = await db.casePatternDetectionReceipt.findFirst({ where: { workspaceId: fxB.workspaceId, sourceEventId: occB.materializationReceiptItemId } });
    ok("[B-3] stale検出時、Receiptも一切commitされない", receiptAfterStale == null, JSON.stringify(receiptAfterStale));
    const patternAfterStale = await db.casePattern.findFirst({ where: { workspaceId: fxB.workspaceId, ownerSubjectUserId: fxB.userId } });
    ok("[B-4] stale検出時、新規CasePatternも作成されない", patternAfterStale == null, JSON.stringify(patternAfterStale));

    const jobBAfterStale = await db.casePatternDetectJob.findUniqueOrThrow({ where: { id: claimedJobB.id } });
    ok("[B-5] coalescingを起こしたenqueueCaseDetect自体は正常にgenerationを進める(2)", jobBAfterStale.generation === 2, JSON.stringify(jobBAfterStale));
    ok("[B-6] stale検出そのものはJobのstatusを変えない(caseDetectQueueJob側の責務、この時点ではPROCESSINGのまま)", jobBAfterStale.status === "PROCESSING", JSON.stringify(jobBAfterStale));

    // caseDetectQueueJob.tsのprocessOneJob相当の後処理: 即時PENDING化。
    const requeueResult = await requeueCaseDetectJobForStaleGeneration(claimedJobB.id);
    ok("[B-7] requeueCaseDetectJobForStaleGenerationはstatusをPENDINGへ戻す", requeueResult.status === "PENDING");
    const jobBAfterRequeue = await db.casePatternDetectJob.findUniqueOrThrow({ where: { id: claimedJobB.id } });
    ok("[B-8] 即時PENDING化はgenerationを変えない(coalescing分の2のまま)", jobBAfterRequeue.generation === 2, JSON.stringify(jobBAfterRequeue));
    ok("[B-9] 即時PENDING化はleaseOwnerをクリアする", jobBAfterRequeue.leaseOwner == null, JSON.stringify(jobBAfterRequeue));

    // 新generationで再claim・再実行(取得済み旧Embeddingは破棄され、新
    // generationとして最初から再実行される)。今回はcoalescingを注入しない
    // 通常のfake providerで正常completeさせる。
    const claimed2 = await claimCaseDetectJobs(WORKER_ID, 10);
    const claimedJobB2 = claimed2.find((j) => j.id === claimedJobB.id);
    if (!claimedJobB2) throw new Error("[verify script bug] 再claimでJobを取得できなかった");
    ok("[B-10] 再claim後のgenerationは2(coalescing分を引き継ぐ)", claimedJobB2.generation === 2, JSON.stringify(claimedJobB2));

    const providerClean = makeFakeEmbeddingProvider({
      vectorsByText: new Map([[candidateTextFor("TASK: stale generation対象occurrence"), baseVector()]]),
    });
    await runCasePatternDetectionForOwner(
      fxB.workspaceId,
      fxB.userId,
      { getProvider: async () => providerClean },
      { jobId: claimedJobB2.id, generation: claimedJobB2.generation },
    );
    await computeAndPersistCasePatternAggregatesForOwner(fxB.workspaceId, fxB.userId, { jobId: claimedJobB2.id, generation: claimedJobB2.generation });
    const completeResult = await completeCaseDetectJob(claimedJobB2.id, claimedJobB2.generation);
    ok("[B-11] 再実行後、completeCaseDetectJobがDONEを返す", completeResult.status === "DONE", JSON.stringify(completeResult));

    const sourceLinkFinal = await db.casePatternSourceLink.findMany({ where: { workspaceId: fxB.workspaceId, sourceEventId: occB.materializationReceiptItemId } });
    ok("[B-12] 最終的にSourceLinkはちょうど1件(重複commitなし)", sourceLinkFinal.length === 1, JSON.stringify(sourceLinkFinal));
    const receiptFinal = await db.casePatternDetectionReceipt.findMany({ where: { workspaceId: fxB.workspaceId, sourceEventId: occB.materializationReceiptItemId } });
    ok("[B-13] 最終的にReceiptもちょうど1件", receiptFinal.length === 1, JSON.stringify(receiptFinal));

    // ================================================================
    // [C] computeAndPersistCasePatternAggregateのgeneration lock: 集計側
    // 単体でもstale generation指定時はAggregate/CasePatternへ副作用を
    // commitしない。
    // ================================================================
    const patternC = await db.casePattern.findFirstOrThrow({ where: { workspaceId: fxB.workspaceId, ownerSubjectUserId: fxB.userId } });
    const aggBeforeC = await db.casePatternEvidenceAggregate.findFirst({ where: { workspaceId: fxB.workspaceId, revisionId: { in: (await db.casePatternRevision.findMany({ where: { workspaceId: fxB.workspaceId, patternId: patternC.id }, select: { id: true } })).map((r) => r.id) } } });

    const jobC = await db.casePatternDetectJob.create({
      data: { workspaceId: fxB.workspaceId, ownerSubjectUserId: fxB.userId, status: "PROCESSING", generation: 9, attempt: 1, nextAttemptAt: new Date(), reasonCode: "PRIMARY_LINKED" },
    });
    let aggStaleThrown = false;
    try {
      await computeAndPersistCasePatternAggregate(fxB.workspaceId, patternC.id, { jobId: jobC.id, generation: 999 });
    } catch (err) {
      aggStaleThrown = err instanceof CaseDetectJobGenerationStaleError;
    }
    ok("[C-1] stale generation指定時、computeAndPersistCasePatternAggregateが例外を投げる", aggStaleThrown);
    const aggAfterC = await db.casePatternEvidenceAggregate.findFirst({ where: { workspaceId: fxB.workspaceId, revisionId: aggBeforeC?.revisionId } });
    ok(
      "[C-2] stale generation指定時、AggregateのcomputedAtは更新されない",
      aggAfterC?.computedAt?.getTime() === aggBeforeC?.computedAt?.getTime(),
      `before=${aggBeforeC?.computedAt?.toISOString()} after=${aggAfterC?.computedAt?.toISOString()}`,
    );

    // ================================================================
    // [D] 後方互換: jobContext未指定時は従来通りgeneration lockなしで動作する
    // (verify script等の既存の直接呼び出し元が壊れないことの確認)。
    // ================================================================
    const fxD = await makeFixture("no-jobcontext");
    const ctxD = await makeContext(fxD, "main");
    const occD = await makeEligibleOccurrence(fxD, ctxD.id, "jobContextなしoccurrence");
    const providerD = makeFakeEmbeddingProvider({ vectorsByText: new Map([[candidateTextFor("TASK: jobContextなしoccurrence"), baseVector()]]) });
    const outcomesD = await runCasePatternDetectionForOwner(fxD.workspaceId, fxD.userId, { getProvider: async () => providerD });
    ok("[D-1] jobContext未指定でも従来通りNEW_PATTERN_CREATEDまで到達する", outcomesD[0]?.outcome === "NEW_PATTERN_CREATED", JSON.stringify(outcomesD));
    await computeAndPersistCasePatternAggregatesForOwner(fxD.workspaceId, fxD.userId);
    const aggD = await db.casePattern.findFirstOrThrow({ where: { workspaceId: fxD.workspaceId, ownerSubjectUserId: fxD.userId } });
    ok("[D-2] jobContext未指定でも集計が正常に走る", aggD.currentRevision === 1, JSON.stringify(aggD));
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
