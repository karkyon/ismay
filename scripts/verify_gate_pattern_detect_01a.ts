#!/usr/bin/env node
/**
 * scripts/verify_gate_pattern_detect_01a.ts
 *
 * PATTERN-DETECT-01A(Eligibility・SourceLink write service)の実DB受入証跡。
 * 出典: Claude向け_ISMAY_0fcea2b以降_再監査是正・PATTERN-DETECT連続実装指示_2026-09-03.md
 * §6 PATTERN-DETECT-01A、§7 受入条件 PD-01/PD-02/PD-05。
 *
 * AI providerへの実通信は行わない(installAiNetworkDenyGuardで機械的に保証)。
 *
 * 実行方法:
 *   cd ~/projects/ismay/app
 *   npx tsx ../scripts/verify_gate_pattern_detect_01a.ts
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
const EMAIL_PREFIX = "gate-pattern-detect-01a-verify-";

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
  const { recordCandidateDecision, materializeFormationSession: materializeFormationSessionReal } = await import(
    "../app/src/lib/formation/materialize"
  );
  const { createCasePatternRevision } = await import("../app/src/lib/patterns/casePatternRevisionService");
  const {
    linkPatternSourceEvent,
    PatternSourceEligibilityError,
    PatternSourceProvenanceError,
  } = await import("../app/src/lib/patterns/sourceLinkService");

  async function materializeFormationSession(params: Parameters<typeof materializeFormationSessionReal>[0]) {
    const embedStub = async () => {
      throw new Error("embedAndStoreResponsibility should not be called in this Gate (AI-free verify script)");
    };
    return materializeFormationSessionReal(params, { embedAndStoreResponsibility: embedStub });
  }

  const userIds: string[] = [];

  async function cleanupTestUser(userId: string): Promise<void> {
    const membership = await db.workspaceMember.findFirst({ where: { userId }, select: { workspaceId: true } }).catch(() => null);
    const workspaceId = membership?.workspaceId ?? null;
    if (workspaceId) {
      const patterns = await db.casePattern.findMany({ where: { workspaceId }, select: { id: true } }).catch(() => []);
      const patternIds = patterns.map((p) => p.id);
      if (patternIds.length > 0) {
        const revisions = await db.casePatternRevision
          .findMany({ where: { patternId: { in: patternIds } }, select: { id: true } })
          .catch(() => []);
        const revisionIds = revisions.map((r) => r.id);
        if (revisionIds.length > 0) {
          await db.casePatternEmbedding.deleteMany({ where: { revisionId: { in: revisionIds } } }).catch(() => null);
          await db.casePatternEvidenceAggregate.deleteMany({ where: { revisionId: { in: revisionIds } } }).catch(() => null);
          await db.casePatternSourceLink.deleteMany({ where: { patternRevisionId: { in: revisionIds } } }).catch(() => null);
        }
        await db.casePatternFeedbackEvent.deleteMany({ where: { patternId: { in: patternIds } } }).catch(() => null);
        if (revisionIds.length > 0) {
          await db.casePatternRevision.deleteMany({ where: { id: { in: revisionIds } } }).catch(() => null);
        }
        await db.casePattern.deleteMany({ where: { id: { in: patternIds } } }).catch(() => null);
      }
    }
    const result = await cleanupFormationVerifyUser(db, userId);
    if (result.errors.length > 0) {
      console.log(`  [cleanup警告] cleanupFormationVerifyUserでエラー${result.errors.length}件:`);
      for (const e of result.errors) console.log(`    - ${e.step}: ${String(e.error)}`);
    }
  }

  // 過去実行の孤立テストユーザーを本編実行前に一括回収する(既存確立SWEEPパターン)。
  const orphans = await db.user.findMany({
    where: { email: { startsWith: EMAIL_PREFIX, endsWith: "@example.invalid" } },
    select: { id: true },
  });
  if (orphans.length > 0) {
    console.log(`[SWEEP] 過去実行の孤立テストユーザー${orphans.length}件を削除します...`);
    for (const o of orphans) await cleanupTestUser(o.id);
  }

  async function makeFixture(suffix: string) {
    const email = `${EMAIL_PREFIX}${RUN_ID}-${suffix}@example.invalid`;
    const user = await db.user.create({
      data: { email, passwordHash: "not-a-real-hash-for-db-only-test", displayName: `PATTERN-DETECT-01A ${suffix}` },
    });
    const workspace = await db.workspace.create({ data: { name: `PATTERN-DETECT-01A Workspace ${suffix}` } });
    await db.workspaceMember.create({ data: { workspaceId: workspace.id, userId: user.id, role: "OWNER" } });
    const domain = await db.domain.create({ data: { workspaceId: workspace.id, name: "個人", kind: "PERSONAL" } });
    userIds.push(user.id);
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
      data: { workspaceId: fx.workspaceId, domainId: fx.domainId, createdById: fx.userId, sourceType: "TEXT", rawText: `[PATTERN-DETECT-01A verify ${key}] 検証用テキスト`, processingStatus: "READY" },
    });
    const session = await db.formationSession.create({
      data: { workspaceId: fx.workspaceId, domainId: fx.domainId, subjectUserId: fx.userId, captureId: capture.id, clientSessionKey: `pattern-detect-01a:${RUN_ID}:${key}`, state: "REVIEW_READY" },
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

  try {
    console.log("=== PATTERN-DETECT-01A 実DB受入試験 ===");

    // ================================================================
    // PD-EL-01: PRIMARY active linkを持つResponsibilityのoccurrenceは成功する
    // ================================================================
    let sharedFx: Awaited<ReturnType<typeof makeFixture>>;
    let sharedCtx: Awaited<ReturnType<typeof makeContext>>;
    let sharedOcc: Awaited<ReturnType<typeof makeMaterializedOccurrence>>;
    let sharedPattern: Awaited<ReturnType<typeof makePattern>>;
    {
      sharedFx = await makeFixture("primary");
      sharedCtx = await makeContext(sharedFx, "primary");
      sharedOcc = await makeMaterializedOccurrence(sharedFx, "primary");
      sharedPattern = await makePattern(sharedFx, "primary");

      await db.projectContextLink.create({
        data: { workspaceId: sharedFx.workspaceId, contextId: sharedCtx.id, responsibilityId: sharedOcc.responsibilityId, role: "PRIMARY", sourceKind: "USER" },
      });

      const result = await linkPatternSourceEvent({
        workspaceId: sharedFx.workspaceId,
        patternRevisionId: sharedPattern.revisionId,
        contextId: sharedCtx.id,
        sourceEventKind: "MATERIALIZATION_RECEIPT_ITEM",
        sourceEventId: sharedOcc.materializationReceiptItemId,
        responsibilityId: sharedOcc.responsibilityId,
        independenceGroup: sharedCtx.id,
      });
      ok("[PD-EL-01] PRIMARY active linkを持つoccurrenceはSourceLink作成に成功する", result.created === true);

      const count1 = await db.casePatternSourceLink.count({ where: { patternRevisionId: sharedPattern.revisionId } });
      ok("[PD-EL-01] SourceLink件数は1件", count1 === 1);

      // ================================================================
      // PD-01: 同じsource Eventの再処理100回でSourceLink増加0
      // ================================================================
      for (let i = 0; i < 100; i++) {
        const replay = await linkPatternSourceEvent({
          workspaceId: sharedFx.workspaceId,
          patternRevisionId: sharedPattern.revisionId,
          contextId: sharedCtx.id,
          sourceEventKind: "MATERIALIZATION_RECEIPT_ITEM",
          sourceEventId: sharedOcc.materializationReceiptItemId,
          responsibilityId: sharedOcc.responsibilityId,
          independenceGroup: sharedCtx.id,
        });
        if (replay.created !== false || replay.sourceLinkId !== result.sourceLinkId) {
          throw new Error(`PD-01: 再処理${i}回目で新規created扱い、または別idを返した: ${JSON.stringify(replay)}`);
        }
      }
      const count2 = await db.casePatternSourceLink.count({ where: { patternRevisionId: sharedPattern.revisionId } });
      ok("[PD-01] 同一source Eventの100回再処理後もSourceLink件数は1件のまま(増加0)", count2 === 1, `count=${count2}`);
    }

    // ================================================================
    // PD-02: SUPPORTING/REFERENCEのみのResponsibilityはEligibility拒否される
    // (occurrenceとして計上されない=SourceLink増加0)
    // ================================================================
    {
      const fx = await makeFixture("supporting");
      const ctx = await makeContext(fx, "supporting");
      const occ = await makeMaterializedOccurrence(fx, "supporting");
      const pattern = await makePattern(fx, "supporting");

      await db.projectContextLink.create({
        data: { workspaceId: fx.workspaceId, contextId: ctx.id, responsibilityId: occ.responsibilityId, role: "SUPPORTING", sourceKind: "USER" },
      });

      let rejected = false;
      try {
        await linkPatternSourceEvent({
          workspaceId: fx.workspaceId,
          patternRevisionId: pattern.revisionId,
          contextId: ctx.id,
          sourceEventKind: "MATERIALIZATION_RECEIPT_ITEM",
          sourceEventId: occ.materializationReceiptItemId,
          responsibilityId: occ.responsibilityId,
          independenceGroup: ctx.id,
        });
      } catch (err) {
        rejected = err instanceof PatternSourceEligibilityError;
      }
      ok("[PD-02] SUPPORTING roleのみ(PRIMARYなし)はEligibilityErrorで拒否される", rejected);
      const count = await db.casePatternSourceLink.count({ where: { patternRevisionId: pattern.revisionId } });
      ok("[PD-02] SourceLink件数は0件のまま(occurrence増加0)", count === 0, `count=${count}`);
    }

    // ================================================================
    // unlink済みPRIMARYはEligibility拒否される
    // ================================================================
    {
      const fx = await makeFixture("unlinked");
      const ctx = await makeContext(fx, "unlinked");
      const occ = await makeMaterializedOccurrence(fx, "unlinked");
      const pattern = await makePattern(fx, "unlinked");

      await db.projectContextLink.create({
        data: { workspaceId: fx.workspaceId, contextId: ctx.id, responsibilityId: occ.responsibilityId, role: "PRIMARY", sourceKind: "USER", unlinkedAt: new Date() },
      });

      let rejected = false;
      try {
        await linkPatternSourceEvent({
          workspaceId: fx.workspaceId,
          patternRevisionId: pattern.revisionId,
          contextId: ctx.id,
          sourceEventKind: "MATERIALIZATION_RECEIPT_ITEM",
          sourceEventId: occ.materializationReceiptItemId,
          responsibilityId: occ.responsibilityId,
          independenceGroup: ctx.id,
        });
      } catch (err) {
        rejected = err instanceof PatternSourceEligibilityError;
      }
      ok("[unlink済みPRIMARY] unlinkedAtが設定済みのPRIMARY LinkはEligibilityErrorで拒否される", rejected);
    }

    // ================================================================
    // PD-05: 他workspaceのsource Eventは検索対象0(provenance拒否)
    // ================================================================
    {
      const fxA = await makeFixture("pd05a");
      const fxB = await makeFixture("pd05b");
      const ctxA = await makeContext(fxA, "pd05a");
      const occB = await makeMaterializedOccurrence(fxB, "pd05b");
      const patternA = await makePattern(fxA, "pd05a");

      let rejected = false;
      try {
        await linkPatternSourceEvent({
          workspaceId: fxA.workspaceId, // workspace Aを名乗る
          patternRevisionId: patternA.revisionId,
          contextId: ctxA.id,
          sourceEventKind: "MATERIALIZATION_RECEIPT_ITEM",
          sourceEventId: occB.materializationReceiptItemId, // 実際はworkspace Bのitem
          independenceGroup: ctxA.id,
        });
      } catch (err) {
        rejected = err instanceof PatternSourceProvenanceError;
      }
      ok("[PD-05] 他workspaceのMaterializationReceiptItemIdはProvenanceErrorで拒否される", rejected);
    }

    // ================================================================
    // kind不一致: sourceEventKind=FORMATION_CANDIDATE_REVISIONだが実際は
    // MaterializationReceiptItemのidを渡す(provenance拒否)
    // ================================================================
    {
      const fx = await makeFixture("kindmismatch");
      const ctx = await makeContext(fx, "kindmismatch");
      const occ = await makeMaterializedOccurrence(fx, "kindmismatch");
      const pattern = await makePattern(fx, "kindmismatch");

      let rejected = false;
      try {
        await linkPatternSourceEvent({
          workspaceId: fx.workspaceId,
          patternRevisionId: pattern.revisionId,
          contextId: ctx.id,
          sourceEventKind: "FORMATION_CANDIDATE_REVISION", // 実際はMaterializationReceiptItemのid
          sourceEventId: occ.materializationReceiptItemId,
          independenceGroup: ctx.id,
        });
      } catch (err) {
        rejected = err instanceof PatternSourceProvenanceError;
      }
      ok("[kind不一致] 実体と異なるsourceEventKindを指定するとProvenanceErrorで拒否される", rejected);
    }

    // ================================================================
    // responsibilityId明示指定が実provenanceと矛盾する場合の拒否
    // ================================================================
    {
      const fx = await makeFixture("mismatchresp");
      const ctx = await makeContext(fx, "mismatchresp");
      const occ1 = await makeMaterializedOccurrence(fx, "mismatchresp1");
      const occ2 = await makeMaterializedOccurrence(fx, "mismatchresp2");
      const pattern = await makePattern(fx, "mismatchresp");

      let rejected = false;
      try {
        await linkPatternSourceEvent({
          workspaceId: fx.workspaceId,
          patternRevisionId: pattern.revisionId,
          contextId: ctx.id,
          sourceEventKind: "MATERIALIZATION_RECEIPT_ITEM",
          sourceEventId: occ1.materializationReceiptItemId,
          responsibilityId: occ2.responsibilityId, // occ1のitemとは無関係な別responsibilityId
          independenceGroup: ctx.id,
        });
      } catch (err) {
        rejected = err instanceof PatternSourceProvenanceError;
      }
      ok("[provenance矛盾] 指定responsibilityIdが実際のitemと不一致ならProvenanceErrorで拒否される", rejected);
    }

    ok("[AI課金] AI providerへの通信は0件", guard.deniedCallAttempts.length === 0, `attempts=${guard.deniedCallAttempts.length}`);
  } finally {
    console.log("\n[CLEANUP] テスト用データを削除します...");
    for (const userId of userIds) await cleanupTestUser(userId);
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
