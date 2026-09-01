#!/usr/bin/env node
/**
 * scripts/verify_gate_m1b6c4_3_retry_orchestration.ts
 *
 * Gate M1-B6C-4 §6.3(retry orchestration)の非課金DB受入証跡。
 * 出典: Claude向け ISMAY c503e72以降 M1-B6C・全残件連続実装指示(2026-08-31) §6.3。
 *
 * AI providerへの実通信は一切行わない(aiNetworkDenyGuard必須)。実際の
 * Job→aiExtractJob.ts→runExtractionForCapture→AI Provider呼出しの経路は検証せず
 * (実Provider呼出しを要するため)、次の2段に分けて非課金で検証する:
 *   A) orchestrateRetryAnalysis/reconcileStuckRetryOrchestrations(Job冪等投入)
 *   B) attachToSessionId(shadowWrite.ts/shadowCheckpoint.ts、同一Sessionへの
 *      新analysis attempt追記)を、既存M1-B6C-1と同じDB fixture直接investigateパターンで検証
 *
 * 実行方法:
 *   cd ~/projects/ismay/app
 *   npx tsx ../scripts/verify_gate_m1b6c4_3_retry_orchestration.ts
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
const EMAIL_PREFIX = "gate-m1b6c4-3-retry-verify-";

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
  if (!guardSelfTestPassed) {
    denyGuard.restore();
    console.log(`\n合計: ${passed} passed, ${failed} failed`);
    process.exitCode = 1;
    return;
  }

  const { db } = await import("../app/src/lib/db");
  const { orchestrateRetryAnalysis, reconcileStuckRetryOrchestrations } = await import("../app/src/lib/formation/retryOrchestration");
  const { createShadowCheckpoint, processShadowCheckpoint } = await import("../app/src/lib/formation/shadowCheckpoint");

  const orphans = await db.user.findMany({
    where: { email: { startsWith: EMAIL_PREFIX, endsWith: "@example.invalid" } },
    select: { id: true },
  });
  if (orphans.length > 0) {
    console.log(`[SWEEP] 過去実行の孤立テストユーザー${orphans.length}件を削除します...`);
    for (const o of orphans) {
      await cleanupFormationVerifyUser(db, o.id);
    }
  }

  const userIds: string[] = [];

  async function makeFixture(suffix: string) {
    const email = `${EMAIL_PREFIX}${RUN_ID}-${suffix}@example.invalid`;
    const user = await db.user.create({
      data: { email, passwordHash: "not-a-real-hash-for-db-only-test", displayName: `Gate M1-B6C-4-3 ${suffix}` },
    });
    const workspace = await db.workspace.create({ data: { name: `Gate M1-B6C-4-3 Workspace ${suffix}` } });
    await db.workspaceMember.create({ data: { workspaceId: workspace.id, userId: user.id, role: "OWNER" } });
    const domain = await db.domain.create({ data: { workspaceId: workspace.id, name: "個人", kind: "PERSONAL" } });
    userIds.push(user.id);
    return { userId: user.id, workspaceId: workspace.id, domainId: domain.id };
  }

  function candidatePayload(candidateId: string) {
    return {
      candidateId,
      type: "TASK",
      title: "資料を送付する",
      evidenceSpans: [{ start: 0, end: 5 }],
      confidence: 0.8,
      dateMentions: [],
      unknowns: [],
      blockedByCandidateIds: [],
      suggestedTags: [],
      clarificationSignals: [],
    };
  }

  try {
    // ============================================================
    // A: orchestrateRetryAnalysis — FAILED Captureを冪等にQUEUEDへ戻し、
    //    AI_EXTRACT Jobをpayload.attachToSessionId付きで作成する。
    // ============================================================
    let sessionIdA = "";
    let captureIdA = "";
    {
      const fx = await makeFixture("a");
      const capture = await db.capture.create({
        data: { workspaceId: fx.workspaceId, domainId: fx.domainId, createdById: fx.userId, sourceType: "TEXT", rawText: "資料を送付する", processingStatus: "FAILED" },
      });
      const session = await db.formationSession.create({
        data: { workspaceId: fx.workspaceId, domainId: fx.domainId, subjectUserId: fx.userId, captureId: capture.id, clientSessionKey: "retry-a", state: "ANALYZING" },
      });
      sessionIdA = session.id;
      captureIdA = capture.id;

      const result = await orchestrateRetryAnalysis({ sessionId: session.id, workspaceId: fx.workspaceId });
      ok("[A.1・非課金受入] orchestrateRetryAnalysisが成功しqueued=trueを返す", result.ok === true && result.ok && result.queued === true, JSON.stringify(result));

      const captureAfter = await db.capture.findUniqueOrThrow({ where: { id: capture.id } });
      ok("[A.2] Capture.processingStatusがFAILED→QUEUEDへ戻る", captureAfter.processingStatus === "QUEUED", captureAfter.processingStatus);
      ok("[A.3] Capture.versionがincrementされる", captureAfter.version === capture.version + 1, String(captureAfter.version));

      const job = await db.job.findFirst({ where: { jobType: "AI_EXTRACT", aggregateId: capture.id } });
      ok("[A.4・是正の核心] AI_EXTRACT Jobが作成される", !!job, JSON.stringify(job));
      ok("[A.5] Job.sourceVersionが新Capture.versionと一致する", job?.sourceVersion === captureAfter.version, String(job?.sourceVersion));
      ok(
        "[A.6・是正の核心] Job.payload.attachToSessionIdが対象Session IDを指す(同一Session追記のための橋渡し)",
        (job?.payload as { attachToSessionId?: string } | null)?.attachToSessionId === session.id,
        JSON.stringify(job?.payload),
      );
    }

    // ============================================================
    // B: orchestrateRetryAnalysis冪等性 — Captureが既にFAILED以外(QUEUED)なら
    //    二重投入しない。
    // ============================================================
    {
      const result = await orchestrateRetryAnalysis({ sessionId: sessionIdA, workspaceId: (await db.formationSession.findUniqueOrThrow({ where: { id: sessionIdA } })).workspaceId });
      ok("[B.1・冪等性] 既にQUEUEDのCaptureへの再呼出しはqueued=falseで成功する(二重投入しない)", result.ok === true && result.ok && result.queued === false, JSON.stringify(result));
      const jobCount = await db.job.count({ where: { jobType: "AI_EXTRACT", aggregateId: captureIdA } });
      ok("[B.2] Jobは依然1件のまま(重複作成なし)", jobCount === 1, String(jobCount));
    }

    // ============================================================
    // C: reconcileStuckRetryOrchestrations — 「RETRY lifecycle eventがあり
    //    Session=ANALYZINGだがCaptureはFAILEDのまま」を検出して自動的に
    //    orchestrateRetryAnalysisを再試行する。
    // ============================================================
    {
      const fx = await makeFixture("c");
      const capture = await db.capture.create({
        data: { workspaceId: fx.workspaceId, domainId: fx.domainId, createdById: fx.userId, sourceType: "TEXT", rawText: "資料を送付する", processingStatus: "FAILED" },
      });
      const session = await db.formationSession.create({
        data: { workspaceId: fx.workspaceId, domainId: fx.domainId, subjectUserId: fx.userId, captureId: capture.id, clientSessionKey: "retry-c", state: "ANALYZING" },
      });
      // orchestrateRetryAnalysisをまだ一度も呼んでいない「Job投入がまだ完了して
      // いない」状態を模すため、RETRY lifecycle eventだけ直接seedする
      // (実際にはretryFormationSession経由で作られる行だが、ここでは
      // reconciliationの検出条件だけを単体で検証する)。
      await db.formationSessionLifecycleEvent.create({
        data: {
          workspaceId: fx.workspaceId,
          sessionId: session.id,
          clientEventId: `lifecycle-${RUN_ID}-c`,
          requestHash: "test-hash",
          action: "RETRY",
          fromState: "FAILED",
          toState: "ANALYZING",
          actorUserId: fx.userId,
        },
      });

      const { reconciled } = await reconcileStuckRetryOrchestrations();
      ok("[C.1・是正の核心] reconcileStuckRetryOrchestrationsが1件以上検出・再試行する", reconciled >= 1, String(reconciled));

      const captureAfter = await db.capture.findUniqueOrThrow({ where: { id: capture.id } });
      ok("[C.2] reconciliation後、CaptureがQUEUEDへ戻っている", captureAfter.processingStatus === "QUEUED", captureAfter.processingStatus);
      const job = await db.job.findFirst({ where: { jobType: "AI_EXTRACT", aggregateId: capture.id } });
      ok("[C.3] reconciliation後、AI_EXTRACT Jobが作成されている", !!job);

      // 2回目のreconcile呼出しでは、もうFAILEDではないため検出対象から外れる
      // (無限に同じsessionを再試行し続けない)。
      const { reconciled: reconciledAgain } = await reconcileStuckRetryOrchestrations();
      const stillTargeted = await db.formationSessionLifecycleEvent.findFirst({
        where: { action: "RETRY", sessionId: session.id, session: { capture: { processingStatus: "FAILED" } } },
      });
      ok("[C.4] 解消後は同じSessionが検出対象から外れる(無限再試行しない)", stillTargeted === null, String(reconciledAgain));
    }

    // ============================================================
    // D: attachToSessionId(同一Sessionへの新analysis attempt追記)。
    //    既存ANALYZING Session(retryFormationSession後を模す、候補0件)へ、
    //    新AiRun/AiInferenceの結果をshadow checkpoint経由で追記する。
    // ============================================================
    let attachSessionId = "";
    let attachCaptureId = "";
    {
      const fx = await makeFixture("d");
      const capture = await db.capture.create({
        data: { workspaceId: fx.workspaceId, domainId: fx.domainId, createdById: fx.userId, sourceType: "TEXT", rawText: "資料を送付する", processingStatus: "PROCESSING" },
      });
      attachCaptureId = capture.id;
      const session = await db.formationSession.create({
        data: { workspaceId: fx.workspaceId, domainId: fx.domainId, subjectUserId: fx.userId, captureId: capture.id, clientSessionKey: "retry-d", state: "ANALYZING", questionCount: 0 },
      });
      attachSessionId = session.id;
      // retryFormationSession経由で作られるはずのFORMATION_CREATED等の既存Eventを
      // 1件だけ模してseedし、sequence継続の検証材料にする。
      await db.formationSessionEvent.create({
        data: { workspaceId: fx.workspaceId, sessionId: session.id, sequence: 1, eventType: "FORMATION_CREATED", actorType: "SYSTEM", payload: { captureId: capture.id } },
      });

      const aiRun = await db.aiRun.create({
        data: { captureId: capture.id, workspaceId: fx.workspaceId, provider: "test", model: "test", promptVersion: "v", schemaVersion: "v", status: "SUCCEEDED" },
      });
      const candidateId = `cand-${RUN_ID}-d`;
      await db.aiInference.create({
        data: { captureId: capture.id, aiRunId: aiRun.id, inferenceType: "RESPONSIBILITY", payload: candidatePayload(candidateId), evidenceSpans: [{ start: 0, end: 5 }], confidence: 0.8, decision: "PENDING" },
      });

      const checkpoint = await db.$transaction((tx: any) =>
        createShadowCheckpoint(tx, { workspaceId: fx.workspaceId, captureId: capture.id, aiRunId: aiRun.id, schemaVersion: "v", candidateCount: 1, attachToSessionId: session.id }),
      );
      const outcome = await processShadowCheckpoint(checkpoint.id);
      ok("[D.1] attach modeのshadow書込みはSUCCEEDEDになる", outcome === "SUCCEEDED", outcome);

      const sessionCount = await db.formationSession.count({ where: { captureId: capture.id } });
      ok("[D.2・是正の核心] 新規FormationSessionは作られず、このCaptureのSessionは1件のまま(重複作成防止)", sessionCount === 1, String(sessionCount));

      const events = await db.formationSessionEvent.findMany({ where: { sessionId: session.id }, orderBy: { sequence: "asc" } });
      ok("[D.3] Event sequenceが既存(1)の続きから振られる(重複しない)", events.every((e: any, i: number) => e.sequence === i + 1), JSON.stringify(events.map((e: any) => e.sequence)));
      ok("[D.4] 既存のFORMATION_CREATED Eventは失われていない", events.some((e: any) => e.eventType === "FORMATION_CREATED"));
      ok("[D.5] 新しいANALYSIS_REQUESTED Eventが追記される", events.some((e: any) => e.eventType === "ANALYSIS_REQUESTED"));

      const candidateCount = await db.formationCandidateIdentity.count({ where: { sessionId: session.id } });
      ok("[D.6] 新candidateがこのSessionへ追加される", candidateCount === 1, String(candidateCount));

      const sessionAfter = await db.formationSession.findUniqueOrThrow({ where: { id: session.id } });
      ok("[D.7] Sessionは REVIEW_READY または CLARIFYING へ遷移する(ANALYZINGのまま止まらない)", sessionAfter.state === "REVIEW_READY" || sessionAfter.state === "CLARIFYING", sessionAfter.state);
    }

    // ============================================================
    // E: attach fail-closed — 対象Sessionが存在しない/ANALYZING以外の場合、
    //    候補を捏造して書き込まずRETRY_WAIT/DEAD_LETTERで失敗する。
    // ============================================================
    {
      const fx = await makeFixture("e");
      const capture = await db.capture.create({
        data: { workspaceId: fx.workspaceId, domainId: fx.domainId, createdById: fx.userId, sourceType: "TEXT", rawText: "資料を送付する", processingStatus: "PROCESSING" },
      });
      // REVIEW_READY(ANALYZING以外)のSessionへattachしようとする。
      const wrongStateSession = await db.formationSession.create({
        data: { workspaceId: fx.workspaceId, domainId: fx.domainId, subjectUserId: fx.userId, captureId: capture.id, clientSessionKey: "retry-e", state: "REVIEW_READY" },
      });
      const aiRun = await db.aiRun.create({
        data: { captureId: capture.id, workspaceId: fx.workspaceId, provider: "test", model: "test", promptVersion: "v", schemaVersion: "v", status: "SUCCEEDED" },
      });
      await db.aiInference.create({
        data: { captureId: capture.id, aiRunId: aiRun.id, inferenceType: "RESPONSIBILITY", payload: candidatePayload(`cand-${RUN_ID}-e`), evidenceSpans: [{ start: 0, end: 5 }], confidence: 0.8, decision: "PENDING" },
      });
      const checkpoint = await db.$transaction((tx: any) =>
        createShadowCheckpoint(tx, { workspaceId: fx.workspaceId, captureId: capture.id, aiRunId: aiRun.id, schemaVersion: "v", candidateCount: 1, attachToSessionId: wrongStateSession.id }),
      );
      const outcome = await processShadowCheckpoint(checkpoint.id);
      ok("[E.1・捏造しない] ANALYZING以外のSessionへのattachはRETRY_WAITで失敗する(候補を書き込まない)", outcome === "RETRY_WAIT", outcome);
      const candidateCount = await db.formationCandidateIdentity.count({ where: { sessionId: wrongStateSession.id } });
      ok("[E.2] 失敗時、候補は1件も追加されない", candidateCount === 0, String(candidateCount));
    }

    // ============================================================
    // F: attach idempotent replay — 既にANALYSIS_REQUESTED Eventが記録済みの
    //    aiRunIdへの再処理は、候補を重複させずSUCCEEDEDへ収束する。
    // ============================================================
    {
      const outcome = await processShadowCheckpoint((await db.formationShadowCheckpoint.findFirstOrThrow({ where: { captureId: attachCaptureId } })).id);
      // 既にSUCCEEDED状態のcheckpointはclaim対象外(PENDING/RETRY_WAITのみclaim
      // できる)ため、再claim不能を確認する形でidempotencyの土台を確認する。
      ok("[F.1] 既にSUCCEEDED済みのcheckpointは再claimできない(NOT_CLAIMABLE)", outcome === "NOT_CLAIMABLE", outcome);
      const candidateCount = await db.formationCandidateIdentity.count({ where: { sessionId: attachSessionId } });
      ok("[F.2] 再処理を試みても候補は重複しない(1件のまま)", candidateCount === 1, String(candidateCount));
    }
  } catch (err) {
    failed++;
    failures.push(`予期しない例外: ${String(err)}`);
    console.error(err);
  }

  for (const uid of userIds) {
    const result = await cleanupFormationVerifyUser(db, uid);
    if (result.errors.length > 0) {
      failed++;
      failures.push(`cleanup失敗(userId=${uid}): ${JSON.stringify(result.errors)}`);
    }
  }
  const leftover = await assertNoLeftoverFormationVerifyUsers(db, EMAIL_PREFIX);
  ok("[cleanup] test用Userが1件も残っていない", leftover.clean, JSON.stringify(leftover.remainingUserIds));

  denyGuard.restore();
  console.log(`\n合計: ${passed} passed, ${failed} failed`);
  if (failed > 0) {
    console.log("\n失敗一覧:");
    for (const f of failures) console.log(`  - ${f}`);
    process.exitCode = 1;
  }
}

main().catch((err) => {
  console.error("[FATAL]", err);
  process.exitCode = 1;
});
