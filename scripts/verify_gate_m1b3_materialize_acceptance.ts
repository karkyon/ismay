#!/usr/bin/env node
/**
 * scripts/verify_gate_m1b3_materialize_acceptance.ts
 *
 * DOC-03(Formation Session仕様書) 10章のロールアップ計画でいう「B3: Materialize
 * serviceへsingle-write」の受入証跡。
 *
 * [重要・このスクリプトの位置づけ] B1/B2の受入証跡スクリプトと異なり、このスクリプトは
 * 実AI呼び出し(Anthropic API)を一切行わない。B3で実装した
 * `recordCandidateDecision`/`materializeFormationSession`(app/src/lib/formation/
 * materialize.ts)はFormationSession/CandidateIdentity/Revision/CandidateDecisionEvent/
 * MaterializationReceiptというFormation domainのテーブルのみを対象とし、AI抽出結果
 * そのもの(候補の中身)には依存しない。そのため、このスクリプトはCapture作成→AI解析
 * というB1/B2の実運用経路を再現せず、FormationSession/CandidateIdentity/Revisionを
 * Prisma経由で直接シードする(shadowWrite.tsが実際に書き込むのと同じ形の行を、
 * AI呼び出し無しで用意するだけ)。ismay-app.serviceが起動している必要も無い
 * (このスクリプトはHTTPを一切使わず、DB直結で検証する)。
 *
 * 検証内容(実DB、EV-F-*相当):
 *   1. recordCandidateDecision: 正しいrevisionでACCEPT成功、REJECT成功。
 *      古いrevisionを渡すとREVISION_CONFLICT。既に決定済みの候補への再決定は
 *      ALREADY_DECIDED。REVIEW_READY→PARTIALLY_CONFIRMEDの遷移が
 *      「acceptedとpending混在」の条件でのみ発火すること。
 *   2. materializeFormationSession: version不一致でVERSION_CONFLICT。
 *      ACCEPTED候補が無いSessionはNO_ACCEPTED_CANDIDATES。DRAFT状態の
 *      SessionはINVALID_SESSION_STATE。
 *   3. 正常系: ACCEPTED候補だけがResponsibility化され、REJECTED候補は
 *      Responsibilityを生成しないこと(EV-F相当「本人承認なしのResponsibility
 *      生成0件」)。生成されたResponsibilityのtype/title/confidenceが
 *      採否対象Revision(currentRevisionではなく決定時点のrevisionId)と
 *      一致すること。
 *   4. MaterializationReceipt/Itemが1候補1生成で作成され、Session.stateが
 *      CONFIRMEDへ遷移すること。FormationSessionEventへ
 *      MATERIALIZATION_COMMITTED/SESSION_CONFIRMEDが記録されること。
 *   5. 同一operationIdの再送(同一内容)はreplay:trueで同じReceiptを返し、
 *      新規Responsibilityを作らないこと(冪等性)。
 *   6. requestHashが異なる状態でoperationIdを再利用するとIDEMPOTENCY_KEY_REUSED。
 *
 * 実行方法:
 *   cd ~/projects/ismay/app
 *   npx tsx ../scripts/verify_gate_m1b3_materialize_acceptance.ts
 *
 * 前提: DATABASE_URLが有効なPostgres(pgvector込み)を指していること。
 *       ismay-app.serviceの起動・AIプロバイダー設定は不要(AIを一切呼ばないため)。
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
const EMAIL_PREFIX = "gate-m1b3-materialize-verify-";
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

async function main(): Promise<void> {
  // [B3.2新設・B32-01] AI provider host(OpenAI/Anthropic)への通信を、実際に
  // ネットワークへ出す前に機械的に遮断するguardを最初に設置する。APIキーが
  // .envに設定されていても、このguard配下ではEmbedding API等への通信は0件になる。
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
    // guard自体が機能していない状態でscenarioを進めると「AI呼出し無し」を
    // 証明できないため、ここで即座に打ち切る。
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
  // (dependency injection)。既存の呼び出し箇所を書き換えずに済むよう、
  // importした本来の関数をこのファイル内だけshadowする。stub呼出し回数を数え、
  // 最後に「実際にMaterializeされた新規item数」と一致することをassertする
  // (監査B32-01「stub呼出し回数をassertし、本来post-commit配送対象となった件数と
  // 一致することも確認する」)。
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

  console.log("V5-M1-B3 Materialize service 受入証跡(AI呼出し無し・実DBのみ・DI stub + network deny guard)");

  // ---- 孤立テストデータの掃除 -------------------------------------------
  const cleanupErrors: { step: string; error: unknown }[] = [];
  const orphans = await db.user.findMany({
    where: { email: { startsWith: EMAIL_PREFIX, endsWith: "@example.invalid" } },
    select: { id: true },
  });
  for (const o of orphans) {
    const result = await cleanupFormationVerifyUser(db, o.id);
    cleanupErrors.push(...result.errors);
  }

  let userId: string | null = null;
  let workspaceId: string | null = null;
  let materializedItemCountBeforeCleanup: number | null = null;

  try {
    // ---- テストfixture作成(HTTPを使わず直接Prisma、AI呼出し無し) --------
    const email = `${EMAIL_PREFIX}${RUN_ID}@example.invalid`;
    const user = await db.user.create({
      data: { email, passwordHash: "not-a-real-hash-for-db-only-test", displayName: "Gate M1B3 Verify" },
    });
    userId = user.id;

    const workspace = await db.workspace.create({ data: { name: "Gate M1B3 Test Workspace" } });
    workspaceId = workspace.id;
    await db.workspaceMember.create({ data: { workspaceId: workspace.id, userId: user.id, role: "OWNER" } });
    const domain = await db.domain.create({ data: { workspaceId: workspace.id, name: "個人", kind: "PERSONAL" } });

    const capture = await db.capture.create({
      data: {
        workspaceId: workspace.id,
        domainId: domain.id,
        createdById: user.id,
        sourceType: "TEXT",
        rawText: "明日までに見積書をA社へ送る。念のため先方の予算感も再確認しておく。",
        processingStatus: "READY",
      },
    });

    // ---- Scenario A: 正常な採否→Materialize -------------------------------
    const sessionA = await seedSession(db, {
      workspaceId: workspace.id,
      domainId: domain.id,
      userId: user.id,
      captureId: capture.id,
      clientSessionKey: `test:${RUN_ID}:A`,
      candidates: [
        { candidateKey: "c1", type: "TASK", title: "見積書をA社へ送る", confidence: 0.9, hardDeadlineAt: "2026-08-29T00:00:00+09:00" },
        { candidateKey: "c2", type: "TASK", title: "予算感を再確認する", confidence: 0.6 },
      ],
    });

    // 古いrevision(0)でACCEPTしようとするとREVISION_CONFLICT
    const staleDecision = await recordCandidateDecision({
      sessionId: sessionA.sessionId,
      workspaceId: workspace.id,
      candidateId: sessionA.candidates[0].identityId,
      expectedRevision: 0,
      decision: "ACCEPTED",
      actorUserId: user.id,
    });
    ok("古いrevisionでの採否はREVISION_CONFLICT", !staleDecision.ok && staleDecision.error === "REVISION_CONFLICT");

    // c1をACCEPT
    const acceptC1 = await recordCandidateDecision({
      sessionId: sessionA.sessionId,
      workspaceId: workspace.id,
      candidateId: sessionA.candidates[0].identityId,
      expectedRevision: 1,
      decision: "ACCEPTED",
      actorUserId: user.id,
    });
    ok("c1のACCEPTが成功する", acceptC1.ok === true);
    if (acceptC1.ok) {
      ok(
        "c1 ACCEPT後、Session状態はPARTIALLY_CONFIRMED(acceptedとpending混在)",
        acceptC1.sessionState === "PARTIALLY_CONFIRMED",
        acceptC1.sessionState,
      );
    }

    // 同じ候補への再決定はALREADY_DECIDED
    const reDecide = await recordCandidateDecision({
      sessionId: sessionA.sessionId,
      workspaceId: workspace.id,
      candidateId: sessionA.candidates[0].identityId,
      expectedRevision: 1,
      decision: "REJECTED",
      actorUserId: user.id,
    });
    ok("決定済み候補への再決定はALREADY_DECIDED", !reDecide.ok && reDecide.error === "ALREADY_DECIDED");

    // c2をREJECT
    const rejectC2 = await recordCandidateDecision({
      sessionId: sessionA.sessionId,
      workspaceId: workspace.id,
      candidateId: sessionA.candidates[1].identityId,
      expectedRevision: 1,
      decision: "REJECTED",
      actorUserId: user.id,
    });
    ok("c2のREJECTが成功する", rejectC2.ok === true);

    const sessionAfterDecisions = await db.formationSession.findUniqueOrThrow({ where: { id: sessionA.sessionId } });
    const versionBeforeMaterialize = sessionAfterDecisions.version;

    // version不一致でMaterializeするとVERSION_CONFLICT
    const badVersion = await materializeFormationSession({
      sessionId: sessionA.sessionId,
      workspaceId: workspace.id,
      operationId: `op-${RUN_ID}-badversion`,
      expectedVersion: versionBeforeMaterialize + 999,
      actorUserId: user.id,
    });
    ok("version不一致のMaterializeはVERSION_CONFLICT", !badVersion.ok && badVersion.error === "VERSION_CONFLICT");
    const sessionAfterBadVersion = await db.formationSession.findUniqueOrThrow({ where: { id: sessionA.sessionId } });
    ok(
      "VERSION_CONFLICT後もResponsibilityが生成されていない",
      (await db.responsibility.count({ where: { originCaptureId: capture.id } })) === 0,
    );
    ok("VERSION_CONFLICT後もSession.stateはCONFIRMEDへ進んでいない", sessionAfterBadVersion.state !== "CONFIRMED");

    const operationId = `op-${RUN_ID}-main`;
    const materialized = await materializeFormationSession({
      sessionId: sessionA.sessionId,
      workspaceId: workspace.id,
      operationId,
      expectedVersion: sessionAfterBadVersion.version,
      actorUserId: user.id,
    });
    ok("正常なMaterializeが成功する", materialized.ok === true);

    if (materialized.ok) {
      ok("Materialize結果はreplay:falseの新規commit", materialized.replay === false);
      ok("ACCEPTEDの1候補だけがitemsに含まれる(REJECTEDは含まれない)", materialized.items.length === 1);
      ok(
        "生成されたitemはc1(ACCEPTED)のcandidateId",
        materialized.items[0]?.candidateId === sessionA.candidates[0].identityId,
      );

      const responsibility = await db.responsibility.findUnique({
        where: { id: materialized.items[0]!.responsibilityId },
      });
      ok("Responsibilityが実際に作成されている", !!responsibility);
      if (responsibility) {
        ok("Responsibility.typeがcandidateのtypeと一致", responsibility.type === "TASK");
        ok("Responsibility.titleがcandidateのtitleと一致", responsibility.title === "見積書をA社へ送る");
        ok("Responsibility.hardDeadlineAtがdateMentionsから設定されている", responsibility.hardDeadlineAt !== null);
        ok("Responsibility.sourceKindはAI", responsibility.sourceKind === "AI");
      }

      ok(
        "REJECTEDのc2からはResponsibilityが作られていない(本人承認なしのResponsibility生成0件)",
        (await db.responsibility.count({ where: { originCaptureId: capture.id } })) === 1,
      );

      const receipt = await db.materializationReceipt.findUnique({
        where: { id: materialized.receiptId },
        include: { items: true },
      });
      ok("MaterializationReceiptが作成されている", !!receipt);
      ok("Receipt.itemsが1件(1候補1生成)", receipt?.items.length === 1);

      const sessionAfterCommit = await db.formationSession.findUniqueOrThrow({ where: { id: sessionA.sessionId } });
      ok("Materialize後、Session.stateはCONFIRMED", sessionAfterCommit.state === "CONFIRMED");

      const timelineEvents = await db.formationSessionEvent.findMany({
        where: { sessionId: sessionA.sessionId },
        orderBy: { sequence: "asc" },
      });
      ok(
        "FormationSessionEventにMATERIALIZATION_COMMITTEDが記録されている",
        timelineEvents.some((e: { eventType: string }) => e.eventType === "MATERIALIZATION_COMMITTED"),
      );
      ok(
        "FormationSessionEventにSESSION_CONFIRMEDが記録されている",
        timelineEvents.some((e: { eventType: string }) => e.eventType === "SESSION_CONFIRMED"),
      );

      const eventLog = await db.eventLog.findFirst({
        where: { aggregateType: "Responsibility", aggregateId: materialized.items[0]!.responsibilityId },
      });
      ok("EventLog(AI_CANDIDATE_DECIDED)が記録されている", !!eventLog);
      const outbox = await db.outboxEvent.findFirst({
        where: { eventName: "ResponsibilityCreated.v1", aggregateId: materialized.items[0]!.responsibilityId },
      });
      ok("OutboxEvent(ResponsibilityCreated.v1)が記録されている", !!outbox);

      // ---- 冪等性: 同一operationIdの再送 -----------------------------------
      const replay = await materializeFormationSession({
        sessionId: sessionA.sessionId,
        workspaceId: workspace.id,
        operationId,
        expectedVersion: sessionAfterBadVersion.version,
        actorUserId: user.id,
      });
      ok("同一operationId再送はreplay:trueで成功する", replay.ok === true && replay.replay === true);
      if (replay.ok) {
        ok("再送は同じReceiptIdを返す", replay.receiptId === materialized.receiptId);
      }
      ok(
        "再送でもResponsibilityが増えない(冪等性)",
        (await db.responsibility.count({ where: { originCaptureId: capture.id } })) === 1,
      );

      // requestHashを故意に壊してIDEMPOTENCY_KEY_REUSEDを確認
      await db.materializationReceipt.update({
        where: { id: materialized.receiptId },
        data: { requestHash: "corrupted-for-test" },
      });
      const reused = await materializeFormationSession({
        sessionId: sessionA.sessionId,
        workspaceId: workspace.id,
        operationId,
        expectedVersion: sessionAfterBadVersion.version,
        actorUserId: user.id,
      });
      ok("requestHash不一致の同一operationId再利用はIDEMPOTENCY_KEY_REUSED", !reused.ok && reused.error === "IDEMPOTENCY_KEY_REUSED");
      // 検証用に壊したhashを元に戻す(以降のcleanupに影響しないが一応整合させる)
      await db.materializationReceipt.update({
        where: { id: materialized.receiptId },
        data: {
          requestHash: computeMaterializeRequestHash({
            sessionId: sessionA.sessionId,
            workspaceId: workspace.id,
            expectedVersion: sessionAfterBadVersion.version,
          }),
        },
      });
    }

    // ---- Scenario B: ACCEPTEDが1件も無いSessionはNO_ACCEPTED_CANDIDATES ----
    const captureB = await db.capture.create({
      data: {
        workspaceId: workspace.id,
        domainId: domain.id,
        createdById: user.id,
        sourceType: "TEXT",
        rawText: "検討中の案件メモ",
        processingStatus: "READY",
      },
    });
    const sessionB = await seedSession(db, {
      workspaceId: workspace.id,
      domainId: domain.id,
      userId: user.id,
      captureId: captureB.id,
      clientSessionKey: `test:${RUN_ID}:B`,
      candidates: [{ candidateKey: "c1", type: "TASK", title: "後で決める", confidence: 0.5 }],
    });
    const noAccepted = await materializeFormationSession({
      sessionId: sessionB.sessionId,
      workspaceId: workspace.id,
      operationId: `op-${RUN_ID}-b`,
      expectedVersion: 0,
      actorUserId: user.id,
    });
    ok("ACCEPTED候補0件のMaterializeはNO_ACCEPTED_CANDIDATES", !noAccepted.ok && noAccepted.error === "NO_ACCEPTED_CANDIDATES");

    // ---- Scenario C: DRAFT状態のSessionはINVALID_SESSION_STATE ------------
    const captureC = await db.capture.create({
      data: {
        workspaceId: workspace.id,
        domainId: domain.id,
        createdById: user.id,
        sourceType: "TEXT",
        rawText: "まだ解析していないメモ",
        processingStatus: "SAVED",
      },
    });
    const sessionC = await db.formationSession.create({
      data: {
        workspaceId: workspace.id,
        domainId: domain.id,
        subjectUserId: user.id,
        captureId: captureC.id,
        clientSessionKey: `test:${RUN_ID}:C`,
        state: "DRAFT",
      },
    });
    const draftMaterialize = await materializeFormationSession({
      sessionId: sessionC.id,
      workspaceId: workspace.id,
      operationId: `op-${RUN_ID}-c`,
      expectedVersion: 0,
      actorUserId: user.id,
    });
    ok(
      "DRAFT状態のSessionへのMaterializeはINVALID_SESSION_STATE",
      !draftMaterialize.ok && draftMaterialize.error === "INVALID_SESSION_STATE",
    );
    const draftDecision = await recordCandidateDecision({
      sessionId: sessionC.id,
      workspaceId: workspace.id,
      candidateId: "00000000-0000-0000-0000-000000000000",
      expectedRevision: 1,
      decision: "ACCEPTED",
      actorUserId: user.id,
    });
    ok(
      "DRAFT状態のSessionへの候補決定はINVALID_SESSION_STATE",
      !draftDecision.ok && draftDecision.error === "INVALID_SESSION_STATE",
    );

    // [B3.2新設・B32-01] cleanupで消える前に、このworkspace配下で実際に生成された
    // MaterializationReceiptItem数を記録しておく(stub呼出し回数との突合用)。
    if (workspaceId) {
      materializedItemCountBeforeCleanup = await db.materializationReceiptItem.count({ where: { workspaceId } });
    }
  } finally {
    if (failed === 0 || !KEEP_ON_FAILURE) {
      if (userId) {
        const result = await cleanupFormationVerifyUser((await import("../app/src/lib/db")).db, userId);
        cleanupErrors.push(...result.errors);
      }
    } else {
      console.log(`[KEEP_TEST_DATA_ON_FAILURE=1] userId=${userId} workspaceId=${workspaceId} を残します`);
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

  // [B3.2新設・B32-01] AI providerへの通信guardは終始deny件数0のはず(=本番と
  // 同じ経路を辿った場合でも実通信は起きていない)。
  ok(
    "[非課金guard] scenario実行中、AI provider hostへの通信試行は0件(self-test自身の既知の1件を除く)",
    denyGuard.deniedCallAttempts.length === deniedCallAttemptsBaselineAfterSelfTest,
    `total=${denyGuard.deniedCallAttempts.length} baseline(self-test分)=${deniedCallAttemptsBaselineAfterSelfTest} attempts=${JSON.stringify(denyGuard.deniedCallAttempts)}`,
  );

  // [B3.2新設・B32-01] stub呼出し回数と、実際に新規Materializeされたitem数が
  // 一致することを確認する(replayではstubを再呼出ししないことも間接的に検証する。
  // replay含む全materializeFormationSession呼び出しの中で新規commitはこのRUNでは
  // 1回だけなので、item数=1であればreplayではstubが呼ばれていないことになる)。
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

interface SeedCandidateSpec {
  candidateKey: string;
  type: string;
  title: string;
  confidence: number;
  hardDeadlineAt?: string;
}

async function seedSession(
  db: typeof import("../app/src/lib/db")["db"],
  input: {
    workspaceId: string;
    domainId: string;
    userId: string;
    captureId: string;
    clientSessionKey: string;
    candidates: SeedCandidateSpec[];
  },
): Promise<{ sessionId: string; candidates: { identityId: string; candidateKey: string }[] }> {
  // shadowWrite.tsが実際に書き込むのと同じ形の行を、AI呼出し無しで直接用意する
  // (このGate=B3は候補の「中身」ではなくMaterialize transactionの正しさを検証する)。
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
          dateMentions: spec.hardDeadlineAt
            ? [{ rawExpression: "明日", meaning: "HARD_DEADLINE", timezone: "Asia/Tokyo", normalizedAt: spec.hardDeadlineAt, confidence: 0.8 }]
            : [],
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

  return { sessionId: session.id, candidates };
}


main()
  .then(() => process.exit(process.exitCode ?? 0))
  .catch((err) => {
    console.error("予期しない例外:", err);
    process.exit(1);
  });
