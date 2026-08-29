#!/usr/bin/env node
/**
 * scripts/verify_gate_m1b41_cutover_foundation.ts
 *
 * Gate M1-B4.1(監査「Claude向け ISMAY M1-B4監査是正・B4.1実装指示」)の受入証跡。
 * AI providerへの実通信は一切行わない(aiNetworkDenyGuard必須、DI stub必須)。
 *
 * [v2・設計変更の経緯を正直に記録] 初版はHTTPサーバを起動せず、旧
 * `/inferences/[id]/decision`route.tsからexportされた実`POST`関数を`next/server`の
 * `NextRequest`を組み立てて直接呼ぶ設計だった。実行の結果
 * `Cannot find package 'next' imported from .../scripts/...`で失敗した。原因は
 * このリポジトリ構成にある: `next`パッケージは`app/node_modules`にしか存在せず、
 * Node.jsのESM解決は「importしているファイル自身の場所」から上方向に
 * node_modulesを探すため、`scripts/`(appの外、兄弟ディレクトリ)からは
 * `app/node_modules`へ到達できない。既存の`verify_gate_m1a/m1b1/m1b2`が
 * 全て`fetch()`によるHTTP経由でテストしている理由もこれだった(調査不足だった)。
 *
 * さらに、HTTP経由でのテストであっても、Flag ON(`FEATURE_CHG011_SHARED_CORE=true`)
 * を検証するには実際に動いているサーバプロセス自身の環境変数を変える必要があり、
 * これはテストスクリプトの`process.env`からは制御不能(別プロセスのため)。
 *
 * この版は、旧route(Flag ON時)と新Formation Materializeの両方が実際に収束する
 * 先である共通コア関数`createResponsibilityWithLinks`(および
 * `resolveLegacyProjectionMap`)を直接呼ぶ形にした。これはHTTPサーバにもNext.js
 * ランタイムにも一切依存せず、`@/`パスエイリアスのみで解決できる
 * (既存のFormation系DB受入scriptと同じ、実績のある方式)。旧新二重生成防止
 * (5.2節)・Partial Materialize(5.3節)は元々`recordCandidateDecision`/
 * `materializeFormationSession`という同じ理由でHTTP非依存だったため変更なし。
 * legacy AiInferenceの状態は、旧routeを経由させる代わりに直接DB seedする
 * (これはguardロジック自身がAiInference.decision/Responsibility有無という
 * 「結果の状態」だけを見て判定する設計であるため、経由方法を問わず正しく検証できる)。
 *
 * 実行方法:
 *   cd ~/projects/ismay/app
 *   npx tsx ../scripts/verify_gate_m1b41_cutover_foundation.ts
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
const EMAIL_PREFIX = "gate-m1b41-verify-";

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
  const denyGuard = installAiNetworkDenyGuard();
  const guardSelfTestPassed = await selfTestAiNetworkDenyGuard(denyGuard);
  ok("[非課金guard] AI network deny guardのpure self-testが機能する", guardSelfTestPassed);
  const deniedBaseline = denyGuard.deniedCallAttempts.length;
  if (!guardSelfTestPassed) {
    denyGuard.restore();
    console.log(`\n合計: ${passed} passed, ${failed} failed`);
    process.exitCode = 1;
    return;
  }

  const { db } = await import("../app/src/lib/db");
  const { createResponsibilityWithLinks } = await import("../app/src/lib/formation/responsibilityMaterializationCore");
  const { resolveLegacyProjectionMap } = await import("../app/src/lib/formation/legacyProjectionResolver");
  const { recordCandidateDecision, materializeFormationSession } = await import("../app/src/lib/formation/materialize");

  // [新設] 過去の失敗実行(cleanup未完了)が残した孤立test userを、本実行の前に
  // 一掃する(既存verify_gate_m1b2_dual_read_acceptance.tsの[SWEEP]と同じ方式)。
  const orphans = await db.user.findMany({
    where: { email: { startsWith: EMAIL_PREFIX, endsWith: "@example.invalid" } },
    select: { id: true },
  });
  if (orphans.length > 0) {
    console.log(`[SWEEP] 過去実行の孤立テストユーザー${orphans.length}件を削除します...`);
    for (const o of orphans) {
      const result = await cleanupFormationVerifyUser(db, o.id);
      if (result.errors.length > 0) {
        console.log(`  [SWEEP] userId=${o.id} cleanup中に例外: ${result.errors.map((e) => e.step).join(",")}`);
      }
    }
  }

  const embedStub = async () => ({ ok: true as const });
  const stubbedDeps = { embedAndStoreResponsibility: embedStub };
  const materialize = (params: Parameters<typeof materializeFormationSession>[0]) =>
    materializeFormationSession(params, stubbedDeps);

  const userIds: string[] = [];

  async function makeFixture(suffix: string) {
    const email = `${EMAIL_PREFIX}${RUN_ID}-${suffix}@example.invalid`;
    const user = await db.user.create({
      data: { email, passwordHash: "not-a-real-hash-for-db-only-test", displayName: `Gate M1B41 ${suffix}` },
    });
    const workspace = await db.workspace.create({ data: { name: `Gate M1B41 Workspace ${suffix}` } });
    await db.workspaceMember.create({ data: { workspaceId: workspace.id, userId: user.id, role: "OWNER" } });
    const domain = await db.domain.create({ data: { workspaceId: workspace.id, name: "個人", kind: "PERSONAL" } });
    userIds.push(user.id);
    return { userId: user.id, workspaceId: workspace.id, domainId: domain.id };
  }

  async function makeCapture(fx: { workspaceId: string; domainId: string; userId: string }, rawText: string) {
    return db.capture.create({
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

  /** 旧routeを経由させず、AiInference/AiRunを直接DB seedする(絶対ルール1.4)。
   *  guardロジック自身はAiInference.decision/Responsibility有無という
   *  「結果の状態」だけを見るため、経由方法を問わず正しく検証できる。 */
  async function seedAiInference(params: {
    captureId: string;
    candidateKey: string;
    title: string;
    decision?: string;
  }) {
    const aiRun = await db.aiRun.create({
      data: {
        captureId: params.captureId,
        provider: "anthropic",
        model: "claude-haiku-4-5-20251001",
        promptVersion: "test",
        schemaVersion: "1.0",
        status: "SUCCEEDED",
      },
    });
    const inference = await db.aiInference.create({
      data: {
        captureId: params.captureId,
        aiRunId: aiRun.id,
        inferenceType: "RESPONSIBILITY",
        evidenceSpans: [{ start: 0, end: Math.min(4, params.title.length) }],
        decision: params.decision ?? "PENDING",
        payload: {
          candidateId: params.candidateKey,
          type: "TASK",
          title: params.title,
          evidenceSpans: [{ start: 0, end: Math.min(4, params.title.length) }],
          confidence: 0.9,
          dateMentions: [],
          unknowns: [],
          blockedByCandidateIds: [],
          suggestedTags: [],
        },
        confidence: 0.9,
      },
    });
    return { aiRunId: aiRun.id, inferenceId: inference.id };
  }

  async function seedFormationSession(fx: { workspaceId: string; domainId: string; userId: string }, captureId: string, aiRunId: string | null, clientSessionKey: string) {
    const session = await db.formationSession.create({
      data: { workspaceId: fx.workspaceId, domainId: fx.domainId, subjectUserId: fx.userId, captureId, clientSessionKey, state: "REVIEW_READY" },
    });
    if (aiRunId) {
      await db.formationSessionEvent.create({
        data: { workspaceId: fx.workspaceId, sessionId: session.id, sequence: 1, eventType: "ANALYSIS_REQUESTED", actorType: "SYSTEM", payload: { aiRunId } },
      });
    }
    return session;
  }

  async function seedCandidate(fx: { workspaceId: string }, sessionId: string, key: string, title: string, blockedByCandidateIds: string[] = []) {
    const identity = await db.formationCandidateIdentity.create({
      data: { workspaceId: fx.workspaceId, sessionId, candidateKey: key, currentRevision: 1 },
    });
    await db.formationCandidateRevision.create({
      data: {
        workspaceId: fx.workspaceId, candidateId: identity.id, revision: 1, type: "TASK", title,
        proposedFields: { candidateId: key, type: "TASK", title, evidenceSpans: [{ start: 0, end: 4 }], confidence: 0.9, dateMentions: [], unknowns: [], blockedByCandidateIds, suggestedTags: [] },
        confidence: 0.9, schemaVersion: "1.0",
      },
    });
    return identity;
  }

  try {
    // ============================================================
    // 5.1 共通コア互換(createResponsibilityWithLinksを直接呼ぶ。旧route
    // Flag ON時と新Formation Materializeが実際に収束する先そのもの)
    // ============================================================
    const fx1 = await makeFixture("s1");
    const cap1 = await makeCapture(fx1, "経費精算書を提出する");

    const acceptResult = await db.$transaction((tx) =>
      createResponsibilityWithLinks(tx, {
        workspaceId: fx1.workspaceId,
        domainId: fx1.domainId,
        originCaptureId: cap1.id,
        type: "TASK",
        title: "経費精算書を提出する",
        confidence: 0.9,
        actorUserId: fx1.userId,
        suggestedTags: ["経費", "総務", "予算", "第4のタグ"],
        decisionValue: "ACCEPTED",
        actor: "自分",
        counterparty: "経理部",
        provenance: { kind: "AI_INFERENCE", inferenceId: "dummy-inference-id-accept" },
        blockedByResponsibilityIds: [],
        blocksResponsibilityIds: [],
      }),
    );
    const eventLogAccept = await db.eventLog.findFirst({
      where: { aggregateType: "Responsibility", aggregateId: acceptResult.id, eventType: "AI_CANDIDATE_DECIDED" },
    });
    const afterJsonAccept = eventLogAccept?.afterJson as { decision?: string } | null;
    ok(
      "[5.1.1・B41-01] decisionValue='ACCEPTED'指定時、EventLog.afterJson.decision=ACCEPTED",
      afterJsonAccept?.decision === "ACCEPTED",
      afterJsonAccept?.decision,
    );
    ok("[5.1.5・B31-06] actor/counterpartyがCreatedResponsibilityへ素通しされる", acceptResult.actor === "自分" && acceptResult.counterparty === "経理部");
    const tagLinksAccept = await db.responsibilityTag.findMany({ where: { responsibilityId: acceptResult.id }, include: { tag: true } });
    ok("[5.1.4] Tag最大3件(4件提案のうち3件だけ採用)", tagLinksAccept.length === 3, `count=${tagLinksAccept.length}`);

    const editResult = await db.$transaction((tx) =>
      createResponsibilityWithLinks(tx, {
        workspaceId: fx1.workspaceId,
        domainId: fx1.domainId,
        originCaptureId: cap1.id,
        type: "TASK",
        title: "見積書を最終レビューする",
        importance: 4,
        confidence: 0.9,
        actorUserId: fx1.userId,
        suggestedTags: [],
        decisionValue: "EDITED",
        provenance: { kind: "AI_INFERENCE", inferenceId: "dummy-inference-id-edit" },
        blockedByResponsibilityIds: [],
        blocksResponsibilityIds: [],
      }),
    );
    const eventLogEdit = await db.eventLog.findFirst({
      where: { aggregateType: "Responsibility", aggregateId: editResult.id, eventType: "AI_CANDIDATE_DECIDED" },
    });
    const afterJsonEdit = eventLogEdit?.afterJson as { decision?: string } | null;
    ok(
      "[5.1.2・B41-01の核心] decisionValue='EDITED'指定時、EventLog.afterJson.decision=EDITED(修正前はACCEPTEDに固定されるバグだった)",
      afterJsonEdit?.decision === "EDITED",
      afterJsonEdit?.decision,
    );
    ok("[5.1.3] EDITの編集済titleがResponsibilityへ反映される", editResult.title === "見積書を最終レビューする", editResult.title);
    const editedRespRow = await db.responsibility.findUniqueOrThrow({ where: { id: editResult.id } });
    ok("[5.1.3] EDITの編集済importanceがResponsibilityへ反映される", editedRespRow.importance === 4, String(editedRespRow.importance));

    // ============================================================
    // 5.2 旧新二重生成防止(recordCandidateDecisionの旧新横断guard)
    // ============================================================
    const fx3 = await makeFixture("s3guard");
    const cap3 = await makeCapture(fx3, "契約書を確認する");
    const seeded3 = await seedAiInference({ captureId: cap3.id, candidateKey: "cShared", title: "契約書を確認する", decision: "ACCEPTED" });
    // legacy ACCEPTEDに対応する既存Responsibilityを直接seed(旧route既存挙動と同じ形)。
    const legacyResp3 = await createResponsibilityWithLinks(db as any, {
      workspaceId: fx3.workspaceId, domainId: fx3.domainId, originCaptureId: cap3.id, type: "TASK", title: "契約書を確認する",
      confidence: 0.9, actorUserId: fx3.userId, suggestedTags: [], decisionValue: "ACCEPTED",
      originInferenceId: seeded3.inferenceId,
      provenance: { kind: "AI_INFERENCE", inferenceId: seeded3.inferenceId }, blockedByResponsibilityIds: [], blocksResponsibilityIds: [],
    });
    void legacyResp3;

    const session3 = await seedFormationSession(fx3, cap3.id, seeded3.aiRunId, "s3");
    const identity3 = await seedCandidate(fx3, session3.id, "cShared", "契約書を確認する");
    const guardResult = await recordCandidateDecision({
      sessionId: session3.id, workspaceId: fx3.workspaceId, candidateId: identity3.id, expectedRevision: 1, decision: "ACCEPTED", actorUserId: fx3.userId,
    });
    ok(
      "[5.2.1] legacy ACCEPTED+Responsibility既存の候補をFormationでACCEPTしようとするとALREADY_MATERIALIZED_BY_LEGACY",
      guardResult.ok === false && guardResult.error === "ALREADY_MATERIALIZED_BY_LEGACY",
      JSON.stringify(guardResult),
    );
    const decisionEventsAfterGuard = await db.formationCandidateDecisionEvent.count({ where: { workspaceId: fx3.workspaceId, candidateId: identity3.id } });
    ok("[5.2.1] guard発火後もFormation Decision Eventは0件", decisionEventsAfterGuard === 0, `count=${decisionEventsAfterGuard}`);

    const fx4 = await makeFixture("s4reject");
    const cap4 = await makeCapture(fx4, "不要な下書きを削除する");
    const seeded4 = await seedAiInference({ captureId: cap4.id, candidateKey: "cRej", title: "不要な下書きを削除する", decision: "REJECTED" });
    const session4 = await seedFormationSession(fx4, cap4.id, seeded4.aiRunId, "s4");
    const identity4 = await seedCandidate(fx4, session4.id, "cRej", "不要な下書きを削除する");
    const guardResult4 = await recordCandidateDecision({
      sessionId: session4.id, workspaceId: fx4.workspaceId, candidateId: identity4.id, expectedRevision: 1, decision: "ACCEPTED", actorUserId: fx4.userId,
    });
    ok(
      "[5.2.3] legacy REJECTED済みの候補をFormationでACCEPTしようとするとALREADY_DECIDED_BY_LEGACY",
      guardResult4.ok === false && guardResult4.error === "ALREADY_DECIDED_BY_LEGACY",
      JSON.stringify(guardResult4),
    );

    const fx5 = await makeFixture("s5pending");
    const cap5 = await makeCapture(fx5, "資料を確認する");
    const seeded5 = await seedAiInference({ captureId: cap5.id, candidateKey: "cPend", title: "資料を確認する", decision: "PENDING" });
    const session5 = await seedFormationSession(fx5, cap5.id, seeded5.aiRunId, "s5");
    const identity5 = await seedCandidate(fx5, session5.id, "cPend", "資料を確認する");
    const guardResult5 = await recordCandidateDecision({
      sessionId: session5.id, workspaceId: fx5.workspaceId, candidateId: identity5.id, expectedRevision: 1, decision: "ACCEPTED", actorUserId: fx5.userId,
    });
    ok("[5.2.4] legacy PENDINGの候補はFormation decisionを許可される", guardResult5.ok === true, JSON.stringify(guardResult5));

    // 破損ケース: ACCEPTEDなのにResponsibilityが存在しない(originInferenceId不一致等を想定)
    const fx5b = await makeFixture("s5bcorrupt");
    const cap5b = await makeCapture(fx5b, "破損データの候補");
    const seeded5b = await seedAiInference({ captureId: cap5b.id, candidateKey: "cCorrupt", title: "破損データの候補", decision: "ACCEPTED" });
    const session5b = await seedFormationSession(fx5b, cap5b.id, seeded5b.aiRunId, "s5b");
    const identity5b = await seedCandidate(fx5b, session5b.id, "cCorrupt", "破損データの候補");
    const guardResult5b = await recordCandidateDecision({
      sessionId: session5b.id, workspaceId: fx5b.workspaceId, candidateId: identity5b.id, expectedRevision: 1, decision: "ACCEPTED", actorUserId: fx5b.userId,
    });
    ok(
      "[5.2.5] legacy ACCEPTEDなのにResponsibilityが見つからない(破損)場合はLEGACY_PROJECTION_CONFLICT",
      guardResult5b.ok === false && guardResult5b.error === "LEGACY_PROJECTION_CONFLICT",
      JSON.stringify(guardResult5b),
    );

    // resolveLegacyProjectionMapの直接検証(tenant境界含む)
    const legacyMap3 = await resolveLegacyProjectionMap(db as any, { sessionId: session3.id, workspaceId: fx3.workspaceId });
    ok("[5.2.6] resolveLegacyProjectionMapがcandidateKey経由で正しいinferenceIdへ解決する", legacyMap3?.byCandidateKey.get("cShared")?.inferenceId === seeded3.inferenceId);
    const crossTenantMap = await resolveLegacyProjectionMap(db as any, { sessionId: session3.id, workspaceId: fx4.workspaceId });
    ok("[5.2.6] workspaceを跨いだ照合は行われない(別workspaceIdではsession自体が見つからずnull)", crossTenantMap === null);

    // ============================================================
    // 5.3 Partial confirm
    // ============================================================
    const fx6 = await makeFixture("s6partial");
    const cap6 = await makeCapture(fx6, "A/B");
    const session6 = await seedFormationSession(fx6, cap6.id, null, "s6");
    const cand6A = await seedCandidate(fx6, session6.id, "A", "Aを実施する");
    const cand6B = await seedCandidate(fx6, session6.id, "B", "Bを実施する");

    const dec6A = await recordCandidateDecision({ sessionId: session6.id, workspaceId: fx6.workspaceId, candidateId: cand6A.id, expectedRevision: 1, decision: "ACCEPTED", actorUserId: fx6.userId });
    ok("[5.3前提] AのACCEPTED成功", dec6A.ok === true);
    const session6v1 = await db.formationSession.findUniqueOrThrow({ where: { id: session6.id } });
    const mat6a = await materialize({ sessionId: session6.id, workspaceId: fx6.workspaceId, operationId: "op-s6-a", expectedVersion: session6v1.version, actorUserId: fx6.userId });
    ok("[5.3.1] A acceptedのみでmaterialize: 1件生成", mat6a.ok === true && mat6a.items.length === 1, JSON.stringify(mat6a));
    const session6v2 = await db.formationSession.findUniqueOrThrow({ where: { id: session6.id } });
    ok("[5.3.1] Bがpendingのまま残るためSession=PARTIALLY_CONFIRMED", session6v2.state === "PARTIALLY_CONFIRMED", session6v2.state);

    const dec6B = await recordCandidateDecision({ sessionId: session6.id, workspaceId: fx6.workspaceId, candidateId: cand6B.id, expectedRevision: 1, decision: "ACCEPTED", actorUserId: fx6.userId });
    ok("[5.3.2前提] BのACCEPTED成功(pendingあるためSessionはPARTIALLY_CONFIRMEDのまま許可)", dec6B.ok === true, JSON.stringify(dec6B));
    const session6v3 = await db.formationSession.findUniqueOrThrow({ where: { id: session6.id } });
    const mat6b = await materialize({ sessionId: session6.id, workspaceId: fx6.workspaceId, operationId: "op-s6-b", expectedVersion: session6v3.version, actorUserId: fx6.userId });
    ok("[5.3.2・B31-07解消の核心] 2回目materialize(Bのみ)が成功しBだけ1件生成、Aは再生成されない", mat6b.ok === true && mat6b.items.length === 1, JSON.stringify(mat6b));
    const session6v4 = await db.formationSession.findUniqueOrThrow({ where: { id: session6.id } });
    ok("[5.3.2] pending=0となりSession=CONFIRMED", session6v4.state === "CONFIRMED", session6v4.state);
    const totalResp6 = await db.materializationReceiptItem.count({ where: { workspaceId: fx6.workspaceId, candidateId: { in: [cand6A.id, cand6B.id] } } });
    ok("[5.3.2] Responsibility総数2(A,Bそれぞれ1件ずつ、二重生成なし)", totalResp6 === 2, `count=${totalResp6}`);

    const fx7 = await makeFixture("s7finalize");
    const cap7 = await makeCapture(fx7, "A/B2");
    const session7 = await seedFormationSession(fx7, cap7.id, null, "s7");
    const cand7A = await seedCandidate(fx7, session7.id, "A", "Aを実施する");
    const cand7B = await seedCandidate(fx7, session7.id, "B", "Bを却下する");
    await recordCandidateDecision({ sessionId: session7.id, workspaceId: fx7.workspaceId, candidateId: cand7A.id, expectedRevision: 1, decision: "ACCEPTED", actorUserId: fx7.userId });
    const session7v1 = await db.formationSession.findUniqueOrThrow({ where: { id: session7.id } });
    const mat7a = await materialize({ sessionId: session7.id, workspaceId: fx7.workspaceId, operationId: "op-s7-a", expectedVersion: session7v1.version, actorUserId: fx7.userId });
    ok("[5.3.3前提] Aのmaterialize成功", mat7a.ok === true && mat7a.items.length === 1);
    await recordCandidateDecision({ sessionId: session7.id, workspaceId: fx7.workspaceId, candidateId: cand7B.id, expectedRevision: 1, decision: "REJECTED", actorUserId: fx7.userId });
    const session7v2 = await db.formationSession.findUniqueOrThrow({ where: { id: session7.id } });
    const mat7b = await materialize({ sessionId: session7.id, workspaceId: fx7.workspaceId, operationId: "op-s7-finalize", expectedVersion: session7v2.version, actorUserId: fx7.userId });
    ok("[5.3.3] Bがrejectedでpending=0、過去materialized>0のため0-item finalizeが成功する", mat7b.ok === true && mat7b.items.length === 0, JSON.stringify(mat7b));
    const session7v3 = await db.formationSession.findUniqueOrThrow({ where: { id: session7.id } });
    ok("[5.3.3] finalize後Session=CONFIRMED", session7v3.state === "CONFIRMED", session7v3.state);
    const totalResp7 = await db.materializationReceiptItem.count({ where: { workspaceId: fx7.workspaceId, candidateId: { in: [cand7A.id, cand7B.id] } } });
    ok("[5.3.3] Responsibility総数は1のまま(finalizeで増えない)", totalResp7 === 1, `count=${totalResp7}`);

    const fx8 = await makeFixture("s8allrejected");
    const cap8 = await makeCapture(fx8, "C");
    const session8 = await seedFormationSession(fx8, cap8.id, null, "s8");
    const cand8C = await seedCandidate(fx8, session8.id, "C", "Cを却下する");
    await recordCandidateDecision({ sessionId: session8.id, workspaceId: fx8.workspaceId, candidateId: cand8C.id, expectedRevision: 1, decision: "REJECTED", actorUserId: fx8.userId });
    const session8v1 = await db.formationSession.findUniqueOrThrow({ where: { id: session8.id } });
    const mat8 = await materialize({ sessionId: session8.id, workspaceId: fx8.workspaceId, operationId: "op-s8", expectedVersion: session8v1.version, actorUserId: fx8.userId });
    ok("[5.3.4] 全candidate rejected・materialized 0のfinalizeはNO_ACCEPTED_CANDIDATES(CONFIRMEDにならない)", mat8.ok === false && mat8.error === "NO_ACCEPTED_CANDIDATES", JSON.stringify(mat8));
    const session8v2 = await db.formationSession.findUniqueOrThrow({ where: { id: session8.id } });
    ok("[5.3.4] SessionはCONFIRMEDにならない", session8v2.state !== "CONFIRMED", session8v2.state);

    // cross-operation BLOCKS(priorReceiptItems、当時到達不能だったコードが今は機能する)
    const fx9 = await makeFixture("s9crossblocks");
    const cap9 = await makeCapture(fx9, "A/B blocks");
    const session9 = await seedFormationSession(fx9, cap9.id, null, "s9");
    const cand9A = await seedCandidate(fx9, session9.id, "A", "Aを実施する");
    const cand9B = await seedCandidate(fx9, session9.id, "B", "Bを実施する", ["A"]);
    await recordCandidateDecision({ sessionId: session9.id, workspaceId: fx9.workspaceId, candidateId: cand9A.id, expectedRevision: 1, decision: "ACCEPTED", actorUserId: fx9.userId });
    const session9v1 = await db.formationSession.findUniqueOrThrow({ where: { id: session9.id } });
    const mat9a = await materialize({ sessionId: session9.id, workspaceId: fx9.workspaceId, operationId: "op-s9-a", expectedVersion: session9v1.version, actorUserId: fx9.userId });
    ok("[5.3.7前提] Aのmaterialize成功", mat9a.ok === true && mat9a.items.length === 1);
    await recordCandidateDecision({ sessionId: session9.id, workspaceId: fx9.workspaceId, candidateId: cand9B.id, expectedRevision: 1, decision: "ACCEPTED", actorUserId: fx9.userId });
    const session9v2 = await db.formationSession.findUniqueOrThrow({ where: { id: session9.id } });
    const mat9b = await materialize({ sessionId: session9.id, workspaceId: fx9.workspaceId, operationId: "op-s9-b", expectedVersion: session9v2.version, actorUserId: fx9.userId });
    ok("[5.3.7] 2回目materialize(Bのみ)が成功する", mat9b.ok === true && mat9b.items.length === 1, JSON.stringify(mat9b));
    if (mat9a.ok && mat9b.ok) {
      const relations9 = await db.responsibilityRelation.findMany({
        where: { fromId: mat9a.items[0].responsibilityId, toId: mat9b.items[0].responsibilityId, relationType: "BLOCKS" },
      });
      ok("[5.3.7・B4.1新設priorReceiptItemsの実証] 別operationIdを跨いだBLOCKS Relation(A→B)が1件だけ生成される", relations9.length === 1, `count=${relations9.length}`);
    }

    ok(
      "[非課金guard] scenario実行中、AI provider hostへの通信試行は0件(self-test自身の既知の1件を除く)",
      denyGuard.deniedCallAttempts.length === deniedBaseline,
      `total=${denyGuard.deniedCallAttempts.length}`,
    );
  } finally {
    const { db: dbForCleanup } = await import("../app/src/lib/db");
    const cleanupErrors: { step: string; error: unknown }[] = [];
    for (const uid of userIds) {
      const result = await cleanupFormationVerifyUser(dbForCleanup, uid);
      cleanupErrors.push(...result.errors);
    }
    ok("[cleanup] cleanup処理中に例外が0件である", cleanupErrors.length === 0, cleanupErrors.map((e) => e.step).join(","));
    const leftover = await assertNoLeftoverFormationVerifyUsers(dbForCleanup, EMAIL_PREFIX);
    ok("[cleanup] cleanup後、test prefixのUserが0件である", leftover.clean, leftover.remainingUserIds.join(","));
  }

  denyGuard.restore();

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
