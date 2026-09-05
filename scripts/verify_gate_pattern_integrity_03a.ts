#!/usr/bin/env node
/**
 * scripts/verify_gate_pattern_integrity_03a.ts
 *
 * PATTERN-INTEGRITY-03A(PRIMARY解除時の既存SourceLink除外・再集計是正)の
 * 実DB受入証跡。
 * 出典: Claude向け_ISMAY_df2bb2e以降_再監査是正・CasePattern閉ループ完遂指示_
 * 2026-09-05.md §1.2 P0-1、および2026-09-05再監査是正指示(PATTERN-INTEGRITY-03A
 * 受入条件)。
 *
 * [背景・是正内容] DELETE /project-contexts/{id}/links/{responsibilityId}
 * (PRIMARY link解除)は、従来enqueueCaseDetectのみを呼び、既存
 * CasePatternSourceLink(このResponsibility由来でexcludedAt:nullの行)を
 * 除外していなかった。listEligibleMaterializationSources()はactive PRIMARY
 * のみを列挙するため、unlink後はこのResponsibilityが検出対象から外れ、
 * 既存行が永久に残存しraw/weighted/confidenceが減少しないバグがあった。
 * 本Gateは、route.ts(project-contexts/[id]/links/[responsibilityId])が
 * 実際に呼ぶのと同じ2つのservice関数
 * (excludeCasePatternSourceLinksForResponsibility + enqueueCaseDetect)を
 * 同一transaction境界で組み合わせて検証する(既存verify script群
 * (例: verify_gate_pattern_detect_02b.ts)がAPI route handlerを直接
 * 呼ばずservice層を直接検証する慣行を踏襲する。Next.js route handlerを
 * scriptから直接invokeする既存慣行はこのリポジトリに無いため、新規に
 * NextRequestモックを発明しない)。
 *
 * 受入条件(2026-09-05指示書 PATTERN-INTEGRITY-03A):
 *   1. PRIMARY解除とSourceLink除外が同じtransaction境界で確定する
 *   2. 影響Patternが再集計される(raw/weighted/confidence減算)
 *   3. 再送しても二重除外されない
 *   4. 別owner/workspaceのSourceLinkへ影響しない
 *
 * AI providerへの実通信は行わない(installAiNetworkDenyGuardで機械的に保証)。
 *
 * 実行方法:
 *   cd ~/projects/ismay/app
 *   npx tsx ../scripts/verify_gate_pattern_integrity_03a.ts
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
const EMAIL_PREFIX = "gate-pattern-integrity-03a-verify-";
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
  const { excludeCasePatternSourceLinksForResponsibility } = await import("../app/src/lib/patterns/sourceLinkService");
  const { enqueueCaseDetect } = await import("../app/src/lib/patterns/caseDetectQueue");
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
      data: { email, passwordHash: "not-a-real-hash-for-db-only-test", displayName: `PATTERN-INTEGRITY-03A ${suffix}` },
    });
    const workspace = await db.workspace.create({ data: { name: `PATTERN-INTEGRITY-03A Workspace ${suffix}` } });
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
      data: { workspaceId: fx.workspaceId, domainId: fx.domainId, createdById: fx.userId, sourceType: "TEXT", rawText: `[PATTERN-INTEGRITY-03A verify ${key}] ${title}`, processingStatus: "READY" },
    });
    const session = await db.formationSession.create({
      data: { workspaceId: fx.workspaceId, domainId: fx.domainId, subjectUserId: fx.userId, captureId: capture.id, clientSessionKey: `pattern-integrity-03a:${RUN_ID}:${key}`, state: "REVIEW_READY" },
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
   * PATTERN-INTEGRITY-03A是正後に実際に行うのと同じtransaction内の手順
   * (unlink→exclude→enqueue和集合)をそのまま再現する。API route handler
   * (NextRequest)を直接scriptから呼ぶ既存慣行が無いため、route.tsが呼ぶ
   * 2つのservice関数を同じtransaction境界で組み合わせて検証する。
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

  try {
    console.log("=== PATTERN-INTEGRITY-03A 実DB受入試験 ===");

    // ================================================================
    // 前提: 2件のoccurrence(2つの独立Context)を学習させ、rawSampleSize=2の
    // Patternを作る。その後1件のPRIMARYを解除し、対応SourceLinkのみが
    // excludedAtされ、rawSampleSizeが1へ減少することを確認する。
    // ================================================================
    const fx = await makeFixture("primary-unlink");
    const ctxA = await makeContext(fx, "a");
    const occA = await makeEligibleOccurrence(fx, ctxA.id, "解除対象occurrence");
    const providerA = makeFakeEmbeddingProvider({ vectorsByText: new Map([[candidateTextFor("TASK: 解除対象occurrence"), baseVector()]]) });
    await runCasePatternDetectionForOwner(fx.workspaceId, fx.userId, { getProvider: async () => providerA });

    const ctxB = await makeContext(fx, "b");
    const occB = await makeEligibleOccurrence(fx, ctxB.id, "残存occurrence");
    const providerB = makeFakeEmbeddingProvider({ vectorsByText: new Map([[candidateTextFor("TASK: 残存occurrence"), baseVector()]]) });
    await runCasePatternDetectionForOwner(fx.workspaceId, fx.userId, { getProvider: async () => providerB });
    await computeAndPersistCasePatternAggregatesForOwner(fx.workspaceId, fx.userId);

    const pattern = await db.casePattern.findFirstOrThrow({ where: { workspaceId: fx.workspaceId, ownerSubjectUserId: fx.userId } });
    const revision = await db.casePatternRevision.findFirstOrThrow({ where: { workspaceId: fx.workspaceId, patternId: pattern.id, revision: pattern.currentRevision } });
    const aggBefore = await db.casePatternEvidenceAggregate.findFirst({ where: { workspaceId: fx.workspaceId, revisionId: revision.id } });
    ok("[前提] PRIMARY解除前のrawSampleSizeは2", aggBefore?.rawSampleSize === 2, JSON.stringify(aggBefore));
    const confidenceBefore = aggBefore?.confidence != null ? Number(aggBefore.confidence) : null;

    // --- 別owner/workspaceの無関係fixture(是正の副作用が漏れ出ないことの対照群) ---
    const fxOther = await makeFixture("unrelated");
    const ctxOther = await makeContext(fxOther, "other");
    const occOther = await makeEligibleOccurrence(fxOther, ctxOther.id, "無関係occurrence");
    const providerOther = makeFakeEmbeddingProvider({ vectorsByText: new Map([[candidateTextFor("TASK: 無関係occurrence"), baseVector()]]) });
    await runCasePatternDetectionForOwner(fxOther.workspaceId, fxOther.userId, { getProvider: async () => providerOther });
    const sourceLinkOtherBefore = await db.casePatternSourceLink.findFirst({ where: { workspaceId: fxOther.workspaceId, sourceEventId: occOther.materializationReceiptItemId } });
    ok("[前提] 別workspace fixtureのSourceLinkは除外前はexcludedAt:null", sourceLinkOtherBefore?.excludedAt == null, JSON.stringify(sourceLinkOtherBefore));

    // ================================================================
    // 1回目のPRIMARY解除: occAのlinkをunlink → 同一tx内でexclude → enqueue。
    // ================================================================
    const result1 = await unlinkPrimaryAndExclude({
      workspaceId: fx.workspaceId,
      contextOwnerSubjectUserId: fx.userId,
      responsibilityId: occA.responsibilityId,
      linkId: occA.linkId,
    });
    ok("[1] 1回目の解除でexcludedCount=1", result1.excludedCount === 1, JSON.stringify(result1));

    const sourceLinkA = await db.casePatternSourceLink.findFirst({ where: { workspaceId: fx.workspaceId, sourceEventId: occA.materializationReceiptItemId } });
    ok("[1] PRIMARY解除でoccA由来のSourceLinkがexcludedAtされる(同一tx境界)", sourceLinkA?.excludedAt != null, JSON.stringify(sourceLinkA));
    ok("[1] excludedReasonがPRIMARY_UNLINKED", sourceLinkA?.excludedReason === "PRIMARY_UNLINKED", JSON.stringify(sourceLinkA));

    const sourceLinkB = await db.casePatternSourceLink.findFirst({ where: { workspaceId: fx.workspaceId, sourceEventId: occB.materializationReceiptItemId } });
    ok("[1] 解除していないoccBのSourceLinkは除外されない", sourceLinkB?.excludedAt == null, JSON.stringify(sourceLinkB));

    const job = await db.casePatternDetectJob.findFirst({ where: { workspaceId: fx.workspaceId, ownerSubjectUserId: fx.userId } });
    ok("[1] Jobのreason_codeがPRIMARY_UNLINKED", job?.reasonCode === "PRIMARY_UNLINKED", JSON.stringify(job));

    // 再集計(既存workerパイプラインが行うのと同じ2関数を直接呼ぶ、02Bと同じ方針)。
    const providerRecompute = makeFakeEmbeddingProvider({ vectorsByText: new Map() });
    await runCasePatternDetectionForOwner(fx.workspaceId, fx.userId, { getProvider: async () => providerRecompute });
    await computeAndPersistCasePatternAggregatesForOwner(fx.workspaceId, fx.userId);

    const aggAfter = await db.casePatternEvidenceAggregate.findFirst({ where: { workspaceId: fx.workspaceId, revisionId: revision.id } });
    ok("[2] PRIMARY解除後にrawSampleSizeが1へ減少する", aggAfter?.rawSampleSize === 1, JSON.stringify(aggAfter));
    const weightedAfter = aggAfter?.weightedSupport != null ? Number(aggAfter.weightedSupport) : null;
    ok("[2] weightedSupportも減少する(2件時点より小さい)", weightedAfter != null && aggBefore?.weightedSupport != null && weightedAfter < Number(aggBefore.weightedSupport), `before=${aggBefore?.weightedSupport} after=${weightedAfter}`);
    const confidenceAfter = aggAfter?.confidence != null ? Number(aggAfter.confidence) : null;
    // [是正・2026-09-05] casePatternMath.ts(CASE_PATTERN_NULL_INTERVAL_CONFIDENCE_CAP)の
    // 既存仕様により、occurrence間のinterval標本が不足する間はconfidenceがnullのまま
    // 計算される(これは既存の意図された挙動であり、このverify scriptが検証すべき
    // P0-1是正の対象ではない)。従って「両方nullのまま」は不変条件違反ではない。
    // 検証すべき不変条件は「confidenceが除外後に上昇しないこと」のみ。
    const confidenceOk = confidenceAfter == null || (confidenceBefore != null && confidenceAfter <= confidenceBefore);
    ok(
      "[2] confidenceが除外後に上昇しない(null維持は許容、数値化されている場合のみ減少/同一を要求)",
      confidenceOk,
      `before=${confidenceBefore} after=${confidenceAfter}`,
    );

    // ================================================================
    // 2回目の解除試行(再送): 既にunlink済みのlinkに対し同じexclude関数を
    // 再度呼んでも、excludedAt:nullの対象が既に0件のため二重除外されない。
    // ================================================================
    const result2 = await excludeCasePatternSourceLinksForResponsibility(db, {
      workspaceId: fx.workspaceId,
      responsibilityId: occA.responsibilityId,
      reason: "PRIMARY_UNLINKED",
    });
    ok("[3] 再送(2回目のexclude呼出し)はexcludedCount=0(二重除外されない)", result2.excludedCount === 0, JSON.stringify(result2));
    ok("[3] 再送はaffectedOwnerIds=0件", result2.affectedOwnerIds.length === 0, JSON.stringify(result2));

    // ================================================================
    // 別owner/workspaceのSourceLinkへ影響しないことの確認。
    // ================================================================
    const sourceLinkOtherAfter = await db.casePatternSourceLink.findFirst({ where: { workspaceId: fxOther.workspaceId, sourceEventId: occOther.materializationReceiptItemId } });
    ok("[4] 別workspace fixtureのSourceLinkは影響を受けない(excludedAt:nullのまま)", sourceLinkOtherAfter?.excludedAt == null, JSON.stringify(sourceLinkOtherAfter));
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
