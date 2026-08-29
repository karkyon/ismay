#!/usr/bin/env node
/**
 * scripts/verify_gate_m1b31_materialization_invariants.ts
 *
 * Gate M1-B3.1(Materialization不変条件・競合耐性の是正、2026-08-29監査指示書)の
 * 受入証跡。B3(scripts/verify_gate_m1b3_materialize_acceptance.ts)の直列シナリオは
 * 対象外(既存スクリプトを別途32/32 PASSで確認する)。本スクリプトはB3.1で追加した
 * 並行実行・冪等性・tenant境界・異常系のみを検証する。
 *
 * AI呼出しは一切行わない。FormationSession/候補データをPrismaで直接シードし、
 * recordCandidateDecision/materializeFormationSessionをDB直結で検証する
 * (verify_gate_m1b3_materialize_acceptance.tsと同じ設計方針)。
 *
 * 検証内容(監査文書4章の受入テスト1〜8。9は migration.sql の構造検証、
 * 10は本スクリプトの対象外):
 *   1. 同一operationId・同一payloadの直列再送 → 同じReceipt、Responsibility 1件
 *   2. 同一operationId・同一payloadの並行2実行(Promise.all) → 片方commit・
 *      片方replay、Responsibility 1件、Receipt 1件
 *   3. 同一operationId・異payload(異なるexpectedVersion) → IDEMPOTENCY_KEY_REUSED
 *   4. 異operationId・同一candidateの並行実行 → Responsibility 1件、
 *      ReceiptItem 1件。片方は決定論的な競合結果(NO_ACCEPTED_CANDIDATES/
 *      INVALID_SESSION_STATE/CANDIDATE_ALREADY_MATERIALIZED/VERSION_CONFLICTの
 *      いずれか。Session行lockによる直列化のため、実際にはlock獲得順で
 *      決定論的に確定する)
 *   5. 同一Sessionの別candidateへの並行Decision → 両方のDecision Eventが
 *      保存され、Session Event sequenceが一意・連続
 *   6. 同一candidateへのACCEPTED/REJECTED同時実行 → 1つだけ成立
 *   7. tenant越境candidate/session結合 → NOT_FOUND(service層で拒否)
 *   8. 不正Candidate dataでtransaction中断 → Responsibility/Receipt/Item/
 *      commit Eventが0件、Session version/stateも元のまま
 *
 * 実行方法:
 *   cd ~/projects/ismay/app
 *   npx tsx ../scripts/verify_gate_m1b31_materialization_invariants.ts
 *
 * 前提: DATABASE_URLが有効なPostgres(migration 20260829010000_formation_
 *       materialization_invariants適用済み)を指していること。AIプロバイダー
 *       設定・ismay-app.service起動は不要。
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
const EMAIL_PREFIX = "gate-m1b31-materialization-invariants-verify-";
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

interface SeededSession {
  sessionId: string;
  version: number;
  candidates: { identityId: string; candidateKey: string }[];
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
): Promise<SeededSession> {
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

interface Fixture {
  db: Db;
  userId: string;
  workspaceId: string;
  domainId: string;
}

async function makeFixture(db: Db, suffix: string): Promise<Fixture> {
  const email = `${EMAIL_PREFIX}${RUN_ID}-${suffix}@example.invalid`;
  const user = await db.user.create({
    data: { email, passwordHash: "not-a-real-hash-for-db-only-test", displayName: `Gate M1B3.1 Verify ${suffix}` },
  });
  const workspace = await db.workspace.create({ data: { name: `Gate M1B3.1 Test Workspace ${suffix}` } });
  await db.workspaceMember.create({ data: { workspaceId: workspace.id, userId: user.id, role: "OWNER" } });
  const domain = await db.domain.create({ data: { workspaceId: workspace.id, name: "個人", kind: "PERSONAL" } });
  return { db, userId: user.id, workspaceId: workspace.id, domainId: domain.id };
}

async function makeCapture(fx: Fixture, rawText: string) {
  return fx.db.capture.create({
    data: {
      workspaceId: fx.workspaceId,
      domainId: fx.domainId,
      createdById: fx.userId,
      sourceType: "TEXT",
      rawText,
      processingStatus: "READY",
    },
  });
}

async function main(): Promise<void> {
  // [B3.2新設・B32-01] AI provider host(OpenAI/Anthropic)への通信を、実際に
  // ネットワークへ出す前に機械的に遮断するguardを最初に設置する。
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
  const {
    recordCandidateDecision,
    materializeFormationSession: materializeFormationSessionReal,
    computeMaterializeRequestHash,
  } = await import("../app/src/lib/formation/materialize");

  // [B3.2新設・B32-01] post-commit Embedding配送をno-op stubへ差し替える
  // (dependency injection)。既存呼び出し箇所は書き換えず、importした本来の
  // 関数をこのファイル内だけshadowする。
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

  console.log("V5-M1-B3.1 Materialization不変条件・競合耐性 受入証跡(AI呼出し無し・実DBのみ・DI stub + network deny guard)");

  // ---- 孤立テストデータの掃除 -----------------------------------------------
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
    // Scenario 1: 同一operationId・同一payloadの直列再送
    // =========================================================================
    const fx1 = await makeFixture(db, "s1");
    userIds.push(fx1.userId);
    const cap1 = await makeCapture(fx1, "S1: 直列再送テスト用のCapture本文");
    const sess1 = await seedSession(db, {
      workspaceId: fx1.workspaceId,
      domainId: fx1.domainId,
      userId: fx1.userId,
      captureId: cap1.id,
      clientSessionKey: `test:${RUN_ID}:s1`,
      candidates: [{ candidateKey: "c1", type: "TASK", title: "S1候補", confidence: 0.8 }],
    });
    const s1Accept = await recordCandidateDecision({
      sessionId: sess1.sessionId,
      workspaceId: fx1.workspaceId,
      candidateId: sess1.candidates[0].identityId,
      expectedRevision: 1,
      decision: "ACCEPTED",
      actorUserId: fx1.userId,
    });
    ok("[S1] ACCEPTが成功する", s1Accept.ok === true);
    const sess1AfterDecision = await db.formationSession.findUniqueOrThrow({ where: { id: sess1.sessionId } });
    const s1OpId = `op-${RUN_ID}-s1`;
    const s1First = await materializeFormationSession({
      sessionId: sess1.sessionId,
      workspaceId: fx1.workspaceId,
      operationId: s1OpId,
      expectedVersion: sess1AfterDecision.version,
      actorUserId: fx1.userId,
    });
    ok("[S1] 1回目のMaterializeが成功する(replay:false)", s1First.ok === true && s1First.ok && s1First.replay === false);
    const s1Second = await materializeFormationSession({
      sessionId: sess1.sessionId,
      workspaceId: fx1.workspaceId,
      operationId: s1OpId,
      expectedVersion: sess1AfterDecision.version,
      actorUserId: fx1.userId,
    });
    ok("[S1] 同一operationId直列再送はreplay:trueで成功する", s1Second.ok === true && s1Second.ok && s1Second.replay === true);
    if (s1First.ok && s1Second.ok) {
      ok("[S1] 直列再送は同じReceiptIdを返す", s1First.receiptId === s1Second.receiptId);
    }
    ok(
      "[S1] Responsibilityは1件だけ生成される",
      (await db.responsibility.count({ where: { originCaptureId: cap1.id } })) === 1,
    );

    // =========================================================================
    // Scenario 2: 同一operationId・同一payloadの並行2実行
    // =========================================================================
    const fx2 = await makeFixture(db, "s2");
    userIds.push(fx2.userId);
    const cap2 = await makeCapture(fx2, "S2: 並行再送テスト用のCapture本文");
    const sess2 = await seedSession(db, {
      workspaceId: fx2.workspaceId,
      domainId: fx2.domainId,
      userId: fx2.userId,
      captureId: cap2.id,
      clientSessionKey: `test:${RUN_ID}:s2`,
      candidates: [{ candidateKey: "c1", type: "TASK", title: "S2候補", confidence: 0.8 }],
    });
    await recordCandidateDecision({
      sessionId: sess2.sessionId,
      workspaceId: fx2.workspaceId,
      candidateId: sess2.candidates[0].identityId,
      expectedRevision: 1,
      decision: "ACCEPTED",
      actorUserId: fx2.userId,
    });
    const sess2AfterDecision = await db.formationSession.findUniqueOrThrow({ where: { id: sess2.sessionId } });
    const s2OpId = `op-${RUN_ID}-s2`;
    const s2Params = {
      sessionId: sess2.sessionId,
      workspaceId: fx2.workspaceId,
      operationId: s2OpId,
      expectedVersion: sess2AfterDecision.version,
      actorUserId: fx2.userId,
    };
    const [s2A, s2B] = await Promise.all([materializeFormationSession(s2Params), materializeFormationSession(s2Params)]);
    const s2Results = [s2A, s2B];
    const s2OkResults = s2Results.filter((r) => r.ok);
    ok("[S2] 並行2実行とも成功(ok:true)する", s2OkResults.length === 2);
    const s2ReplayFalseCount = s2Results.filter((r) => r.ok && r.replay === false).length;
    const s2ReplayTrueCount = s2Results.filter((r) => r.ok && r.replay === true).length;
    ok("[S2] 片方だけがreplay:false(新規commit)", s2ReplayFalseCount === 1, `false=${s2ReplayFalseCount}`);
    ok("[S2] 片方だけがreplay:true(idempotent replay)", s2ReplayTrueCount === 1, `true=${s2ReplayTrueCount}`);
    if (s2A.ok && s2B.ok) {
      ok("[S2] 並行2実行は同じReceiptIdを返す", s2A.receiptId === s2B.receiptId);
    }
    ok(
      "[S2] Responsibilityは1件だけ生成される(並行実行でも二重生成なし)",
      (await db.responsibility.count({ where: { originCaptureId: cap2.id } })) === 1,
    );
    ok(
      "[S2] MaterializationReceiptは1件だけ生成される",
      (await db.materializationReceipt.count({ where: { workspaceId: fx2.workspaceId, operationId: s2OpId } })) === 1,
    );

    // =========================================================================
    // Scenario 3: 同一operationId・異payload(異なるexpectedVersion)
    // =========================================================================
    const fx3 = await makeFixture(db, "s3");
    userIds.push(fx3.userId);
    const cap3 = await makeCapture(fx3, "S3: 異payload再利用テスト用のCapture本文");
    const sess3 = await seedSession(db, {
      workspaceId: fx3.workspaceId,
      domainId: fx3.domainId,
      userId: fx3.userId,
      captureId: cap3.id,
      clientSessionKey: `test:${RUN_ID}:s3`,
      candidates: [{ candidateKey: "c1", type: "TASK", title: "S3候補", confidence: 0.8 }],
    });
    await recordCandidateDecision({
      sessionId: sess3.sessionId,
      workspaceId: fx3.workspaceId,
      candidateId: sess3.candidates[0].identityId,
      expectedRevision: 1,
      decision: "ACCEPTED",
      actorUserId: fx3.userId,
    });
    const sess3AfterDecision = await db.formationSession.findUniqueOrThrow({ where: { id: sess3.sessionId } });
    const s3OpId = `op-${RUN_ID}-s3`;
    const s3First = await materializeFormationSession({
      sessionId: sess3.sessionId,
      workspaceId: fx3.workspaceId,
      operationId: s3OpId,
      expectedVersion: sess3AfterDecision.version,
      actorUserId: fx3.userId,
    });
    ok("[S3] 1回目のMaterializeが成功する", s3First.ok === true);
    const s3Reused = await materializeFormationSession({
      sessionId: sess3.sessionId,
      workspaceId: fx3.workspaceId,
      operationId: s3OpId,
      // 異payload: 実際のsession.versionとは異なる値を渡し、requestHashを変える
      expectedVersion: sess3AfterDecision.version + 999,
      actorUserId: fx3.userId,
    });
    ok(
      "[S3] 同一operationId・異payload(expectedVersion違い)はIDEMPOTENCY_KEY_REUSED",
      !s3Reused.ok && s3Reused.error === "IDEMPOTENCY_KEY_REUSED",
    );
    ok(
      "[S3] IDEMPOTENCY_KEY_REUSED後もResponsibilityは1件のまま",
      (await db.responsibility.count({ where: { originCaptureId: cap3.id } })) === 1,
    );

    // =========================================================================
    // Scenario 4: 異operationId・同一candidateの並行実行
    // =========================================================================
    const fx4 = await makeFixture(db, "s4");
    userIds.push(fx4.userId);
    const cap4 = await makeCapture(fx4, "S4: 異operationId競合テスト用のCapture本文");
    const sess4 = await seedSession(db, {
      workspaceId: fx4.workspaceId,
      domainId: fx4.domainId,
      userId: fx4.userId,
      captureId: cap4.id,
      clientSessionKey: `test:${RUN_ID}:s4`,
      candidates: [{ candidateKey: "c1", type: "TASK", title: "S4候補", confidence: 0.8 }],
    });
    await recordCandidateDecision({
      sessionId: sess4.sessionId,
      workspaceId: fx4.workspaceId,
      candidateId: sess4.candidates[0].identityId,
      expectedRevision: 1,
      decision: "ACCEPTED",
      actorUserId: fx4.userId,
    });
    const sess4AfterDecision = await db.formationSession.findUniqueOrThrow({ where: { id: sess4.sessionId } });
    const [s4A, s4B] = await Promise.all([
      materializeFormationSession({
        sessionId: sess4.sessionId,
        workspaceId: fx4.workspaceId,
        operationId: `op-${RUN_ID}-s4a`,
        expectedVersion: sess4AfterDecision.version,
        actorUserId: fx4.userId,
      }),
      materializeFormationSession({
        sessionId: sess4.sessionId,
        workspaceId: fx4.workspaceId,
        operationId: `op-${RUN_ID}-s4b`,
        expectedVersion: sess4AfterDecision.version,
        actorUserId: fx4.userId,
      }),
    ]);
    const s4Results = [s4A, s4B];
    const s4WinnerCount = s4Results.filter((r) => r.ok && r.items.length === 1).length;
    // [B3.2是正・B32-04、2026-08-29 実DB実行ログで確認した実際の挙動に基づき訂正]
    // 監査指摘: 旧assertionは
    // NO_ACCEPTED_CANDIDATES/INVALID_SESSION_STATE/CANDIDATE_ALREADY_MATERIALIZED/
    // VERSION_CONFLICTのいずれでもPASSとしており、結果の決定性を証明していなかった。
    // 本Scenarioは同一Sessionへの異operationId並行実行であり、
    // materializeFormationSession冒頭のSession行`FOR UPDATE`により2つの
    // transactionは完全に直列化される。
    //
    // [訂正の経緯] 当初「敗者はalreadyMaterializedCandidateIdsフィルタにより
    // acceptedTargetsが空になりNO_ACCEPTED_CANDIDATESを返すはず」と推定したが、
    // 実DBでの実行で実際にはINVALID_SESSION_STATEになることを確認した。原因は
    // tx内のcheck順序: `session.state`のcheck(REVIEW_READY/PARTIALLY_CONFIRMED
    // 以外を拒否)が、candidateのfilter処理より先に行われる。本Scenarioは
    // ACCEPTED候補が1件だけなので、勝者のtransactionはその1件をMaterializeし
    // 切ってSession.stateを`CONFIRMED`へ遷移させたうえでcommitする(PARTIALLY_
    // CONFIRMEDのまま残る余地が無い)。敗者は勝者commit後にlockを獲得するため、
    // 再読込したSession.stateは既に`CONFIRMED`であり、candidateのfilter処理まで
    // 到達する前に`session.state !== REVIEW_READY/PARTIALLY_CONFIRMED`のcheckで
    // 弾かれる。したがって正しい決定論的結果は`INVALID_SESSION_STATE`である。
    const s4LoserCount = s4Results.filter((r) => !r.ok && r.error === "INVALID_SESSION_STATE").length;
    ok("[S4] 片方だけが実際にMaterializeを成功させる(1件生成)", s4WinnerCount === 1, `winners=${s4WinnerCount}`);
    ok(
      "[S4] もう片方は具体的にINVALID_SESSION_STATEという決定論的な結果を返す(勝者commit後、Sessionが既にCONFIRMEDへ遷移済みのため)",
      s4LoserCount === 1,
      s4Results.map((r) => (r.ok ? "ok" : r.error)).join(","),
    );
    ok(
      "[S4] Responsibilityは1件だけ生成される(二重生成なし)",
      (await db.responsibility.count({ where: { originCaptureId: cap4.id } })) === 1,
    );
    ok(
      "[S4] MaterializationReceiptItemは対象candidateにつき1件だけ",
      (await db.materializationReceiptItem.count({ where: { candidateId: sess4.candidates[0].identityId } })) === 1,
    );

    // =========================================================================
    // Scenario 5: 同一Sessionの別candidateへの並行Decision
    // =========================================================================
    const fx5 = await makeFixture(db, "s5");
    userIds.push(fx5.userId);
    const cap5 = await makeCapture(fx5, "S5: 並行Decision sequenceテスト用のCapture本文");
    const sess5 = await seedSession(db, {
      workspaceId: fx5.workspaceId,
      domainId: fx5.domainId,
      userId: fx5.userId,
      captureId: cap5.id,
      clientSessionKey: `test:${RUN_ID}:s5`,
      candidates: [
        { candidateKey: "c1", type: "TASK", title: "S5候補1", confidence: 0.7 },
        { candidateKey: "c2", type: "TASK", title: "S5候補2", confidence: 0.7 },
      ],
    });
    const [s5A, s5B] = await Promise.all([
      recordCandidateDecision({
        sessionId: sess5.sessionId,
        workspaceId: fx5.workspaceId,
        candidateId: sess5.candidates[0].identityId,
        expectedRevision: 1,
        decision: "ACCEPTED",
        actorUserId: fx5.userId,
      }),
      recordCandidateDecision({
        sessionId: sess5.sessionId,
        workspaceId: fx5.workspaceId,
        candidateId: sess5.candidates[1].identityId,
        expectedRevision: 1,
        decision: "REJECTED",
        actorUserId: fx5.userId,
      }),
    ]);
    ok("[S5] 別candidateへの並行Decisionは両方成功する", s5A.ok === true && s5B.ok === true);
    const s5DecisionEvents = await db.formationCandidateDecisionEvent.findMany({
      where: { candidateId: { in: sess5.candidates.map((c) => c.identityId) } },
    });
    ok("[S5] 両方のDecision Eventが保存されている", s5DecisionEvents.length === 2);
    const s5Timeline = await db.formationSessionEvent.findMany({
      where: { sessionId: sess5.sessionId },
      orderBy: { sequence: "asc" },
      select: { sequence: true },
    });
    const s5Sequences = s5Timeline.map((e: { sequence: number }) => e.sequence);
    const s5Unique = new Set(s5Sequences).size === s5Sequences.length;
    const s5Contiguous = s5Sequences.every((seq: number, idx: number) => seq === idx + 1);
    ok("[S5] Session Event sequenceに重複がない", s5Unique, s5Sequences.join(","));
    ok("[S5] Session Event sequenceが1から連続している", s5Contiguous, s5Sequences.join(","));

    // =========================================================================
    // Scenario 6: 同一candidateへのACCEPTED/REJECTED同時実行
    // =========================================================================
    const fx6 = await makeFixture(db, "s6");
    userIds.push(fx6.userId);
    const cap6 = await makeCapture(fx6, "S6: 相反Decision競合テスト用のCapture本文");
    const sess6 = await seedSession(db, {
      workspaceId: fx6.workspaceId,
      domainId: fx6.domainId,
      userId: fx6.userId,
      captureId: cap6.id,
      clientSessionKey: `test:${RUN_ID}:s6`,
      candidates: [{ candidateKey: "c1", type: "TASK", title: "S6候補", confidence: 0.7 }],
    });
    const [s6A, s6B] = await Promise.all([
      recordCandidateDecision({
        sessionId: sess6.sessionId,
        workspaceId: fx6.workspaceId,
        candidateId: sess6.candidates[0].identityId,
        expectedRevision: 1,
        decision: "ACCEPTED",
        actorUserId: fx6.userId,
      }),
      recordCandidateDecision({
        sessionId: sess6.sessionId,
        workspaceId: fx6.workspaceId,
        candidateId: sess6.candidates[0].identityId,
        expectedRevision: 1,
        decision: "REJECTED",
        actorUserId: fx6.userId,
      }),
    ]);
    const s6Results = [s6A, s6B];
    const s6OkCount = s6Results.filter((r) => r.ok).length;
    const s6AlreadyDecidedCount = s6Results.filter((r) => !r.ok && r.error === "ALREADY_DECIDED").length;
    ok("[S6] 相反decisionの同時実行は1つだけ成立する", s6OkCount === 1, `ok=${s6OkCount}`);
    ok("[S6] もう片方はALREADY_DECIDEDで決定論的に拒否される", s6AlreadyDecidedCount === 1);
    ok(
      "[S6] Decision Eventは1件だけ保存される",
      (await db.formationCandidateDecisionEvent.count({ where: { candidateId: sess6.candidates[0].identityId } })) === 1,
    );

    // =========================================================================
    // Scenario 7: tenant越境candidate/session結合
    // =========================================================================
    const fx7a = await makeFixture(db, "s7a");
    userIds.push(fx7a.userId);
    const fx7b = await makeFixture(db, "s7b");
    userIds.push(fx7b.userId);
    const cap7a = await makeCapture(fx7a, "S7: tenant境界テスト用のCapture本文(workspace A)");
    const sess7a = await seedSession(db, {
      workspaceId: fx7a.workspaceId,
      domainId: fx7a.domainId,
      userId: fx7a.userId,
      captureId: cap7a.id,
      clientSessionKey: `test:${RUN_ID}:s7a`,
      candidates: [{ candidateKey: "c1", type: "TASK", title: "S7候補(A所属)", confidence: 0.7 }],
    });
    const s7CrossDecision = await recordCandidateDecision({
      sessionId: sess7a.sessionId,
      // workspace Bの資格情報でworkspace Aのsessionを操作しようとする
      workspaceId: fx7b.workspaceId,
      candidateId: sess7a.candidates[0].identityId,
      expectedRevision: 1,
      decision: "ACCEPTED",
      actorUserId: fx7b.userId,
    });
    ok(
      "[S7] tenant越境でのCandidate Decisionは拒否される(NOT_FOUND)",
      !s7CrossDecision.ok && s7CrossDecision.error === "NOT_FOUND",
    );
    const s7CrossMaterialize = await materializeFormationSession({
      sessionId: sess7a.sessionId,
      workspaceId: fx7b.workspaceId,
      operationId: `op-${RUN_ID}-s7cross`,
      expectedVersion: 0,
      actorUserId: fx7b.userId,
    });
    ok(
      "[S7] tenant越境でのMaterializeは拒否される(NOT_FOUND)",
      !s7CrossMaterialize.ok && s7CrossMaterialize.error === "NOT_FOUND",
    );
    ok(
      "[S7] tenant越境試行後もResponsibilityは0件のまま",
      (await db.responsibility.count({ where: { originCaptureId: cap7a.id } })) === 0,
    );

    // =========================================================================
    // Scenario 8: 不正Candidate dataでtransaction中断
    // =========================================================================
    const fx8 = await makeFixture(db, "s8");
    userIds.push(fx8.userId);
    const cap8 = await makeCapture(fx8, "S8: 破損データでのtransaction中断テスト用のCapture本文");
    const sess8 = await seedSession(db, {
      workspaceId: fx8.workspaceId,
      domainId: fx8.domainId,
      userId: fx8.userId,
      captureId: cap8.id,
      clientSessionKey: `test:${RUN_ID}:s8`,
      candidates: [{ candidateKey: "c1", type: "TASK", title: "S8候補", confidence: 0.7 }],
    });
    const s8Decision = await recordCandidateDecision({
      sessionId: sess8.sessionId,
      workspaceId: fx8.workspaceId,
      candidateId: sess8.candidates[0].identityId,
      expectedRevision: 1,
      decision: "ACCEPTED",
      actorUserId: fx8.userId,
    });
    ok("[S8] 事前のACCEPTは成功する", s8Decision.ok === true);
    const sess8BeforeMaterialize = await db.formationSession.findUniqueOrThrow({ where: { id: sess8.sessionId } });
    // 決定済みRevisionのproposedFieldsを直接破損させる(ResponsibilityCandidateSchemaで
    // 検証に失敗する形へ。requiredなevidenceSpans/confidence等を全て欠落させる)。
    const s8Identity = await db.formationCandidateIdentity.findUniqueOrThrow({
      where: { id: sess8.candidates[0].identityId },
    });
    await db.formationCandidateRevision.updateMany({
      where: { candidateId: s8Identity.id, revision: s8Identity.currentRevision },
      data: { proposedFields: { broken: true } },
    });
    const s8Materialize = await materializeFormationSession({
      sessionId: sess8.sessionId,
      workspaceId: fx8.workspaceId,
      operationId: `op-${RUN_ID}-s8`,
      expectedVersion: sess8BeforeMaterialize.version,
      actorUserId: fx8.userId,
    });
    ok(
      "[S8] 破損データでのMaterializeはCORRUPTED_CANDIDATE_DATAで中断する",
      !s8Materialize.ok && s8Materialize.error === "CORRUPTED_CANDIDATE_DATA",
    );
    ok(
      "[S8] 中断後もResponsibilityは0件(transaction全体がrollbackされている)",
      (await db.responsibility.count({ where: { originCaptureId: cap8.id } })) === 0,
    );
    ok(
      "[S8] 中断後もMaterializationReceiptは作成されていない",
      (await db.materializationReceipt.count({ where: { workspaceId: fx8.workspaceId, sessionId: sess8.sessionId } })) === 0,
    );
    const sess8AfterFailedMaterialize = await db.formationSession.findUniqueOrThrow({ where: { id: sess8.sessionId } });
    ok(
      "[S8] 中断後もSession.versionは変化していない",
      sess8AfterFailedMaterialize.version === sess8BeforeMaterialize.version,
      `before=${sess8BeforeMaterialize.version} after=${sess8AfterFailedMaterialize.version}`,
    );
    ok(
      "[S8] 中断後もSession.stateはCONFIRMEDへ進んでいない",
      sess8AfterFailedMaterialize.state !== "CONFIRMED",
      sess8AfterFailedMaterialize.state,
    );
    const s8Timeline = await db.formationSessionEvent.findMany({ where: { sessionId: sess8.sessionId } });
    ok(
      "[S8] 中断後もMATERIALIZATION_COMMITTED/SESSION_CONFIRMED Eventが記録されていない",
      !s8Timeline.some((e: { eventType: string }) => e.eventType === "MATERIALIZATION_COMMITTED" || e.eventType === "SESSION_CONFIRMED"),
    );

    // computeMaterializeRequestHashの純粋関数としての整合性(expectedVersion違いで
    // hashが変わること)も直接確認しておく。
    const hashV0 = computeMaterializeRequestHash({ sessionId: "x", workspaceId: "y", expectedVersion: 0 });
    const hashV1 = computeMaterializeRequestHash({ sessionId: "x", workspaceId: "y", expectedVersion: 1 });
    ok("[純粋関数] expectedVersionが異なればrequestHashも異なる", hashV0 !== hashV1);

    // [B3.2新設・B32-01] cleanupで消える前に、このRUNの全workspace配下で実際に
    // 生成されたMaterializationReceiptItem数を記録しておく(stub呼出し回数との
    // 突合用)。
    const memberships = await db.workspaceMember.findMany({
      where: { userId: { in: userIds } },
      select: { workspaceId: true },
    });
    const workspaceIds = memberships.map((m: { workspaceId: string }) => m.workspaceId);
    if (workspaceIds.length > 0) {
      materializedItemCountBeforeCleanup = await db.materializationReceiptItem.count({
        where: { workspaceId: { in: workspaceIds } },
      });
    }
  } finally {
    if (failed === 0 || !KEEP_ON_FAILURE) {
      const { db: dbForCleanup } = await import("../app/src/lib/db");
      for (const uid of userIds) {
        const result = await cleanupFormationVerifyUser(dbForCleanup, uid);
        cleanupErrors.push(...result.errors);
      }
    } else {
      console.log(`[KEEP_TEST_DATA_ON_FAILURE=1] userIds=${JSON.stringify(userIds)} を残します`);
    }
  }

  denyGuard.restore();

  // [B3.2新設・B32-02] cleanup自体の例外を握りつぶさない。1件でもあれば最終結果FAIL。
  ok(
    "[cleanup] cleanup処理中に例外が0件である",
    cleanupErrors.length === 0,
    cleanupErrors.map((e) => e.step).join(","),
  );

  if (failed === 0 || !KEEP_ON_FAILURE) {
    const leftover = await assertNoLeftoverFormationVerifyUsers(db, EMAIL_PREFIX);
    ok("[cleanup] cleanup後、test prefixのUserが0件である", leftover.clean, leftover.remainingUserIds.join(","));
  }

  // [B3.2新設・B32-01] AI providerへの通信guardは終始deny件数0のはず。
  ok(
    "[非課金guard] scenario実行中、AI provider hostへの通信試行は0件(self-test自身の既知の1件を除く)",
    denyGuard.deniedCallAttempts.length === deniedCallAttemptsBaselineAfterSelfTest,
    `total=${denyGuard.deniedCallAttempts.length} baseline(self-test分)=${deniedCallAttemptsBaselineAfterSelfTest} attempts=${JSON.stringify(denyGuard.deniedCallAttempts)}`,
  );

  // [B3.2新設・B32-01] stub呼出し回数と、実際に新規Materializeされたitem数が
  // 一致することを確認する。
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
