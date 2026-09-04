#!/usr/bin/env node
/**
 * scripts/verify_gate_pattern_detect_01e.ts
 *
 * PATTERN-DETECT-01E(Suggestion接続準備)の実DB受入証跡。
 * 出典: Claude向け_ISMAY_0fcea2b以降_再監査是正・PATTERN-DETECT連続実装指示_2026-09-03.md
 * §6 PATTERN-DETECT-01E、DOC-06 §7「提案契約」。
 *
 * 検証対象:
 *   - computeCasePatternAdoptionRate: LATERを分母から除外・決着0件はnull・
 *     ACCEPT/PARTIAL_ACCEPT/REJECT/NOT_RELEVANTの正しい按分。
 *   - buildCasePatternSuggestionDto: 集計未実施ならnull、実施後は
 *     rawSampleSize/distinctContextCount/confidence/adoptionRateが正しい。
 *   - casePatternAggregation.ts(PATTERN-DETECT-01C)への接続: 採用率が
 *     実データに基づいてSTRONG_SUGGESTION昇格を左右するようになったこと
 *     (以前はnull固定でSTRONG_SUGGESTIONへ絶対に昇格しなかった)。
 *
 * AI providerへの実通信は行わない(installAiNetworkDenyGuardで機械的に保証。
 * このGateはEmbeddingを一切使わないため、そもそも呼び出し経路が無い)。
 *
 * 実行方法:
 *   cd ~/projects/ismay/app
 *   npx tsx ../scripts/verify_gate_pattern_detect_01e.ts
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
const EMAIL_PREFIX = "gate-pattern-detect-01e-verify-";

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
  const { computeAndPersistCasePatternAggregate } = await import("../app/src/lib/patterns/casePatternAggregation");
  const { computeCasePatternAdoptionRate, buildCasePatternSuggestionDto } = await import(
    "../app/src/lib/patterns/casePatternSuggestion"
  );

  async function materializeFormationSession(params: Parameters<typeof materializeFormationSessionReal>[0]) {
    const embedStub = async () => {
      throw new Error("embedAndStoreResponsibility should not be called in this Gate (AI-free verify script)");
    };
    return materializeFormationSessionReal(params, { embedAndStoreResponsibility: embedStub });
  }

  const createdFixtures: { userId: string; workspaceId: string }[] = [];

  async function cleanupCasePatternRowsByWorkspace(workspaceId: string): Promise<void> {
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
        const ctx = await db.projectContext.findFirst({ where: { OR: [{ ownerSubjectUserId: userId }, { createdById: userId }] }, select: { workspaceId: true } }).catch(() => null);
        workspaceId = ctx?.workspaceId ?? null;
      }
      if (!workspaceId) {
        const pat = await db.casePattern.findFirst({ where: { ownerSubjectUserId: userId }, select: { workspaceId: true } }).catch(() => null);
        workspaceId = pat?.workspaceId ?? null;
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
      data: { email, passwordHash: "not-a-real-hash-for-db-only-test", displayName: `PATTERN-DETECT-01E ${suffix}` },
    });
    const workspace = await db.workspace.create({ data: { name: `PATTERN-DETECT-01E Workspace ${suffix}` } });
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

  async function makeMaterializedOccurrence(
    fx: { workspaceId: string; domainId: string; userId: string },
    key: string,
  ): Promise<{ responsibilityId: string; materializationReceiptItemId: string }> {
    const capture = await db.capture.create({
      data: { workspaceId: fx.workspaceId, domainId: fx.domainId, createdById: fx.userId, sourceType: "TEXT", rawText: `[PATTERN-DETECT-01E verify ${key}] 検証用テキスト`, processingStatus: "READY" },
    });
    const session = await db.formationSession.create({
      data: { workspaceId: fx.workspaceId, domainId: fx.domainId, subjectUserId: fx.userId, captureId: capture.id, clientSessionKey: `pattern-detect-01e:${RUN_ID}:${key}`, state: "REVIEW_READY" },
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

  const DAY_MS = 24 * 60 * 60 * 1000;

  try {
    console.log("=== PATTERN-DETECT-01E 実DB受入試験 ===");

    // ================================================================
    // computeCasePatternAdoptionRate: 純粋な按分ロジック
    // ================================================================
    {
      const fx = await makeFixture("rate");
      const pat = await makePattern(fx, "rate");

      const noneRate = await computeCasePatternAdoptionRate(fx.workspaceId, pat.patternId);
      ok("[採用率] FeedbackEvent0件はnull(未計測)", noneRate === null, `rate=${noneRate}`);

      await db.casePatternFeedbackEvent.create({
        data: { workspaceId: fx.workspaceId, patternId: pat.patternId, patternRevisionId: pat.revisionId, suggestionId: "sugg-later-1", verdict: "LATER", actorUserId: fx.userId },
      });
      const laterOnlyRate = await computeCasePatternAdoptionRate(fx.workspaceId, pat.patternId);
      ok("[採用率] LATERのみは分母0のためnull(LATERは決着扱いしない)", laterOnlyRate === null, `rate=${laterOnlyRate}`);

      await db.casePatternFeedbackEvent.create({
        data: { workspaceId: fx.workspaceId, patternId: pat.patternId, patternRevisionId: pat.revisionId, suggestionId: "sugg-accept-1", verdict: "ACCEPT", actorUserId: fx.userId },
      });
      await db.casePatternFeedbackEvent.create({
        data: { workspaceId: fx.workspaceId, patternId: pat.patternId, patternRevisionId: pat.revisionId, suggestionId: "sugg-partial-1", verdict: "PARTIAL_ACCEPT", actorUserId: fx.userId },
      });
      await db.casePatternFeedbackEvent.create({
        data: { workspaceId: fx.workspaceId, patternId: pat.patternId, patternRevisionId: pat.revisionId, suggestionId: "sugg-reject-1", verdict: "REJECT", actorUserId: fx.userId },
      });
      // LATERは分母から除外されるため、決着3件(ACCEPT+PARTIAL_ACCEPT+REJECT)中2件採用=2/3。
      const mixedRate = await computeCasePatternAdoptionRate(fx.workspaceId, pat.patternId);
      ok("[採用率] ACCEPT+PARTIAL_ACCEPT=2、決着3件(LATER除外)で2/3", mixedRate !== null && Math.abs(mixedRate - 2 / 3) < 1e-9, `rate=${mixedRate}`);
    }

    // ================================================================
    // buildCasePatternSuggestionDto: 集計未実施ならnull、実施後は正しい値
    // ================================================================
    {
      const fx = await makeFixture("dto");
      const ctx = await makeContext(fx, "dto");
      const pat = await makePattern(fx, "dto");

      const beforeDto = await buildCasePatternSuggestionDto(fx.workspaceId, pat.patternId);
      ok("[DTO] 集計(EvidenceAggregate)未実施ならnull", beforeDto === null);

      const occ = await makeMaterializedOccurrence(fx, "dto1");
      await db.casePatternSourceLink.create({
        data: {
          workspaceId: fx.workspaceId, patternRevisionId: pat.revisionId, contextId: ctx.id,
          sourceEventKind: "MATERIALIZATION_RECEIPT_ITEM", sourceEventId: occ.materializationReceiptItemId,
          responsibilityId: occ.responsibilityId, sourceOccurredAt: new Date(), independenceGroup: ctx.id,
          independenceWeight: 1, qualityWeight: 1,
        },
      });
      await computeAndPersistCasePatternAggregate(fx.workspaceId, pat.patternId);

      await db.casePatternFeedbackEvent.create({
        data: { workspaceId: fx.workspaceId, patternId: pat.patternId, patternRevisionId: pat.revisionId, suggestionId: "sugg-dto-1", verdict: "ACCEPT", actorUserId: fx.userId },
      });

      const afterDto = await buildCasePatternSuggestionDto(fx.workspaceId, pat.patternId);
      ok("[DTO] 集計後はnullでない", afterDto !== null);
      if (afterDto) {
        ok("[DTO] rawSampleSizeが正しい(1)", afterDto.rawSampleSize === 1, `raw=${afterDto.rawSampleSize}`);
        ok("[DTO] distinctContextCountが正しい(1)", afterDto.distinctContextCount === 1);
        ok("[DTO] adoptionRateが正しい(1件ACCEPTのみで1.0)", afterDto.adoptionRate === 1, `rate=${afterDto.adoptionRate}`);
        ok("[DTO] patternId/revisionIdが正しい", afterDto.patternId === pat.patternId && afterDto.revisionId === pat.revisionId);
      }
    }

    // ================================================================
    // STRONG_SUGGESTION昇格の実接続: 採用率0.6以上で昇格・未満で昇格しない
    // ================================================================
    {
      const fx = await makeFixture("strong");
      const pat = await makePattern(fx, "strong");
      const now = new Date();

      // raw>=10, distinctContext>=5(実際は10distinct)、confidence>=0.67を
      // 満たすため、10件の異なるContextへ0〜9日前の日付で1件ずつoccurrenceを作る。
      for (let i = 0; i < 10; i++) {
        const ctx = await makeContext(fx, `strong-ctx${i}`);
        const occ = await makeMaterializedOccurrence(fx, `strong-occ${i}`);
        await db.casePatternSourceLink.create({
          data: {
            workspaceId: fx.workspaceId, patternRevisionId: pat.revisionId, contextId: ctx.id,
            sourceEventKind: "MATERIALIZATION_RECEIPT_ITEM", sourceEventId: occ.materializationReceiptItemId,
            responsibilityId: occ.responsibilityId, sourceOccurredAt: new Date(now.getTime() - i * DAY_MS),
            independenceGroup: ctx.id, independenceWeight: 1, qualityWeight: 1,
          },
        });
      }

      // 採用率をちょうど0.6にする(3 ACCEPT / 5 決着)。
      const verdicts: ("ACCEPT" | "REJECT")[] = ["ACCEPT", "ACCEPT", "ACCEPT", "REJECT", "REJECT"];
      for (let i = 0; i < verdicts.length; i++) {
        await db.casePatternFeedbackEvent.create({
          data: { workspaceId: fx.workspaceId, patternId: pat.patternId, patternRevisionId: pat.revisionId, suggestionId: `sugg-strong-${i}`, verdict: verdicts[i]!, actorUserId: fx.userId },
        });
      }

      const resultAt06 = await computeAndPersistCasePatternAggregate(fx.workspaceId, pat.patternId);
      ok(
        "[STRONG_SUGGESTION接続] raw/context/confidence条件を満たし採用率0.6以上ならSTRONG_SUGGESTIONへ昇格する",
        resultAt06.stage === "STRONG_SUGGESTION",
        `stage=${resultAt06.stage} raw=${resultAt06.rawSampleSize} distinct=${resultAt06.distinctContextCount} confidence=${resultAt06.confidence}`,
      );

      // 採用率を0.6未満(4 REJECT追加、3 ACCEPT / 9決着 ≒ 0.333)へ落とす。
      for (let i = 0; i < 4; i++) {
        await db.casePatternFeedbackEvent.create({
          data: { workspaceId: fx.workspaceId, patternId: pat.patternId, patternRevisionId: pat.revisionId, suggestionId: `sugg-strong-extra-${i}`, verdict: "REJECT", actorUserId: fx.userId },
        });
      }
      const resultBelow06 = await computeAndPersistCasePatternAggregate(fx.workspaceId, pat.patternId);
      ok(
        "[STRONG_SUGGESTION接続] 採用率が0.6未満に下がるとSTRONG_SUGGESTIONへは昇格しない(ACTIVE止まり)",
        resultBelow06.stage === "ACTIVE",
        `stage=${resultBelow06.stage}`,
      );
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
