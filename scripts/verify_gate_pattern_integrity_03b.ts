#!/usr/bin/env node
/**
 * scripts/verify_gate_pattern_integrity_03b.ts
 *
 * PATTERN-INTEGRITY-03B(title訂正時の旧SourceLink除外・再判定・二重計上防止、
 * linkPatternSourceEvent再有効化)の実DB受入証跡。
 * 出典: ISMAY_ハンドオフ資料_2026-09-05_続き3.md §3「未着手:
 * PATTERN-INTEGRITY-03B」、§3.3 受入条件。
 *
 * [背景・是正内容] enqueueCaseDetectForResponsibilityCorrection
 * (casePatternTriggers.ts)は、title変更時にenqueueCaseDetectを呼ぶのみで、
 * 旧SourceLinkの除外を一切行っていなかった。再判定が別Patternへ一致した
 * 場合、旧SourceLink(旧Pattern向け)と新SourceLink(新Pattern向け)が両方
 * 残り二重計上される欠陥があった。また、title変更後に以前と同じPatternへ
 * 再一致した場合、linkPatternSourceEventの冪等チェックが既存行のexcludedAt
 * を見ずにそのまま成功扱いで返すため、除外済みのまま復活せず有効な
 * Evidenceが永久に失われるデータロスがあった。
 *
 * 受入条件(ハンドオフ資料§3.3):
 *   1. title変更前のSourceLinkを有効な学習Evidenceとして残さない
 *   2. 新titleで再判定する
 *   3. 同一sourceが旧Patternと新Patternへ同時にactive linkされない
 *   4. 同一Patternへ再一致した場合も二重計上しない(かつ再有効化されること)
 *   5. ReceiptのinputDigest更新とprovenanceが整合する
 *
 * AI providerへの実通信は行わない(installAiNetworkDenyGuardで機械的に保証)。
 *
 * 実行方法:
 *   cd ~/projects/ismay/app
 *   npx tsx ../scripts/verify_gate_pattern_integrity_03b.ts
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
const EMAIL_PREFIX = "gate-pattern-integrity-03b-verify-";
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

/** vector[0]=1の系(Pattern P1相当)。 */
function vectorA(): number[] {
  const v = new Array(DIMENSIONS).fill(0);
  v[0] = 1;
  return v;
}
/** vector[1]=1の系(Pattern P2相当、P1と直交=類似度0)。 */
function vectorB(): number[] {
  const v = new Array(DIMENSIONS).fill(0);
  v[1] = 1;
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
  const { enqueueCaseDetectForResponsibilityCorrection } = await import("../app/src/lib/patterns/casePatternTriggers");
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
  function digestOf(text: string): string {
    return createHash("sha256").update(text).digest("hex");
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
      data: { email, passwordHash: "not-a-real-hash-for-db-only-test", displayName: `PATTERN-INTEGRITY-03B ${suffix}` },
    });
    const workspace = await db.workspace.create({ data: { name: `PATTERN-INTEGRITY-03B Workspace ${suffix}` } });
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
      data: { workspaceId: fx.workspaceId, domainId: fx.domainId, createdById: fx.userId, sourceType: "TEXT", rawText: `[PATTERN-INTEGRITY-03B verify ${key}] ${title}`, processingStatus: "READY" },
    });
    const session = await db.formationSession.create({
      data: { workspaceId: fx.workspaceId, domainId: fx.domainId, subjectUserId: fx.userId, captureId: capture.id, clientSessionKey: `pattern-integrity-03b:${RUN_ID}:${key}`, state: "REVIEW_READY" },
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

  /** PATCH /api/v1/responsibilities/[id]がtitle実変化時に行うのと同じ2手順を再現する。 */
  async function correctTitle(params: { workspaceId: string; responsibilityId: string; newTitle: string }): Promise<void> {
    await db.responsibility.update({ where: { id: params.responsibilityId }, data: { title: params.newTitle } });
    await enqueueCaseDetectForResponsibilityCorrection(db, { workspaceId: params.workspaceId, responsibilityId: params.responsibilityId });
  }

  try {
    console.log("=== PATTERN-INTEGRITY-03B 実DB受入試験 ===");

    // ================================================================
    // 前提: 2つの独立Pattern P1・P2を先に作る(直交ベクトルで別Patternとして
    // 確定させる)。対象occurrenceは最初P1へ一致するtitleで作成する。
    // ================================================================
    const fx = await makeFixture("title-correction");

    const ctxSeedA = await makeContext(fx, "seed-a");
    const seedA = await makeEligibleOccurrence(fx, ctxSeedA.id, "P1シード occurrence");
    const providerSeedA = makeFakeEmbeddingProvider({ vectorsByText: new Map([[candidateTextFor("TASK: P1シード occurrence"), vectorA()]]) });
    await runCasePatternDetectionForOwner(fx.workspaceId, fx.userId, { getProvider: async () => providerSeedA });

    const ctxSeedB = await makeContext(fx, "seed-b");
    const seedB = await makeEligibleOccurrence(fx, ctxSeedB.id, "P2シード occurrence");
    const providerSeedB = makeFakeEmbeddingProvider({ vectorsByText: new Map([[candidateTextFor("TASK: P2シード occurrence"), vectorB()]]) });
    await runCasePatternDetectionForOwner(fx.workspaceId, fx.userId, { getProvider: async () => providerSeedB });

    const patternP1 = await db.casePattern.findFirstOrThrow({
      where: { workspaceId: fx.workspaceId, ownerSubjectUserId: fx.userId, revisions: { some: { sourceLinks: { some: { sourceEventId: seedA.materializationReceiptItemId } } } } },
    });
    const patternP2 = await db.casePattern.findFirstOrThrow({
      where: { workspaceId: fx.workspaceId, ownerSubjectUserId: fx.userId, revisions: { some: { sourceLinks: { some: { sourceEventId: seedB.materializationReceiptItemId } } } } },
    });
    ok("[前提] P1とP2は別Pattern", patternP1.id !== patternP2.id, `P1=${patternP1.id} P2=${patternP2.id}`);
    const revisionP1 = await db.casePatternRevision.findFirstOrThrow({ where: { workspaceId: fx.workspaceId, patternId: patternP1.id, revision: patternP1.currentRevision } });
    const revisionP2 = await db.casePatternRevision.findFirstOrThrow({ where: { workspaceId: fx.workspaceId, patternId: patternP2.id, revision: patternP2.currentRevision } });

    // --- 別owner/workspaceの無関係fixture(是正の副作用が漏れ出ないことの対照群) ---
    const fxOther = await makeFixture("unrelated");
    const ctxOther = await makeContext(fxOther, "other");
    const occOther = await makeEligibleOccurrence(fxOther, ctxOther.id, "無関係occurrence");
    const providerOther = makeFakeEmbeddingProvider({ vectorsByText: new Map([[candidateTextFor("TASK: 無関係occurrence"), vectorA()]]) });
    await runCasePatternDetectionForOwner(fxOther.workspaceId, fxOther.userId, { getProvider: async () => providerOther });
    const sourceLinkOtherBefore = await db.casePatternSourceLink.findFirst({ where: { workspaceId: fxOther.workspaceId, sourceEventId: occOther.materializationReceiptItemId } });
    ok("[前提] 別workspace fixtureのSourceLinkは除外前はexcludedAt:null", sourceLinkOtherBefore?.excludedAt == null, JSON.stringify(sourceLinkOtherBefore));

    // ================================================================
    // 対象occurrenceをtitle=T1(P1一致)で作成し、初回検出でP1へlinkさせる。
    // ================================================================
    const ctxMain = await makeContext(fx, "main");
    const titleT1 = "対象occurrence T1";
    const titleT2 = "対象occurrence T2";
    const occMain = await makeEligibleOccurrence(fx, ctxMain.id, titleT1);
    const providerInit = makeFakeEmbeddingProvider({ vectorsByText: new Map([[candidateTextFor(`TASK: ${titleT1}`), vectorA()]]) });
    await runCasePatternDetectionForOwner(fx.workspaceId, fx.userId, { getProvider: async () => providerInit });

    const linkT1 = await db.casePatternSourceLink.findFirstOrThrow({ where: { workspaceId: fx.workspaceId, sourceEventId: occMain.materializationReceiptItemId } });
    ok("[前提] 初回検出でP1のrevisionへlinkされる", linkT1.patternRevisionId === revisionP1.id, JSON.stringify(linkT1));
    ok("[前提] 初回linkはexcludedAt:null", linkT1.excludedAt == null, JSON.stringify(linkT1));

    // ================================================================
    // [1] titleをT1→T2(P2一致)へ訂正する。是正後のenqueueCaseDetectFor
    // ResponsibilityCorrectionは、同一tx内でexclude→enqueueを行う。
    // ================================================================
    await correctTitle({ workspaceId: fx.workspaceId, responsibilityId: occMain.responsibilityId, newTitle: titleT2 });

    const linkT1AfterExclude = await db.casePatternSourceLink.findUniqueOrThrow({ where: { id: linkT1.id } });
    ok("[1] title変更(T1→T2)で旧SourceLink(P1向け)が除外される", linkT1AfterExclude.excludedAt != null, JSON.stringify(linkT1AfterExclude));
    ok("[1] excludedReasonがRESPONSIBILITY_CORRECTED", linkT1AfterExclude.excludedReason === "RESPONSIBILITY_CORRECTED", JSON.stringify(linkT1AfterExclude));

    const jobAfterCorrection1 = await db.casePatternDetectJob.findFirstOrThrow({ where: { workspaceId: fx.workspaceId, ownerSubjectUserId: fx.userId } });
    ok("[1] Jobのreason_codeがRESPONSIBILITY_CORRECTED", jobAfterCorrection1.reasonCode === "RESPONSIBILITY_CORRECTED", JSON.stringify(jobAfterCorrection1));

    // 新titleで再判定(実際にworkerが行うのと同じ関数呼出し)。
    const providerT2 = makeFakeEmbeddingProvider({ vectorsByText: new Map([[candidateTextFor(`TASK: ${titleT2}`), vectorB()]]) });
    await runCasePatternDetectionForOwner(fx.workspaceId, fx.userId, { getProvider: async () => providerT2 });

    const linkT2 = await db.casePatternSourceLink.findFirstOrThrow({
      where: { workspaceId: fx.workspaceId, sourceEventId: occMain.materializationReceiptItemId, patternRevisionId: revisionP2.id },
    });
    ok("[2] 新title(T2)で再判定し、P2のrevisionへ新規linkされる(新titleで再判定される)", linkT2.excludedAt == null, JSON.stringify(linkT2));
    ok("[3] 旧Pattern(P1)向けlinkは除外されたまま、新Pattern(P2)向けlinkのみactive(同時active linkされない)", linkT1AfterExclude.excludedAt != null && linkT2.excludedAt == null);

    const receiptAfterT2 = await db.casePatternDetectionReceipt.findFirstOrThrow({ where: { workspaceId: fx.workspaceId, sourceEventId: occMain.materializationReceiptItemId } });
    ok("[5] ReceiptのinputDigestが新titleの候補テキストdigestと一致する(provenance整合)", receiptAfterT2.inputDigest === digestOf(candidateTextFor(`TASK: ${titleT2}`)), JSON.stringify(receiptAfterT2));

    // ================================================================
    // [4] titleをT2→T1(P1へ再一致)へ戻す。旧title変更時(T1→T2)にP1向け
    // linkTを既に除外済みのため、T1→再一致時はlinkPatternSourceEventの
    // 冪等チェックが(patternRevisionId=P1, kind, sourceEventId)の既存行
    // (linkT1、excludedAt非null)を見つけ、再有効化するはず。
    // ================================================================
    const sourceLinkCountBeforeRevert = await db.casePatternSourceLink.count({
      where: { workspaceId: fx.workspaceId, sourceEventId: occMain.materializationReceiptItemId },
    });

    await correctTitle({ workspaceId: fx.workspaceId, responsibilityId: occMain.responsibilityId, newTitle: titleT1 });

    const linkT2AfterExclude = await db.casePatternSourceLink.findUniqueOrThrow({ where: { id: linkT2.id } });
    ok("[4] title変更(T2→T1)でP2向けlinkが除外される", linkT2AfterExclude.excludedAt != null, JSON.stringify(linkT2AfterExclude));

    const providerT1Again = makeFakeEmbeddingProvider({ vectorsByText: new Map([[candidateTextFor(`TASK: ${titleT1}`), vectorA()]]) });
    await runCasePatternDetectionForOwner(fx.workspaceId, fx.userId, { getProvider: async () => providerT1Again });

    const sourceLinkCountAfterRevert = await db.casePatternSourceLink.count({
      where: { workspaceId: fx.workspaceId, sourceEventId: occMain.materializationReceiptItemId },
    });
    ok(
      "[4] T1へ再一致してもSourceLink行数は増えない(二重計上しない、既存行を再有効化)",
      sourceLinkCountAfterRevert === sourceLinkCountBeforeRevert,
      `before=${sourceLinkCountBeforeRevert} after=${sourceLinkCountAfterRevert}`,
    );

    const linkT1AfterReactivate = await db.casePatternSourceLink.findUniqueOrThrow({ where: { id: linkT1.id } });
    ok("[4] 元のP1向けlink(linkT1)が同一行のまま再有効化される(excludedAt:null)", linkT1AfterReactivate.excludedAt == null, JSON.stringify(linkT1AfterReactivate));
    ok("[4] excludedReasonもクリアされる", linkT1AfterReactivate.excludedReason == null, JSON.stringify(linkT1AfterReactivate));

    const linkT2FinalState = await db.casePatternSourceLink.findUniqueOrThrow({ where: { id: linkT2.id } });
    ok("[4] P2向けの旧link(linkT2)は除外されたまま(active linkは1件のみ)", linkT2FinalState.excludedAt != null, JSON.stringify(linkT2FinalState));

    const activeLinksForMain = await db.casePatternSourceLink.count({
      where: { workspaceId: fx.workspaceId, sourceEventId: occMain.materializationReceiptItemId, excludedAt: null },
    });
    ok("[4] このoccurrenceのactive SourceLinkは常に高々1件", activeLinksForMain === 1, `activeCount=${activeLinksForMain}`);

    // ================================================================
    // 再送(同一titleへの無変化更新)は何もexcludeしないことの確認
    // (二重計上防止の回帰)。
    // ================================================================
    const linkT1CountBeforeNoop = await db.casePatternSourceLink.count({ where: { workspaceId: fx.workspaceId, sourceEventId: occMain.materializationReceiptItemId } });
    await enqueueCaseDetectForResponsibilityCorrection(db, { workspaceId: fx.workspaceId, responsibilityId: occMain.responsibilityId });
    const linkT1AfterNoop = await db.casePatternSourceLink.findUniqueOrThrow({ where: { id: linkT1.id } });
    const linkT1CountAfterNoop = await db.casePatternSourceLink.count({ where: { workspaceId: fx.workspaceId, sourceEventId: occMain.materializationReceiptItemId } });
    ok("[再送] 同一reasonでの再enqueueはP1向けlinkを除外しない(呼出し元はtitle実変化時のみ呼ぶ契約だが、関数自体の冪等性も確認)", linkT1AfterNoop.excludedAt == null, JSON.stringify(linkT1AfterNoop));
    ok("[再送] SourceLink行数も変化しない", linkT1CountAfterNoop === linkT1CountBeforeNoop, `before=${linkT1CountBeforeNoop} after=${linkT1CountAfterNoop}`);

    // ================================================================
    // 別owner/workspaceのSourceLinkへ影響しないことの確認。
    // ================================================================
    const sourceLinkOtherAfter = await db.casePatternSourceLink.findFirst({ where: { workspaceId: fxOther.workspaceId, sourceEventId: occOther.materializationReceiptItemId } });
    ok("[別workspace] 無関係fixtureのSourceLinkは影響を受けない(excludedAt:nullのまま)", sourceLinkOtherAfter?.excludedAt == null, JSON.stringify(sourceLinkOtherAfter));

    // 集計側も併せて健全であることを確認(P1のaggregateにoccurrenceが1件、
    // seedA+再有効化されたoccMainの2件になるはず)。
    await computeAndPersistCasePatternAggregatesForOwner(fx.workspaceId, fx.userId);
    const aggP1Final = await db.casePatternEvidenceAggregate.findFirst({ where: { workspaceId: fx.workspaceId, revisionId: revisionP1.id } });
    ok("[集計] P1のrawSampleSizeは2(seedA + 再有効化されたoccMain)", aggP1Final?.rawSampleSize === 2, JSON.stringify(aggP1Final));
    const aggP2Final = await db.casePatternEvidenceAggregate.findFirst({ where: { workspaceId: fx.workspaceId, revisionId: revisionP2.id } });
    ok("[集計] P2のrawSampleSizeは1(seedBのみ、occMainのP2向けlinkは除外済みのため計上されない)", aggP2Final?.rawSampleSize === 1, JSON.stringify(aggP2Final));
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
