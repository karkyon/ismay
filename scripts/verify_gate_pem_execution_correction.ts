#!/usr/bin/env node
/**
 * scripts/verify_gate_pem_execution_correction.ts
 *
 * PEM Execution Event Correction(REVOKE)の実DB受入証跡。
 * 出典: DOC-11(API・Event仕様書) 3章 API-E03「POST /execution-events/:id/corrections」、
 * DOC-05(Execution Event・Session Projection仕様書) 8章・11章
 * 「訂正後再計算で旧Revisionが残り、latestだけが切り替わる」。
 *
 * AI providerへの実通信は行わない(このGateはAI呼び出しを一切含まない)。
 *
 * 実行方法:
 *   cd ~/projects/ismay/app
 *   npx tsx ../scripts/verify_gate_pem_execution_correction.ts
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
const EMAIL_PREFIX = "gate-pem-exec-correction-verify-";

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
  const { buildPemAuthorizationContext } = await import("../app/src/lib/pem/authorizationBoundary");
  const { revokeCompleteEvent } = await import("../app/src/lib/pem/executionCorrection");

  const orphans = await db.user.findMany({
    where: { email: { startsWith: EMAIL_PREFIX, endsWith: "@example.invalid" } },
    select: { id: true },
  });

  const userIds: string[] = [];
  const workspaceIds: string[] = [];

  /**
   * [2026-09-02重要バグ修正・実DB検証で発覚] 当初`workspaceId`を
   * `db.workspaceMember.findFirst`経由で取得し、それが見つからない場合
   * (workspaceId===null)はResponsibility等の削除を一切スキップする設計だった。
   * しかし前回セッションの失敗時、Prisma例外を`.catch(() => null)`で握り潰す
   * 設計そのものにより「workspaceMemberだけは正常に削除されたが、Responsibility/
   * Capture/ExecutionEvent等は(当時のReasonPrompt FKバグにより)削除できずに
   * 残る」という中途半端な状態がDBに実際に残ってしまった。次回SWEEP時、
   * workspaceMemberが既に無いためworkspaceIdを解決できず、残存Responsibility
   * 等を検出できないままuser削除だけを試みてFK違反を繰り返す悪循環になっていた。
   *
   * 対策として、workspaceIdの経由有無に依存せず、`createdById=userId`(このGateの
   * 全fixtureが必ず自分自身をcreatedByとして使う設計であるため機械的に検出できる)
   * を起点にResponsibility/Captureを直接検索する経路を主に据える。引数の
   * `workspaceIdHint`(workspaceMember経由で分かっていれば)は補助的にのみ使う。
   */
  async function cleanupTestUser(userId: string, workspaceIdHint: string | null): Promise<void> {
    const responsibilities = await db.responsibility
      .findMany({ where: { createdById: userId }, select: { id: true, workspaceId: true } })
      .catch(() => [] as { id: string; workspaceId: string }[]);
    const responsibilityIds = responsibilities.map((r: { id: string }) => r.id);
    const workspaceIds = new Set<string>(responsibilities.map((r: { workspaceId: string }) => r.workspaceId));
    if (workspaceIdHint) workspaceIds.add(workspaceIdHint);

    if (responsibilityIds.length > 0) {
      await db.responsibilityLifecycleEvent.deleteMany({ where: { responsibilityId: { in: responsibilityIds } } }).catch(() => null);
      const identities = await db.executionSessionIdentity
        .findMany({ where: { responsibilityId: { in: responsibilityIds } }, select: { id: true } })
        .catch(() => [] as { id: string }[]);
      const identityIds = identities.map((i: { id: string }) => i.id);
      if (identityIds.length > 0) {
        await db.executionSessionRevision.deleteMany({ where: { sessionIdentityId: { in: identityIds } } }).catch(() => null);
        await db.executionSessionIdentity.deleteMany({ where: { id: { in: identityIds } } }).catch(() => null);
      }
      // [2026-09-02バグ修正・実DB検証で発覚] ReasonPrompt.triggerEventIdは
      // ResponsibilityExecutionEvent.idへの単一列FKを持つ(reason_prompts_
      // trigger_event_fkey)。REOPEN等requiresReasonPrompt=trueのEventでは
      // recordReasonPromptAndAnswer経由でReasonPrompt/StateEvent/Answerが
      // 作られるため、ExecutionEvent削除より先にこれらを消す必要がある。
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

    // [同様にworkspaceId不問] CaptureもcreatedById経由で直接検索する。
    const captures = await db.capture
      .findMany({ where: { createdById: userId }, select: { id: true } })
      .catch(() => [] as { id: string }[]);
    const captureIds = captures.map((c: { id: string }) => c.id);
    if (captureIds.length > 0) {
      await db.capture.deleteMany({ where: { id: { in: captureIds } } }).catch(() => null);
    }

    await db.pemConsentEvent.deleteMany({ where: { userId } }).catch(() => null);
    await db.pemMetricConsentEvent.deleteMany({ where: { userId } }).catch(() => null);
    await db.workspaceMember.deleteMany({ where: { userId } }).catch(() => null);
    for (const wsId of workspaceIds) {
      await db.workspace.deleteMany({ where: { id: wsId } }).catch(() => null);
    }
    await db.userSession.deleteMany({ where: { userId } }).catch(() => null);
    await db.user.deleteMany({ where: { id: userId } }).catch(() => null);
  }

  if (orphans.length > 0) {
    console.log(`[SWEEP] 過去実行の孤立テストユーザー${orphans.length}件を削除します...`);
    for (const o of orphans) {
      const membership = await db.workspaceMember.findFirst({ where: { userId: o.id }, select: { workspaceId: true } });
      await cleanupTestUser(o.id, membership?.workspaceId ?? null);
    }
  }

  async function makeFixture(suffix: string) {
    const email = `${EMAIL_PREFIX}${RUN_ID}-${suffix}@example.invalid`;
    const user = await db.user.create({
      data: { email, passwordHash: "not-a-real-hash-for-db-only-test", displayName: `PEM ExecCorrection ${suffix}` },
    });
    const workspace = await db.workspace.create({ data: { name: `PEM ExecCorrection Workspace ${suffix}` } });
    await db.workspaceMember.create({ data: { workspaceId: workspace.id, userId: user.id, role: "OWNER" } });
    const domain = await db.domain.create({ data: { workspaceId: workspace.id, name: "個人", kind: "PERSONAL" } });
    // PEM同意はConsent Event(insert-only)を明示的に付与する(recordExecutionLedgerEventが
    // PEM_DATA_COLLECTION同意を要求するため)。
    await db.pemConsentEvent.create({
      data: { userId: user.id, workspaceId: workspace.id, consentType: "PEM_DATA_COLLECTION", action: "GRANTED", policyVersion: "v4.0-2026-08-24", source: "SETTINGS" },
    });
    userIds.push(user.id);
    workspaceIds.push(workspace.id);
    return { userId: user.id, workspaceId: workspace.id, domainId: domain.id };
  }

  async function seedCompletedResponsibility(fx: { workspaceId: string; domainId: string; userId: string }, key: string) {
    const capture = await db.capture.create({
      data: { workspaceId: fx.workspaceId, domainId: fx.domainId, createdById: fx.userId, sourceType: "TEXT", rawText: `検証用${key}`, processingStatus: "READY" },
    });
    const resp = await db.responsibility.create({
      data: {
        workspaceId: fx.workspaceId, domainId: fx.domainId, originCaptureId: capture.id,
        type: "TASK", title: `correction検証${key}`, status: "COMPLETED", importance: 3,
        sourceKind: "USER", createdById: fx.userId, updatedById: fx.userId, version: 1, eventSequenceCounter: 1,
      },
    });
    const completeEvent = await db.responsibilityExecutionEvent.create({
      data: {
        workspaceId: fx.workspaceId, subjectUserId: fx.userId, actorType: "USER", actorUserId: fx.userId,
        requestId: `req-${RUN_ID}-${key}`, responsibilityId: resp.id, eventType: "COMPLETE",
        fromState: "IN_PROGRESS", toState: "COMPLETED", responsibilityVersionBefore: 0, responsibilityVersionAfter: 1,
        responsibilitySequence: 1, source: "WEB", clientOccurredAt: new Date(), effectiveOccurredAt: new Date(),
        occurredAtQuality: "HIGH", idempotencyKey: `${resp.id}:COMPLETE:0`, requestPayloadHash: "seed-hash",
        schemaVersion: "v4.0",
      },
    });
    return { resp, completeEvent };
  }

  try {
    // ============================================================
    // A: 正常なREVOKE。REOPEN Event生成・status戻る・Lifecycle Event記録。
    // ============================================================
    {
      const fx = await makeFixture("a");
      const { resp, completeEvent } = await seedCompletedResponsibility(fx, "a");
      const pemCtx = await buildPemAuthorizationContext(fx.userId, fx.userId);

      const eventCountBefore = await db.responsibilityExecutionEvent.count({ where: { responsibilityId: resp.id } });

      const result = await revokeCompleteEvent({
        workspaceId: fx.workspaceId, ctx: pemCtx, targetEventId: completeEvent.id,
        reason: "手動テスト訂正", idempotencyKey: `client-${RUN_ID}-a`, requestPayloadHash: "hash-a",
      });
      ok("[A] revoke成功", result.ok);
      if (result.ok) {
        ok("[A] resultingEventIdが設定される(REOPEN Event)", result.resultingEventId !== null);
        ok("[A] 初回はreplay=false", result.replay === false);
      }

      const respAfter = await db.responsibility.findUniqueOrThrow({ where: { id: resp.id } });
      ok("[A] Responsibility.statusがPLANNEDに戻る", respAfter.status === "PLANNED");
      ok("[A] versionが1つ進む", respAfter.version === 2);

      const eventCountAfter = await db.responsibilityExecutionEvent.count({ where: { responsibilityId: resp.id } });
      ok("[A] insert-only: 新しいREOPEN Eventが1件追加される(元Eventは消えない)", eventCountAfter === eventCountBefore + 1);

      const originalStillExists = await db.responsibilityExecutionEvent.findUnique({ where: { id: completeEvent.id } });
      ok("[A] DOC-05 8.1節「元Evidenceを更新せず」: 元COMPLETE Eventは削除されず残る", originalStillExists !== null);
      ok("[A] 元Eventのeventtype/fromState/toStateは不変(直接UPDATEしない)", originalStillExists?.eventType === "COMPLETE" && originalStillExists?.toState === "COMPLETED");

      if (result.ok) {
        const lifecycleEvent = await db.responsibilityLifecycleEvent.findUniqueOrThrow({ where: { id: result.lifecycleEventId } });
        ok("[A] Lifecycle Event.kind=CORRECTION", lifecycleEvent.kind === "CORRECTION");
        ok("[A] Lifecycle Event.correctionType=REVOKE", lifecycleEvent.correctionType === "REVOKE");
        ok("[A] Lifecycle Event.correctionOfEventIdが元Eventを指す", lifecycleEvent.correctionOfEventId === completeEvent.id);
        ok("[A] Lifecycle Event.resultingEventIdがREOPEN Eventを指す", lifecycleEvent.resultingEventId === result.resultingEventId);
      }
    }

    // ============================================================
    // B: COMPLETE以外のeventTypeを指定した場合はNOT_COMPLETE_EVENT。
    // ============================================================
    {
      const fx = await makeFixture("b");
      const resp = await db.responsibility.create({
        data: {
          workspaceId: fx.workspaceId, domainId: fx.domainId, type: "TASK", title: "b",
          status: "IN_PROGRESS", sourceKind: "USER", createdById: fx.userId, updatedById: fx.userId,
        },
      });
      const startEvent = await db.responsibilityExecutionEvent.create({
        data: {
          workspaceId: fx.workspaceId, subjectUserId: fx.userId, actorType: "USER", actorUserId: fx.userId,
          requestId: `req-${RUN_ID}-b`, responsibilityId: resp.id, eventType: "START",
          fromState: "PLANNED", toState: "IN_PROGRESS", responsibilityVersionBefore: 0, responsibilityVersionAfter: 1,
          responsibilitySequence: 1, source: "WEB", clientOccurredAt: new Date(), effectiveOccurredAt: new Date(),
          occurredAtQuality: "HIGH", idempotencyKey: `${resp.id}:START:0`, requestPayloadHash: "seed-hash-b",
          schemaVersion: "v4.0",
        },
      });
      const pemCtx = await buildPemAuthorizationContext(fx.userId, fx.userId);
      const result = await revokeCompleteEvent({
        workspaceId: fx.workspaceId, ctx: pemCtx, targetEventId: startEvent.id,
        idempotencyKey: `client-${RUN_ID}-b`, requestPayloadHash: "hash-b",
      });
      ok("[B] START Eventの取消はNOT_COMPLETE_EVENT", !result.ok && result.error === "NOT_COMPLETE_EVENT");
    }

    // ============================================================
    // C: 既に訂正済みのEventを再度取り消そうとするとALREADY_CORRECTED。
    // ============================================================
    {
      const fx = await makeFixture("c");
      const { completeEvent } = await seedCompletedResponsibility(fx, "c");
      const pemCtx = await buildPemAuthorizationContext(fx.userId, fx.userId);

      const first = await revokeCompleteEvent({
        workspaceId: fx.workspaceId, ctx: pemCtx, targetEventId: completeEvent.id,
        idempotencyKey: `client-${RUN_ID}-c-1`, requestPayloadHash: "hash-c-1",
      });
      ok("[C] 1回目成功", first.ok);

      const second = await revokeCompleteEvent({
        workspaceId: fx.workspaceId, ctx: pemCtx, targetEventId: completeEvent.id,
        idempotencyKey: `client-${RUN_ID}-c-2`, requestPayloadHash: "hash-c-2",
      });
      ok("[C] 別keyでの再取消はALREADY_CORRECTED", !second.ok && second.error === "ALREADY_CORRECTED");
    }

    // ============================================================
    // D: Responsibility.statusが既にCOMPLETED以外の場合STATE_CHANGED。
    // ============================================================
    {
      const fx = await makeFixture("d");
      const { resp, completeEvent } = await seedCompletedResponsibility(fx, "d");
      // 他の操作により状態が変わっていたことをシミュレート。
      await db.responsibility.update({ where: { id: resp.id }, data: { status: "PLANNED", version: { increment: 1 } } });

      const pemCtx = await buildPemAuthorizationContext(fx.userId, fx.userId);
      const result = await revokeCompleteEvent({
        workspaceId: fx.workspaceId, ctx: pemCtx, targetEventId: completeEvent.id,
        idempotencyKey: `client-${RUN_ID}-d`, requestPayloadHash: "hash-d",
      });
      ok("[D] status変化済みはSTATE_CHANGED", !result.ok && result.error === "STATE_CHANGED");
    }

    // ============================================================
    // E: 冪等再送(同一key・同一payload)は同じ結果を返す。
    // ============================================================
    {
      const fx = await makeFixture("e");
      const { completeEvent } = await seedCompletedResponsibility(fx, "e");
      const pemCtx = await buildPemAuthorizationContext(fx.userId, fx.userId);
      const key = `client-${RUN_ID}-e`;

      const first = await revokeCompleteEvent({
        workspaceId: fx.workspaceId, ctx: pemCtx, targetEventId: completeEvent.id,
        idempotencyKey: key, requestPayloadHash: "hash-e",
      });
      const second = await revokeCompleteEvent({
        workspaceId: fx.workspaceId, ctx: pemCtx, targetEventId: completeEvent.id,
        idempotencyKey: key, requestPayloadHash: "hash-e",
      });
      ok("[E] 1回目成功", first.ok);
      ok("[E] 2回目も成功(replay)", second.ok && second.replay === true);
      if (first.ok && second.ok) {
        ok("[E] 同一lifecycleEventIdを返す", first.lifecycleEventId === second.lifecycleEventId);
      }
    }

    // ============================================================
    // F: 異payload再送はIDEMPOTENCY_KEY_REUSED。
    // ============================================================
    {
      const fx = await makeFixture("f");
      const { completeEvent } = await seedCompletedResponsibility(fx, "f");
      const pemCtx = await buildPemAuthorizationContext(fx.userId, fx.userId);
      const key = `client-${RUN_ID}-f`;

      const first = await revokeCompleteEvent({
        workspaceId: fx.workspaceId, ctx: pemCtx, targetEventId: completeEvent.id,
        idempotencyKey: key, requestPayloadHash: "hash-f-1",
      });
      const second = await revokeCompleteEvent({
        workspaceId: fx.workspaceId, ctx: pemCtx, targetEventId: completeEvent.id,
        idempotencyKey: key, requestPayloadHash: "hash-f-2-different",
      });
      ok("[F] 1回目成功", first.ok);
      ok("[F] 異payload再送はIDEMPOTENCY_KEY_REUSED", !second.ok && second.error === "IDEMPOTENCY_KEY_REUSED");
    }

    // ============================================================
    // G: tenant越境。他workspaceのeventIdを指定するとNOT_FOUND。
    // ============================================================
    {
      const fxA = await makeFixture("g-a");
      const fxB = await makeFixture("g-b");
      const { completeEvent } = await seedCompletedResponsibility(fxA, "g");
      const pemCtxB = await buildPemAuthorizationContext(fxB.userId, fxB.userId);

      const result = await revokeCompleteEvent({
        workspaceId: fxB.workspaceId, ctx: pemCtxB, targetEventId: completeEvent.id,
        idempotencyKey: `client-${RUN_ID}-g`, requestPayloadHash: "hash-g",
      });
      ok("[G] tenant越境はNOT_FOUND", !result.ok && result.error === "NOT_FOUND");
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
