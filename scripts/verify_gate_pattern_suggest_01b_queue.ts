#!/usr/bin/env node
/**
 * scripts/verify_gate_pattern_suggest_01b_queue.ts
 *
 * PATTERN-SUGGEST-01B(Suggest Job Queue・generation・trigger配線)の実DB受入証跡。
 * 出典: Claude向け_ISMAY_3b695d9以降_再監査是正・CasePattern実機能完遂指示_
 * 2026-09-04.md §6 PATTERN-SUGGEST-01B。既存verify_gate_pattern_detect_01b.tsと
 * 同型(caseDetectQueue.ts→caseSuggestQueue.tsの対応)。
 *
 * このGate(queue infra)の対象はenqueue/coalesce/claim/complete/failの
 * 状態機械と、4経路(shadowWrite/answerService/mergeCorrection/
 * splitCorrection)からのenqueue配線そのもの(実際にFormationCandidateRevision
 * 作成時にジョブが1件作られるか)である。Pattern照合本体・Suggestion生成は
 * このGateのscope外(想像で先行実装しない)。
 *
 * AI providerへの実通信は行わない(installAiNetworkDenyGuardで機械的に保証)。
 *
 * 実行方法:
 *   cd ~/projects/ismay/app
 *   npx tsx ../scripts/verify_gate_pattern_suggest_01b_queue.ts
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
const EMAIL_PREFIX = "gate-pattern-suggest-01b-verify-";

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
  const {
    enqueueCaseSuggestionMatch,
    claimCaseSuggestJobs,
    completeCaseSuggestJob,
    failCaseSuggestJob,
  } = await import("../app/src/lib/patterns/caseSuggestQueue");
  // [教訓反映・ISMAY_ハンドオフ資料2026-09-05 3章] 自前でcleanup関数を書かず、
  // 既存の共有ヘルパー(FK cascade依存を正しく把握している)を再利用する。
  const { cleanupFormationVerifyUser, assertNoLeftoverFormationVerifyUsers } = await import("./lib/formationVerifyCleanup");

  const userIds: string[] = [];

  async function cleanupTestUser(userId: string): Promise<void> {
    // CasePatternSuggestJobは共有ヘルパーが知らない本Gate固有のtableのため、
    // 先にこちらだけ削除してから共有ヘルパーへ委譲する。
    await db.casePatternSuggestJob.deleteMany({ where: { ownerSubjectUserId: userId } }).catch(() => null);
    const result = await cleanupFormationVerifyUser(db, userId);
    if (result.errors.length > 0) {
      for (const e of result.errors) {
        console.log(`  [cleanup警告] step=${e.step}`, e.error);
      }
    }
  }

  const orphans = await db.user.findMany({
    where: { email: { startsWith: EMAIL_PREFIX, endsWith: "@example.invalid" } },
    select: { id: true },
  });
  if (orphans.length > 0) {
    console.log(`[SWEEP] 過去実行の孤立テストユーザー${orphans.length}件を削除します...`);
    for (const o of orphans) await cleanupTestUser(o.id);
  }

  async function makeCandidateFixture(suffix: string): Promise<{ userId: string; workspaceId: string; candidateId: string }> {
    const email = `${EMAIL_PREFIX}${RUN_ID}-${suffix}@example.invalid`;
    const user = await db.user.create({
      data: { email, passwordHash: "not-a-real-hash-for-db-only-test", displayName: `PATTERN-SUGGEST-01B ${suffix}` },
    });
    const workspace = await db.workspace.create({ data: { name: `PATTERN-SUGGEST-01B Workspace ${suffix}` } });
    await db.workspaceMember.create({ data: { workspaceId: workspace.id, userId: user.id, role: "OWNER" } });
    const domain = await db.domain.create({ data: { workspaceId: workspace.id, name: `dom-${suffix}` } });
    const capture = await db.capture.create({
      data: {
        workspaceId: workspace.id,
        domainId: domain.id,
        createdById: user.id,
        sourceType: "TEXT",
        rawText: "verify fixture",
        processingStatus: "SAVED",
        clientDraftId: `cd-${suffix}-${RUN_ID}`,
      },
    });
    const session = await db.formationSession.create({
      data: {
        workspaceId: workspace.id,
        domainId: domain.id,
        subjectUserId: user.id,
        captureId: capture.id,
        clientSessionKey: `csk-${suffix}-${RUN_ID}`,
        state: "DRAFT",
      },
    });
    const identity = await db.formationCandidateIdentity.create({
      data: { workspaceId: workspace.id, sessionId: session.id, candidateKey: "c1" },
    });
    userIds.push(user.id);
    return { userId: user.id, workspaceId: workspace.id, candidateId: identity.id };
  }

  try {
    console.log("=== PATTERN-SUGGEST-01B Queue 実DB受入試験 ===");

    // ================================================================
    // enqueue → 新規PENDING行作成
    // ================================================================
    {
      const fx = await makeCandidateFixture("enqueue");
      const result = await enqueueCaseSuggestionMatch(db, {
        workspaceId: fx.workspaceId,
        ownerSubjectUserId: fx.userId,
        candidateId: fx.candidateId,
        reasonCode: "CANDIDATE_REVISION_CREATED",
      });
      ok("[enqueue] 初回enqueueは新規行を作成する(coalesced=false)", result.coalesced === false);
      ok("[enqueue] 初回generationは1", result.generation === 1);

      // ================================================================
      // coalescing: 既存PENDING行があれば新規行を作らずgenerationを増やす
      // ================================================================
      const result2 = await enqueueCaseSuggestionMatch(db, {
        workspaceId: fx.workspaceId,
        ownerSubjectUserId: fx.userId,
        candidateId: fx.candidateId,
        reasonCode: "CANDIDATE_REVISION_CREATED",
      });
      ok("[coalescing] 2回目のenqueueはcoalesceされる(coalesced=true)", result2.coalesced === true);
      ok("[coalescing] 同一jobId", result2.id === result.id);
      ok("[coalescing] generationが2へ増加", result2.generation === 2);

      const count = await db.casePatternSuggestJob.count({
        where: { workspaceId: fx.workspaceId, candidateId: fx.candidateId },
      });
      ok("[coalescing] DB上のjob行数は1件のまま(重複行なし)", count === 1, `count=${count}`);
    }

    // ================================================================
    // claim → complete: 正常系
    // ================================================================
    {
      const fx = await makeCandidateFixture("claim");
      await enqueueCaseSuggestionMatch(db, {
        workspaceId: fx.workspaceId,
        ownerSubjectUserId: fx.userId,
        candidateId: fx.candidateId,
        reasonCode: "CANDIDATE_REVISION_CREATED",
      });

      const claimed = await claimCaseSuggestJobs(`test-worker-${RUN_ID}`, 10);
      const mine = claimed.filter((c) => c.candidateId === fx.candidateId);
      ok("[claim] enqueueした自分のjobが1件claimされる", mine.length === 1, `claimed=${mine.length}`);

      if (mine.length === 1) {
        const job = mine[0]!;
        const processing = await db.casePatternSuggestJob.findUnique({ where: { id: job.id }, select: { status: true } });
        ok("[claim] claim後の状態はPROCESSING", processing?.status === "PROCESSING");

        const completeResult = await completeCaseSuggestJob(job.id, job.generation);
        ok("[complete] generation一致時はDONEへ確定する", completeResult.status === "DONE");
        const done = await db.casePatternSuggestJob.findUnique({ where: { id: job.id }, select: { status: true } });
        ok("[complete] DB上もDONE", done?.status === "DONE");
      }
    }

    // ================================================================
    // 古いgenerationでのcomplete試行はDONEにならずPENDINGへ差し戻される
    // (caseDetectQueue.tsのPD-07と同じ設計・同じ試験)
    // ================================================================
    {
      const fx = await makeCandidateFixture("staleGen");
      await enqueueCaseSuggestionMatch(db, {
        workspaceId: fx.workspaceId,
        ownerSubjectUserId: fx.userId,
        candidateId: fx.candidateId,
        reasonCode: "CANDIDATE_REVISION_CREATED",
      });

      const claimed = await claimCaseSuggestJobs(`test-worker-staleGen-${RUN_ID}`, 10);
      const mine = claimed.filter((c) => c.candidateId === fx.candidateId);
      ok("[前提] claim成功", mine.length === 1);
      const job = mine[0]!;
      const observedGeneration = job.generation;

      const coalesceResult = await enqueueCaseSuggestionMatch(db, {
        workspaceId: fx.workspaceId,
        ownerSubjectUserId: fx.userId,
        candidateId: fx.candidateId,
        reasonCode: "CANDIDATE_REVISION_CREATED",
      });
      ok("[前提] PROCESSING中のcoalescingでgenerationが増加する", coalesceResult.generation > observedGeneration);

      const staleComplete = await completeCaseSuggestJob(job.id, observedGeneration);
      ok(
        "[古いgeneration] 古いgenerationでのcomplete試行はDONEにならずPENDINGへ差し戻される",
        staleComplete.status === "PENDING",
      );
      const afterStale = await db.casePatternSuggestJob.findUnique({ where: { id: job.id }, select: { status: true, generation: true } });
      ok("[古いgeneration] DB上もPENDINGのまま", afterStale?.status === "PENDING");
      ok("[古いgeneration] generationは増加した値を保持している", afterStale?.generation === coalesceResult.generation);

      const reclaimed = await claimCaseSuggestJobs(`test-worker-staleGenB-${RUN_ID}`, 10);
      const mineAgain = reclaimed.filter((c) => c.candidateId === fx.candidateId);
      ok("[古いgeneration] 差し戻し後は再claimできる", mineAgain.length === 1);
      if (mineAgain.length === 1) {
        const finalComplete = await completeCaseSuggestJob(mineAgain[0]!.id, mineAgain[0]!.generation);
        ok("[古いgeneration] 最新generationでのcompleteはDONEに確定する", finalComplete.status === "DONE");
      }
    }

    // ================================================================
    // dead-letter: maxAttempts到達でDEAD_LETTERへ
    // ================================================================
    {
      const fx = await makeCandidateFixture("deadletter");
      const enq = await enqueueCaseSuggestionMatch(db, {
        workspaceId: fx.workspaceId,
        ownerSubjectUserId: fx.userId,
        candidateId: fx.candidateId,
        reasonCode: "CANDIDATE_REVISION_CREATED",
      });
      await db.casePatternSuggestJob.update({ where: { id: enq.id }, data: { maxAttempts: 1 } });

      const claimed = await claimCaseSuggestJobs(`test-worker-dl-${RUN_ID}`, 10);
      const mine = claimed.filter((c) => c.candidateId === fx.candidateId);
      ok("[dead-letter前提] claim成功・attempt=1", mine.length === 1 && mine[0]!.attempt === 1);

      const failResult = await failCaseSuggestJob(mine[0]!.id, new Error("verify-forced-failure"));
      ok("[dead-letter] maxAttempts(1)到達時点でDEAD_LETTERへ確定する", failResult.status === "DEAD_LETTER");
      const final = await db.casePatternSuggestJob.findUnique({ where: { id: mine[0]!.id }, select: { status: true, lastErrorCode: true } });
      ok("[dead-letter] DB上もDEAD_LETTER", final?.status === "DEAD_LETTER");
      ok("[dead-letter] lastErrorCodeが記録される", !!final?.lastErrorCode);
    }

    // ================================================================
    // 二重worker同時claimでも重複0(FOR UPDATE SKIP LOCKEDの効果)
    // ================================================================
    {
      const fx = await makeCandidateFixture("dualworker");
      await enqueueCaseSuggestionMatch(db, {
        workspaceId: fx.workspaceId,
        ownerSubjectUserId: fx.userId,
        candidateId: fx.candidateId,
        reasonCode: "CANDIDATE_REVISION_CREATED",
      });

      const [claimedA, claimedB] = await Promise.all([
        claimCaseSuggestJobs(`test-worker-dualA-${RUN_ID}`, 10),
        claimCaseSuggestJobs(`test-worker-dualB-${RUN_ID}`, 10),
      ]);
      const mineA = claimedA.filter((c) => c.candidateId === fx.candidateId).length;
      const mineB = claimedB.filter((c) => c.candidateId === fx.candidateId).length;
      ok("[二重worker] 合計claim件数は1件のみ(重複claim0件)", mineA + mineB === 1, `A=${mineA} B=${mineB}`);
    }

    // ================================================================
    // 実配線: shadowWrite.tsが新Candidate作成時に実際にjobを1件作ること
    // (writeShadowFormationSessionを実際に呼び、AI providerには一切触れず、
    // Candidate配列を直接渡す形で検証する)
    // ================================================================
    {
      const { writeShadowFormationSession } = await import("../app/src/lib/formation/shadowWrite");
      const email = `${EMAIL_PREFIX}${RUN_ID}-wiring@example.invalid`;
      const user = await db.user.create({
        data: { email, passwordHash: "not-a-real-hash-for-db-only-test", displayName: "PATTERN-SUGGEST-01B wiring" },
      });
      const workspace = await db.workspace.create({ data: { name: "PATTERN-SUGGEST-01B Workspace wiring" } });
      await db.workspaceMember.create({ data: { workspaceId: workspace.id, userId: user.id, role: "OWNER" } });
      const domain = await db.domain.create({ data: { workspaceId: workspace.id, name: "dom-wiring" } });
      const rawText = "明日までにクライアントへ見積書を送る";
      const capture = await db.capture.create({
        data: {
          workspaceId: workspace.id,
          domainId: domain.id,
          createdById: user.id,
          sourceType: "TEXT",
          rawText,
          processingStatus: "SAVED",
          clientDraftId: `cd-wiring-${RUN_ID}`,
        },
      });
      userIds.push(user.id);

      const aiRunId = `verify-airun-${RUN_ID}`;
      await writeShadowFormationSession({
        capture: {
          id: capture.id,
          workspaceId: workspace.id,
          domainId: domain.id,
          createdById: user.id,
          sourceType: "TEXT",
          rawText,
        } as never,
        aiRunId,
        schemaVersion: "1.0",
        candidates: [
          {
            candidateId: "c1",
            type: "TASK",
            title: "見積書を送る",
            description: null,
            completionCondition: "送付完了",
            evidenceSpans: [],
            confidence: 0.9,
            dateMentions: [],
            unknowns: [],
            blockedByCandidateIds: [],
            suggestedTags: [],
            clarificationSignals: [],
          },
        ] as never,
      });

      const jobCount = await db.casePatternSuggestJob.count({ where: { workspaceId: workspace.id, ownerSubjectUserId: user.id } });
      ok("[実配線] shadowWrite経由の新Candidate作成でSuggest Jobが1件作られる", jobCount === 1, `jobCount=${jobCount}`);
    }

    ok("[AI課金] AI providerへの通信は0件", guard.deniedCallAttempts.length === 0, `attempts=${guard.deniedCallAttempts.length}`);
  } finally {
    console.log("\n[CLEANUP] テスト用データを削除します...");
    for (const userId of userIds) await cleanupTestUser(userId);
    const leftover = await assertNoLeftoverFormationVerifyUsers(db, EMAIL_PREFIX);
    ok("[cleanup] test用Userが1件も残っていない", leftover.clean, `remaining=${leftover.remainingUserIds.length}`);
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
