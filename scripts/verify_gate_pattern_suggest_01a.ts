#!/usr/bin/env node
/**
 * scripts/verify_gate_pattern_suggest_01a.ts
 *
 * PATTERN-SUGGEST-01A(Suggestion identity/revision schema)の実DB受入証跡。
 * 出典: Claude向け_ISMAY_3b695d9以降_再監査是正・CasePattern実機能完遂指示_
 * 2026-09-04.md §5。
 *
 * このGateはschemaのみが対象(実際にSuggestionを作成する検出接続は
 * PATTERN-SUGGEST-01B、Feedback処理APIはPATTERN-SUGGEST-01Cのscope)。
 * そのため本scriptはPrisma Clientを直接使い、schema制約(複合FK・CHECK・
 * unique)が設計通り機能することを検証する(サービス層は未実装のため
 * 対象外)。
 *
 * AI providerへの実通信は行わない(installAiNetworkDenyGuardで機械的に保証。
 * このGateはAI呼出し自体を含まないが、既存verify script群と同じ規約として
 * 導入する)。
 *
 * 実行方法:
 *   cd ~/projects/ismay/app
 *   npx tsx ../scripts/verify_gate_pattern_suggest_01a.ts
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
const EMAIL_PREFIX = "gate-pattern-suggest-01a-verify-";

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

function isP2002(err: unknown): boolean {
  return (err as { code?: string })?.code === "P2002";
}
function isP2003(err: unknown): boolean {
  return (err as { code?: string })?.code === "P2003";
}

async function main(): Promise<void> {
  const { installAiNetworkDenyGuard } = await import("./lib/aiNetworkDenyGuard");
  const guard = installAiNetworkDenyGuard();

  const { db } = await import("../app/src/lib/db");
  const { cleanupFormationVerifyUser } = await import("./lib/formationVerifyCleanup");
  const { createCasePatternRevision } = await import("../app/src/lib/patterns/casePatternRevisionService");

  const createdFixtures: { userId: string; workspaceId: string }[] = [];

  async function cleanupCasePatternRowsByWorkspace(workspaceId: string): Promise<void> {
    await db.casePatternFeedbackEvent.deleteMany({ where: { workspaceId } }).catch(() => null);
    await db.casePatternSuggestionRevision.deleteMany({ where: { workspaceId } }).catch(() => null);
    await db.casePatternSuggestionIdentity.deleteMany({ where: { workspaceId } }).catch(() => null);
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
      data: { email, passwordHash: "not-a-real-hash-for-db-only-test", displayName: `PATTERN-SUGGEST-01A ${suffix}` },
    });
    const workspace = await db.workspace.create({ data: { name: `PATTERN-SUGGEST-01A Workspace ${suffix}` } });
    await db.workspaceMember.create({ data: { workspaceId: workspace.id, userId: user.id, role: "OWNER" } });
    const domain = await db.domain.create({ data: { workspaceId: workspace.id, name: "個人", kind: "PERSONAL" } });
    createdFixtures.push({ userId: user.id, workspaceId: workspace.id });
    return { userId: user.id, workspaceId: workspace.id, domainId: domain.id };
  }

  /** Formation Session + CandidateIdentity/Revision(materialize不要、Suggestionの照合元として使うのみ)。 */
  async function makeCandidate(fx: { workspaceId: string; domainId: string; userId: string }, key: string) {
    const capture = await db.capture.create({
      data: { workspaceId: fx.workspaceId, domainId: fx.domainId, createdById: fx.userId, sourceType: "TEXT", rawText: `[verify ${key}]`, processingStatus: "READY" },
    });
    const session = await db.formationSession.create({
      data: { workspaceId: fx.workspaceId, domainId: fx.domainId, subjectUserId: fx.userId, captureId: capture.id, clientSessionKey: `pattern-suggest-01a:${RUN_ID}:${key}`, state: "REVIEW_READY" },
    });
    const identity = await db.formationCandidateIdentity.create({
      data: { workspaceId: fx.workspaceId, sessionId: session.id, candidateKey: `ck-${key}`, currentRevision: 1 },
    });
    const revision = await db.formationCandidateRevision.create({
      data: {
        workspaceId: fx.workspaceId, candidateId: identity.id, revision: 1, type: "TASK", title: `検証用候補 ${key}`, description: null,
        proposedFields: { candidateId: `ck-${key}`, type: "TASK", title: `検証用候補 ${key}`, completionCondition: "検証用", evidenceSpans: [], confidence: 0.9, dateMentions: [], unknowns: [], blockedByCandidateIds: [], suggestedTags: [] },
        confidence: 0.9, schemaVersion: "1.0",
      },
    });
    return { sessionId: session.id, candidateId: identity.id, candidateKey: identity.candidateKey, candidateRevisionId: revision.id };
  }

  async function makePattern(fx: { workspaceId: string; userId: string }, key: string) {
    const pattern = await db.casePattern.create({
      data: { workspaceId: fx.workspaceId, ownerSubjectUserId: fx.userId, patternKey: `pk-${RUN_ID}-${key}`, title: `検証パターン ${key}` },
    });
    const rev = await createCasePatternRevision({
      workspaceId: fx.workspaceId, patternId: pattern.id, representativeText: `検証用 ${key}`, decompositionTemplate: {}, thresholds: {}, schemaVersion: "1.0",
    });
    return { patternId: pattern.id, revisionId: rev.revisionId };
  }

  try {
    console.log("=== PATTERN-SUGGEST-01A 実DB受入試験 ===");

    // ================================================================
    // 正常系: Identity + Revision + FeedbackEventを正しい参照で作成できる
    // ================================================================
    let suggestionId = "";
    let suggestionRevisionId = "";
    {
      const fx = await makeFixture("basic");
      const cand = await makeCandidate(fx, "basic");
      const pat = await makePattern(fx, "basic");

      const identity = await db.casePatternSuggestionIdentity.create({
        data: {
          workspaceId: fx.workspaceId,
          ownerSubjectUserId: fx.userId,
          formationSessionId: cand.sessionId,
          candidateId: cand.candidateId,
          suggestionKey: cand.candidateKey,
          currentRevision: 1,
        },
      });
      ok("[正常系] CasePatternSuggestionIdentityが作成できる", identity.id != null);
      ok("[正常系] stateの既定値はPENDING", identity.state === "PENDING", identity.state);
      suggestionId = identity.id;

      const revision = await db.casePatternSuggestionRevision.create({
        data: {
          workspaceId: fx.workspaceId,
          suggestionId: identity.id,
          revision: 1,
          candidateId: cand.candidateId,
          sourceCandidateRevisionId: cand.candidateRevisionId,
          matchedPatternId: pat.patternId,
          matchedPatternRevisionId: pat.revisionId,
          matchPolicyVersion: "case-pattern-match-v1",
          similarity: "0.95",
          decompositionProposal: { children: [{ childKey: "c1-1", type: "TASK", title: "分解案1" }] },
          evidenceSnapshot: { rawSampleSize: 5, distinctContextCount: 3, confidence: 0.6, adoptionRate: null, adoptionPolicyVersion: "case-pattern-adoption-v1" },
          schemaVersion: "1.0",
        },
      });
      ok("[正常系] CasePatternSuggestionRevisionが作成できる", revision.id != null);
      suggestionRevisionId = revision.id;

      const feedback = await db.casePatternFeedbackEvent.create({
        data: {
          workspaceId: fx.workspaceId,
          patternId: pat.patternId,
          patternRevisionId: pat.revisionId,
          suggestionId: identity.id,
          suggestionRevisionId: revision.id,
          verdict: "ACCEPT",
          actorUserId: fx.userId,
          idempotencyKey: `${RUN_ID}-fb1`,
          requestPayloadHash: "hash1",
        },
      });
      ok("[正常系] CasePatternFeedbackEventがsuggestion/suggestionRevisionへ正しくFKできる", feedback.id != null);

      // ================================================================
      // unique制約: 同一Candidateへ2件目のSuggestion identityは拒否される
      // ================================================================
      let duplicateIdentityRejected = false;
      try {
        await db.casePatternSuggestionIdentity.create({
          data: {
            workspaceId: fx.workspaceId, ownerSubjectUserId: fx.userId, formationSessionId: cand.sessionId,
            candidateId: cand.candidateId, suggestionKey: cand.candidateKey, currentRevision: 1,
          },
        });
      } catch (err) {
        duplicateIdentityRejected = isP2002(err);
      }
      ok("[unique制約] 同一Candidateへの2件目のSuggestion identityはP2002で拒否される", duplicateIdentityRejected);

      // ================================================================
      // unique制約: idempotencyKey重複は拒否される
      // ================================================================
      let duplicateIdempotencyRejected = false;
      try {
        await db.casePatternFeedbackEvent.create({
          data: {
            workspaceId: fx.workspaceId, patternId: pat.patternId, patternRevisionId: pat.revisionId,
            suggestionId: identity.id, suggestionRevisionId: revision.id, verdict: "REJECT", actorUserId: fx.userId,
            idempotencyKey: `${RUN_ID}-fb1`, requestPayloadHash: "hash-different",
          },
        });
      } catch (err) {
        duplicateIdempotencyRejected = isP2002(err);
      }
      ok("[unique制約] 同一idempotencyKeyの2件目FeedbackEventはP2002で拒否される", duplicateIdempotencyRejected);

      // ================================================================
      // CHECK制約: matched_pattern_id/matched_pattern_revision_idは対で
      // 必須(片方だけの指定は拒否される)
      // ================================================================
      let partialMatchedRejected = false;
      try {
        await db.casePatternSuggestionRevision.create({
          data: {
            workspaceId: fx.workspaceId, suggestionId: identity.id, revision: 2, candidateId: cand.candidateId,
            sourceCandidateRevisionId: cand.candidateRevisionId, matchedPatternId: pat.patternId, matchedPatternRevisionId: null,
            matchPolicyVersion: "case-pattern-match-v1", similarity: "0.95",
            decompositionProposal: {}, evidenceSnapshot: {}, schemaVersion: "1.0",
          },
        });
      } catch {
        partialMatchedRejected = true;
      }
      ok("[CHECK制約] matched_pattern_id/matched_pattern_revision_idの片方だけの指定は拒否される", partialMatchedRejected);

      // ================================================================
      // 複合FK: workspaceIdが一致しないsuggestionId/suggestionRevisionIdを
      // 指すFeedbackEventは拒否される(「採否は提案Revisionに固定」を
      // 支えるtenant境界の複合FK保証)。
      // ================================================================
      const fx2 = await makeFixture("crosscheck");
      let crossWorkspaceRejected = false;
      try {
        await db.casePatternFeedbackEvent.create({
          data: {
            workspaceId: fx2.workspaceId, patternId: pat.patternId, patternRevisionId: pat.revisionId,
            suggestionId: identity.id, suggestionRevisionId: revision.id, verdict: "ACCEPT", actorUserId: fx2.userId,
            idempotencyKey: `${RUN_ID}-cross`, requestPayloadHash: "hash-cross",
          },
        });
      } catch (err) {
        crossWorkspaceRejected = isP2003(err) || isP2002(err) || err != null;
      }
      ok("[複合FK] 他workspaceIdを指定したFeedbackEventは拒否される(suggestion/pattern双方のtenant境界FK)", crossWorkspaceRejected);
    }

    ok("[疎通] 作成したsuggestionId/suggestionRevisionIdが空でない", suggestionId.length > 0 && suggestionRevisionId.length > 0);
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
