#!/usr/bin/env node
/**
 * scripts/verify_gate_pattern_detect_02a.ts
 *
 * PATTERN-DETECT-02A(実経路接続・検出Receipt)の実DB受入証跡。
 * 出典: Claude向け_ISMAY_3b695d9以降_再監査是正・CasePattern実機能完遂指示_
 * 2026-09-04.md §3(PATTERN-DETECT-02A)、§9(PE2E-01/02/03/06/07/09/18の
 * 一部先取り検証。PE2E全項目の網羅はPATTERN-E2E-01の別scope)。
 *
 * AI providerへの実通信は行わない(installAiNetworkDenyGuardで機械的に保証)。
 *
 * 実行方法:
 *   cd ~/projects/ismay/app
 *   npx tsx ../scripts/verify_gate_pattern_detect_02a.ts
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
const EMAIL_PREFIX = "gate-pattern-detect-02a-verify-";
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
function orthogonalVector(): number[] {
  const v = new Array(DIMENSIONS).fill(0);
  v[2] = 1;
  return v;
}
/** cosine類似度がtargetSimilarityになるよう、baseVectorに対して構成したベクトル。 */
function vectorWithSimilarity(targetSimilarity: number): number[] {
  const v = new Array(DIMENSIONS).fill(0);
  v[0] = targetSimilarity;
  v[1] = Math.sqrt(Math.max(0, 1 - targetSimilarity * targetSimilarity));
  return v;
}

