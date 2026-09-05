#!/usr/bin/env node
/**
 * scripts/verify_gate_pattern_e2e_01.ts
 *
 * PATTERN-E2E-01(非課金E2E受入試験)。
 * 出典: Claude向け_ISMAY_3b695d9以降_再監査是正・CasePattern実機能完遂指示_
 * 2026-09-04.md §0(工程順序末尾)「PATTERN-E2E-01 学習からCandidate生成までの
 * 非課金E2E」、およびISMAY_ハンドオフ資料_2026-09-05.md §5-3(01D完了後の
 * 次工程として明記)。
 *
 * [scope確認・解釈の明示] 「学習からCandidate生成までの非課金E2E」という
 * 原文は、PATTERN-SUGGEST-01A〜01Dが実装される前の指示書(3b695d9基準)に
 * 由来する。当時はSuggestion機能自体が存在しなかったため、終着点が
 * 「Candidate生成」(Formation Candidate自体の生成)という記述になっていた。
 * しかし現在のHEAD(01A〜01D完了済み)では、指示書の一連の工程順序自体が
 * 「検出→Suggestion生成→Feedback→UI」の閉ループを完成させることを目的と
 * しており、ハンドオフ資料もE2E-01を01D完了後(閉ループ完成後)に位置付けて
 * いる。従ってこのGateでは、現在のシステムの実態に即して「検出(学習)→
 * Pattern成熟→新Candidate生成→Suggestion一致→Feedback記録」という、
 * 現時点で実装済みの全Gate(PATTERN-DETECT-02A/02B、PATTERN-SUGGEST-01A/
 * 01B/01C)を横断する閉ループとしてE2Eを構成する(想像で新しい終着点を
 * 発明したのではなく、原文の意図がこの閉ループの完成にあることを工程順序
 * から読み取った上での解釈)。
 *
 * [Pattern成熟(ACTIVE昇格)を実アグリゲーションで再現しない理由] 既存
 * casePatternMath.test.tsが、raw sample数・distinctContext数・confidence・
 * 採用率の各閾値によるstage計算(NONE/CANDIDATE_DISPLAY/ACTIVE/
 * STRONG_SUGGESTION)を既に純粋関数として網羅的に検証済みである。この
 * E2Eで同じ閾値を満たすfixtureを大量に作ってstage計算を再現することは、
 * 既にテスト済みのロジックの重複再検証にしかならず、このGate本来の目的
 * (「検出で作られたPatternが、後続のSuggestion生成で実際に参照できるか」
 * というGate間の配線)を薄める。そのため、検出直後のPattern(status=
 * CANDIDATE_DISPLAY相当)を、この一点でのみ直接ACTIVEへ更新し、後続の
 * Suggestion生成(ACTIVE/STRONG_SUGGESTION限定照合)が正しく参照できることを
 * 検証する対象に絞る。
 *
 * AI providerへの実通信は行わない(installAiNetworkDenyGuardで機械的に保証、
 * fake embedding providerのみを使用)。
 *
 * 実行方法:
 *   cd ~/projects/ismay/app
 *   npx tsx ../scripts/verify_gate_pattern_e2e_01.ts
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
const EMAIL_PREFIX = "gate-pattern-e2e-01-verify-";
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

function hashPayload(payload: unknown): string {
  return createHash("sha256").update(JSON.stringify(payload)).digest("hex");
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
  const { generateCaseSuggestionForCandidate } = await import("../app/src/lib/patterns/casePatternSuggestionGenerationService");
  const { recordCasePatternFeedback } = await import("../app/src/lib/patterns/casePatternFeedbackService");
  const { writeShadowFormationSession } = await import("../app/src/lib/formation/shadowWrite");
  const { buildCasePatternEmbeddingText } = await import("../app/src/lib/patterns/casePatternEmbeddingText");
  const { PEM_CONSENT_POLICY_VERSION } = await import("../app/src/lib/pem/consent");

  function candidateTextFor(representativeText: string): string {
    return buildCasePatternEmbeddingText({ representativeText, decompositionTemplate: null });
  }

  async function materializeFormationSession(params: Parameters<typeof materializeFormationSessionReal>[0]) {
    const embedStub = async () => {
      throw new Error("embedAndStoreResponsibility should not be called in this Gate (AI-free verify script)");
    };
    return materializeFormationSessionReal(params, { embedAndStoreResponsibility: embedStub as never });
  }

  const createdFixtures: { userId: string; workspaceId: string }[] = [];

  async function cleanupCasePatternRowsByWorkspace(workspaceId: string): Promise<void> {
    await db.casePatternFeedbackEvent.deleteMany({ where: { workspaceId } }).catch(() => null);
    await db.casePatternSuggestionRevision.deleteMany({ where: { workspaceId } }).catch(() => null);
    await db.casePatternSuggestionIdentity.deleteMany({ where: { workspaceId } }).catch(() => null);
    await db.casePatternSuggestJob.deleteMany({ where: { workspaceId } }).catch(() => null);
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
    if (workspaceId) await cleanupCasePatternRowsByWorkspace(workspaceId);

    const ownedOrCreatedContexts = await db.projectContext
      .findMany({ where: { OR: [{ ownerSubjectUserId: userId }, { createdById: userId }] }, select: { id: true } })
      .catch(() => []);
    const contextIds = ownedOrCreatedContexts.map((c: { id: string }) => c.id);
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
      data: { email, passwordHash: "not-a-real-hash-for-db-only-test", displayName: `PATTERN-E2E-01 ${suffix}` },
    });
    const workspace = await db.workspace.create({ data: { name: `PATTERN-E2E-01 Workspace ${suffix}` } });
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

  /** materializeFormationSession経由で本物のMaterializationReceiptItem/Responsibilityを1件作り、PRIMARY Linkで指定Contextへ紐付ける(02AのmakeEligibleOccurrenceと同一設計)。 */
  async function makeEligibleOccurrence(
    fx: { workspaceId: string; domainId: string; userId: string },
    contextId: string,
    title: string,
    key: string,
  ): Promise<{ responsibilityId: string }> {
    const capture = await db.capture.create({
      data: { workspaceId: fx.workspaceId, domainId: fx.domainId, createdById: fx.userId, sourceType: "TEXT", rawText: `[PATTERN-E2E-01 verify ${key}] ${title}`, processingStatus: "READY" },
    });
    const session = await db.formationSession.create({
      data: { workspaceId: fx.workspaceId, domainId: fx.domainId, subjectUserId: fx.userId, captureId: capture.id, clientSessionKey: `pattern-e2e-01:${RUN_ID}:${key}`, state: "REVIEW_READY" },
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

    await db.projectContextLink.create({
      data: { workspaceId: fx.workspaceId, contextId, responsibilityId, role: "PRIMARY", sourceKind: "USER" },
    });
    return { responsibilityId };
  }

  try {
    console.log("=== PATTERN-E2E-01 閉ループ実DB受入試験(非課金) ===");
    console.log("    検出(学習) → Pattern成熟(直接昇格) → 新Candidate生成 → Suggestion一致 → Feedback記録");

    const fx = await makeFixture("main");
    const ctx = await makeContext(fx, "main");
    const representativeText = "毎週の定例報告";
    const embeddingText = candidateTextFor(`TASK: ${representativeText}`);
    const vector = baseVector();
    const callLog: string[] = [];
    const provider = makeFakeEmbeddingProvider({ vectorsByText: new Map([[embeddingText, vector]]), callLog });

    // ================================================================
    // Step 1(学習・検出): 採用済みResponsibility1件からCase Patternを検出する
    // (PATTERN-DETECT-02A/02B、既にverify_gate_pattern_detect_02a.tsで
    // 個別検証済みのロジックをこの閉ループの入口として再利用する)。
    // ================================================================
    await makeEligibleOccurrence(fx, ctx.id, representativeText, "occ1");
    const detectOutcomes = await runCasePatternDetectionForOwner(fx.workspaceId, fx.userId, { getProvider: async () => provider });
    ok("[Step1:検出] 検出結果1件、outcome=NEW_PATTERN_CREATED", detectOutcomes.length === 1 && detectOutcomes[0]!.outcome === "NEW_PATTERN_CREATED", JSON.stringify(detectOutcomes));

    const pattern = await db.casePattern.findFirst({ where: { workspaceId: fx.workspaceId, ownerSubjectUserId: fx.userId } });
    ok("[Step1:検出] CasePatternが作成された", pattern != null);
    ok("[Step1:検出] 直後のstatusはACTIVE未満(NONE/CANDIDATE_DISPLAY)", pattern != null && pattern.status !== "ACTIVE" && pattern.status !== "STRONG_SUGGESTION", pattern?.status);

    // ================================================================
    // Step 2(Pattern成熟・直接昇格): このGateの対象はstage計算の再検証では
    // なく後続Gate間の配線であるため、casePatternMath.test.tsで既に
    // 網羅検証済みの閾値計算を再現せず、ACTIVEへ直接昇格させる
    // (モジュールコメント参照)。
    // ================================================================
    await db.casePattern.update({ where: { id: pattern!.id }, data: { status: "ACTIVE", confidence: 0.9 } });
    const patternActive = await db.casePattern.findFirst({ where: { id: pattern!.id } });
    ok("[Step2:成熟] Pattern.statusをACTIVEへ更新できた", patternActive?.status === "ACTIVE");

    // ================================================================
    // Step 3(新Candidate生成): 同じ内容の新しいFormation Candidateが
    // shadowWrite経由で作られると、PATTERN-SUGGEST-01Bの配線により
    // CasePatternSuggestJobが自動的にenqueueされる(01Bで個別検証済みの
    // 配線をこの閉ループで再確認する)。
    // ================================================================
    const capture2 = await db.capture.create({
      data: { workspaceId: fx.workspaceId, domainId: fx.domainId, createdById: fx.userId, sourceType: "TEXT", rawText: representativeText, processingStatus: "SAVED", clientDraftId: `cd-e2e-${RUN_ID}` },
    });
    await writeShadowFormationSession({
      capture: {
        id: capture2.id,
        workspaceId: fx.workspaceId,
        domainId: fx.domainId,
        createdById: fx.userId,
        sourceType: "TEXT",
        rawText: representativeText,
      } as never,
      aiRunId: `verify-airun-e2e-${RUN_ID}`,
      schemaVersion: "1.0",
      candidates: [
        {
          candidateId: "c1",
          type: "TASK",
          title: representativeText,
          description: null,
          completionCondition: "検証用",
          evidenceSpans: [],
          confidence: 0.9,
          dateMentions: [],
          unknowns: [],
          blockedByCandidateIds: [],
          suggestedTags: [],
          clarificationSignals: [],
        },
      ] as never,
    });

    const suggestJobCount = await db.casePatternSuggestJob.count({ where: { workspaceId: fx.workspaceId, ownerSubjectUserId: fx.userId } });
    ok("[Step3:新Candidate生成] shadowWrite経由でCase Pattern Suggest Jobが1件enqueueされる", suggestJobCount === 1, `count=${suggestJobCount}`);

    const suggestJob = await db.casePatternSuggestJob.findFirst({ where: { workspaceId: fx.workspaceId, ownerSubjectUserId: fx.userId } });
    ok("[Step3:新Candidate生成] enqueueされたjobはPENDING", suggestJob?.status === "PENDING");

    // ================================================================
    // Step 4(Suggestion一致): enqueueされたjobのcandidateIdに対し実際に
    // 照合を実行する(worker/caseSuggestQueueJob.tsのpolling自体は
    // このGateの対象外、queue infra自体は01Bで既に検証済みのため、
    // ここでは決定論性のためgenerateCaseSuggestionForCandidateを直接
    // 呼ぶ)。ACTIVEへ昇格済みのPatternへMATCHEDするはず。
    // ================================================================
    const genResult = await generateCaseSuggestionForCandidate(
      { workspaceId: fx.workspaceId, ownerSubjectUserId: fx.userId, candidateId: suggestJob!.candidateId },
      { getProvider: async () => provider },
    );
    ok("[Step4:Suggestion一致] outcome=SUGGESTION_CREATED", genResult.outcome === "SUGGESTION_CREATED", JSON.stringify(genResult));
    if (genResult.outcome === "SUGGESTION_CREATED") {
      ok("[Step4:Suggestion一致] matchedPatternIdがStep1で検出したPatternと一致", genResult.patternId === pattern!.id);
    }

    const suggestionIdentity = await db.casePatternSuggestionIdentity.findFirst({ where: { workspaceId: fx.workspaceId, candidateId: suggestJob!.candidateId } });
    ok("[Step4:Suggestion一致] CasePatternSuggestionIdentityが作成された", suggestionIdentity != null);
    ok("[Step4:Suggestion一致] state=PENDING(feedback未記録)", suggestionIdentity?.state === "PENDING");

    // ================================================================
    // Step 5(Feedback記録): ユーザーがACCEPTを送る(PATTERN-SUGGEST-01C)。
    // ================================================================
    const feedbackPayload = { revision: suggestionIdentity!.currentRevision, verdict: "ACCEPT" as const };
    const feedbackResult = await recordCasePatternFeedback({
      workspaceId: fx.workspaceId,
      suggestionId: suggestionIdentity!.id,
      actorUserId: fx.userId,
      expectedRevision: suggestionIdentity!.currentRevision,
      verdict: "ACCEPT",
      idempotencyKey: `idem-e2e-${RUN_ID}`,
      requestPayloadHash: hashPayload(feedbackPayload),
    });
    ok("[Step5:Feedback記録] recordCasePatternFeedbackがok:trueを返す", feedbackResult.ok === true, JSON.stringify(feedbackResult));
    if (feedbackResult.ok) {
      ok("[Step5:Feedback記録] suggestionState=ACCEPT", feedbackResult.suggestionState === "ACCEPT");
    }
    const suggestionAfterFeedback = await db.casePatternSuggestionIdentity.findFirst({ where: { id: suggestionIdentity!.id } });
    ok("[Step5:Feedback記録] DB上のSuggestion.stateもACCEPT(閉ループ完成)", suggestionAfterFeedback?.state === "ACCEPT");

    // ================================================================
    // 非課金確認: この閉ループ全体でAI providerへの実通信が0件であること。
    // ================================================================
    ok("[非課金] AI providerへの実通信は0件(fake providerのみ使用)", guard.deniedCallAttempts.length === 0, `attempts=${guard.deniedCallAttempts.length}`);
    ok("[非課金] fake providerへの呼出しは記録されている(embed自体は実行された)", callLog.length > 0, `callLog.length=${callLog.length}`);
  } finally {
    console.log("\n[CLEANUP] テスト用データを削除します...");
    for (const fxDone of createdFixtures) await cleanupTestUser(fxDone.userId, fxDone.workspaceId);
    const leftover = await db.user.findMany({ where: { email: { startsWith: EMAIL_PREFIX, endsWith: "@example.invalid" } }, select: { id: true } });
    ok("[cleanup] test用Userが1件も残っていない", leftover.length === 0, `remaining=${leftover.length}`);
    guard.restore();
  }

  console.log(`\n合計: ${passed} passed, ${failed} failed`);
  if (failed > 0) {
    console.log("\n失敗した項目:");
    for (const f of failures) console.log(`  - ${f}`);
    process.exit(1);
  }
}

main().catch((err) => {
  console.error("FATAL:", err);
  process.exit(1);
});
