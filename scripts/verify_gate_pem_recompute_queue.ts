#!/usr/bin/env node
/**
 * scripts/verify_gate_pem_recompute_queue.ts
 *
 * PEM-RECOMPUTE-QUEUE(Recompute Queue / checkpoint-rebuild)の実DB受入証跡。
 * 出典: 統合正本仕様書v5.0 §22.3、DOC-05(Execution Event・Session Projection
 * 仕様書) 8章。
 *
 * AI providerへの実通信は行わない(このGateはAI呼び出しを一切含まない)。
 *
 * 実行方法:
 *   cd ~/projects/ismay/app
 *   npx tsx ../scripts/verify_gate_pem_recompute_queue.ts
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
const EMAIL_PREFIX = "gate-pem-recompute-queue-verify-";

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
  const { db } = await import("../app/src/lib/db");
  const { enqueueRecompute, claimRecomputeJobs, completeRecomputeJob, failRecomputeJob, getProjectionStatus } =
    await import("../app/src/lib/pem/recomputeQueue");
  const { revokeCompleteEvent } = await import("../app/src/lib/pem/executionCorrection");
  const { recordExecutionLedgerEvent } = await import("../app/src/lib/pem/executionLedger");
  const { PEM_CONSENT_POLICY_VERSION } = await import("../app/src/lib/pem/coreTypes");
  const { processRecomputeQueue } = await import("../app/src/lib/worker/recomputeQueueJob");

  const orphans = await db.user.findMany({
    where: { email: { startsWith: EMAIL_PREFIX, endsWith: "@example.invalid" } },
    select: { id: true },
  });

  const userIds: string[] = [];
  const workspaceIds: string[] = [];

  // [教訓踏襲] cleanupはworkspaceMember経由ではなくcreatedById/userId起点で直接検索する
  // (ハンドオフ資料3章「cleanup関数のworkspaceMember依存」対策)。
  // [FK順序] projection_recompute_jobs→responsibilitiesはRESTRICTのため、
  // responsibility削除より先にjob行を削除する。
  async function cleanupTestUser(userId: string, workspaceId: string | null): Promise<void> {
    if (workspaceId) {
      const responsibilities = await db.responsibility
        .findMany({ where: { workspaceId }, select: { id: true } })
        .catch(() => [] as { id: string }[]);
      const responsibilityIds = responsibilities.map((r: { id: string }) => r.id);
      if (responsibilityIds.length > 0) {
        await db.projectionRecomputeJob.deleteMany({ where: { responsibilityId: { in: responsibilityIds } } }).catch(() => null);
        const identities = await db.executionSessionIdentity
          .findMany({ where: { responsibilityId: { in: responsibilityIds } }, select: { id: true } })
          .catch(() => [] as { id: string }[]);
        const identityIds = identities.map((i: { id: string }) => i.id);
        if (identityIds.length > 0) {
          await db.executionSessionRevision.deleteMany({ where: { sessionIdentityId: { in: identityIds } } }).catch(() => null);
          await db.executionSessionIdentity.deleteMany({ where: { id: { in: identityIds } } }).catch(() => null);
        }
        await db.responsibilityLifecycleEvent.deleteMany({ where: { responsibilityId: { in: responsibilityIds } } }).catch(() => null);
        // [既知バグの再発防止・verify_gate_pem_execution_correction.tsと同じ教訓]
        // ReasonPrompt.triggerEventIdはResponsibilityExecutionEvent.idへの単一列FK
        // (reason_prompts_trigger_event_fkey)。REOPEN等requiresReasonPrompt=trueの
        // Eventではrecord ReasonPromptAndAnswer経由でReasonPrompt/StateEvent/Answerが
        // 作られるため、ExecutionEvent削除より先にこれらを消す必要がある
        // (このverify scriptのテストJがrevokeCompleteEvent(REOPEN)を使うため該当する)。
        const execEvents = await db.responsibilityExecutionEvent
          .findMany({ where: { responsibilityId: { in: responsibilityIds } }, select: { id: true } })
          .catch(() => [] as { id: string }[]);
        const execEventIds = execEvents.map((e: { id: string }) => e.id);
        if (execEventIds.length > 0) {
          const prompts = await db.reasonPrompt
            .findMany({ where: { triggerEventId: { in: execEventIds } }, select: { id: true } })
            .catch(() => [] as { id: string }[]);
          const promptIds = prompts.map((p: { id: string }) => p.id);
          if (promptIds.length > 0) {
            await db.executionReasonAnswer.deleteMany({ where: { promptId: { in: promptIds } } }).catch(() => null);
            await db.reasonPromptStateEvent.deleteMany({ where: { promptId: { in: promptIds } } }).catch(() => null);
            await db.reasonPrompt.deleteMany({ where: { id: { in: promptIds } } }).catch(() => null);
          }
        }
        await db.responsibilityExecutionEvent.deleteMany({ where: { responsibilityId: { in: responsibilityIds } } }).catch(() => null);
        await db.eventLog.deleteMany({ where: { aggregateId: { in: responsibilityIds } } }).catch(() => null);
        await db.outboxEvent.deleteMany({ where: { aggregateId: { in: responsibilityIds } } }).catch(() => null);
        await db.responsibility.deleteMany({ where: { id: { in: responsibilityIds } } }).catch(() => null);
      }
      const captures = await db.capture.findMany({ where: { workspaceId }, select: { id: true } }).catch(() => [] as { id: string }[]);
      const captureIds = captures.map((c: { id: string }) => c.id);
      if (captureIds.length > 0) {
        await db.capture.deleteMany({ where: { id: { in: captureIds } } }).catch(() => null);
      }
    }
    await db.pemConsentEvent.deleteMany({ where: { userId } }).catch(() => null);
    await db.pemMetricConsentEvent.deleteMany({ where: { userId } }).catch(() => null);
    await db.workspaceMember.deleteMany({ where: { userId } }).catch(() => null);
    if (workspaceId) {
      await db.workspace.deleteMany({ where: { id: workspaceId } }).catch(() => null);
    }
    await db.userSession.deleteMany({ where: { userId } }).catch(() => null);
    await db.user.deleteMany({ where: { id: userId } }).catch(() => null);
  }

  if (orphans.length > 0) {
    console.log(`[SWEEP] 過去実行の孤立テストユーザー${orphans.length}件を削除します...`);
    for (const o of orphans) {
      // [教訓再適用] workspaceMemberだけが先に削除され、responsibility等が孤児として
      // 残る「中途半端な失敗cleanup」が過去に発生している(ハンドオフ資料3章)。
      // workspaceMember経由の解決が失敗(既に削除済み)した場合、responsibility/
      // captureのcreatedById起点で直接workspaceIdを探すフォールバックを用意する。
      const membership = await db.workspaceMember.findFirst({ where: { userId: o.id }, select: { workspaceId: true } });
      let workspaceId: string | null = membership?.workspaceId ?? null;
      if (!workspaceId) {
        const respFallback = await db.responsibility.findFirst({ where: { createdById: o.id }, select: { workspaceId: true } });
        workspaceId = respFallback?.workspaceId ?? null;
      }
      if (!workspaceId) {
        const captureFallback = await db.capture.findFirst({ where: { createdById: o.id }, select: { workspaceId: true } });
        workspaceId = captureFallback?.workspaceId ?? null;
      }
      await cleanupTestUser(o.id, workspaceId);
    }
  }

  async function makeFixture(suffix: string) {
    const email = `${EMAIL_PREFIX}${RUN_ID}-${suffix}@example.invalid`;
    const user = await db.user.create({
      data: { email, passwordHash: "not-a-real-hash-for-db-only-test", displayName: `Recompute Queue ${suffix}` },
    });
    const workspace = await db.workspace.create({ data: { name: `Recompute Queue Workspace ${suffix}` } });
    await db.workspaceMember.create({ data: { workspaceId: workspace.id, userId: user.id, role: "OWNER" } });
    const domain = await db.domain.create({ data: { workspaceId: workspace.id, name: "個人", kind: "PERSONAL" } });
    // [是正・2026-09-03] recordExecutionLedgerEventはPEM_DATA_COLLECTION同意が
    // 無いと例外を投げず静かにnullを返す(executionLedger.ts冒頭コメント参照)。
    // テストJ(Correction統合試験)がEventを作れず失敗していたのはこの同意未付与が
    // 原因だった。Consent Event(insert-only)を明示的に付与する。
    await db.pemConsentEvent.create({
      data: { userId: user.id, workspaceId: workspace.id, consentType: "PEM_DATA_COLLECTION", action: "GRANTED", policyVersion: PEM_CONSENT_POLICY_VERSION, source: "SETTINGS" },
    });
    userIds.push(user.id);
    workspaceIds.push(workspace.id);
    return { userId: user.id, workspaceId: workspace.id, domainId: domain.id };
  }

  async function seedResponsibility(fx: { workspaceId: string; domainId: string; userId: string }, key: string) {
    const capture = await db.capture.create({
      data: { workspaceId: fx.workspaceId, domainId: fx.domainId, createdById: fx.userId, sourceType: "TEXT", rawText: `検証用${key}`, processingStatus: "READY" },
    });
    return db.responsibility.create({
      data: {
        workspaceId: fx.workspaceId, domainId: fx.domainId, originCaptureId: capture.id,
        type: "TASK", title: `recompute検証${key}`, status: "PLANNED", importance: 3,
        sourceKind: "USER", createdById: fx.userId, updatedById: fx.userId,
      },
    });
  }

  function pemCtxOf(fx: { workspaceId: string; userId: string }) {
    return {
      tenantId: fx.workspaceId,
      subjectUserId: fx.userId,
      actorUserId: fx.userId,
      workspaceRole: "OWNER",
      authenticationContextId: "verify-script",
    };
  }

  try {
    // ============================================================
    // A: enqueueRecomputeは新規PENDING行(generation=1)を作る。
    // ============================================================
    {
      const fx = await makeFixture("a");
      const resp = await seedResponsibility(fx, "a");
      const result = await db.$transaction((tx: any) =>
        enqueueRecompute(tx, {
          workspaceId: fx.workspaceId,
          responsibilityId: resp.id,
          subjectUserId: fx.userId,
          derivationVersion: "v1",
          projectionType: "EXECUTION_SESSION",
          reasonCode: "MANUAL_REBUILD",
        }),
      );
      ok("[A] 新規行はgeneration=1", result.generation === 1);
      ok("[A] 新規行はcoalesced=false", result.coalesced === false);

      const row = await db.projectionRecomputeJob.findUnique({ where: { id: result.id } });
      ok("[A] statusはPENDING", row?.status === "PENDING");
      ok("[A] attemptは0", row?.attempt === 0);
    }

    // ============================================================
    // B: 同一(workspace,responsibility,projectionType)へ再度enqueueすると
    //    coalescingされる(新規行が増えず、generationが増加する)。
    // ============================================================
    {
      const fx = await makeFixture("b");
      const resp = await seedResponsibility(fx, "b");
      const first = await db.$transaction((tx: any) =>
        enqueueRecompute(tx, {
          workspaceId: fx.workspaceId, responsibilityId: resp.id, subjectUserId: fx.userId,
          derivationVersion: "v1", reasonCode: "MANUAL_REBUILD",
        }),
      );
      const second = await db.$transaction((tx: any) =>
        enqueueRecompute(tx, {
          workspaceId: fx.workspaceId, responsibilityId: resp.id, subjectUserId: fx.userId,
          derivationVersion: "v1", reasonCode: "DELAYED_EVENT",
        }),
      );
      ok("[B] 2回目はcoalesced=true", second.coalesced === true);
      ok("[B] 同一idを指す", second.id === first.id);
      ok("[B] generationが2へ増加", second.generation === 2);

      const activeCount = await db.projectionRecomputeJob.count({
        where: { workspaceId: fx.workspaceId, responsibilityId: resp.id, status: { in: ["PENDING", "PROCESSING"] } },
      });
      ok("[B] アクティブ行は1件のまま(重複作成されない)", activeCount === 1);

      const row = await db.projectionRecomputeJob.findUnique({ where: { id: first.id } });
      ok("[B] reasonCodeは最新理由(DELAYED_EVENT)へ更新される", row?.reasonCode === "DELAYED_EVENT");
    }

    // ============================================================
    // C: 部分一意制約(DB層)。2件のアクティブ行を直接作ろうとすると拒否される。
    // ============================================================
    {
      const fx = await makeFixture("c");
      const resp = await seedResponsibility(fx, "c");
      await db.projectionRecomputeJob.create({
        data: {
          workspaceId: fx.workspaceId, responsibilityId: resp.id, subjectUserId: fx.userId,
          projectionType: "EXECUTION_SESSION", status: "PENDING", generation: 1,
          derivationVersion: "v1", reasonCode: "MANUAL_REBUILD",
        },
      });
      let threw = false;
      try {
        await db.projectionRecomputeJob.create({
          data: {
            workspaceId: fx.workspaceId, responsibilityId: resp.id, subjectUserId: fx.userId,
            projectionType: "EXECUTION_SESSION", status: "PENDING", generation: 1,
            derivationVersion: "v1", reasonCode: "MANUAL_REBUILD",
          },
        });
      } catch {
        threw = true;
      }
      ok("[C] 部分一意index(status IN (PENDING,PROCESSING))が2件目を拒否する", threw);
    }

    // ============================================================
    // D: claimRecomputeJobsはnext_attempt_at到来分のPENDINGのみclaimする。
    // ============================================================
    {
      const fx = await makeFixture("d");
      const resp = await seedResponsibility(fx, "d");
      const future = await db.projectionRecomputeJob.create({
        data: {
          workspaceId: fx.workspaceId, responsibilityId: resp.id, subjectUserId: fx.userId,
          projectionType: "EXECUTION_SESSION", status: "PENDING", generation: 1,
          nextAttemptAt: new Date(Date.now() + 60 * 60 * 1000),
          derivationVersion: "v1", reasonCode: "MANUAL_REBUILD",
        },
      });
      const claimed = await claimRecomputeJobs(`verify-worker-${RUN_ID}`, 50);
      const claimedIds = claimed.map((c) => c.id);
      ok("[D] 未来のnextAttemptAt行はclaimされない", !claimedIds.includes(future.id));

      // 後片付け(次テストの母集団に影響しないよう削除)。
      await db.projectionRecomputeJob.delete({ where: { id: future.id } }).catch(() => null);
    }

    // ============================================================
    // E: claim→complete(generation一致)でDONEになる。
    // ============================================================
    {
      const fx = await makeFixture("e");
      const resp = await seedResponsibility(fx, "e");
      const created = await db.projectionRecomputeJob.create({
        data: {
          workspaceId: fx.workspaceId, responsibilityId: resp.id, subjectUserId: fx.userId,
          projectionType: "EXECUTION_SESSION", status: "PENDING", generation: 1,
          derivationVersion: "v1", reasonCode: "MANUAL_REBUILD",
        },
      });
      const claimed = await claimRecomputeJobs(`verify-worker-${RUN_ID}`, 50);
      const mine = claimed.find((c) => c.id === created.id);
      ok("[E] claimされる", mine !== undefined);
      if (mine) {
        const claimedRow = await db.projectionRecomputeJob.findUnique({ where: { id: created.id } });
        ok("[E] claim後status=PROCESSING", claimedRow?.status === "PROCESSING");
        ok("[E] leaseOwner設定", claimedRow?.leaseOwner === `verify-worker-${RUN_ID}`);
        ok("[E] leaseExpiresAt設定", claimedRow?.leaseExpiresAt != null);
        ok("[E] attemptが1へ増加", claimedRow?.attempt === 1);

        const completeResult = await completeRecomputeJob(created.id, mine.generation, null);
        ok("[E] complete(generation一致)でDONE", completeResult.status === "DONE");
        const finalRow = await db.projectionRecomputeJob.findUnique({ where: { id: created.id } });
        ok("[E] status=DONE・leaseクリア", finalRow?.status === "DONE" && finalRow?.leaseOwner === null);
      }
    }

    // ============================================================
    // F: 処理中にcoalescingされた(generation不一致)場合、DONEにせずPENDINGへ差し戻す。
    // ============================================================
    {
      const fx = await makeFixture("f");
      const resp = await seedResponsibility(fx, "f");
      const created = await db.projectionRecomputeJob.create({
        data: {
          workspaceId: fx.workspaceId, responsibilityId: resp.id, subjectUserId: fx.userId,
          projectionType: "EXECUTION_SESSION", status: "PENDING", generation: 1,
          derivationVersion: "v1", reasonCode: "MANUAL_REBUILD",
        },
      });
      const claimed = await claimRecomputeJobs(`verify-worker-${RUN_ID}`, 50);
      const mine = claimed.find((c) => c.id === created.id)!;
      ok("[F] claimされる", mine !== undefined);

      // Worker処理中に新たなCorrectionが発生しcoalescingされたことを模擬する。
      await db.$transaction((tx: any) =>
        enqueueRecompute(tx, {
          workspaceId: fx.workspaceId, responsibilityId: resp.id, subjectUserId: fx.userId,
          derivationVersion: "v1", reasonCode: "CORRECTION",
        }),
      );

      const completeResult = await completeRecomputeJob(created.id, mine.generation, null);
      ok("[F] generation不一致時はDONEにならずPENDINGへ差し戻される", completeResult.status === "PENDING");
      const finalRow = await db.projectionRecomputeJob.findUnique({ where: { id: created.id } });
      ok("[F] 実際にstatus=PENDING", finalRow?.status === "PENDING");
      ok("[F] generationは進んだまま(2)", finalRow?.generation === 2);
    }

    // ============================================================
    // G: failRecomputeJobはmaxAttempts未満ならPENDING+backoffへ戻す。
    // ============================================================
    {
      const fx = await makeFixture("g");
      const resp = await seedResponsibility(fx, "g");
      const created = await db.projectionRecomputeJob.create({
        data: {
          workspaceId: fx.workspaceId, responsibilityId: resp.id, subjectUserId: fx.userId,
          projectionType: "EXECUTION_SESSION", status: "PROCESSING", generation: 1, attempt: 1, maxAttempts: 8,
          leaseOwner: "dummy", leaseExpiresAt: new Date(Date.now() + 60_000),
          derivationVersion: "v1", reasonCode: "MANUAL_REBUILD",
        },
      });
      const before = Date.now();
      const result = await failRecomputeJob(created.id, new Error("擬似エラー(検証用)"));
      ok("[G] maxAttempts未満はPENDINGへ戻る", result.status === "PENDING");
      const row = await db.projectionRecomputeJob.findUnique({ where: { id: created.id } });
      ok("[G] leaseがクリアされる", row?.leaseOwner === null && row?.leaseExpiresAt === null);
      ok("[G] nextAttemptAtが指数backoff分だけ未来になる", (row?.nextAttemptAt?.getTime() ?? 0) > before);
      ok("[G] lastErrorCodeが記録される", typeof row?.lastErrorCode === "string" && row.lastErrorCode.length > 0);
    }

    // ============================================================
    // H: failRecomputeJobはmaxAttempts到達でDEAD_LETTERへ確定する。
    // ============================================================
    {
      const fx = await makeFixture("h");
      const resp = await seedResponsibility(fx, "h");
      const created = await db.projectionRecomputeJob.create({
        data: {
          workspaceId: fx.workspaceId, responsibilityId: resp.id, subjectUserId: fx.userId,
          projectionType: "EXECUTION_SESSION", status: "PROCESSING", generation: 1, attempt: 8, maxAttempts: 8,
          leaseOwner: "dummy", leaseExpiresAt: new Date(Date.now() + 60_000),
          derivationVersion: "v1", reasonCode: "MANUAL_REBUILD",
        },
      });
      const result = await failRecomputeJob(created.id, new Error("擬似エラー(検証用・上限到達)"));
      ok("[H] maxAttempts到達でDEAD_LETTER", result.status === "DEAD_LETTER");
      const row = await db.projectionRecomputeJob.findUnique({ where: { id: created.id } });
      ok("[H] status=DEAD_LETTER・completedAt設定", row?.status === "DEAD_LETTER" && row?.completedAt != null);
    }

    // ============================================================
    // I: getProjectionStatusはlatest job行のstatusから機械的に導出する。
    // ============================================================
    {
      const fx = await makeFixture("i");
      const resp = await seedResponsibility(fx, "i");
      ok(
        "[I] job行が無ければFRESH",
        (await getProjectionStatus(fx.workspaceId, resp.id, "EXECUTION_SESSION")) === "FRESH",
      );

      await db.projectionRecomputeJob.create({
        data: {
          workspaceId: fx.workspaceId, responsibilityId: resp.id, subjectUserId: fx.userId,
          projectionType: "EXECUTION_SESSION", status: "PENDING", generation: 1,
          derivationVersion: "v1", reasonCode: "MANUAL_REBUILD",
        },
      });
      ok(
        "[I] PENDINGならSTALE",
        (await getProjectionStatus(fx.workspaceId, resp.id, "EXECUTION_SESSION")) === "STALE",
      );

      await db.projectionRecomputeJob.updateMany({
        where: { workspaceId: fx.workspaceId, responsibilityId: resp.id },
        data: { status: "PROCESSING" },
      });
      ok(
        "[I] PROCESSINGならREBUILDING",
        (await getProjectionStatus(fx.workspaceId, resp.id, "EXECUTION_SESSION")) === "REBUILDING",
      );

      await db.projectionRecomputeJob.updateMany({
        where: { workspaceId: fx.workspaceId, responsibilityId: resp.id },
        data: { status: "DEAD_LETTER" },
      });
      ok(
        "[I] DEAD_LETTERならFAILED",
        (await getProjectionStatus(fx.workspaceId, resp.id, "EXECUTION_SESSION")) === "FAILED",
      );

      await db.projectionRecomputeJob.updateMany({
        where: { workspaceId: fx.workspaceId, responsibilityId: resp.id },
        data: { status: "DONE" },
      });
      ok(
        "[I] DONEならFRESH",
        (await getProjectionStatus(fx.workspaceId, resp.id, "EXECUTION_SESSION")) === "FRESH",
      );
    }

    // ============================================================
    // J: 統合試験。Correction(REVOKE)→enqueue→Worker処理までend-to-end。
    // ============================================================
    {
      const fx = await makeFixture("j");
      const pemCtx = pemCtxOf(fx);
      const resp = await seedResponsibility(fx, "j");

      // START→COMPLETEのExecution Eventを作り、責任をCOMPLETEDへ進める(REVOKE検証の前提)。
      await db.$transaction(async (tx: any) => {
        const startEvent = await recordExecutionLedgerEvent({
          tx, ctx: pemCtx, responsibilityId: resp.id, responsibilityType: "TASK",
          action: "START", fromState: "PLANNED", toState: "IN_PROGRESS",
          versionBefore: resp.version, versionAfter: resp.version + 1,
          clientOccurredAt: new Date("2026-09-03T09:00:00Z"), actorType: "USER", source: "API",
          requestId: `verify-j-start-${RUN_ID}`, requestPayloadHash: "dummy-hash-start", reason: null,
        });
        await tx.responsibility.update({ where: { id: resp.id }, data: { status: "IN_PROGRESS", version: { increment: 1 } } });
        await recordExecutionLedgerEvent({
          tx, ctx: pemCtx, responsibilityId: resp.id, responsibilityType: "TASK",
          action: "COMPLETE", fromState: "IN_PROGRESS", toState: "COMPLETED",
          versionBefore: resp.version + 1, versionAfter: resp.version + 2,
          clientOccurredAt: new Date("2026-09-03T10:00:00Z"), actorType: "USER", source: "API",
          requestId: `verify-j-complete-${RUN_ID}`, requestPayloadHash: "dummy-hash-complete", reason: null,
        });
        await tx.responsibility.update({ where: { id: resp.id }, data: { status: "COMPLETED", completedAt: new Date("2026-09-03T10:00:00Z"), version: { increment: 1 } } });
        void startEvent;
      });

      const completeEvent = await db.responsibilityExecutionEvent.findFirst({
        where: { responsibilityId: resp.id, eventType: "COMPLETE" },
      });
      ok("[J] 前提: COMPLETE Eventが存在する", completeEvent !== null);

      if (completeEvent) {
        const revokeResult = await revokeCompleteEvent({
          workspaceId: fx.workspaceId, ctx: pemCtx, targetEventId: completeEvent.id,
          reason: "PEM-RECOMPUTE-QUEUE検証", idempotencyKey: `verify-j-revoke-${RUN_ID}`,
          requestPayloadHash: "dummy-hash-revoke",
        });
        ok("[J] REVOKE成功", revokeResult.ok === true);

        const jobAfterCorrection = await db.projectionRecomputeJob.findFirst({
          where: { workspaceId: fx.workspaceId, responsibilityId: resp.id, projectionType: "EXECUTION_SESSION" },
          orderBy: { createdAt: "desc" },
        });
        ok("[J] Correctionによりqueueへreason=CORRECTIONでmark staleされる", jobAfterCorrection?.reasonCode === "CORRECTION");
        // executionCorrection.ts側で既に同期的にprojectAndPersistExecutionSessionsを
        // 呼んでいるため、insert-onlyの内容不変チェックによりWorker実行前でも
        // 既にPENDING(=このtx内で作られた直後の状態)のはず。
        ok("[J] mark stale直後はPENDING(=projectionStatus STALE相当)", jobAfterCorrection?.status === "PENDING");

        const workerResult = await processRecomputeQueue();
        ok("[J] Workerが1件以上処理する", workerResult.processed >= 1);

        const jobAfterWorker = jobAfterCorrection
          ? await db.projectionRecomputeJob.findUnique({ where: { id: jobAfterCorrection.id } })
          : null;
        ok("[J] Worker処理後はDONE", jobAfterWorker?.status === "DONE");

        const status = await getProjectionStatus(fx.workspaceId, resp.id, "EXECUTION_SESSION");
        ok("[J] projectionStatusはFRESHへ戻る", status === "FRESH");

        // insert-onlyの内容不変チェックにより、REVOKE時の同期呼び出しと
        // Worker再実行の2回projectAndPersistExecutionSessionsが走っても
        // Revisionが重複追記されないことを確認する(冪等性)。
        const identity = await db.executionSessionIdentity.findFirst({ where: { workspaceId: fx.workspaceId, responsibilityId: resp.id } });
        const revisionCount = identity
          ? await db.executionSessionRevision.count({ where: { sessionIdentityId: identity.id } })
          : 0;
        ok("[J] Worker再実行しても内容不変のためRevisionは重複追記されない", revisionCount <= 2, `revisionCount=${revisionCount}`);
      } else {
        ok("[J] 以降のサブテストは前提不成立のためスキップ扱い(失敗として記録済み)", false, "completeEventがnull");
      }
    }
  } finally {
    console.log("[CLEANUP] テスト用データを削除します...");
    for (let i = 0; i < userIds.length; i++) {
      await cleanupTestUser(userIds[i]!, workspaceIds[i] ?? null);
    }
    const leftover = await db.user.findMany({
      where: { email: { startsWith: EMAIL_PREFIX, endsWith: "@example.invalid" } },
      select: { id: true },
    });
    ok("[cleanup] test用Userが1件も残っていない", leftover.length === 0, `remaining=${leftover.length}`);
  }

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
