#!/usr/bin/env node
/**
 * scripts/verify_gate_m1b32_ai_free_cross_session.ts
 *
 * Gate M1-B3.2(非課金証跡保証・残存競合是正、2026-08-29監査指示書
 * 「Claude向け ISMAY M1-B3.2」)の受入証跡。B3/B3.1の直列・同一Session内競合は
 * 対象外(既存の2スクリプトを別途PASSで確認する。両スクリプトも本Gateで
 * AI network deny guard + Embedding DI stubを追加済み)。本スクリプトは
 * B3.2で新たに追加した、B3/B3.1では検証できていなかった項目のみを対象にする。
 *
 * AI呼出しは一切行わない。冒頭でAI provider host(OpenAI/Anthropic)への
 * `globalThis.fetch`を機械的に遮断するguardを設置し(監査B32-01)、
 * post-commit EmbeddingはDI stubへ差し替える。
 *
 * 検証内容:
 *   1. [B32-01] AI network deny guardのpure self-test。
 *   2. [B32-03] 異Session(同一Workspace)・同一operationId並行実行。
 *      `materialization_receipts_operation_uq`は`(workspaceId,operationId)`
 *      なので、同一Workspace内の異なるFormationSessionでもoperationIdは
 *      衝突し得る。異Sessionは異なる行をFOR UPDATEするため、同一Session内の
 *      ような直列化は効かず、実際に並行実行される。sessionIdがrequestHashに
 *      含まれるため、勝者がcommitし、敗者はP2002を捕捉して
 *      `IDEMPOTENCY_KEY_REUSED`へ決定論的に変換されるはず(raw例外・500は0件)。
 *   3. cleanup例外0件、cleanup後のtest prefixデータ0件。
 *
 * 実行方法:
 *   cd ~/projects/ismay/app
 *   npx tsx ../scripts/verify_gate_m1b32_ai_free_cross_session.ts
 *
 * 前提: DATABASE_URLが有効なPostgres(migration
 *       20260829010000_formation_materialization_invariants適用済み)を
 *       指していること。AIプロバイダー設定・ismay-app.service起動は不要。
 *
 * 環境変数:
 *   KEEP_TEST_DATA_ON_FAILURE=1 : 失敗時にテストデータを残す(調査用)。
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { installAiNetworkDenyGuard, selfTestAiNetworkDenyGuard } from "./lib/aiNetworkDenyGuard";
import { cleanupFormationVerifyUser, assertNoLeftoverFormationVerifyUsers } from "./lib/formationVerifyCleanup";

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
const EMAIL_PREFIX = "gate-m1b32-ai-free-cross-session-verify-";
const KEEP_ON_FAILURE = process.env.KEEP_TEST_DATA_ON_FAILURE === "1";

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

type Db = typeof import("../app/src/lib/db")["db"];

interface SeedCandidateSpec {
  candidateKey: string;
  type: string;
  title: string;
  confidence: number;
}

async function seedSession(
  db: Db,
  input: {
    workspaceId: string;
    domainId: string;
    userId: string;
    captureId: string;
    clientSessionKey: string;
    candidates: SeedCandidateSpec[];
  },
): Promise<{ sessionId: string; version: number; candidates: { identityId: string; candidateKey: string }[] }> {
  const session = await db.formationSession.create({
    data: {
      workspaceId: input.workspaceId,
      domainId: input.domainId,
      subjectUserId: input.userId,
      captureId: input.captureId,
      clientSessionKey: input.clientSessionKey,
      state: "REVIEW_READY",
    },
  });
  let sequence = 1;
  await db.formationSessionEvent.create({
    data: {
      workspaceId: input.workspaceId,
      sessionId: session.id,
      sequence: sequence++,
      eventType: "FORMATION_CREATED",
      actorType: "SYSTEM",
      payload: { captureId: input.captureId },
    },
  });

  const candidates: { identityId: string; candidateKey: string }[] = [];
  for (const spec of input.candidates) {
    const identity = await db.formationCandidateIdentity.create({
      data: { workspaceId: input.workspaceId, sessionId: session.id, candidateKey: spec.candidateKey, currentRevision: 1 },
    });
    await db.formationCandidateRevision.create({
      data: {
        workspaceId: input.workspaceId,
        candidateId: identity.id,
        revision: 1,
        type: spec.type,
        title: spec.title,
        description: null,
        proposedFields: {
          candidateId: spec.candidateKey,
          type: spec.type,
          title: spec.title,
          evidenceSpans: [{ start: 0, end: 4 }],
          confidence: spec.confidence,
          dateMentions: [],
          unknowns: [],
          blockedByCandidateIds: [],
          suggestedTags: [],
        },
        confidence: spec.confidence,
        schemaVersion: "1.0",
      },
    });
    await db.formationSessionEvent.create({
      data: {
        workspaceId: input.workspaceId,
        sessionId: session.id,
        sequence: sequence++,
        eventType: "CANDIDATE_CREATED",
        actorType: "SYSTEM",
        payload: { candidateKey: spec.candidateKey },
      },
    });
    candidates.push({ identityId: identity.id, candidateKey: spec.candidateKey });
  }

  await db.formationSessionEvent.create({
    data: {
      workspaceId: input.workspaceId,
      sessionId: session.id,
      sequence: sequence++,
      eventType: "ANALYSIS_SUCCEEDED",
      actorType: "SYSTEM",
      payload: { candidateCount: input.candidates.length },
    },
  });

  return { sessionId: session.id, version: session.version, candidates };
}

async function main(): Promise<void> {
  // [B32-01] pure self-test。実際のdummy requestは送信せず、guard内でthrowする
  // ことだけを確認する。
  const denyGuard = installAiNetworkDenyGuard();
  const guardSelfTestPassed = await selfTestAiNetworkDenyGuard(denyGuard);
  ok("[非課金guard] AI network deny guardのpure self-testが機能する", guardSelfTestPassed);
  // [バグ修正・2026-08-29 実行ログで判明] self-test自身がapi.openai.comへの
  // dummy callを1件意図的に発生させ、それをguardが正しく検知・記録する
  // (deniedCallAttemptsへ1件積む)ことをもって「self-testが機能する」と
  // 判定している。したがって以降の「scenario実行中はAI通信0件」assertionは、
  // この基準値(self-test由来の既知の1件)を差し引いた差分で判定しなければ、
  // self-testが成功するたびに必ず1件分「AI通信があった」という誤検知になる。
  const deniedCallAttemptsBaselineAfterSelfTest = denyGuard.deniedCallAttempts.length;
  if (!guardSelfTestPassed) {
    denyGuard.restore();
    console.log(`\n合計: ${passed} passed, ${failed} failed`);
    console.log("失敗一覧:\n  - [非課金guard] AI network deny guardのpure self-testが機能する");
    process.exitCode = 1;
    return;
  }

  const { db } = await import("../app/src/lib/db");
  const { materializeFormationSession: materializeFormationSessionReal, recordCandidateDecision } = await import(
    "../app/src/lib/formation/materialize"
  );

  let embedStubCallCount = 0;
  const embedStub = async () => {
    embedStubCallCount++;
    return { ok: true as const };
  };
  function materializeFormationSession(
    params: Parameters<typeof materializeFormationSessionReal>[0],
  ): ReturnType<typeof materializeFormationSessionReal> {
    return materializeFormationSessionReal(params, { embedAndStoreResponsibility: embedStub });
  }

  console.log("V5-M1-B3.2 非課金証跡保証・cross-session競合 受入証跡(AI呼出し無し・実DBのみ)");

  const cleanupErrors: { step: string; error: unknown }[] = [];
  const orphans = await db.user.findMany({
    where: { email: { startsWith: EMAIL_PREFIX, endsWith: "@example.invalid" } },
    select: { id: true },
  });
  for (const o of orphans) {
    const result = await cleanupFormationVerifyUser(db, o.id);
    cleanupErrors.push(...result.errors);
  }

  const userIds: string[] = [];
  let materializedItemCountBeforeCleanup: number | null = null;

  try {
    // =========================================================================
    // Scenario X1: 異Session(同一Workspace)・同一operationId並行実行
    // =========================================================================
    const email = `${EMAIL_PREFIX}${RUN_ID}@example.invalid`;
    const user = await db.user.create({
      data: { email, passwordHash: "not-a-real-hash-for-db-only-test", displayName: "Gate M1B3.2 Verify" },
    });
    userIds.push(user.id);
    const workspace = await db.workspace.create({ data: { name: "Gate M1B3.2 Test Workspace" } });
    await db.workspaceMember.create({ data: { workspaceId: workspace.id, userId: user.id, role: "OWNER" } });
    const domain = await db.domain.create({ data: { workspaceId: workspace.id, name: "個人", kind: "PERSONAL" } });

    const capX1a = await db.capture.create({
      data: {
        workspaceId: workspace.id,
        domainId: domain.id,
        createdById: user.id,
        sourceType: "TEXT",
        rawText: "X1a: cross-session race検証用のCapture本文",
        processingStatus: "READY",
      },
    });
    const capX1b = await db.capture.create({
      data: {
        workspaceId: workspace.id,
        domainId: domain.id,
        createdById: user.id,
        sourceType: "TEXT",
        rawText: "X1b: cross-session race検証用のCapture本文",
        processingStatus: "READY",
      },
    });

    const sessX1a = await seedSession(db, {
      workspaceId: workspace.id,
      domainId: domain.id,
      userId: user.id,
      captureId: capX1a.id,
      clientSessionKey: `test:${RUN_ID}:x1a`,
      candidates: [{ candidateKey: "c1", type: "TASK", title: "X1a候補", confidence: 0.8 }],
    });
    const sessX1b = await seedSession(db, {
      workspaceId: workspace.id,
      domainId: domain.id,
      userId: user.id,
      captureId: capX1b.id,
      clientSessionKey: `test:${RUN_ID}:x1b`,
      candidates: [{ candidateKey: "c1", type: "TASK", title: "X1b候補", confidence: 0.8 }],
    });

    await recordCandidateDecision({
      sessionId: sessX1a.sessionId,
      workspaceId: workspace.id,
      candidateId: sessX1a.candidates[0].identityId,
      expectedRevision: 1,
      decision: "ACCEPTED",
      actorUserId: user.id,
    });
    await recordCandidateDecision({
      sessionId: sessX1b.sessionId,
      workspaceId: workspace.id,
      candidateId: sessX1b.candidates[0].identityId,
      expectedRevision: 1,
      decision: "ACCEPTED",
      actorUserId: user.id,
    });

    const sessX1aAfterDecision = await db.formationSession.findUniqueOrThrow({ where: { id: sessX1a.sessionId } });
    const sessX1bAfterDecision = await db.formationSession.findUniqueOrThrow({ where: { id: sessX1b.sessionId } });

    // [B32-03] 意図的に同一workspace内で同一operationIdを異なるSessionへ使う。
    // sessionIdがrequestHashへ含まれるため、この2requestは異payload扱いになる
    // (=正しい仕様であり、単なるIDEMPOTENCY_KEY_REUSEDの再現ではなく「異Session
    // からの誤った再利用」を模している)。
    const sharedOperationId = `op-${RUN_ID}-x1-shared`;
    let rawExceptionCount = 0;
    const [x1A, x1B] = await Promise.all([
      materializeFormationSession({
        sessionId: sessX1a.sessionId,
        workspaceId: workspace.id,
        operationId: sharedOperationId,
        expectedVersion: sessX1aAfterDecision.version,
        actorUserId: user.id,
      }).catch((err: unknown) => {
        rawExceptionCount++;
        console.error("[X1] materializeFormationSession(A)で想定外の例外:", err);
        return { ok: false as const, error: "RAW_EXCEPTION" as const };
      }),
      materializeFormationSession({
        sessionId: sessX1b.sessionId,
        workspaceId: workspace.id,
        operationId: sharedOperationId,
        expectedVersion: sessX1bAfterDecision.version,
        actorUserId: user.id,
      }).catch((err: unknown) => {
        rawExceptionCount++;
        console.error("[X1] materializeFormationSession(B)で想定外の例外:", err);
        return { ok: false as const, error: "RAW_EXCEPTION" as const };
      }),
    ]);
    const x1Results = [x1A, x1B];

    ok("[X1] cross-session同一operationId並行実行でraw例外は0件", rawExceptionCount === 0, String(rawExceptionCount));
    const x1CommitCount = x1Results.filter((r) => r.ok && r.replay === false).length;
    const x1IdempotencyReusedCount = x1Results.filter((r) => !r.ok && r.error === "IDEMPOTENCY_KEY_REUSED").length;
    ok("[X1] 片方だけが実際にcommitする(replay:false)", x1CommitCount === 1, `commit=${x1CommitCount}`);
    ok(
      "[X1] もう片方は具体的にIDEMPOTENCY_KEY_REUSEDという決定論的な結果を返す",
      x1IdempotencyReusedCount === 1,
      x1Results.map((r) => (r.ok ? `ok:replay=${r.replay}` : r.error)).join(","),
    );
    ok(
      "[X1] Responsibilityは、勝者のcandidateの分だけ1件生成される(敗者側は0件)",
      (await db.responsibility.count({ where: { originCaptureId: { in: [capX1a.id, capX1b.id] } } })) === 1,
    );
    ok(
      "[X1] MaterializationReceiptは1件だけ(同一operationIdにつき1件)",
      (await db.materializationReceipt.count({ where: { workspaceId: workspace.id, operationId: sharedOperationId } })) === 1,
    );

    materializedItemCountBeforeCleanup = await db.materializationReceiptItem.count({
      where: { workspaceId: workspace.id },
    });
  } finally {
    if (failed === 0 || !KEEP_ON_FAILURE) {
      for (const uid of userIds) {
        const result = await cleanupFormationVerifyUser(db, uid);
        cleanupErrors.push(...result.errors);
      }
    } else {
      console.log(`[KEEP_TEST_DATA_ON_FAILURE=1] userIds=${JSON.stringify(userIds)} を残します`);
    }
  }

  denyGuard.restore();

  ok(
    "[cleanup] cleanup処理中に例外が0件である",
    cleanupErrors.length === 0,
    cleanupErrors.map((e) => e.step).join(","),
  );
  if (failed === 0 || !KEEP_ON_FAILURE) {
    const leftover = await assertNoLeftoverFormationVerifyUsers(db, EMAIL_PREFIX);
    ok("[cleanup] cleanup後、test prefixのUserが0件である", leftover.clean, leftover.remainingUserIds.join(","));
  }

  ok(
    "[非課金guard] scenario実行中、AI provider hostへの通信試行は0件(self-test自身の既知の1件を除く)",
    denyGuard.deniedCallAttempts.length === deniedCallAttemptsBaselineAfterSelfTest,
    `total=${denyGuard.deniedCallAttempts.length} baseline(self-test分)=${deniedCallAttemptsBaselineAfterSelfTest} attempts=${JSON.stringify(denyGuard.deniedCallAttempts)}`,
  );

  if (materializedItemCountBeforeCleanup !== null) {
    ok(
      "[DI] Embedding stub呼出し回数が実際のMaterialize item数と一致する",
      embedStubCallCount === materializedItemCountBeforeCleanup,
      `stub=${embedStubCallCount} items=${materializedItemCountBeforeCleanup}`,
    );
  }

  console.log(`\n合計: ${passed} passed, ${failed} failed`);
  if (failed > 0) {
    console.log("失敗一覧:");
    for (const f of failures) console.log(`  - ${f}`);
    process.exitCode = 1;
  }
}

main()
  .then(() => process.exit(process.exitCode ?? 0))
  .catch((err) => {
    console.error("予期しない例外:", err);
    process.exit(1);
  });
