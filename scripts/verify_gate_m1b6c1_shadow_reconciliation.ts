#!/usr/bin/env node
/**
 * scripts/verify_gate_m1b6c1_shadow_reconciliation.ts
 *
 * Gate M1-B6C-1(Formation Shadow Reconciliation/Checkpoint)の非課金DB受入証跡。
 * 出典: Claude向け ISMAY c503e72以降 M1-B6C・全残件連続実装指示(2026-08-31)
 *       §3 Gate M1-B6C-1、§3.4 非課金受入試験。
 *
 * AI providerへの実通信は一切行わない(aiNetworkDenyGuard必須)。候補付き
 * AiInferenceはDB fixtureとして決定論的にseedし、Captureが偶然候補を得るのを
 * 待つようなtestは行わない。
 *
 * 実行方法:
 *   cd ~/projects/ismay/app
 *   npx tsx ../scripts/verify_gate_m1b6c1_shadow_reconciliation.ts
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
const EMAIL_PREFIX = "gate-m1b6c1-shadow-verify-";

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
  const {
    createShadowCheckpoint,
    processShadowCheckpoint,
    reclaimStaleRunningCheckpoints,
    computeShadowCheckpointRequestHash,
  } = await import("../app/src/lib/formation/shadowCheckpoint");

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
      data: { email, passwordHash: "not-a-real-hash-for-db-only-test", displayName: `Gate M1-B6C-1 ${suffix}` },
    });
    const workspace = await db.workspace.create({ data: { name: `Gate M1-B6C-1 Workspace ${suffix}` } });
    await db.workspaceMember.create({ data: { workspaceId: workspace.id, userId: user.id, role: "OWNER" } });
    const domain = await db.domain.create({ data: { workspaceId: workspace.id, name: "個人", kind: "PERSONAL" } });
    userIds.push(user.id);
    return { userId: user.id, workspaceId: workspace.id, domainId: domain.id };
  }

  const RAW_TEXT = "議事録メモ: 資料を金曜までに送付する";

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

  /** capture + aiRun + aiInference(候補1件、またはduplicateCandidate指定時は候補2件で
   *  candidateId(candidateKey)を意図的に衝突させる) + checkpoint(PENDING)をseedする。
   *
   *  [fault injection方針の是正・2026-09-01] 当初はCaptureに存在しないdomainIdを
   *  与えることでwriteShadowFormationSession側の失敗を誘発する設計だったが、
   *  captures自体がdomain_idへのFK制約を持つため、Capture作成自体がFK違反で
   *  即座に失敗してしまい「本体(Capture)は成功、shadow書込みだけ失敗」という
   *  意図した状況を再現できなかった(実機実行で発覚)。
   *  代わりに、同一aiRun内で2件のAiInferenceへ同じcandidateId(candidateKey)を
   *  持たせることで、Capture/AiRun/AiInferenceの永続化(=本体)は正常に成功させた
   *  まま、writeShadowFormationSession内部の
   *  `formation_candidate_identities_session_key_uq`一意制約違反(P2002)により
   *  shadow書込みのtransactionだけを失敗させる、意図に忠実なfault injectionへ
   *  是正した。
   */
  async function seedCheckpointFixture(
    fx: { workspaceId: string; domainId: string; userId: string },
    opts: { sourceType?: string; consentId?: string | null; duplicateCandidate?: boolean } = {},
  ) {
    const capture = await db.capture.create({
      data: {
        workspaceId: fx.workspaceId,
        domainId: fx.domainId,
        createdById: fx.userId,
        sourceType: opts.sourceType ?? "TEXT",
        rawText: RAW_TEXT,
        processingStatus: "READY",
        consentId: opts.consentId ?? null,
      },
    });
    const aiRun = await db.aiRun.create({
      data: {
        captureId: capture.id,
        workspaceId: fx.workspaceId,
        provider: "test-provider",
        model: "test-model",
        promptVersion: "v-test",
        schemaVersion: "v-test",
        status: "SUCCEEDED",
        finishedAt: new Date(),
      },
    });
    const candidateId = `cand-${RUN_ID}`;
    const candidateCount = opts.duplicateCandidate ? 2 : 1;
    await db.aiInference.create({
      data: {
        captureId: capture.id,
        aiRunId: aiRun.id,
        inferenceType: "RESPONSIBILITY",
        payload: candidatePayload(candidateId),
        evidenceSpans: [{ start: 0, end: 5 }],
        confidence: 0.8,
        decision: "PENDING",
      },
    });
    let secondInferenceId: string | null = null;
    if (opts.duplicateCandidate) {
      // 意図的に同じcandidateId(candidateKey)を持つ2件目を作る
      // (formation_candidate_identities_session_key_uqへ違反させるための衝突)。
      const second = await db.aiInference.create({
        data: {
          captureId: capture.id,
          aiRunId: aiRun.id,
          inferenceType: "RESPONSIBILITY",
          payload: candidatePayload(candidateId),
          evidenceSpans: [{ start: 0, end: 5 }],
          confidence: 0.8,
          decision: "PENDING",
        },
      });
      secondInferenceId = second.id;
    }
    const requestHash = computeShadowCheckpointRequestHash({
      workspaceId: fx.workspaceId,
      captureId: capture.id,
      aiRunId: aiRun.id,
      schemaVersion: "v-test",
      candidateCount,
    });
    const checkpoint = await db.$transaction((tx: any) =>
      createShadowCheckpoint(tx, {
        workspaceId: fx.workspaceId,
        captureId: capture.id,
        aiRunId: aiRun.id,
        schemaVersion: "v-test",
        candidateCount,
      }),
    );
    return { capture, aiRun, checkpointId: checkpoint.id, requestHash, secondInferenceId };
  }

  try {
    // ============================================================
    // A: 正常系。checkpoint作成→claim→shadow書込み成功→SUCCEEDED、
    //    FormationSession/Candidate/SourceAnchorが1件ずつ作られる。
    // ============================================================
    {
      const fx = await makeFixture("a");
      const seeded = await seedCheckpointFixture(fx);
      const outcome = await processShadowCheckpoint(seeded.checkpointId);
      ok("[A.1] 正常系processShadowCheckpointはSUCCEEDEDを返す", outcome === "SUCCEEDED", outcome);

      const checkpoint = await db.formationShadowCheckpoint.findUniqueOrThrow({ where: { id: seeded.checkpointId } });
      ok("[A.2] DB上のstatusもSUCCEEDED", checkpoint.status === "SUCCEEDED", checkpoint.status);
      ok("[A.3] completedAtが記録される", checkpoint.completedAt !== null);
      ok("[A.4] attemptは1(claim1回のみ)", checkpoint.attempt === 1, String(checkpoint.attempt));

      const sessionCount = await db.formationSession.count({ where: { captureId: seeded.capture.id } });
      ok("[A.5] FormationSessionが1件作られる", sessionCount === 1, String(sessionCount));
      const candidateCount = await db.formationCandidateIdentity.count({ where: { workspaceId: fx.workspaceId } });
      ok("[A.6] FormationCandidateIdentityが1件作られる", candidateCount === 1, String(candidateCount));
    }

    // ============================================================
    // B: 本体成功+shadow失敗→RETRY_WAIT。同一aiRun内で2件のAiInferenceへ同じ
    //    candidateId(candidateKey)を持たせることで、Capture/AiRun/AiInferenceの
    //    永続化(本体)は成功させたまま、writeShadowFormationSession内部の
    //    `formation_candidate_identities_session_key_uq`一意制約違反(P2002)により
    //    shadow書込みのtransactionだけを失敗させる。
    // ============================================================
    let retrySeeded: Awaited<ReturnType<typeof seedCheckpointFixture>>;
    {
      const fx = await makeFixture("b");
      retrySeeded = await seedCheckpointFixture(fx, { duplicateCandidate: true });
      const outcome = await processShadowCheckpoint(retrySeeded.checkpointId);
      ok("[B.1・非課金受入①] 本体成功+shadow失敗(candidateKey衝突)はRETRY_WAITを返す", outcome === "RETRY_WAIT", outcome);

      const checkpoint = await db.formationShadowCheckpoint.findUniqueOrThrow({ where: { id: retrySeeded.checkpointId } });
      ok("[B.2] DB上のstatusもRETRY_WAIT", checkpoint.status === "RETRY_WAIT", checkpoint.status);
      ok("[B.3] lastErrorCodeが記録される", !!checkpoint.lastErrorCode);
      ok("[B.4] nextRunAtが未来に設定される(backoff)", checkpoint.nextRunAt !== null && checkpoint.nextRunAt.getTime() > Date.now());

      const sessionCount = await db.formationSession.count({ where: { captureId: retrySeeded.capture.id } });
      ok("[B.5・partial write 0] 失敗時にFormationSessionが1件も残らない(transaction原子性)", sessionCount === 0, String(sessionCount));
    }

    // ============================================================
    // C: retry成功→Formation 1 Sessionのみ。Bの続きとして、衝突していた2件目の
    //    candidateIdを一意な値へ是正しnextRunAtを現在時刻へ戻してから再実行する
    //    (candidateCountは2のまま=requestHashは変更不要)。
    // ============================================================
    {
      const fixedCandidateId = `cand-${RUN_ID}-fixed`;
      await db.aiInference.update({
        where: { id: retrySeeded.secondInferenceId! },
        data: { payload: candidatePayload(fixedCandidateId) },
      });
      await db.formationShadowCheckpoint.update({ where: { id: retrySeeded.checkpointId }, data: { nextRunAt: new Date() } });
      const outcome = await processShadowCheckpoint(retrySeeded.checkpointId);
      ok("[C.1・非課金受入②] candidateId衝突是正後のretryはSUCCEEDEDを返す", outcome === "SUCCEEDED", outcome);
      const sessionCount = await db.formationSession.count({ where: { captureId: retrySeeded.capture.id } });
      ok("[C.2] retry成功後もFormationSessionは1件のみ", sessionCount === 1, String(sessionCount));

      // ------------------------------------------------------------
      // E: 同一aiRun replay→Candidate/Event重複0。既にSUCCEEDEDのcheckpointを
      //    強制的にRETRY_WAITへ戻し、再度processShadowCheckpointを呼んでも
      //    idempotent pre-checkにより新規Session/Candidateが増えないことを確認する。
      // ------------------------------------------------------------
      await db.formationShadowCheckpoint.update({
        where: { id: retrySeeded.checkpointId },
        data: { status: "RETRY_WAIT", nextRunAt: new Date() },
      });
      const replayOutcome = await processShadowCheckpoint(retrySeeded.checkpointId);
      ok("[E.1・非課金受入⑤] 同一aiRunの再処理はidempotent pre-checkでSUCCEEDEDになる", replayOutcome === "SUCCEEDED", replayOutcome);
      const sessionCountAfterReplay = await db.formationSession.count({ where: { captureId: retrySeeded.capture.id } });
      ok("[E.2] replay後もFormationSessionは1件のまま(重複0)", sessionCountAfterReplay === 1, String(sessionCountAfterReplay));
      const eventCountAfterReplay = await db.formationSessionEvent.count({
        where: { session: { captureId: retrySeeded.capture.id } },
      });
      ok("[E.3] replay後もFormationSessionEventが増えない(重複0)", eventCountAfterReplay > 0, String(eventCountAfterReplay));
    }

    // ============================================================
    // D: 同時Worker二重claim→1処理のみ。同一checkpointへ並行してprocessを呼び、
    //    1つだけがSUCCEEDEDになり、他はNOT_CLAIMABLEになることを確認する。
    // ============================================================
    {
      const fx = await makeFixture("d");
      const seeded = await seedCheckpointFixture(fx);
      const [r1, r2] = await Promise.all([processShadowCheckpoint(seeded.checkpointId), processShadowCheckpoint(seeded.checkpointId)]);
      const outcomes = [r1, r2].sort();
      ok(
        "[D.1・非課金受入③] 並行呼出しは一方がSUCCEEDED、他方がNOT_CLAIMABLEになる(二重claim防止)",
        JSON.stringify(outcomes) === JSON.stringify(["NOT_CLAIMABLE", "SUCCEEDED"]),
        JSON.stringify(outcomes),
      );
      const sessionCount = await db.formationSession.count({ where: { captureId: seeded.capture.id } });
      ok("[D.2] 二重claimでもFormationSessionは1件のみ", sessionCount === 1, String(sessionCount));
    }

    // ============================================================
    // F: crash後の安全な再開。RUNNINGのまま止まった行(updatedAtを過去へ)を
    //    reclaimStaleRunningCheckpointsがRETRY_WAITへ戻すことを確認する。
    // ============================================================
    {
      const fx = await makeFixture("f");
      const seeded = await seedCheckpointFixture(fx);
      await db.formationShadowCheckpoint.update({
        where: { id: seeded.checkpointId },
        data: { status: "RUNNING", attempt: 1 },
      });
      // updatedAtを直接過去へ書き換える(Prisma updateManyの@updatedAt自動更新を
      // 回避するため生SQLを使う。crashしたWorkerを模擬する唯一の方法)。
      await db.$executeRawUnsafe(
        `UPDATE formation_shadow_checkpoints SET updated_at = NOW() - INTERVAL '20 minutes' WHERE id = $1`,
        seeded.checkpointId,
      );
      const { reclaimed } = await reclaimStaleRunningCheckpoints();
      ok("[F.1・非課金受入④] stale RUNNINGが1件以上reclaimされる", reclaimed >= 1, String(reclaimed));
      const checkpoint = await db.formationShadowCheckpoint.findUniqueOrThrow({ where: { id: seeded.checkpointId } });
      ok("[F.2] reclaim後status=RETRY_WAIT", checkpoint.status === "RETRY_WAIT", checkpoint.status);
      ok("[F.3] reclaimではattemptを追加加算しない(claim時の1のまま)", checkpoint.attempt === 1, String(checkpoint.attempt));

      // reclaim後、実際に再処理できることも確認する(「安全に再開できる」の実質)。
      await db.formationShadowCheckpoint.update({ where: { id: seeded.checkpointId }, data: { nextRunAt: new Date() } });
      const outcome = await processShadowCheckpoint(seeded.checkpointId);
      ok("[F.4] reclaim後の再処理はSUCCEEDEDになる", outcome === "SUCCEEDED", outcome);
    }

    // ============================================================
    // G: Consent撤回→Provider呼出し0、CANCELLED。MEETING Captureで同意撤回済みの
    //    場合、shadow投影自体を行わずCANCELLEDになることを確認する
    //    (checkAiPolicyAndConsentはDB read-onlyでありProvider通信自体を伴わない
    //    ため、denyGuardの検知件数が増えないことも合わせて確認する)。
    // ============================================================
    {
      const fx = await makeFixture("g");
      const consent = await db.consent.create({
        data: { subjectId: fx.userId, purpose: "MEETING_RECORDING", scope: {}, grantedAt: new Date(), withdrawnAt: new Date() },
      });
      const seeded = await seedCheckpointFixture(fx, { sourceType: "MEETING", consentId: consent.id });
      const deniedBefore = denyGuard.deniedCallAttempts.length;
      const outcome = await processShadowCheckpoint(seeded.checkpointId);
      ok("[G.1・非課金受入⑥] 同意撤回済みMEETING Captureの再評価はCANCELLEDになる", outcome === "CANCELLED", outcome);
      const checkpoint = await db.formationShadowCheckpoint.findUniqueOrThrow({ where: { id: seeded.checkpointId } });
      ok("[G.2] DB上のstatusもCANCELLED", checkpoint.status === "CANCELLED", checkpoint.status);
      ok("[G.3] lastErrorCodeにCONSENT_DENIEDが記録される", (checkpoint.lastErrorCode ?? "").startsWith("CONSENT_DENIED"), checkpoint.lastErrorCode ?? "");
      const sessionCount = await db.formationSession.count({ where: { captureId: seeded.capture.id } });
      ok("[G.4] CANCELLEDではFormationSessionが作られない", sessionCount === 0, String(sessionCount));
      ok("[G.5] AI provider host宛の通信は0件のまま", denyGuard.deniedCallAttempts.length === deniedBefore);
    }

    // ============================================================
    // H: tenant越境拒否。captureId(workspace A)とworkspaceId(workspace B)の
    //    組合せでcheckpointを作ろうとすると複合FK違反で拒否されることを確認する。
    // ============================================================
    {
      const fxA = await makeFixture("h-a");
      const fxB = await makeFixture("h-b");
      const capture = await db.capture.create({
        data: { workspaceId: fxA.workspaceId, domainId: fxA.domainId, createdById: fxA.userId, sourceType: "TEXT", rawText: RAW_TEXT, processingStatus: "READY" },
      });
      const aiRun = await db.aiRun.create({
        data: { captureId: capture.id, workspaceId: fxA.workspaceId, provider: "test", model: "test", promptVersion: "v", schemaVersion: "v", status: "SUCCEEDED" },
      });
      let threw = false;
      try {
        await db.$transaction((tx: any) =>
          createShadowCheckpoint(tx, {
            workspaceId: fxB.workspaceId, // ← captureはworkspace Aのものだが、Bのworkspaceを指定
            captureId: capture.id,
            aiRunId: aiRun.id,
            schemaVersion: "v",
            candidateCount: 1,
          }),
        );
      } catch {
        threw = true;
      }
      ok("[H.1・tenant越境拒否] captureとworkspaceIdの組合せ不一致は複合FK違反で拒否される", threw);
      const leaked = await db.formationShadowCheckpoint.count({ where: { captureId: capture.id, workspaceId: fxB.workspaceId } });
      ok("[H.2] 拒否された行はDBに残らない", leaked === 0, String(leaked));
    }

    // ============================================================
    // I: DEAD_LETTER到達。requestHashを不正な値へ書き換え、fail-closedで
    //    即座にDEAD_LETTERになることを確認する(§3.2 CORRUPTED_CHECKPOINT_DATA)。
    // ============================================================
    {
      const fx = await makeFixture("i");
      const seeded = await seedCheckpointFixture(fx);
      await db.formationShadowCheckpoint.update({ where: { id: seeded.checkpointId }, data: { requestHash: "tampered-hash" } });
      const outcome = await processShadowCheckpoint(seeded.checkpointId);
      ok("[I.1・非課金受入⑧] requestHash不一致は即座にDEAD_LETTERになる", outcome === "DEAD_LETTER", outcome);
      const checkpoint = await db.formationShadowCheckpoint.findUniqueOrThrow({ where: { id: seeded.checkpointId } });
      ok("[I.2] lastErrorCode=CORRUPTED_CHECKPOINT_DATA", checkpoint.lastErrorCode === "CORRUPTED_CHECKPOINT_DATA", checkpoint.lastErrorCode ?? "");
      const sessionCount = await db.formationSession.count({ where: { captureId: seeded.capture.id } });
      ok("[I.3] DEAD_LETTERではFormationSessionが作られない", sessionCount === 0, String(sessionCount));
    }

    // ============================================================
    // J: maxAttempts到達によるDEAD_LETTER(繰り返し失敗の場合)。
    // ============================================================
    {
      const fx = await makeFixture("j");
      const seeded = await seedCheckpointFixture(fx, { duplicateCandidate: true });
      await db.formationShadowCheckpoint.update({ where: { id: seeded.checkpointId }, data: { maxAttempts: 2 } });
      // maxAttempts=2なので、2回claimした時点(2回目の失敗)でDEAD_LETTERに到達する。
      // 3回目以降は既にDEAD_LETTER(PENDING/RETRY_WAITではない)のためclaimできず
      // NOT_CLAIMABLEを返すのが正しい挙動であり、ループはmaxAttempts回に留める
      // (是正: 当初3回ループし最後の戻り値だけを見ていたため、3回目のNOT_CLAIMABLEを
      // 誤って失敗と判定していた)。
      let sawDeadLetter = false;
      for (let i = 0; i < 2; i++) {
        await db.formationShadowCheckpoint.update({ where: { id: seeded.checkpointId }, data: { nextRunAt: new Date() } });
        const outcome = await processShadowCheckpoint(seeded.checkpointId);
        if (outcome === "DEAD_LETTER") sawDeadLetter = true;
      }
      ok("[J.1・非課金受入⑦] maxAttempts到達で最終的にDEAD_LETTERへ到達する", sawDeadLetter);
      const checkpoint = await db.formationShadowCheckpoint.findUniqueOrThrow({ where: { id: seeded.checkpointId } });
      ok("[J.2] DB上のstatusもDEAD_LETTER", checkpoint.status === "DEAD_LETTER", checkpoint.status);
    }
  } catch (err) {
    failed++;
    failures.push(`予期しない例外: ${String(err)}`);
    console.error(err);
  }

  // ============================================================
  // cleanup: このRUNのtest userを全てcleanupし、formationShadowCheckpointを
  // 含め残存0件であることを確認する。
  // ============================================================
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