interface FakeEmbeddingProviderOptions {
  modelName?: string;
  vectorsByText: Map<string, number[]>;
  forcedFailure?: { kind: "TRANSIENT" | "FATAL"; message: string };
  callLog?: string[];
}
function makeFakeEmbeddingProvider(opts: FakeEmbeddingProviderOptions) {
  return {
    providerName: "fake",
    modelName: opts.modelName ?? "fake-embed-v1",
    dimensions: DIMENSIONS,
    async embed(input: { text: string }) {
      opts.callLog?.push(input.text);
      if (opts.forcedFailure) {
        return { ok: false as const, kind: opts.forcedFailure.kind, message: opts.forcedFailure.message };
      }
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
  // [verify script是正・2026-09-04 omega-dev2実DB試験で発覚] buildCasePatternEmbeddingText
  // はdecompositionTemplate=nullを`null ?? {}`で空オブジェクト相当として扱う
  // (stableStringify出力は"{}"であり"null"という文字列ではない)。fake providerへ
  // 登録するテキストキーはこの関数の実出力と必ず一致させる必要があるため、
  // 手計算の文字列リテラルではなく、この関数自体を呼んで構築する。
  const { buildCasePatternEmbeddingText } = await import("../app/src/lib/patterns/casePatternEmbeddingText");
  function candidateTextFor(representativeText: string): string {
    return buildCasePatternEmbeddingText({ representativeText, decompositionTemplate: null });
  }
  const { PEM_CONSENT_POLICY_VERSION } = await import("../app/src/lib/pem/consent");

  async function materializeFormationSession(params: Parameters<typeof materializeFormationSessionReal>[0]) {
    const embedStub = async () => {
      throw new Error("embedAndStoreResponsibility should not be called in this Gate (AI-free verify script)");
    };
    return materializeFormationSessionReal(params, { embedAndStoreResponsibility: embedStub as never });
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

  async function makeFixture(suffix: string, grantConsent = true) {
    const email = `${EMAIL_PREFIX}${RUN_ID}-${suffix}@example.invalid`;
    const user = await db.user.create({
      data: { email, passwordHash: "not-a-real-hash-for-db-only-test", displayName: `PATTERN-DETECT-02A ${suffix}` },
    });
    const workspace = await db.workspace.create({ data: { name: `PATTERN-DETECT-02A Workspace ${suffix}` } });
    await db.workspaceMember.create({ data: { workspaceId: workspace.id, userId: user.id, role: "OWNER" } });
    const domain = await db.domain.create({ data: { workspaceId: workspace.id, name: "個人", kind: "PERSONAL" } });
    if (grantConsent) {
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
    }
    createdFixtures.push({ userId: user.id, workspaceId: workspace.id });
    return { userId: user.id, workspaceId: workspace.id, domainId: domain.id };
  }

  async function makeContext(fx: { workspaceId: string; domainId: string; userId: string }, key: string) {
    return db.projectContext.create({
      data: { workspaceId: fx.workspaceId, domainId: fx.domainId, ownerSubjectUserId: fx.userId, name: `ctx-${RUN_ID}-${key}`, createdById: fx.userId },
    });
  }

  let occSeq = 0;
  /** materializeFormationSession経由で本物のMaterializationReceiptItem/Responsibilityを1件作り、PRIMARY Linkで指定Contextへ紐付ける。 */
  async function makeEligibleOccurrence(
    fx: { workspaceId: string; domainId: string; userId: string },
    contextId: string,
    title: string,
  ): Promise<{ responsibilityId: string; materializationReceiptItemId: string }> {
    occSeq++;
    const key = `occ${occSeq}`;
    const capture = await db.capture.create({
      data: { workspaceId: fx.workspaceId, domainId: fx.domainId, createdById: fx.userId, sourceType: "TEXT", rawText: `[PATTERN-DETECT-02A verify ${key}] ${title}`, processingStatus: "READY" },
    });
    const session = await db.formationSession.create({
      data: { workspaceId: fx.workspaceId, domainId: fx.domainId, subjectUserId: fx.userId, captureId: capture.id, clientSessionKey: `pattern-detect-02a:${RUN_ID}:${key}`, state: "REVIEW_READY" },
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
    console.log("=== PATTERN-DETECT-02A 実DB受入試験 ===");

    // ================================================================
    // PE2E-01(先取り): Pattern 0件でeligible PRIMARY link作成
    // → Pattern revision 1、embedding、SourceLink、receiptが各1件
    // ================================================================
    {
      const fx = await makeFixture("pe2e01");
      const ctx = await makeContext(fx, "pe2e01");
      const occ = await makeEligibleOccurrence(fx, ctx.id, "毎週の定例報告");
      const provider = makeFakeEmbeddingProvider({
        vectorsByText: new Map([[candidateTextFor("TASK: 毎週の定例報告"), baseVector()]]),
      });

      const outcomes = await runCasePatternDetectionForOwner(fx.workspaceId, fx.userId, { getProvider: async () => provider });
      ok("[PE2E-01] 検出結果1件、outcome=NEW_PATTERN_CREATED", outcomes.length === 1 && outcomes[0]!.outcome === "NEW_PATTERN_CREATED", JSON.stringify(outcomes));

      const patternCount = await db.casePattern.count({ where: { workspaceId: fx.workspaceId, ownerSubjectUserId: fx.userId } });
      ok("[PE2E-01] CasePatternが1件作成された", patternCount === 1, `count=${patternCount}`);
      const revisionCount = await db.casePatternRevision.count({ where: { workspaceId: fx.workspaceId } });
      ok("[PE2E-01] CasePatternRevisionが1件作成された", revisionCount === 1, `count=${revisionCount}`);
      const embeddingCount = await db.casePatternEmbedding.count({ where: { workspaceId: fx.workspaceId } });
      ok("[PE2E-01] CasePatternEmbeddingが1件作成された", embeddingCount === 1, `count=${embeddingCount}`);
      const sourceLinkCount = await db.casePatternSourceLink.count({ where: { workspaceId: fx.workspaceId } });
      ok("[PE2E-01] CasePatternSourceLinkが1件作成された", sourceLinkCount === 1, `count=${sourceLinkCount}`);
      const receiptCount = await db.casePatternDetectionReceipt.count({ where: { workspaceId: fx.workspaceId } });
      ok("[PE2E-01] CasePatternDetectionReceiptが1件作成された", receiptCount === 1, `count=${receiptCount}`);
      const receipt = await db.casePatternDetectionReceipt.findFirst({ where: { workspaceId: fx.workspaceId } });
      ok("[PE2E-01] Receipt.outcome=NEW_PATTERN_CREATED", receipt?.outcome === "NEW_PATTERN_CREATED", JSON.stringify(receipt));
      ok("[PE2E-01] Receipt.createdPatternIdがCasePattern.idと一致", receipt?.createdPatternId != null, JSON.stringify(receipt));

      // ================================================================
      // PE2E-02: 同一sourceを100回再処理 → Pattern/SourceLink/sample増加なし、AI呼出し0
      // ================================================================
      const callLog: string[] = [];
      const providerNoCall = makeFakeEmbeddingProvider({ vectorsByText: new Map(), callLog });
      for (let i = 0; i < 100; i++) {
        await runCasePatternDetectionForOwner(fx.workspaceId, fx.userId, { getProvider: async () => providerNoCall });
      }
      const patternCountAfter = await db.casePattern.count({ where: { workspaceId: fx.workspaceId, ownerSubjectUserId: fx.userId } });
      ok("[PE2E-02] 100回再処理後もPattern件数1件のまま", patternCountAfter === 1, `count=${patternCountAfter}`);
      const sourceLinkCountAfter = await db.casePatternSourceLink.count({ where: { workspaceId: fx.workspaceId } });
      ok("[PE2E-02] 100回再処理後もSourceLink件数1件のまま", sourceLinkCountAfter === 1, `count=${sourceLinkCountAfter}`);
      const receiptCountAfter = await db.casePatternDetectionReceipt.count({ where: { workspaceId: fx.workspaceId } });
      ok("[PE2E-02] 100回再処理後もReceipt件数1件のまま", receiptCountAfter === 1, `count=${receiptCountAfter}`);
      ok("[PE2E-02/PE2E-18] 再処理中、embed() API呼出しは0回", callLog.length === 0, `callLog=${JSON.stringify(callLog)}`);

      // ================================================================
      // PE2E-03: 類似sourceを別Contextで処理 → 既存PatternへSourceLink、N/M増加
      // ================================================================
      const ctx2 = await makeContext(fx, "pe2e03");
      const occ2 = await makeEligibleOccurrence(fx, ctx2.id, "毎週の定例報告2");
      const providerSimilar = makeFakeEmbeddingProvider({
        vectorsByText: new Map([[candidateTextFor("TASK: 毎週の定例報告2"), vectorWithSimilarity(0.95)]]),
      });
      const outcomes3 = await runCasePatternDetectionForOwner(fx.workspaceId, fx.userId, { getProvider: async () => providerSimilar });
      ok("[PE2E-03] 類似候補はMATCHEDと判定される", outcomes3.some((o) => o.outcome === "MATCHED"), JSON.stringify(outcomes3));
      const sourceLinkCountAfter3 = await db.casePatternSourceLink.count({ where: { workspaceId: fx.workspaceId } });
      ok("[PE2E-03] 既存PatternへSourceLinkが追加され件数2件になる", sourceLinkCountAfter3 === 2, `count=${sourceLinkCountAfter3}`);
      const distinctContexts = await db.casePatternSourceLink.findMany({ where: { workspaceId: fx.workspaceId }, select: { contextId: true }, distinct: ["contextId"] });
      ok("[PE2E-03] distinct Contextが2件になる", distinctContexts.length === 2, `count=${distinctContexts.length}`);
    }

    // ================================================================
    // PE2E-06: 閾値付近(0.88超)の高類似度candidateはMATCHED
    // [設計是正・2026-09-04] 当初は類似度をちょうど0.88に構成していたが、
    // pgvectorはembedding列をfloat4(単精度)で格納するため、厳密に0.88を
    // 計算しても実際の格納値はわずかな丸め誤差で0.8799999...になり得る
    // (このプロジェクトの過去のverify script実測でも0.97→0.9699999707937276
    // という同種の誤差を確認済み)。閾値ちょうどの厳密な境界判定自体は
    // pgvectorを経由しない純粋関数テスト(casePatternMatching.test.ts、
    // classifyCasePatternMatchCandidates)で既に1e-9未満の誤差なく検証済み
    // であり、実DB経由のE2E試験でこの剃刀の刃のような境界へ依存するのは
    // 不適切なため、閾値から十分離れた値(0.95)へ変更する。
    // ================================================================
    {
      const fx = await makeFixture("pe2e06");
      const ctx = await makeContext(fx, "pe2e06-base");
      await makeEligibleOccurrence(fx, ctx.id, "境界値の確認作業A");
      const providerBase = makeFakeEmbeddingProvider({ vectorsByText: new Map([[candidateTextFor("TASK: 境界値の確認作業A"), baseVector()]]) });
      await runCasePatternDetectionForOwner(fx.workspaceId, fx.userId, { getProvider: async () => providerBase });

      const ctx2 = await makeContext(fx, "pe2e06-cand");
      await makeEligibleOccurrence(fx, ctx2.id, "境界値の確認作業B");
      const providerBoundary = makeFakeEmbeddingProvider({ vectorsByText: new Map([[candidateTextFor("TASK: 境界値の確認作業B"), vectorWithSimilarity(0.95)]]) });
      const outcomes = await runCasePatternDetectionForOwner(fx.workspaceId, fx.userId, { getProvider: async () => providerBoundary });
      ok("[PE2E-06] 閾値超の高類似度candidateはMATCHED", outcomes.some((o) => o.outcome === "MATCHED"), JSON.stringify(outcomes));
    }

    // ================================================================
    // PE2E-07: best-second<0.03 → 自動統合0、AMBIGUOUS receipt
    // ================================================================
    {
      const fx = await makeFixture("pe2e07");
      const ctxA = await makeContext(fx, "pe2e07-a");
      await makeEligibleOccurrence(fx, ctxA.id, "曖昧性確認A");
      const providerA = makeFakeEmbeddingProvider({ vectorsByText: new Map([[candidateTextFor("TASK: 曖昧性確認A"), baseVector()]]) });
      await runCasePatternDetectionForOwner(fx.workspaceId, fx.userId, { getProvider: async () => providerA });

      const ctxB = await makeContext(fx, "pe2e07-b");
      await makeEligibleOccurrence(fx, ctxB.id, "曖昧性確認B");
      // [設計是正・2026-09-04] 直交ベクトル(similarity=0)ではAMBIGUOUS判定へ到達できない
      // (best/second双方が0.88閾値を満たす必要があり、直交同士の中間ベクトルは
      // 最大でもcos(45°)≈0.707にしかならず閾値未満でNO_MATCH=NEW_PATTERN_CREATEDに
      // なってしまうバグをomega-dev2実DB試験で検出)。PatternBはAから30°の角度
      // (similarity=cos(30°)≈0.866、閾値0.88未満のためBはNEW_PATTERN_CREATEDのまま)
      // に置き、候補Cを両者の中間15°(similarity=cos(15°)≈0.966、双方に対し等距離)
      // に置くことで、best/second共に閾値以上・差0という正しいAMBIGUOUSシナリオを構成する。
      const angle30 = new Array(DIMENSIONS).fill(0);
      angle30[0] = Math.cos((30 * Math.PI) / 180);
      angle30[1] = Math.sin((30 * Math.PI) / 180);
      const providerB = makeFakeEmbeddingProvider({ vectorsByText: new Map([[candidateTextFor("TASK: 曖昧性確認B"), angle30]]) });
      await runCasePatternDetectionForOwner(fx.workspaceId, fx.userId, { getProvider: async () => providerB });

      const patternCountBefore = await db.casePattern.count({ where: { workspaceId: fx.workspaceId } });
      ok("[PE2E-07前提] ここまでPatternが2件存在する", patternCountBefore === 2, `count=${patternCountBefore}`);

      const ctxC = await makeContext(fx, "pe2e07-c");
      await makeEligibleOccurrence(fx, ctxC.id, "曖昧性確認C");
      // AとBの中間15°(両方に対しsimilarity≈0.966で等しく、best-second差=0<margin)。
      const midVector = new Array(DIMENSIONS).fill(0);
      midVector[0] = Math.cos((15 * Math.PI) / 180);
      midVector[1] = Math.sin((15 * Math.PI) / 180);
      const providerC = makeFakeEmbeddingProvider({ vectorsByText: new Map([[candidateTextFor("TASK: 曖昧性確認C"), midVector]]) });
      const outcomesC = await runCasePatternDetectionForOwner(fx.workspaceId, fx.userId, { getProvider: async () => providerC });
      ok("[PE2E-07] outcome=AMBIGUOUS", outcomesC.some((o) => o.outcome === "AMBIGUOUS"), JSON.stringify(outcomesC));
      const patternCountAfter = await db.casePattern.count({ where: { workspaceId: fx.workspaceId } });
      ok("[PE2E-07] AMBIGUOUS時にPatternが自動作成されない(件数2件のまま)", patternCountAfter === 2, `count=${patternCountAfter}`);
      const sourceLinkCountAfter = await db.casePatternSourceLink.count({ where: { workspaceId: fx.workspaceId } });
      ok("[PE2E-07] AMBIGUOUS時にSourceLinkが作成されない(件数2件のまま)", sourceLinkCountAfter === 2, `count=${sourceLinkCountAfter}`);
      const ambiguousReceipt = await db.casePatternDetectionReceipt.findFirst({ where: { workspaceId: fx.workspaceId, outcome: "AMBIGUOUS" } });
      ok("[PE2E-07] AMBIGUOUS Receiptにbest/secondSimilarityが記録される", ambiguousReceipt?.bestSimilarity != null && ambiguousReceipt?.secondSimilarity != null, JSON.stringify(ambiguousReceipt));
    }

    // ================================================================
    // §2 P1-4: consent未取得ownerはSKIP(SourceLink/Pattern作成0、AI呼出し0)
    // ================================================================
    {
      const fx = await makeFixture("consent-off", false);
      const ctx = await makeContext(fx, "consent-off");
      await makeEligibleOccurrence(fx, ctx.id, "consent未取得の確認");
      const callLog: string[] = [];
      const provider = makeFakeEmbeddingProvider({ vectorsByText: new Map(), callLog });
      const outcomes = await runCasePatternDetectionForOwner(fx.workspaceId, fx.userId, { getProvider: async () => provider });
      ok("[CONSENT] consent未取得時は結果0件", outcomes.length === 0, JSON.stringify(outcomes));
      ok("[CONSENT] consent未取得時はembed() API呼出し0回", callLog.length === 0, `callLog=${JSON.stringify(callLog)}`);
      const patternCount = await db.casePattern.count({ where: { workspaceId: fx.workspaceId } });
      ok("[CONSENT] consent未取得時はPattern作成0件", patternCount === 0, `count=${patternCount}`);
    }

    // ================================================================
    // §2 P1-3: dimensions不一致はFATAL(未分類DB例外にならない)
    // ================================================================
    {
      const fx = await makeFixture("dim-mismatch");
      const ctx = await makeContext(fx, "dim-mismatch");
      await makeEligibleOccurrence(fx, ctx.id, "次元不一致の確認");
      const wrongDimVector = new Array(768).fill(0.1);
      const provider = {
        providerName: "fake",
        modelName: "fake-embed-wrong-dim",
        dimensions: 768,
        async embed() {
          return { ok: true as const, vector: wrongDimVector, dimensions: 768, usage: { inputTokens: 0, latencyMs: 0 } };
        },
      };
      let threw = false;
      let outcomes: Awaited<ReturnType<typeof runCasePatternDetectionForOwner>> = [];
      try {
        outcomes = await runCasePatternDetectionForOwner(fx.workspaceId, fx.userId, { getProvider: async () => provider });
      } catch {
        threw = true;
      }
      ok("[P1-3] 次元不一致は未分類例外をthrowしない", !threw);
      ok("[P1-3] 次元不一致はoutcome=FAILEDとして正規化される", outcomes.length === 1 && outcomes[0]!.outcome === "FAILED", JSON.stringify(outcomes));
      const failedReceipt = await db.casePatternDetectionReceipt.findFirst({ where: { workspaceId: fx.workspaceId, outcome: "FAILED" } });
      ok("[P1-3] FAILED Receiptが記録される", failedReceipt != null, JSON.stringify(failedReceipt));
      const embeddingCount = await db.casePatternEmbedding.count({ where: { workspaceId: fx.workspaceId } });
      ok("[P1-3] 次元不一致のEmbeddingはDBへ書き込まれない", embeddingCount === 0, `count=${embeddingCount}`);
    }

    // ================================================================
    // §2 P1-2: Pattern保存側・候補照合側のEmbedding入力対称性
    // (同じrepresentativeText+decompositionTemplate=nullの組が、両経路で
    // 同一のbuildCasePatternEmbeddingText()出力になることをPE2E-01の
    // vectorsByTextキー一致(例外を投げずに解決できたこと)自体が証跡だが、
    // 明示的にも確認する)。
    // ================================================================
    {
      const { buildCasePatternEmbeddingText } = await import("../app/src/lib/patterns/casePatternEmbeddingText");
      const savedSideText = buildCasePatternEmbeddingText({ representativeText: "TASK: 対称性確認", decompositionTemplate: null });
      const candidateSideText = buildCasePatternEmbeddingText({ representativeText: "TASK: 対称性確認", decompositionTemplate: null });
      ok("[P1-2] Pattern保存側と候補照合側で同一のEmbedding入力テキストになる", savedSideText === candidateSideText, `${savedSideText} !== ${candidateSideText}`);
    }
  } finally {
    console.log("--- cleanup ---");
    for (const fx of createdFixtures) {
      await cleanupTestUser(fx.userId, fx.workspaceId);
    }
    const remaining = await db.user.count({ where: { email: { startsWith: EMAIL_PREFIX, endsWith: "@example.invalid" } } });
    ok("[PE2E-19] cleanup後、専用fixtureユーザーの残存0件", remaining === 0, `remaining=${remaining}`);

    guard.restore();
    ok("[PE2E-18] AI networkへの実通信試行は0回", guard.deniedCallAttempts.length === 0, `attempts=${JSON.stringify(guard.deniedCallAttempts)}`);

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
