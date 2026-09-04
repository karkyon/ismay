#!/usr/bin/env node
/**
 * scripts/verify_gate_pattern_detect_02b.ts
 *
 * PATTERN-DETECT-02B(欠落enqueue契機・削除再計算)の実DB受入証跡。
 * 出典: Claude向け_ISMAY_3b695d9以降_再監査是正・CasePattern実機能完遂指示_
 * 2026-09-04.md §4。
 *
 * 検証範囲(このGateで実装した2契機 + 02Aで見落としていたdeletedAtフィルタ):
 *   1. RESPONSIBILITY_CORRECTED: PATCH相当のtitle変更 →
 *      enqueueCaseDetectForResponsibilityCorrection → worker再実行で
 *      新しいtitleに基づく候補textが再評価される。
 *   2. EVIDENCE_EXCLUDED: DELETE相当のResponsibility論理削除 →
 *      enqueueCaseDetectForResponsibilityDeletion →
 *      CasePatternSourceLink.excludedAtがセットされ、集計(raw sample size)
 *      が減少する。
 *   3. [02A是正] 論理削除済みResponsibilityのMaterializationReceiptItemは
 *      以降のeligible source列挙から除外される。
 *
 * AI providerへの実通信は行わない(installAiNetworkDenyGuardで機械的に保証)。
 *
 * 実行方法:
 *   cd ~/projects/ismay/app
 *   npx tsx ../scripts/verify_gate_pattern_detect_02b.ts
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
const EMAIL_PREFIX = "gate-pattern-detect-02b-verify-";
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

interface FakeEmbeddingProviderOptions {
  vectorsByText: Map<string, number[]>;
  callLog?: string[];
}
function makeFakeEmbeddingProvider(opts: FakeEmbeddingProviderOptions) {
  return {
    providerName: "fake",
    modelName: "fake-embed-v1",
    dimensions: DIMENSIONS,
    async embed(input: { text: string }) {
      opts.callLog?.push(input.text);
      const vector = opts.vectorsByText.get(input.text);
      if (!vector) {
        throw new Error(`[verify script bug] fake providerに未登録のテキストが渡された: ${JSON.stringify(input.text)}`);
      }
      return { ok: true as const, vector, dimensions: DIMENSIONS, usage: { inputTokens: 0, latencyMs: 0 } };
    },
  };
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
  const {
    enqueueCaseDetectForResponsibilityCorrection,
    enqueueCaseDetectForResponsibilityDeletion,
  } = await import("../app/src/lib/patterns/casePatternTriggers");
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
      data: { email, passwordHash: "not-a-real-hash-for-db-only-test", displayName: `PATTERN-DETECT-02B ${suffix}` },
    });
    const workspace = await db.workspace.create({ data: { name: `PATTERN-DETECT-02B Workspace ${suffix}` } });
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
  ): Promise<{ responsibilityId: string; materializationReceiptItemId: string }> {
    occSeq++;
    const key = `occ${occSeq}`;
    const capture = await db.capture.create({
      data: { workspaceId: fx.workspaceId, domainId: fx.domainId, createdById: fx.userId, sourceType: "TEXT", rawText: `[PATTERN-DETECT-02B verify ${key}] ${title}`, processingStatus: "READY" },
    });
    const session = await db.formationSession.create({
      data: { workspaceId: fx.workspaceId, domainId: fx.domainId, subjectUserId: fx.userId, captureId: capture.id, clientSessionKey: `pattern-detect-02b:${RUN_ID}:${key}`, state: "REVIEW_READY" },
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

    await db.projectContextLink.create({
      data: { workspaceId: fx.workspaceId, contextId, responsibilityId, role: "PRIMARY", sourceKind: "USER" },
    });

    return { responsibilityId, materializationReceiptItemId: receiptItem.id };
  }

  try {
    console.log("=== PATTERN-DETECT-02B 実DB受入試験 ===");

    // ================================================================
    // RESPONSIBILITY_CORRECTED: title変更 → enqueue → worker再実行で
    // 新titleに基づくcandidate textが評価される(既存ReceiptがinputDigest
    // 不一致で上書きされる)。
    // ================================================================
    {
      const fx = await makeFixture("corrected");
      const ctx = await makeContext(fx, "corrected");
      const occ = await makeEligibleOccurrence(fx, ctx.id, "旧タイトル");
      const provider1 = makeFakeEmbeddingProvider({ vectorsByText: new Map([[candidateTextFor("TASK: 旧タイトル"), baseVector()]]) });
      const outcomes1 = await runCasePatternDetectionForOwner(fx.workspaceId, fx.userId, { getProvider: async () => provider1 });
      ok("[RESPONSIBILITY_CORRECTED前提] 初回検出はNEW_PATTERN_CREATED", outcomes1.length === 1 && outcomes1[0]!.outcome === "NEW_PATTERN_CREATED", JSON.stringify(outcomes1));

      const receiptBefore = await db.casePatternDetectionReceipt.findFirst({ where: { workspaceId: fx.workspaceId, sourceEventId: occ.materializationReceiptItemId } });
      const digestBefore = receiptBefore?.inputDigest;

      await db.responsibility.update({ where: { id: occ.responsibilityId }, data: { title: "新タイトル", version: { increment: 1 } } });
      await enqueueCaseDetectForResponsibilityCorrection(db, { workspaceId: fx.workspaceId, responsibilityId: occ.responsibilityId });

      const job = await db.casePatternDetectJob.findFirst({ where: { workspaceId: fx.workspaceId, ownerSubjectUserId: fx.userId } });
      ok("[RESPONSIBILITY_CORRECTED] enqueueによりJobが作成される", job != null, JSON.stringify(job));
      ok("[RESPONSIBILITY_CORRECTED] Jobのreason_codeがRESPONSIBILITY_CORRECTED", job?.reasonCode === "RESPONSIBILITY_CORRECTED", JSON.stringify(job));

      const provider2 = makeFakeEmbeddingProvider({ vectorsByText: new Map([[candidateTextFor("TASK: 新タイトル"), baseVector()]]) });
      const outcomes2 = await runCasePatternDetectionForOwner(fx.workspaceId, fx.userId, { getProvider: async () => provider2 });
      ok("[RESPONSIBILITY_CORRECTED] title変更後の再実行は同一source 1件が再処理される", outcomes2.length === 1, JSON.stringify(outcomes2));

      const receiptAfter = await db.casePatternDetectionReceipt.findFirst({ where: { workspaceId: fx.workspaceId, sourceEventId: occ.materializationReceiptItemId } });
      ok("[RESPONSIBILITY_CORRECTED] Receiptのinput_digestが変化する(同一行をupdate、件数は増えない)", receiptAfter?.inputDigest !== digestBefore, `before=${digestBefore} after=${receiptAfter?.inputDigest}`);
      const receiptCount = await db.casePatternDetectionReceipt.count({ where: { workspaceId: fx.workspaceId, sourceEventId: occ.materializationReceiptItemId } });
      ok("[RESPONSIBILITY_CORRECTED] Receipt行数は1件のまま(create重複なし)", receiptCount === 1, `count=${receiptCount}`);
    }

    // ================================================================
    // EVIDENCE_EXCLUDED: Responsibility論理削除 → SourceLink除外 →
    // 集計(raw sample size)が減少する。
    // ================================================================
    {
      const fx = await makeFixture("excluded");
      const ctxA = await makeContext(fx, "excluded-a");
      const occA = await makeEligibleOccurrence(fx, ctxA.id, "削除対象occurrence");
      const providerA = makeFakeEmbeddingProvider({ vectorsByText: new Map([[candidateTextFor("TASK: 削除対象occurrence"), baseVector()]]) });
      await runCasePatternDetectionForOwner(fx.workspaceId, fx.userId, { getProvider: async () => providerA });

      const ctxB = await makeContext(fx, "excluded-b");
      const occB = await makeEligibleOccurrence(fx, ctxB.id, "残存occurrence");
      const providerB = makeFakeEmbeddingProvider({ vectorsByText: new Map([[candidateTextFor("TASK: 残存occurrence"), baseVector()]]) });
      await runCasePatternDetectionForOwner(fx.workspaceId, fx.userId, { getProvider: async () => providerB });
      await computeAndPersistCasePatternAggregatesForOwner(fx.workspaceId, fx.userId);

      const pattern = await db.casePattern.findFirstOrThrow({ where: { workspaceId: fx.workspaceId, ownerSubjectUserId: fx.userId } });
      const revision = await db.casePatternRevision.findFirstOrThrow({ where: { workspaceId: fx.workspaceId, patternId: pattern.id, revision: pattern.currentRevision } });
      const aggBefore = await db.casePatternEvidenceAggregate.findFirst({ where: { workspaceId: fx.workspaceId, revisionId: revision.id } });
      ok("[EVIDENCE_EXCLUDED前提] 削除前のrawSampleSizeは2", aggBefore?.rawSampleSize === 2, JSON.stringify(aggBefore));

      await db.$transaction(async (tx) => {
        await tx.responsibility.update({ where: { id: occA.responsibilityId }, data: { deletedAt: new Date(), version: { increment: 1 } } });
        await enqueueCaseDetectForResponsibilityDeletion(tx, { workspaceId: fx.workspaceId, responsibilityId: occA.responsibilityId });
      });

      const sourceLinkA = await db.casePatternSourceLink.findFirst({ where: { workspaceId: fx.workspaceId, sourceEventId: occA.materializationReceiptItemId } });
      ok("[EVIDENCE_EXCLUDED] 削除したResponsibility由来のSourceLinkがexcludedAtされる", sourceLinkA?.excludedAt != null, JSON.stringify(sourceLinkA));
      ok("[EVIDENCE_EXCLUDED] excludedReasonがRESPONSIBILITY_DELETED", sourceLinkA?.excludedReason === "RESPONSIBILITY_DELETED", JSON.stringify(sourceLinkA));

      const sourceLinkB = await db.casePatternSourceLink.findFirst({ where: { workspaceId: fx.workspaceId, sourceEventId: occB.materializationReceiptItemId } });
      ok("[EVIDENCE_EXCLUDED] 残存occurrenceのSourceLinkは除外されない", sourceLinkB?.excludedAt == null, JSON.stringify(sourceLinkB));

      const job = await db.casePatternDetectJob.findFirst({ where: { workspaceId: fx.workspaceId, ownerSubjectUserId: fx.userId } });
      ok("[EVIDENCE_EXCLUDED] Jobのreason_codeがEVIDENCE_EXCLUDED", job?.reasonCode === "EVIDENCE_EXCLUDED", JSON.stringify(job));

      // [注記] caseDetectQueueJob.ts(実worker)はgetActiveEmbeddingProviderを
      // 上書きできない設計(本番既定値固定)のため、AI provider未設定のこの
      // 検証用workspaceでworkerポーリングを直接動かすとprovider解決自体が
      // 失敗しうる。worker内部で呼ばれる2関数
      // (runCasePatternDetectionForOwner + computeAndPersistCasePatternAggregatesForOwner)
      // をfake providerを注入して直接呼び、同じ処理を検証する
      // (02A verify scriptと同じ方針)。Jobがenqueueされたこと自体は上のcheckで
      // 既に確認済み。
      const providerRecompute = makeFakeEmbeddingProvider({ vectorsByText: new Map() });
      await runCasePatternDetectionForOwner(fx.workspaceId, fx.userId, { getProvider: async () => providerRecompute });
      await computeAndPersistCasePatternAggregatesForOwner(fx.workspaceId, fx.userId);

      const aggAfter = await db.casePatternEvidenceAggregate.findFirst({ where: { workspaceId: fx.workspaceId, revisionId: revision.id } });
      ok("[EVIDENCE_EXCLUDED] 除外後のrawSampleSizeが1へ減少する", aggAfter?.rawSampleSize === 1, JSON.stringify(aggAfter));

      // [02A是正確認] 削除済みResponsibilityのMaterializationReceiptItemは、
      // 以降のeligible source列挙から除外される(残存occBのみが列挙され、
      // 既にReceipt済みのためSKIPPEDになる。embed() API呼出しは発生しない)。
      const callLog: string[] = [];
      const providerRerun = makeFakeEmbeddingProvider({ vectorsByText: new Map(), callLog });
      const outcomesRerun = await runCasePatternDetectionForOwner(fx.workspaceId, fx.userId, { getProvider: async () => providerRerun });
      ok("[02A是正] 削除済みResponsibility由来のsourceは再列挙されない(結果は残存occBの1件のみ)", outcomesRerun.length === 1 && outcomesRerun[0]!.sourceEventId === occB.materializationReceiptItemId, JSON.stringify(outcomesRerun));
      ok("[02A是正] 再列挙時にembed() API呼出しは発生しない(全件SKIP)", callLog.length === 0, `callLog=${JSON.stringify(callLog)}`);
    }
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
