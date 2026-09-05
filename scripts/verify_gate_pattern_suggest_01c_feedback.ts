#!/usr/bin/env node
/**
 * scripts/verify_gate_pattern_suggest_01c_feedback.ts
 *
 * PATTERN-SUGGEST-01C(Feedback command・採用処理)の実DB受入証跡。
 * 出典: ISMAY_ハンドオフ資料_2026-09-05.md §5-2。
 *
 * このGateの対象はrecordCasePatternFeedback(サービス層)のみ。HTTP層
 * (CSRF検証・Idempotency-Keyヘッダ読取・zodバリデーション)は
 * route.tsが薄いラッパーのため、既存verify script群と同じ方針で
 * サービス関数を直接呼び出して検証する(実HTTPサーバー起動はしない)。
 *
 * AI providerへの実通信は行わない(installAiNetworkDenyGuardで機械的に保証。
 * このGate自体はAI呼出しを含まないが、既存verify script群と同じ規約として
 * 導入する)。
 *
 * 実行方法:
 *   cd ~/projects/ismay/app
 *   npx tsx ../scripts/verify_gate_pattern_suggest_01c_feedback.ts
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { createHash, randomUUID } from "node:crypto";

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
const EMAIL_PREFIX = "gate-pattern-suggest-01c-verify-";

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

async function main(): Promise<void> {
  const { installAiNetworkDenyGuard } = await import("./lib/aiNetworkDenyGuard");
  const guard = installAiNetworkDenyGuard();

  const { db } = await import("../app/src/lib/db");
  const { cleanupFormationVerifyUser } = await import("./lib/formationVerifyCleanup");
  const { createCasePatternRevision } = await import("../app/src/lib/patterns/casePatternRevisionService");
  const { recordCasePatternFeedback } = await import("../app/src/lib/patterns/casePatternFeedbackService");

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
      data: { email, passwordHash: "not-a-real-hash-for-db-only-test", displayName: `PATTERN-SUGGEST-01C ${suffix}` },
    });
    const workspace = await db.workspace.create({ data: { name: `PATTERN-SUGGEST-01C Workspace ${suffix}` } });
    await db.workspaceMember.create({ data: { workspaceId: workspace.id, userId: user.id, role: "OWNER" } });
    const domain = await db.domain.create({ data: { workspaceId: workspace.id, name: "個人", kind: "PERSONAL" } });
    createdFixtures.push({ userId: user.id, workspaceId: workspace.id });
    return { userId: user.id, workspaceId: workspace.id, domainId: domain.id };
  }

  async function makeCandidate(fx: { workspaceId: string; domainId: string; userId: string }, key: string) {
    const capture = await db.capture.create({
      data: { workspaceId: fx.workspaceId, domainId: fx.domainId, createdById: fx.userId, sourceType: "TEXT", rawText: `[verify ${key}]`, processingStatus: "READY" },
    });
    const session = await db.formationSession.create({
      data: { workspaceId: fx.workspaceId, domainId: fx.domainId, subjectUserId: fx.userId, captureId: capture.id, clientSessionKey: `pattern-suggest-01c:${RUN_ID}:${key}`, state: "REVIEW_READY" },
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

  /** MATCHEDなSuggestionIdentity+Revisionを1件作る(matchedPatternId/matchedPatternRevisionIdあり)。 */
  async function makeMatchedSuggestion(
    fx: { workspaceId: string; domainId: string; userId: string },
    key: string,
  ): Promise<{ suggestionId: string; revision: number }> {
    const cand = await makeCandidate(fx, key);
    const pat = await makePattern(fx, key);
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
    await db.casePatternSuggestionRevision.create({
      data: {
        workspaceId: fx.workspaceId,
        suggestionId: identity.id,
        revision: 1,
        candidateId: cand.candidateId,
        sourceCandidateRevisionId: cand.candidateRevisionId,
        matchedPatternId: pat.patternId,
        matchedPatternRevisionId: pat.revisionId,
        matchPolicyVersion: "case-pattern-match-v1",
        similarity: 0.95,
        decompositionProposal: {},
        evidenceSnapshot: {},
        schemaVersion: "1.0",
      },
    });
    return { suggestionId: identity.id, revision: 1 };
  }

  /** AMBIGUOUSなSuggestionIdentity+Revisionを1件作る(matchedPatternId/matchedPatternRevisionIdともにnull)。 */
  async function makeAmbiguousSuggestion(
    fx: { workspaceId: string; domainId: string; userId: string },
    key: string,
  ): Promise<{ suggestionId: string; revision: number }> {
    const cand = await makeCandidate(fx, key);
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
    await db.casePatternSuggestionRevision.create({
      data: {
        workspaceId: fx.workspaceId,
        suggestionId: identity.id,
        revision: 1,
        candidateId: cand.candidateId,
        sourceCandidateRevisionId: cand.candidateRevisionId,
        matchedPatternId: null,
        matchedPatternRevisionId: null,
        matchPolicyVersion: "case-pattern-match-v1",
        similarity: 0.5,
        decompositionProposal: { ambiguousCandidates: [] },
        evidenceSnapshot: {},
        schemaVersion: "1.0",
      },
    });
    return { suggestionId: identity.id, revision: 1 };
  }

  try {
    console.log("=== PATTERN-SUGGEST-01C Feedback 実DB受入試験 ===");

    // ================================================================
    // 正常系: ACCEPT feedbackが記録できる・Suggestion.stateが更新される
    // ================================================================
    {
      const fx = await makeFixture("basic");
      const sug = await makeMatchedSuggestion(fx, "basic");
      const payload = { revision: sug.revision, verdict: "ACCEPT" as const };
      const result = await recordCasePatternFeedback({
        workspaceId: fx.workspaceId,
        suggestionId: sug.suggestionId,
        actorUserId: fx.userId,
        expectedRevision: sug.revision,
        verdict: payload.verdict,
        idempotencyKey: `idem-basic-${RUN_ID}`,
        requestPayloadHash: hashPayload(payload),
      });
      ok("[正常系] recordCasePatternFeedbackがok:trueを返す", result.ok === true);
      if (result.ok) {
        ok("[正常系] replay=false(新規作成)", result.replay === false);
        ok("[正常系] suggestionState=ACCEPT", result.suggestionState === "ACCEPT");
        const dbIdentity = await db.casePatternSuggestionIdentity.findFirst({ where: { id: sug.suggestionId }, select: { state: true } });
        ok("[正常系] DB上もstate=ACCEPT", dbIdentity?.state === "ACCEPT");
        const dbEvent = await db.casePatternFeedbackEvent.findFirst({ where: { id: result.feedbackEventId }, select: { verdict: true, supersedesFeedbackEventId: true } });
        ok("[正常系] FeedbackEvent.verdict=ACCEPT", dbEvent?.verdict === "ACCEPT");
        ok("[正常系] 初回のためsupersedesFeedbackEventId=null", dbEvent?.supersedesFeedbackEventId === null);
      }
    }

    // ================================================================
    // idempotent replay: 同一idempotencyKey・同一payloadは既存結果を返す
    // ================================================================
    {
      const fx = await makeFixture("replay");
      const sug = await makeMatchedSuggestion(fx, "replay");
      const payload = { revision: sug.revision, verdict: "ACCEPT" as const };
      const key = `idem-replay-${RUN_ID}`;
      const first = await recordCasePatternFeedback({
        workspaceId: fx.workspaceId, suggestionId: sug.suggestionId, actorUserId: fx.userId,
        expectedRevision: sug.revision, verdict: "ACCEPT", idempotencyKey: key, requestPayloadHash: hashPayload(payload),
      });
      const second = await recordCasePatternFeedback({
        workspaceId: fx.workspaceId, suggestionId: sug.suggestionId, actorUserId: fx.userId,
        expectedRevision: sug.revision, verdict: "ACCEPT", idempotencyKey: key, requestPayloadHash: hashPayload(payload),
      });
      ok("[replay] 1回目・2回目ともok:true", first.ok === true && second.ok === true);
      if (first.ok && second.ok) {
        ok("[replay] 2回目はreplay=true", second.replay === true);
        ok("[replay] 同一feedbackEventIdを返す", first.feedbackEventId === second.feedbackEventId);
      }
      const count = await db.casePatternFeedbackEvent.count({ where: { workspaceId: fx.workspaceId, suggestionId: sug.suggestionId } });
      ok("[replay] DB上のFeedbackEvent行数は1件のまま(重複記録なし)", count === 1, `count=${count}`);
    }

    // ================================================================
    // idempotency key reused: 同一key・異なるpayloadはIDEMPOTENCY_KEY_REUSED
    // ================================================================
    {
      const fx = await makeFixture("reused");
      const sug = await makeMatchedSuggestion(fx, "reused");
      const key = `idem-reused-${RUN_ID}`;
      const payload1 = { revision: sug.revision, verdict: "ACCEPT" as const };
      const payload2 = { revision: sug.revision, verdict: "REJECT" as const };
      const first = await recordCasePatternFeedback({
        workspaceId: fx.workspaceId, suggestionId: sug.suggestionId, actorUserId: fx.userId,
        expectedRevision: sug.revision, verdict: "ACCEPT", idempotencyKey: key, requestPayloadHash: hashPayload(payload1),
      });
      ok("[key再利用前提] 1回目はok:true", first.ok === true);
      const second = await recordCasePatternFeedback({
        workspaceId: fx.workspaceId, suggestionId: sug.suggestionId, actorUserId: fx.userId,
        expectedRevision: sug.revision, verdict: "REJECT", idempotencyKey: key, requestPayloadHash: hashPayload(payload2),
      });
      ok("[key再利用] 異なるpayloadはIDEMPOTENCY_KEY_REUSED", !second.ok && second.error === "IDEMPOTENCY_KEY_REUSED");
    }

    // ================================================================
    // owner本人以外はFORBIDDEN
    // ================================================================
    {
      const fx = await makeFixture("forbidden");
      const other = await makeFixture("forbidden-other");
      const sug = await makeMatchedSuggestion(fx, "forbidden");
      const payload = { revision: sug.revision, verdict: "ACCEPT" as const };
      const result = await recordCasePatternFeedback({
        workspaceId: fx.workspaceId, suggestionId: sug.suggestionId, actorUserId: other.userId,
        expectedRevision: sug.revision, verdict: "ACCEPT", idempotencyKey: `idem-forbidden-${RUN_ID}`, requestPayloadHash: hashPayload(payload),
      });
      ok("[owner認可] 他人がfeedbackを送るとFORBIDDEN", !result.ok && result.error === "FORBIDDEN");
    }

    // ================================================================
    // revision不一致はREVISION_CONFLICT
    // ================================================================
    {
      const fx = await makeFixture("revconflict");
      const sug = await makeMatchedSuggestion(fx, "revconflict");
      const payload = { revision: 999, verdict: "ACCEPT" as const };
      const result = await recordCasePatternFeedback({
        workspaceId: fx.workspaceId, suggestionId: sug.suggestionId, actorUserId: fx.userId,
        expectedRevision: 999, verdict: "ACCEPT", idempotencyKey: `idem-revconflict-${RUN_ID}`, requestPayloadHash: hashPayload(payload),
      });
      ok("[optimistic concurrency] 古いrevision指定はREVISION_CONFLICT", !result.ok && result.error === "REVISION_CONFLICT");
      if (!result.ok && result.error === "REVISION_CONFLICT") {
        ok("[optimistic concurrency] latestRevisionは実際の現在値(1)", result.latestRevision === 1);
      }
    }

    // ================================================================
    // AMBIGUOUS(matchedPatternId=null)なSuggestionはSUGGESTION_NOT_MATCHED
    // ================================================================
    {
      const fx = await makeFixture("ambiguous");
      const sug = await makeAmbiguousSuggestion(fx, "ambiguous");
      const payload = { revision: sug.revision, verdict: "ACCEPT" as const };
      const result = await recordCasePatternFeedback({
        workspaceId: fx.workspaceId, suggestionId: sug.suggestionId, actorUserId: fx.userId,
        expectedRevision: sug.revision, verdict: "ACCEPT", idempotencyKey: `idem-ambiguous-${RUN_ID}`, requestPayloadHash: hashPayload(payload),
      });
      ok("[AMBIGUOUS] matchedPatternId=nullのSuggestionはSUGGESTION_NOT_MATCHED", !result.ok && result.error === "SUGGESTION_NOT_MATCHED");
      const count = await db.casePatternFeedbackEvent.count({ where: { workspaceId: fx.workspaceId, suggestionId: sug.suggestionId } });
      ok("[AMBIGUOUS] FeedbackEventは1件も作られない", count === 0, `count=${count}`);
    }

    // ================================================================
    // 存在しないsuggestionIdはNOT_FOUND
    // ================================================================
    {
      const fx = await makeFixture("notfound");
      const bogusId = randomUUID();
      const payload = { revision: 1, verdict: "ACCEPT" as const };
      const result = await recordCasePatternFeedback({
        workspaceId: fx.workspaceId, suggestionId: bogusId, actorUserId: fx.userId,
        expectedRevision: 1, verdict: "ACCEPT", idempotencyKey: `idem-notfound-${RUN_ID}`, requestPayloadHash: hashPayload(payload),
      });
      ok("[NOT_FOUND] 存在しないsuggestionIdはNOT_FOUND", !result.ok && result.error === "NOT_FOUND");
    }

    // ================================================================
    // 訂正(supersedesFeedbackEventId): 異なるidempotencyKeyでの2回目の提出は
    // 1回目のFeedbackEventをsupersedesFeedbackEventIdで指す(append-only)
    // ================================================================
    {
      const fx = await makeFixture("correction");
      const sug = await makeMatchedSuggestion(fx, "correction");
      const payload1 = { revision: sug.revision, verdict: "REJECT" as const };
      const first = await recordCasePatternFeedback({
        workspaceId: fx.workspaceId, suggestionId: sug.suggestionId, actorUserId: fx.userId,
        expectedRevision: sug.revision, verdict: "REJECT", idempotencyKey: `idem-correction-1-${RUN_ID}`, requestPayloadHash: hashPayload(payload1),
      });
      ok("[訂正前提] 1回目(REJECT)はok:true", first.ok === true);

      const payload2 = { revision: sug.revision, verdict: "ACCEPT" as const };
      const second = await recordCasePatternFeedback({
        workspaceId: fx.workspaceId, suggestionId: sug.suggestionId, actorUserId: fx.userId,
        expectedRevision: sug.revision, verdict: "ACCEPT", idempotencyKey: `idem-correction-2-${RUN_ID}`, requestPayloadHash: hashPayload(payload2),
      });
      ok("[訂正] 2回目(ACCEPTへの訂正)はok:true", second.ok === true);
      if (first.ok && second.ok) {
        ok("[訂正] 2回目のfeedbackEventIdは1回目と異なる(append-only、UPDATEではない)", first.feedbackEventId !== second.feedbackEventId);
        const secondEvent = await db.casePatternFeedbackEvent.findFirst({ where: { id: second.feedbackEventId }, select: { supersedesFeedbackEventId: true, verdict: true } });
        ok("[訂正] 2回目のsupersedesFeedbackEventIdが1回目を指す", secondEvent?.supersedesFeedbackEventId === first.feedbackEventId);
        const firstEvent = await db.casePatternFeedbackEvent.findFirst({ where: { id: first.feedbackEventId }, select: { verdict: true } });
        ok("[訂正] 1回目の行は書き換わらずverdict=REJECTのまま(append-only)", firstEvent?.verdict === "REJECT");
        ok("[訂正] Suggestion.stateは最新の訂正内容(ACCEPT)を反映する", second.suggestionState === "ACCEPT");
        const dbIdentity = await db.casePatternSuggestionIdentity.findFirst({ where: { id: sug.suggestionId }, select: { state: true } });
        ok("[訂正] DB上のSuggestion.stateもACCEPT", dbIdentity?.state === "ACCEPT");
      }
      const count = await db.casePatternFeedbackEvent.count({ where: { workspaceId: fx.workspaceId, suggestionId: sug.suggestionId } });
      ok("[訂正] FeedbackEventは2件(append-only、UPDATEで1件のままにならない)", count === 2, `count=${count}`);
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
