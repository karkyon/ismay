#!/usr/bin/env node
/**
 * scripts/verify_gate_m1b4_shared_core_acceptance.ts
 *
 * Gate M1-B4(監査「Gate M1-B4 次工程指示」B31-05/B31-06是正、案B・カルキョンさん
 * 承認)の受入証跡。
 *
 * このGateで`app/src/lib/formation/responsibilityMaterializationCore.ts`を新設し、
 * 旧`/inferences/[id]/decision`route.tsと新`materialize.ts`が同じResponsibility作成
 * コア(Tag自動付与+BLOCKS Relation解決+EventLog+Outbox)を共有するようにした。
 * このスクリプトは`materialize.ts`(実際にproduction routeが呼ぶ本物のコード)経由で、
 * 従来スコープ外だったTag/BLOCKS挙動が新たに正しく機能することをDB直結で検証する。
 * 旧route側の同値性(責務が「共通コアを呼ぶ」という1点に収束していること)は
 * ソースレビューで確認済み(route.ts中、CHG011_SHARED_CORE_ENABLED時のみ
 * createResponsibilityWithLinksを呼ぶ経路が存在し、それ以外は既存inline実装を
 * 変更なしで温存している)。route.ts自体のHTTP層(認証/CSRF)を経由したe2e検証は、
 * このGateのスコープ外として明示的に次工程送りとする(下記「未実施」参照)。
 *
 * 検証内容:
 *   1. 単一candidate、suggestedTags 2件 → materialize後、Tag 2件が作成され
 *      ResponsibilityTagで正しく紐付く
 *   2. 同一Session内、候補B.blockedByCandidateIds=[候補Aのkey]、両方を同一
 *      materialize呼び出し(同一operationId)でACCEPTED→materialize
 *      → ResponsibilityRelation(fromId=A, toId=B, BLOCKS, CONFIRMED)が1件だけ存在
 *   3. 1回目materialize成功後、Session.stateが既にCONFIRMEDへ進むため、未決定のまま
 *      残った候補への2回目Decisionが拒否されることを確認する(=このGateで新設した
 *      cross-operation BLOCKS解決コード(`priorReceiptItems`)は、現状の状態遷移規則
 *      の下では到達不能であることの実証。B31-07の具体的裏付けとして記録する)
 *   4. 1〜3のいずれでもAI providerへのネットワーク通信が0件
 *   5. cleanup後、ResponsibilityRelation/Tag/Responsibilityにtest用行が残らない
 *
 * 未実施(次工程へ明示的に申し送り):
 *   - 旧`/inferences/[id]/decision`route.ts自体をHTTP経由(認証/CSRFを含む)で
 *     呼び出し、FEATURE_CHG011_SHARED_CORE=true/false双方で応答が同値であることの
 *     e2e確認。認証/CSRFのtest fixture基盤がこのリポジトリに未整備のため、
 *     別途の準備作業が必要(想像で簡易モックを作ると却って信頼性の低い検証に
 *     なるため、このGateでは行わない)。
 *   - B31-07(旧Inbox UIの1件処理と、materializeのCOMMIT一括終端の意味論不一致)。
 *     この点は`coreTypes.ts`のFormationSession状態遷移表(COMMIT操作は
 *     REVIEW_READY/PARTIALLY_CONFIRMEDから常にCONFIRMEDへ、という1行のみ定義)を
 *     実読して確認済みだが、UI移行かSpec改訂(統合正本v5.0 6.8節)のいずれで
 *     解消するかはカルキョンさんの意思決定が必要なため、コード変更は含めない。
 *
 * 実行方法:
 *   cd ~/projects/ismay/app
 *   npx tsx ../scripts/verify_gate_m1b4_shared_core_acceptance.ts
 *
 * 前提: DATABASE_URLが有効なPostgres(既存migrationすべて適用済み)を指していること。
 *       AIプロバイダー設定・ismay-app.service起動は不要。schema変更は一切伴わない。
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
const EMAIL_PREFIX = "gate-m1b4-shared-core-verify-";
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
  suggestedTags?: string[];
  blockedByCandidateIds?: string[];
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
          blockedByCandidateIds: spec.blockedByCandidateIds ?? [],
          suggestedTags: spec.suggestedTags ?? [],
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
    data: { email, passwordHash: "not-a-real-hash-for-db-only-test", displayName: `Gate M1B4 Verify ${suffix}` },
  });
  const workspace = await db.workspace.create({ data: { name: `Gate M1B4 Test Workspace ${suffix}` } });
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
  const denyGuard = installAiNetworkDenyGuard();
  const guardSelfTestPassed = await selfTestAiNetworkDenyGuard(denyGuard);
  ok("[非課金guard] AI network deny guardのpure self-testが機能する", guardSelfTestPassed);
  const deniedCallAttemptsBaselineAfterSelfTest = denyGuard.deniedCallAttempts.length;
  if (!guardSelfTestPassed) {
    denyGuard.restore();
    console.log(`\n合計: ${passed} passed, ${failed} failed`);
    console.log("失敗一覧:\n  - [非課金guard] AI network deny guardのpure self-testが機能する");
    process.exitCode = 1;
    return;
  }

  const { db } = await import("../app/src/lib/db");
  const { recordCandidateDecision, materializeFormationSession: materializeReal } = await import(
    "../app/src/lib/formation/materialize"
  );

  const embedStub = async () => ({ ok: true as const });
  const stubbedDeps = { embedAndStoreResponsibility: embedStub };
  const materializeFormationSession = (params: Parameters<typeof materializeReal>[0]) =>
    materializeReal(params, stubbedDeps);

  const userIds: string[] = [];
  const cleanupErrors: { step: string; error: unknown }[] = [];

  try {
    // --- Scenario 1: suggestedTags自動付与 ---
    const fx1 = await makeFixture(db, "s1");
    userIds.push(fx1.userId);
    const cap1 = await makeCapture(fx1, "経費精算書を来週までに提出する");
    const sess1 = await seedSession(db, {
      workspaceId: fx1.workspaceId,
      domainId: fx1.domainId,
      userId: fx1.userId,
      captureId: cap1.id,
      clientSessionKey: "s1",
      candidates: [
        { candidateKey: "c1", type: "TASK", title: "経費精算書を提出する", confidence: 0.9, suggestedTags: ["経費", "総務"] },
      ],
    });
    const dec1 = await recordCandidateDecision({
      sessionId: sess1.sessionId,
      workspaceId: fx1.workspaceId,
      candidateId: sess1.candidates[0].identityId,
      expectedRevision: 1,
      decision: "ACCEPTED",
      actorUserId: fx1.userId,
    });
    ok("[S1] Decision記録成功", dec1.ok === true);
    const mat1 = await materializeFormationSession({
      sessionId: sess1.sessionId,
      workspaceId: fx1.workspaceId,
      operationId: "op-s1",
      expectedVersion: sess1.version,
      actorUserId: fx1.userId,
    });
    ok("[S1] Materialize成功", mat1.ok === true, JSON.stringify(mat1));
    if (mat1.ok) {
      const resp1Id = mat1.items[0].responsibilityId;
      const tagLinks = await db.responsibilityTag.findMany({
        where: { responsibilityId: resp1Id },
        include: { tag: true },
      });
      const tagNames = tagLinks.map((t: { tag: { name: string } }) => t.tag.name).sort();
      ok(
        "[S1・B31-06] suggestedTags 2件がTagとして作成・紐付けされる",
        tagNames.length === 2 && tagNames[0] === "経費" && tagNames[1] === "総務",
        JSON.stringify(tagNames),
      );
    }

    // --- Scenario 2: 同一materialize呼び出し内でのBLOCKS解決(順方向) ---
    const fx2 = await makeFixture(db, "s2");
    userIds.push(fx2.userId);
    const cap2 = await makeCapture(fx2, "設計書を作成後にレビュー依頼を送る");
    const sess2 = await seedSession(db, {
      workspaceId: fx2.workspaceId,
      domainId: fx2.domainId,
      userId: fx2.userId,
      captureId: cap2.id,
      clientSessionKey: "s2",
      candidates: [
        { candidateKey: "cA", type: "TASK", title: "設計書を作成する", confidence: 0.9 },
        { candidateKey: "cB", type: "TASK", title: "レビュー依頼を送る", confidence: 0.9, blockedByCandidateIds: ["cA"] },
      ],
    });
    for (const c of sess2.candidates) {
      const d = await recordCandidateDecision({
        sessionId: sess2.sessionId,
        workspaceId: fx2.workspaceId,
        candidateId: c.identityId,
        expectedRevision: 1,
        decision: "ACCEPTED",
        actorUserId: fx2.userId,
      });
      ok(`[S2] Decision記録成功(${c.candidateKey})`, d.ok === true);
    }
    // [修正] recordCandidateDecisionは呼ぶたびSession.versionを進めるため、
    // seedSession直後に取得したsess2.versionは既に古い。materialize直前に
    // 最新versionを取り直す(想像で決め打ちせず、実際のDB値を見る)。
    const sess2Latest = await db.formationSession.findUniqueOrThrow({ where: { id: sess2.sessionId } });
    const mat2 = await materializeFormationSession({
      sessionId: sess2.sessionId,
      workspaceId: fx2.workspaceId,
      operationId: "op-s2",
      expectedVersion: sess2Latest.version,
      actorUserId: fx2.userId,
    });
    ok("[S2] Materialize成功(2件同時)", mat2.ok === true && mat2.items.length === 2, JSON.stringify(mat2));
    if (mat2.ok) {
      const respA = mat2.items.find((i) => i.candidateId === sess2.candidates[0].identityId);
      const respB = mat2.items.find((i) => i.candidateId === sess2.candidates[1].identityId);
      const relations = await db.responsibilityRelation.findMany({
        where: { fromId: respA?.responsibilityId, toId: respB?.responsibilityId, relationType: "BLOCKS" },
      });
      ok(
        "[S2・B31-06] BLOCKS Relation(A→B)が1件だけ存在する(同一tx内・順方向)",
        relations.length === 1 && relations[0].status === "CONFIRMED",
        `count=${relations.length}`,
      );
    }

    // --- Scenario 3: 1回目materialize後、Sessionが既にCONFIRMEDへ進むため、
    //     未決定のまま残った候補への2回目Decisionは拒否される(確認) ---
    // [重要な発見・このスクリプト作成中に実コードで確認] `acceptedTargets`計算部には
    // 「既にmaterialize済みのcandidateを除外する」`alreadyMaterializedCandidateIds`
    // フィルタが元から存在し、これは「同一Sessionへ複数回materializeを呼べる」ことを
    // 前提にしている。しかし実際にはCOMMIT操作(coreTypes.ts)が常にSessionを
    // CONFIRMEDへ遷移させるため、1回目のmaterialize成功後はrecordCandidateDecision
    // 自体がINVALID_SESSION_STATEで拒否され、2回目のmaterializeへ到達する経路が
    // 存在しない。つまりこのGateで新設した「過去commit済み候補を跨いだBLOCKS解決」
    // (`priorReceiptItems`)は、現在の状態遷移規則の下では到達不能なdead codeである
    // (B31-07が指摘する意味論不一致の、コード上の具体的な現れ)。害はない
    // (将来B31-07が「pending残存時はPARTIALLY_CONFIRMEDのまま」という方向で解消
    // されれば、そのまま活きるようになる設計)が、このGateでは実行到達を証明できない
    // ため「未検証」として正直に記録する。B31-07自体の解消(状態遷移規則の変更)は
    // カルキョンさんの意思決定が必要なため、このGateのコード変更には含めない。
    const fx3 = await makeFixture(db, "s3");
    userIds.push(fx3.userId);
    const cap3 = await makeCapture(fx3, "見積書を送付後に契約書を締結する");
    const sess3 = await seedSession(db, {
      workspaceId: fx3.workspaceId,
      domainId: fx3.domainId,
      userId: fx3.userId,
      captureId: cap3.id,
      clientSessionKey: "s3",
      candidates: [
        { candidateKey: "cA", type: "TASK", title: "見積書を送付する", confidence: 0.9 },
        { candidateKey: "cB", type: "TASK", title: "契約書を締結する", confidence: 0.9, blockedByCandidateIds: ["cA"] },
      ],
    });
    const decA3 = await recordCandidateDecision({
      sessionId: sess3.sessionId,
      workspaceId: fx3.workspaceId,
      candidateId: sess3.candidates[0].identityId,
      expectedRevision: 1,
      decision: "ACCEPTED",
      actorUserId: fx3.userId,
    });
    ok("[S3] Decision記録成功(A、1回目)", decA3.ok === true);
    // [修正] S2と同じ理由。recordCandidateDecision後の最新versionを取り直す。
    const sess3Latest = await db.formationSession.findUniqueOrThrow({ where: { id: sess3.sessionId } });
    const mat3a = await materializeFormationSession({
      sessionId: sess3.sessionId,
      workspaceId: fx3.workspaceId,
      operationId: "op-s3-a",
      expectedVersion: sess3Latest.version,
      actorUserId: fx3.userId,
    });
    ok(
      "[S3] 1回目のMaterialize成功(Aのみ、B31-06のBLOCKS該当先が未存在のため相手なし)",
      mat3a.ok === true && mat3a.items.length === 1,
      JSON.stringify(mat3a),
    );
    if (mat3a.ok) {
      const decB3 = await recordCandidateDecision({
        sessionId: sess3.sessionId,
        workspaceId: fx3.workspaceId,
        candidateId: sess3.candidates[1].identityId,
        expectedRevision: 1,
        decision: "ACCEPTED",
        actorUserId: fx3.userId,
      });
      ok(
        "[S3・B31-07の具体的裏付け] 1回目materialize後Session.stateが既にCONFIRMEDと" +
          "なるため、Bの2回目DecisionはINVALID_SESSION_STATEで拒否される" +
          "(=priorReceiptItemsによるcross-operation BLOCKS解決は現状到達不能)",
        decB3.ok === false && decB3.error === "INVALID_SESSION_STATE",
        JSON.stringify(decB3),
      );
    }

    // --- cleanup用に生成したworkspaceId一覧をcleanup前に記録 ---
    const memberships = await db.workspaceMember.findMany({
      where: { userId: { in: userIds } },
      select: { workspaceId: true },
    });
    const workspaceIds = memberships.map((m: { workspaceId: string }) => m.workspaceId);

    ok(
      "[非課金guard] scenario実行中、AI provider hostへの通信試行は0件(self-test自身の既知の1件を除く)",
      denyGuard.deniedCallAttempts.length === deniedCallAttemptsBaselineAfterSelfTest,
      `total=${denyGuard.deniedCallAttempts.length}`,
    );

    void workspaceIds; // (現時点では追加集計に未使用。将来のstub呼出し回数突合用に保持)
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

  ok("[cleanup] cleanup処理中に例外が0件である", cleanupErrors.length === 0, cleanupErrors.map((e) => e.step).join(","));

  if (failed === 0 || !KEEP_ON_FAILURE) {
    const leftover = await assertNoLeftoverFormationVerifyUsers(db, EMAIL_PREFIX);
    ok("[cleanup] cleanup後、test prefixのUserが0件である", leftover.clean, leftover.remainingUserIds.join(","));
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
