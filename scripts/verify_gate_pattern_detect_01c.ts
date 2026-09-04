#!/usr/bin/env node
/**
 * scripts/verify_gate_pattern_detect_01c.ts
 *
 * PATTERN-DETECT-01C(集計・stage projection)の実DB受入証跡。
 * 出典: Claude向け_ISMAY_0fcea2b以降_再監査是正・PATTERN-DETECT連続実装指示_2026-09-03.md
 * §6 PATTERN-DETECT-01C、§7 受入条件 PD-03/PD-04/PD-08。
 *
 * casePatternMath.tsの数式自体(golden dataset含む)は
 * src/lib/patterns/__tests__/casePatternMath.test.tsで既に検証済みのため、
 * このスクリプトはDB読み書き経路(independenceWeight正規化、current
 * revisionのみ集計、excludedAt除外、CasePattern/Aggregate永続化)のみを
 * 対象とする(数式の再検証はしない、重複しない)。
 *
 * [是正履歴]
 * v1: CasePatternSourceLinkを実在しないsourceEventId・responsibilityId未設定で
 *     直接createしており、provenance_check制約に違反して失敗(rollback済み)。
 * v2: v1を修正したが、cleanupでtest用User 1件が削除されずに残った
 *     (16 passed, 1 failed。rollback済み、commit/push無し)。
 * v3: workspaceId解決を複数経路でフォールバックし、CasePattern関連テーブルを
 *     workspaceId直接指定で削除するよう単純化・堅牢化した。しかし実DBで
 *     v2と全く同じ結果(16 passed, 1 failed, remaining=1)が再現し、かつ
 *     追加した診断ログ([cleanup警告]/[cleanup診断])が一切出力されなかった。
 *     これは cleanupFormationVerifyUser・v3の追加コードいずれも例外/エラーを
 *     一切記録しておらず、「見えている経路はすべて成功しているのに、
 *     最終確認だけがUser残存を報告する」という状態を意味する。
 * v4(本版): 原因を憶測で潰そうとするのをやめ、(a) workspaceId解決に依存しない
 *     userId直接(ownerSubjectUserId/contextId所有権)経由のCasePattern関連
 *     テーブル削除を独立した第二の経路として追加し、(b) 各cleanup呼び出しの
 *     前後で「解決したworkspaceId」「削除試行後にUserが実在するか」を無条件に
 *     (エラー時だけでなく常に)ログ出力するようにした。これにより、次回
 *     実行時に何が起きているか(workspaceId解決自体の失敗か、削除自体の失敗か、
 *     全く別の経路が残存の原因か)を確実に可視化できるようにする。
 * app/src/lib/patterns/casePatternAggregation.ts自体(集計ロジック)には
 * バグが無く、v1から変更していない。
 *
 * AI providerへの実通信は行わない(installAiNetworkDenyGuardで機械的に保証)。
 *
 * 実行方法:
 *   cd ~/projects/ismay/app
 *   npx tsx ../scripts/verify_gate_pattern_detect_01c.ts
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
const EMAIL_PREFIX = "gate-pattern-detect-01c-verify-";

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

function closeEnough(a: number, b: number, eps = 1e-6): boolean {
  return Math.abs(a - b) < eps;
}

async function main(): Promise<void> {
  const { installAiNetworkDenyGuard } = await import("./lib/aiNetworkDenyGuard");
  const guard = installAiNetworkDenyGuard();

  const { db } = await import("../app/src/lib/db");
  const { cleanupFormationVerifyUser } = await import("./lib/formationVerifyCleanup");
  const { recordCandidateDecision, materializeFormationSession: materializeFormationSessionReal } = await import(
    "../app/src/lib/formation/materialize"
  );
  const { createCasePatternRevision } = await import("../app/src/lib/patterns/casePatternRevisionService");
  const { computeAndPersistCasePatternAggregate } = await import("../app/src/lib/patterns/casePatternAggregation");

  async function materializeFormationSession(params: Parameters<typeof materializeFormationSessionReal>[0]) {
    const embedStub = async () => {
      throw new Error("embedAndStoreResponsibility should not be called in this Gate (AI-free verify script)");
    };
    return materializeFormationSessionReal(params, { embedAndStoreResponsibility: embedStub });
  }

  const createdFixtures: { userId: string; workspaceId: string }[] = [];

  /** workspaceId直接指定でCasePattern関連テーブルを削除する(経路A)。 */
  async function cleanupCasePatternRowsByWorkspace(workspaceId: string): Promise<void> {
    await db.casePatternSourceLink.deleteMany({ where: { workspaceId } }).catch(() => null);
    await db.casePatternEvidenceAggregate.deleteMany({ where: { workspaceId } }).catch(() => null);
    await db.casePatternEmbedding.deleteMany({ where: { workspaceId } }).catch(() => null);
    await db.casePatternFeedbackEvent.deleteMany({ where: { workspaceId } }).catch(() => null);
    await db.casePatternRevision.deleteMany({ where: { workspaceId } }).catch(() => null);
    await db.casePattern.deleteMany({ where: { workspaceId } }).catch(() => null);
  }

  /**
   * [v4新設] workspaceId解決に一切依存しない第二の削除経路(経路B)。
   * ProjectContext.ownerSubjectUserId・CasePattern.ownerSubjectUserIdという
   * userId直接所有のFKだけを辿るため、workspaceMember等の中間lookupが
   * 何らかの理由で失敗していても、これ単体で完結してCasePattern関連の
   * 参照(特にCasePatternSourceLink.contextId → ProjectContextへのRESTRICT
   * FK、CasePattern.ownerSubjectUserId → UserへのRESTRICT FK)を断ち切れる。
   */
  async function cleanupCasePatternRowsByOwner(userId: string): Promise<void> {
    const ownedContexts = await db.projectContext.findMany({ where: { ownerSubjectUserId: userId }, select: { id: true } }).catch(() => []);
    const contextIds = ownedContexts.map((c) => c.id);
    if (contextIds.length > 0) {
      await db.casePatternSourceLink.deleteMany({ where: { contextId: { in: contextIds } } }).catch(() => null);
    }

    const ownedPatterns = await db.casePattern.findMany({ where: { ownerSubjectUserId: userId }, select: { id: true } }).catch(() => []);
    const patternIds = ownedPatterns.map((p) => p.id);
    if (patternIds.length > 0) {
      const revisions = await db.casePatternRevision.findMany({ where: { patternId: { in: patternIds } }, select: { id: true } }).catch(() => []);
      const revisionIds = revisions.map((r) => r.id);
      if (revisionIds.length > 0) {
        await db.casePatternSourceLink.deleteMany({ where: { patternRevisionId: { in: revisionIds } } }).catch(() => null);
        await db.casePatternEvidenceAggregate.deleteMany({ where: { revisionId: { in: revisionIds } } }).catch(() => null);
        await db.casePatternEmbedding.deleteMany({ where: { revisionId: { in: revisionIds } } }).catch(() => null);
      }
      await db.casePatternFeedbackEvent.deleteMany({ where: { patternId: { in: patternIds } } }).catch(() => null);
      if (revisionIds.length > 0) await db.casePatternRevision.deleteMany({ where: { id: { in: revisionIds } } }).catch(() => null);
      await db.casePattern.deleteMany({ where: { id: { in: patternIds } } }).catch(() => null);
    }
  }

  async function resolveWorkspaceId(userId: string): Promise<string | null> {
    const membership = await db.workspaceMember.findFirst({ where: { userId }, select: { workspaceId: true } }).catch(() => null);
    if (membership?.workspaceId) return membership.workspaceId;
    const ctx = await db.projectContext.findFirst({ where: { ownerSubjectUserId: userId }, select: { workspaceId: true } }).catch(() => null);
    if (ctx?.workspaceId) return ctx.workspaceId;
    const pat = await db.casePattern.findFirst({ where: { ownerSubjectUserId: userId }, select: { workspaceId: true } }).catch(() => null);
    if (pat?.workspaceId) return pat.workspaceId;
    const cap = await db.capture.findFirst({ where: { createdById: userId }, select: { workspaceId: true } }).catch(() => null);
    if (cap?.workspaceId) return cap.workspaceId;
    return null;
  }

  async function cleanupTestUser(userId: string, knownWorkspaceId: string | null): Promise<void> {
    const workspaceId = knownWorkspaceId ?? (await resolveWorkspaceId(userId));
    // [v4・常時ログ] エラー時だけでなく常に出力する。次回実行時にここが
    // 手がかりとして必ず残るようにする。
    console.log(`  [cleanup] userId=${userId} 解決したworkspaceId=${workspaceId ?? "(なし)"}`);

    // 経路A: workspaceId直接指定(解決できた場合のみ)。
    if (workspaceId) {
      await cleanupCasePatternRowsByWorkspace(workspaceId);
    }
    // 経路B: userId直接所有(workspaceId解決の成否によらず必ず実行する)。
    await cleanupCasePatternRowsByOwner(userId);

    const result = await cleanupFormationVerifyUser(db, userId);
    console.log(`  [cleanup] userId=${userId} cleanupFormationVerifyUser errors=${result.errors.length}`);
    if (result.errors.length > 0) {
      for (const e of result.errors) console.log(`    - ${e.step}: ${String(e.error)}`);
    }

    const stillExists = await db.user.findUnique({ where: { id: userId }, select: { id: true } }).catch(() => null);
    console.log(`  [cleanup] userId=${userId} 1回目試行後の残存: ${stillExists ? "あり" : "なし"}`);
    if (stillExists) {
      // [v4] 何が残っているかを実際に数えて出力する(想像で再試行を
      // 繰り返すのではなく、実体を確認してから対処する)。
      const resolvedWorkspaceId = workspaceId ?? (await resolveWorkspaceId(userId));
      const diag = {
        resolvedWorkspaceId,
        projectContextByOwner: await db.projectContext.count({ where: { ownerSubjectUserId: userId } }).catch(() => -1),
        casePatternByOwner: await db.casePattern.count({ where: { ownerSubjectUserId: userId } }).catch(() => -1),
        workspaceMemberByUser: await db.workspaceMember.count({ where: { userId } }).catch(() => -1),
        captureByCreator: await db.capture.count({ where: { createdById: userId } }).catch(() => -1),
        ...(resolvedWorkspaceId
          ? {
              projectContextByWorkspace: await db.projectContext.count({ where: { workspaceId: resolvedWorkspaceId } }).catch(() => -1),
              casePatternSourceLinkByWorkspace: await db.casePatternSourceLink.count({ where: { workspaceId: resolvedWorkspaceId } }).catch(() => -1),
              responsibilityByWorkspace: await db.responsibility.count({ where: { workspaceId: resolvedWorkspaceId } }).catch(() => -1),
              workspaceExists: (await db.workspace.findUnique({ where: { id: resolvedWorkspaceId }, select: { id: true } }).catch(() => null)) !== null,
            }
          : {}),
      };
      console.log(`  [cleanup診断] userId=${userId} 残存件数: ${JSON.stringify(diag)}`);

      // 再試行(経路A・Bを両方再実行してから、cleanupFormationVerifyUserを再度呼ぶ)。
      if (resolvedWorkspaceId) await cleanupCasePatternRowsByWorkspace(resolvedWorkspaceId);
      await cleanupCasePatternRowsByOwner(userId);
      const retryResult = await cleanupFormationVerifyUser(db, userId);
      console.log(`  [cleanup再試行] userId=${userId} errors=${retryResult.errors.length}`);
      if (retryResult.errors.length > 0) {
        for (const e of retryResult.errors) console.log(`    - ${e.step}: ${String(e.error)}`);
      }
      const stillExistsAfterRetry = await db.user.findUnique({ where: { id: userId }, select: { id: true } }).catch(() => null);
      console.log(`  [cleanup] userId=${userId} 再試行後の残存: ${stillExistsAfterRetry ? "あり" : "なし"}`);
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
      data: { email, passwordHash: "not-a-real-hash-for-db-only-test", displayName: `PATTERN-DETECT-01C ${suffix}` },
    });
    const workspace = await db.workspace.create({ data: { name: `PATTERN-DETECT-01C Workspace ${suffix}` } });
    await db.workspaceMember.create({ data: { workspaceId: workspace.id, userId: user.id, role: "OWNER" } });
    const domain = await db.domain.create({ data: { workspaceId: workspace.id, name: "個人", kind: "PERSONAL" } });
    createdFixtures.push({ userId: user.id, workspaceId: workspace.id });
    return { userId: user.id, workspaceId: workspace.id, domainId: domain.id };
  }

  async function makeContext(fx: { workspaceId: string; domainId: string; userId: string }, key: string) {
    return db.projectContext.create({
      data: { workspaceId: fx.workspaceId, domainId: fx.domainId, ownerSubjectUserId: fx.userId, name: `ctx-${RUN_ID}-${key}`, createdById: fx.userId },
    });
  }

  async function makePattern(fx: { workspaceId: string; userId: string }, key: string) {
    const pattern = await db.casePattern.create({
      data: { workspaceId: fx.workspaceId, ownerSubjectUserId: fx.userId, patternKey: `pk-${RUN_ID}-${key}`, title: `検証パターン ${key}` },
    });
    const rev = await createCasePatternRevision({
      workspaceId: fx.workspaceId,
      patternId: pattern.id,
      representativeText: "検証用",
      decompositionTemplate: {},
      thresholds: {},
      schemaVersion: "1.0",
    });
    return { patternId: pattern.id, revisionId: rev.revisionId };
  }

  /** materializeFormationSession経由で本物のMaterializationReceiptItem/Responsibilityを1件作る。 */
  async function makeMaterializedOccurrence(
    fx: { workspaceId: string; domainId: string; userId: string },
    key: string,
  ): Promise<{ responsibilityId: string; materializationReceiptItemId: string }> {
    const capture = await db.capture.create({
      data: { workspaceId: fx.workspaceId, domainId: fx.domainId, createdById: fx.userId, sourceType: "TEXT", rawText: `[PATTERN-DETECT-01C verify ${key}] 検証用テキスト`, processingStatus: "READY" },
    });
    const session = await db.formationSession.create({
      data: { workspaceId: fx.workspaceId, domainId: fx.domainId, subjectUserId: fx.userId, captureId: capture.id, clientSessionKey: `pattern-detect-01c:${RUN_ID}:${key}`, state: "REVIEW_READY" },
    });
    const identity = await db.formationCandidateIdentity.create({
      data: { workspaceId: fx.workspaceId, sessionId: session.id, candidateKey: "c1", currentRevision: 1 },
    });
    await db.formationCandidateRevision.create({
      data: {
        workspaceId: fx.workspaceId, candidateId: identity.id, revision: 1, type: "TASK", title: `検証用候補 ${key}`, description: null,
        proposedFields: {
          candidateId: "c1", type: "TASK", title: `検証用候補 ${key}`, completionCondition: "検証用の完了条件",
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
    return { responsibilityId, materializationReceiptItemId: receiptItem.id };
  }

  let occSeq = 0;
  /** 実Responsibility/MaterializationReceiptItemを1件作り、その上でCasePatternSourceLinkを直接createする。 */
  async function makeOccurrenceLink(params: {
    fx: { workspaceId: string; domainId: string; userId: string };
    revisionId: string;
    contextId: string;
    occurredAt: Date;
    independenceGroup: string;
    independenceWeight: number;
    qualityWeight: number;
    excludedAt?: Date | null;
  }) {
    occSeq++;
    const occ = await makeMaterializedOccurrence(params.fx, `occ${occSeq}`);
    return db.casePatternSourceLink.create({
      data: {
        workspaceId: params.fx.workspaceId,
        patternRevisionId: params.revisionId,
        contextId: params.contextId,
        sourceEventKind: "MATERIALIZATION_RECEIPT_ITEM",
        sourceEventId: occ.materializationReceiptItemId,
        responsibilityId: occ.responsibilityId,
        sourceOccurredAt: params.occurredAt,
        independenceGroup: params.independenceGroup,
        independenceWeight: params.independenceWeight,
        qualityWeight: params.qualityWeight,
        excludedAt: params.excludedAt ?? null,
      },
    });
  }

  const DAY_MS = 24 * 60 * 60 * 1000;

  try {
    console.log("=== PATTERN-DETECT-01C 実DB受入試験 ===");

    // ================================================================
    // PD-03: 1 Context内に100 occurrenceを積んでもdistinctContext=1、ACTIVE禁止
    // ================================================================
    {
      const fx = await makeFixture("pd03");
      const ctx = await makeContext(fx, "pd03");
      const pat = await makePattern(fx, "pd03");
      const now = new Date();
      for (let i = 0; i < 100; i++) {
        await makeOccurrenceLink({
          fx, revisionId: pat.revisionId, contextId: ctx.id,
          occurredAt: new Date(now.getTime() - i * DAY_MS),
          independenceGroup: ctx.id, independenceWeight: 1, qualityWeight: 1,
        });
      }
      const result = await computeAndPersistCasePatternAggregate(fx.workspaceId, pat.patternId);
      ok("[PD-03] 100 occurrenceでもrawSampleSizeは100として集計される", result.rawSampleSize === 100, `raw=${result.rawSampleSize}`);
      ok("[PD-03] distinctContextCountは1のまま(同一Context)", result.distinctContextCount === 1, `distinct=${result.distinctContextCount}`);
      ok("[PD-03] ACTIVEへ昇格しない(distinctContext<3のため)", result.stage !== "ACTIVE" && result.stage !== "STRONG_SUGGESTION", `stage=${result.stage}`);

      const patternRow = await db.casePattern.findUnique({ where: { id: pat.patternId }, select: { status: true } });
      ok("[PD-03] CasePattern.statusにも反映される", patternRow?.status === result.stage);
    }

    // ================================================================
    // PD-04: 同一Context群のindependenceWeight合計は1.0以下へ正規化される
    // ================================================================
    {
      const fx = await makeFixture("pd04b");
      const ctx = await makeContext(fx, "pd04b");
      const pat = await makePattern(fx, "pd04b");
      const now = new Date();
      const t1 = new Date(now.getTime() - 30 * DAY_MS);
      const t2 = new Date(now.getTime() - 29 * DAY_MS);
      await makeOccurrenceLink({ fx, revisionId: pat.revisionId, contextId: ctx.id, occurredAt: t1, independenceGroup: ctx.id, independenceWeight: 0.7, qualityWeight: 1 });
      await makeOccurrenceLink({ fx, revisionId: pat.revisionId, contextId: ctx.id, occurredAt: t2, independenceGroup: ctx.id, independenceWeight: 0.7, qualityWeight: 1 });
      const result = await computeAndPersistCasePatternAggregate(fx.workspaceId, pat.patternId);
      const expectedWeightedSupport = (Math.pow(0.5, 30 / 6) + Math.pow(0.5, 29 / 6)) * 0.5;
      ok(
        "[PD-04] 正規化後の重み(各0.5)でweightedSupportが計算される(1e-4以内)",
        closeEnough(result.weightedSupport, expectedWeightedSupport, 1e-4),
        `actual=${result.weightedSupport} expected=${expectedWeightedSupport}`,
      );
    }

    // ================================================================
    // 異なるContext(独立グループ)は正規化されない(合計>1.0にならないため)
    // ================================================================
    {
      const fx = await makeFixture("multictx");
      const ctxA = await makeContext(fx, "multictxA");
      const ctxB = await makeContext(fx, "multictxB");
      const ctxC = await makeContext(fx, "multictxC");
      const pat = await makePattern(fx, "multictx");
      const now = new Date();
      await makeOccurrenceLink({ fx, revisionId: pat.revisionId, contextId: ctxA.id, occurredAt: now, independenceGroup: ctxA.id, independenceWeight: 1, qualityWeight: 1 });
      await makeOccurrenceLink({ fx, revisionId: pat.revisionId, contextId: ctxB.id, occurredAt: new Date(now.getTime() - DAY_MS), independenceGroup: ctxB.id, independenceWeight: 1, qualityWeight: 1 });
      await makeOccurrenceLink({ fx, revisionId: pat.revisionId, contextId: ctxC.id, occurredAt: new Date(now.getTime() - 2 * DAY_MS), independenceGroup: ctxC.id, independenceWeight: 1, qualityWeight: 1 });

      const result = await computeAndPersistCasePatternAggregate(fx.workspaceId, pat.patternId);
      ok("[異Context非正規化] distinctContextCountは3", result.distinctContextCount === 3, `distinct=${result.distinctContextCount}`);
      ok("[異Context非正規化] rawSampleSizeは3", result.rawSampleSize === 3);
    }

    // ================================================================
    // current revisionのみ集計: 旧revisionのSourceLinkは横断加算されない
    // ================================================================
    {
      const fx = await makeFixture("revscope");
      const ctx = await makeContext(fx, "revscope");
      const pat = await makePattern(fx, "revscope");
      const now = new Date();
      await makeOccurrenceLink({ fx, revisionId: pat.revisionId, contextId: ctx.id, occurredAt: now, independenceGroup: ctx.id, independenceWeight: 1, qualityWeight: 1 });
      await makeOccurrenceLink({ fx, revisionId: pat.revisionId, contextId: ctx.id, occurredAt: new Date(now.getTime() - DAY_MS), independenceGroup: ctx.id, independenceWeight: 1, qualityWeight: 1 });
      await makeOccurrenceLink({ fx, revisionId: pat.revisionId, contextId: ctx.id, occurredAt: new Date(now.getTime() - 2 * DAY_MS), independenceGroup: ctx.id, independenceWeight: 1, qualityWeight: 1 });

      await createCasePatternRevision({
        workspaceId: fx.workspaceId,
        patternId: pat.patternId,
        representativeText: "検証用v2",
        decompositionTemplate: {},
        thresholds: {},
        schemaVersion: "1.0",
      });

      const result = await computeAndPersistCasePatternAggregate(fx.workspaceId, pat.patternId);
      ok(
        "[current revisionのみ] revision2集計時、revision1のSourceLinkは加算されない(rawSampleSize=0)",
        result.rawSampleSize === 0,
        `raw=${result.rawSampleSize}`,
      );
      ok("[current revisionのみ] revisionIdはrevision2を指す", result.revisionId !== pat.revisionId);
    }

    // ================================================================
    // PS-07/PD-08踏襲: Evidence除外(excludedAt設定)後の再計算でraw/weighted/confidence減少
    // ================================================================
    {
      const fx = await makeFixture("pd08");
      const ctx = await makeContext(fx, "pd08");
      const pat = await makePattern(fx, "pd08");
      const now = new Date();
      const link1 = await makeOccurrenceLink({ fx, revisionId: pat.revisionId, contextId: ctx.id, occurredAt: now, independenceGroup: `${ctx.id}-a`, independenceWeight: 1, qualityWeight: 1 });
      await makeOccurrenceLink({ fx, revisionId: pat.revisionId, contextId: ctx.id, occurredAt: new Date(now.getTime() - DAY_MS), independenceGroup: `${ctx.id}-b`, independenceWeight: 1, qualityWeight: 1 });
      await makeOccurrenceLink({ fx, revisionId: pat.revisionId, contextId: ctx.id, occurredAt: new Date(now.getTime() - 2 * DAY_MS), independenceGroup: `${ctx.id}-c`, independenceWeight: 1, qualityWeight: 1 });

      const before = await computeAndPersistCasePatternAggregate(fx.workspaceId, pat.patternId);
      ok("[PD-08前提] 除外前rawSampleSizeは3", before.rawSampleSize === 3);

      await db.casePatternSourceLink.update({ where: { id: link1.id }, data: { excludedAt: new Date(), excludedReason: "verify-01c-forced-exclusion" } });

      const after = await computeAndPersistCasePatternAggregate(fx.workspaceId, pat.patternId);
      ok("[PD-08] 除外後rawSampleSizeが減少する(3→2)", after.rawSampleSize === 2, `after=${after.rawSampleSize}`);
      ok("[PD-08] 除外後weightedSupportが減少する", after.weightedSupport < before.weightedSupport, `before=${before.weightedSupport} after=${after.weightedSupport}`);
      ok("[PD-08] 除外後confidenceが増加しない(減少または同値)", after.confidence <= before.confidence);

      const aggRow = await db.casePatternEvidenceAggregate.findFirst({ where: { revisionId: before.revisionId }, select: { rawSampleSize: true } });
      ok("[PD-08] CasePatternEvidenceAggregate行にも反映される", aggRow?.rawSampleSize === 2);
    }

    // ================================================================
    // rawSampleSize<2はNONE(casePatternMath.tsの既存挙動をDB経路で再確認)
    // ================================================================
    {
      const fx = await makeFixture("none");
      const ctx = await makeContext(fx, "none");
      const pat = await makePattern(fx, "none");
      await makeOccurrenceLink({ fx, revisionId: pat.revisionId, contextId: ctx.id, occurredAt: new Date(), independenceGroup: ctx.id, independenceWeight: 1, qualityWeight: 1 });
      const result = await computeAndPersistCasePatternAggregate(fx.workspaceId, pat.patternId);
      ok("[NONE] occurrence1件はstage=NONE", result.stage === "NONE", `stage=${result.stage}`);
    }

    ok("[AI課金] AI providerへの通信は0件", guard.deniedCallAttempts.length === 0, `attempts=${guard.deniedCallAttempts.length}`);
  } finally {
    console.log("\n[CLEANUP] テスト用データを削除します...");
    for (const fx of createdFixtures) await cleanupTestUser(fx.userId, fx.workspaceId);
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
