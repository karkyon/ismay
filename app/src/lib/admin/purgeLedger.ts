/**
 * 30日Purgeの運用台帳(PURGE-OPS-03B・2026-09-25新設)。
 *
 * DEC-PURGE-02B §7.1(利用者決定)の6段順序を1ユーザーずつ実行・記録する:
 *   1) OBJECTS_SNAPSHOTTED: DB参照key ∪ workspace接頭辞一覧を台帳(purge_item_objects)へ確定
 *   2) OBJECTS_DELETED:     MinIO objectを削除
 *   3) OBJECTS_VERIFIED:    全objectの不存在(statObject NotFound)と接頭辞一覧が空であることを確認
 *   4) DB_PURGED:           DB物理削除(executePurgeForUser。台帳のDB_PURGEDは同じtransactionで記録)
 *   5) AUDITED:             監査記録(AuditLog。匿名化はFK上users削除と不可分のため4と同じtransaction)
 *   6) COMPLETED:           commit後の遅延object再確認・object keyの墨消し・完了
 *
 * [lockと順序] 工程1〜4はexecutePurgeForUserのtransaction内(users/workspaces行を
 * FOR UPDATEで保持し、30日条件を再検証した後)で行う。lockを取らずにobjectを先に消すと、
 * その間にアカウントが復元された場合に復元ユーザーのファイルだけが失われるため。
 * 台帳の工程1〜3は別接続で即時commitし(途中停止しても何を消したかが残る)、
 * 工程4はDB削除と原子的に記録する。工程3で不存在を確認できなければ例外でrollbackし、
 * DBは変更しない(retryで工程1からやり直す。削除済みobjectは不存在として通過する)。
 *
 * [運用要素] batch size(1回の処理件数)、lease(owner/期限、期限切れは再取得可)、
 * retry(指数backoff)、dead-letter(max_attempts到達)、idempotent再実行(phaseは前進のみ、
 * 工程1〜3は冪等、DB_PURGED以降はDB段を再実行しない)、中断再開(--resume)、
 * dry-run manifestとexecute manifestのdigest対応(planned_digest/actual_digest/drift_count)。
 */
import { randomUUID } from "node:crypto";
import { db } from "@/lib/db";
import type { Prisma } from "@/generated/prisma/client";
import { dryRunPurgeForUser, executePurgeForUser, type PurgeManifest, type PurgeRunOptions } from "./purgeJob";
import {
  ObjectVerificationError,
  hashObjectKey,
  mergeObjectTargets,
  purgeRetryDelayMs,
  workspaceObjectPrefix,
  type PurgeObjectSource,
  type PurgeObjectStore,
} from "./purgeObjects";
import { PURGE_EXIT, buildPurgeAuditReason, type PurgeItemOutcome, type PurgeRunContext } from "./purgeReporting";
import { writePurgeAuditLog, type PurgeAuditWriter } from "./purgeRunner";
import { computePlanDigest, phaseIndex, type PurgePhase, type PurgeItemStatus } from "./purgeLedgerCore";

export { PURGE_PHASES, phaseIndex, computePlanDigest, type PurgePhase, type PurgeItemStatus } from "./purgeLedgerCore";

/** lease期限(1ユーザーtransactionの上限10分より長くする)。 */
export const DEFAULT_PURGE_LEASE_MS = 15 * 60 * 1000;
export const DEFAULT_PURGE_BATCH_SIZE = 10;
export const DEFAULT_PURGE_MAX_ATTEMPTS = 5;
/** 工程3で接頭辞一覧に新たなobjectが現れた場合の再削除の上限回数。 */
const VERIFY_ROUNDS = 3;
const UTC_NOW = `(now() AT TIME ZONE 'UTC')`;

export class LeaseLostError extends Error {
  constructor(itemId: string) {
    super(`[purgeLedger] item ${itemId} のleaseを失いました(他プロセスが再取得した可能性)。処理を中止します`);
  }
}

function errorSummary(err: unknown): string {
  const text = err instanceof Error ? err.message : String(err);
  return text.replace(/\s+/g, " ").trim().slice(0, 1000);
}

function asJson(value: unknown): Prisma.InputJsonValue {
  return value as Prisma.InputJsonValue;
}

// ---------------------------------------------------------------------------
// Run作成(dry-run manifestの確定)
// ---------------------------------------------------------------------------

export interface CreatePurgeRunParams {
  userIds: string[];
  context: PurgeRunContext;
  batchSize?: number;
  maxAttempts?: number;
  runOptions?: PurgeRunOptions;
  auditWriter?: PurgeAuditWriter;
}


/**
 * 対象ユーザーごとにdry-run(transaction内の計画→rollback)を行い、そのmanifestを
 * planned_manifest/planned_digestとして台帳へ確定する。dry-runで拒否された対象は
 * SKIPPED(refusal_status付き)として記録する。run.idはcontext.runId。
 */
export async function createPurgeRun(params: CreatePurgeRunParams): Promise<string> {
  const batchSize = params.batchSize ?? DEFAULT_PURGE_BATCH_SIZE;
  const maxAttempts = params.maxAttempts ?? DEFAULT_PURGE_MAX_ATTEMPTS;
  const userIds = [...new Set(params.userIds)];
  if (userIds.length === 0) throw new Error("[purgeLedger] 対象ユーザーが0件です");

  const planned: { userId: string; manifest: PurgeManifest | null; refusalStatus: string | null; refusalDetail: string | null }[] = [];
  for (const userId of userIds) {
    const plan = await dryRunPurgeForUser({ userId }, params.runOptions);
    if (plan.status === "ELIGIBLE") planned.push({ userId, manifest: plan.manifest, refusalStatus: null, refusalDetail: null });
    else planned.push({ userId, manifest: null, refusalStatus: plan.status, refusalDetail: plan.detail });
  }
  const planDigest = computePlanDigest(planned.map((p) => ({ userId: p.userId, plannedDigest: p.manifest?.digest ?? null, refusalStatus: p.refusalStatus })));

  await db.$transaction(async (tx: Prisma.TransactionClient): Promise<void> => {
    await tx.purgeRun.create({
      data: {
        id: params.context.runId,
        osUser: params.context.osUser,
        hostname: params.context.hostname,
        pid: params.context.pid,
        operatorDeclared: params.context.operatorDeclared,
        batchSize,
        maxAttempts,
        itemCount: planned.length,
        planDigest,
      },
    });
    for (const p of planned) {
      await tx.purgeItem.create({
        data: {
          runId: params.context.runId,
          userId: p.userId,
          status: p.manifest ? "PENDING" : "SKIPPED",
          plannedDigest: p.manifest?.digest ?? null,
          plannedManifest: p.manifest ? asJson(p.manifest) : undefined,
          refusalStatus: p.refusalStatus,
          refusalDetail: p.refusalDetail,
          maxAttempts,
        },
      });
    }
  });

  // dry-run段で拒否された対象はFAILURE監査を記録する(AUDIT-02D: 削除結果と監査記録は別状態)。
  const skipped = await db.purgeItem.findMany({ where: { runId: params.context.runId, status: "SKIPPED" } });
  for (const item of skipped) {
    await recordAudit(item.id, params.context, params.auditWriter ?? writePurgeAuditLog, {
      userId: item.userId,
      purgeStatus: (item.refusalStatus ?? "ERROR") as PurgeItemOutcome["purgeStatus"],
      purgeSucceeded: false,
      detail: `item=${item.id} dry-run段で拒否: ${item.refusalDetail ?? ""}`,
    });
  }
  return params.context.runId;
}

// ---------------------------------------------------------------------------
// lease
// ---------------------------------------------------------------------------

interface ClaimedItem {
  id: string;
  run_id: string;
  user_id: string;
  phase: string;
  attempts: number;
  max_attempts: number;
  planned_manifest: unknown;
  audit_recorded: boolean;
}

/** 実行可能なitemを1件だけleaseつきで取得する(FOR UPDATE SKIP LOCKED。複数プロセスでも重複しない)。 */
export async function claimNextPurgeItem(runId: string, owner: string, leaseMs: number = DEFAULT_PURGE_LEASE_MS): Promise<ClaimedItem | null> {
  if (!Number.isInteger(leaseMs) || leaseMs < 1000) throw new Error(`[purgeLedger] leaseMsが不正です: ${leaseMs}`);
  const rows = await db.$queryRawUnsafe<ClaimedItem[]>(
    `UPDATE "purge_items" SET "status" = 'IN_PROGRESS', "lease_owner" = $2,
       "lease_expires_at" = ${UTC_NOW} + ($3::int * interval '1 millisecond'),
       "attempts" = "attempts" + 1, "updated_at" = ${UTC_NOW}
     WHERE "id" = (
       SELECT "id" FROM "purge_items"
       WHERE "run_id" = $1 AND (
         ("status" IN ('PENDING', 'RETRY_WAIT') AND ("next_attempt_at" IS NULL OR "next_attempt_at" <= ${UTC_NOW}))
         OR ("status" = 'IN_PROGRESS' AND "lease_expires_at" < ${UTC_NOW})
       )
       ORDER BY "created_at", "id"
       FOR UPDATE SKIP LOCKED
       LIMIT 1
     )
     RETURNING "id", "run_id", "user_id", "phase", "attempts", "max_attempts", "planned_manifest", "audit_recorded"`,
    runId,
    owner,
    leaseMs,
  );
  return rows[0] ?? null;
}

async function heartbeat(itemId: string, owner: string, leaseMs: number, data: Prisma.PurgeItemUpdateManyMutationInput = {}): Promise<void> {
  const n = await db.purgeItem.updateMany({
    where: { id: itemId, leaseOwner: owner, status: "IN_PROGRESS" },
    data: { ...data, leaseExpiresAt: new Date(Date.now() + leaseMs) },
  });
  if (n.count !== 1) throw new LeaseLostError(itemId);
}

async function advancePhase(itemId: string, owner: string, leaseMs: number, phase: PurgePhase, current: { phase: string }): Promise<void> {
  if (phaseIndex(phase) <= phaseIndex(current.phase)) {
    await heartbeat(itemId, owner, leaseMs);
    return;
  }
  await heartbeat(itemId, owner, leaseMs, { phase });
  current.phase = phase;
}

// ---------------------------------------------------------------------------
// 工程1〜3: Object Storage
// ---------------------------------------------------------------------------

async function recordObjectTargets(itemId: string, bucket: string, targets: { objectKey: string; source: PurgeObjectSource }[]): Promise<number> {
  if (targets.length === 0) return 0;
  const r = await db.purgeItemObject.createMany({
    data: targets.map((t) => ({ itemId, bucket, objectKey: t.objectKey, objectKeyHash: hashObjectKey(bucket, t.objectKey), source: t.source })),
    skipDuplicates: true,
  });
  return r.count;
}

async function listPrefixes(store: PurgeObjectStore, workspaceIds: string[]): Promise<string[]> {
  const keys: string[] = [];
  for (const ws of workspaceIds) keys.push(...(await store.list(workspaceObjectPrefix(ws))));
  return keys;
}

/**
 * 工程1〜3。対象workspaceの接頭辞に残るobjectが0件、かつ台帳上の全objectが不存在に
 * なるまで削除・確認を繰り返す(上限VERIFY_ROUNDS)。確認できなければ例外(DBへ進まない)。
 */
async function runObjectPhase(params: {
  itemId: string;
  owner: string;
  leaseMs: number;
  store: PurgeObjectStore;
  workspaceIds: string[];
  dbObjectKeys: string[];
  current: { phase: string };
  lateSource?: boolean;
}): Promise<{ newlyRecorded: number }> {
  const { itemId, owner, leaseMs, store, workspaceIds, current } = params;
  // 1) snapshot
  const listed = await listPrefixes(store, workspaceIds);
  let newlyRecorded = await recordObjectTargets(itemId, store.bucket, mergeObjectTargets(params.dbObjectKeys, listed, params.lateSource ? "LATE_PREFIX_LISTING" : "PREFIX_LISTING"));
  if (!params.lateSource) await advancePhase(itemId, owner, leaseMs, "OBJECTS_SNAPSHOTTED", current);

  for (let round = 1; round <= VERIFY_ROUNDS; round++) {
    // 2) 削除(未確認のもの全て。前回試行で削除済みでも再度removeは無害)
    const pending = await db.purgeItemObject.findMany({ where: { itemId, bucket: store.bucket, status: { not: "VERIFIED_ABSENT" }, objectKey: { not: null } } });
    const pendingKeys = pending.map((o) => o.objectKey!).filter(Boolean);
    if (pendingKeys.length > 0) await store.remove(pendingKeys);
    if (pending.length > 0) {
      await db.purgeItemObject.updateMany({ where: { id: { in: pending.map((o) => o.id) } }, data: { status: "DELETED", deletedAt: new Date() } });
    }
    if (!params.lateSource) await advancePhase(itemId, owner, leaseMs, "OBJECTS_DELETED", current);
    else await heartbeat(itemId, owner, leaseMs);

    // 3) 不存在確認(台帳の全object + 接頭辞の再一覧)
    const all = await db.purgeItemObject.findMany({ where: { itemId, bucket: store.bucket, objectKey: { not: null } } });
    let remaining = 0;
    for (const o of all) if (await store.exists(o.objectKey!)) remaining++;
    const relisted = await listPrefixes(store, workspaceIds);
    const unknown = relisted.filter((k) => !all.some((o) => o.objectKey === k));
    if (remaining === 0 && relisted.length === 0) {
      await db.purgeItemObject.updateMany({ where: { itemId, bucket: store.bucket, status: { not: "VERIFIED_ABSENT" } }, data: { status: "VERIFIED_ABSENT", verifiedAt: new Date() } });
      if (!params.lateSource) await advancePhase(itemId, owner, leaseMs, "OBJECTS_VERIFIED", current);
      return { newlyRecorded };
    }
    if (unknown.length > 0) {
      // 接頭辞に新たなobjectが現れた(確認中のupload等)。台帳へ追加して次のroundで削除する。
      newlyRecorded += await recordObjectTargets(itemId, store.bucket, mergeObjectTargets([], unknown, params.lateSource ? "LATE_PREFIX_LISTING" : "PREFIX_LISTING"));
    }
    if (round === VERIFY_ROUNDS) throw new ObjectVerificationError(Math.max(remaining, relisted.length));
  }
  throw new ObjectVerificationError(-1);
}

// ---------------------------------------------------------------------------
// 監査記録(工程5)
// ---------------------------------------------------------------------------

async function recordAudit(
  itemId: string,
  context: PurgeRunContext,
  writer: PurgeAuditWriter,
  partial: Pick<PurgeItemOutcome, "userId" | "purgeStatus" | "purgeSucceeded" | "detail"> & Partial<PurgeItemOutcome>,
): Promise<boolean> {
  const outcome: PurgeItemOutcome = {
    totals: null,
    workspaceRowsDeleted: null,
    userRowsDeleted: null,
    anonymizedRows: null,
    digest: null,
    expectedDigest: null,
    driftCount: null,
    auditRecorded: false,
    auditError: null,
    ...partial,
  };
  try {
    await writer({ targetUserId: outcome.userId, result: outcome.purgeSucceeded ? "SUCCESS" : "FAILURE", reason: buildPurgeAuditReason(context, outcome) });
    await db.purgeItem.update({ where: { id: itemId }, data: { auditRecorded: true, auditError: null } });
    return true;
  } catch (err) {
    await db.purgeItem.update({ where: { id: itemId }, data: { auditRecorded: false, auditError: errorSummary(err) } }).catch(() => undefined);
    return false;
  }
}

// ---------------------------------------------------------------------------
// 1件処理
// ---------------------------------------------------------------------------

export interface ProcessPurgeItemDeps {
  store: PurgeObjectStore;
  context: PurgeRunContext;
  owner: string;
  leaseMs?: number;
  auditWriter?: PurgeAuditWriter;
  runOptions?: PurgeRunOptions;
}

export type ProcessPurgeItemResult = { itemId: string; status: PurgeItemStatus; phase: string; detail: string | null };

async function scheduleRetryOrDeadLetter(item: ClaimedItem, owner: string, reason: string, deps: ProcessPurgeItemDeps): Promise<ProcessPurgeItemResult> {
  const dead = item.attempts >= item.max_attempts;
  const status: PurgeItemStatus = dead ? "DEAD_LETTER" : "RETRY_WAIT";
  await db.purgeItem.updateMany({
    where: { id: item.id, leaseOwner: owner },
    data: {
      status,
      lastError: reason.slice(0, 1000),
      nextAttemptAt: dead ? null : new Date(Date.now() + purgeRetryDelayMs(item.attempts)),
      leaseOwner: null,
      leaseExpiresAt: null,
    },
  });
  const latest = await db.purgeItem.findUniqueOrThrow({ where: { id: item.id } });
  if (dead && !latest.auditRecorded && phaseIndex(latest.phase) < phaseIndex("DB_PURGED")) {
    await recordAudit(item.id, deps.context, deps.auditWriter ?? writePurgeAuditLog, {
      userId: item.user_id,
      purgeStatus: "ERROR",
      purgeSucceeded: false,
      detail: `item=${item.id} DEAD_LETTER(attempts=${item.attempts}) ${reason.slice(0, 300)}`,
    });
  }
  return { itemId: item.id, status, phase: latest.phase, detail: reason };
}

/** claim済みitemを、到達済みphaseの次の工程から完了まで進める(例外は投げない)。 */
export async function processPurgeItem(item: ClaimedItem, deps: ProcessPurgeItemDeps): Promise<ProcessPurgeItemResult> {
  const leaseMs = deps.leaseMs ?? DEFAULT_PURGE_LEASE_MS;
  const owner = deps.owner;
  const current = { phase: item.phase };
  const writer = deps.auditWriter ?? writePurgeAuditLog;
  try {
    // 工程1〜4(DB_PURGED未到達の場合のみ。到達済みならDB段は二度と実行しない)
    if (phaseIndex(current.phase) < phaseIndex("DB_PURGED")) {
      const expected = (item.planned_manifest ?? null) as PurgeManifest | null;
      const result = await executePurgeForUser(
        { userId: item.user_id },
        {
          ...(deps.runOptions ?? {}),
          expected,
          hooks: {
            beforeDatabaseMutation: async ({ workspaceIds, dbObjectKeys }) => {
              await runObjectPhase({ itemId: item.id, owner, leaseMs, store: deps.store, workspaceIds, dbObjectKeys, current });
            },
            beforeCommit: async (tx, { manifest, drift }) => {
              const n = await tx.purgeItem.updateMany({
                where: { id: item.id, leaseOwner: owner, status: "IN_PROGRESS" },
                data: { phase: "DB_PURGED", actualManifest: asJson(manifest), actualDigest: manifest.digest, driftCount: drift ? drift.length : null },
              });
              if (n.count !== 1) throw new LeaseLostError(item.id);
            },
          },
        },
      );
      if (result.status !== "PURGED") {
        if (result.status === "LOCK_CONFLICT") return await scheduleRetryOrDeadLetter(item, owner, `${result.status}: ${result.detail}`, deps);
        await db.purgeItem.updateMany({
          where: { id: item.id, leaseOwner: owner },
          data: { status: "SKIPPED", refusalStatus: result.status, refusalDetail: result.detail, leaseOwner: null, leaseExpiresAt: null },
        });
        await recordAudit(item.id, deps.context, writer, { userId: item.user_id, purgeStatus: result.status, purgeSucceeded: false, detail: `item=${item.id} ${result.detail}` });
        return { itemId: item.id, status: "SKIPPED", phase: current.phase, detail: `${result.status}: ${result.detail}` };
      }
      current.phase = "DB_PURGED";
    }

    const latest = await db.purgeItem.findUniqueOrThrow({ where: { id: item.id }, include: { _count: { select: { objects: true } } } });
    const manifest = latest.actualManifest as unknown as PurgeManifest | null;

    // 工程5: 監査記録(失敗しても削除結果は変えない。retryで監査だけをやり直す)
    if (!latest.auditRecorded) {
      const ok = await recordAudit(item.id, deps.context, writer, {
        userId: item.user_id,
        purgeStatus: "PURGED",
        purgeSucceeded: true,
        totals: manifest?.totals ?? null,
        workspaceRowsDeleted: manifest?.workspaceRowsDeleted ?? null,
        userRowsDeleted: manifest?.userRowsDeleted ?? null,
        anonymizedRows: manifest ? manifest.anonymizedReferences.reduce((s, u) => s + u.count, 0) : null,
        digest: latest.actualDigest,
        expectedDigest: latest.plannedDigest,
        driftCount: latest.driftCount,
        detail: `item=${item.id} objects=${latest._count.objects}`,
      });
      if (!ok) {
        const refreshed = await db.purgeItem.findUniqueOrThrow({ where: { id: item.id } });
        return await scheduleRetryOrDeadLetter(item, owner, `AUDIT_FAILED: ${refreshed.auditError ?? ""}`, deps);
      }
    }
    await advancePhase(item.id, owner, leaseMs, "AUDITED", current);

    // 工程6: commit後の遅延object再確認(lock解放後に現れたupload残骸)→ key墨消し → 完了
    const workspaceIds = manifest?.workspaceIds ?? [];
    const before = await db.purgeItemObject.count({ where: { itemId: item.id } });
    await runObjectPhase({ itemId: item.id, owner, leaseMs, store: deps.store, workspaceIds, dbObjectKeys: [], current, lateSource: true });
    const after = await db.purgeItemObject.count({ where: { itemId: item.id } });
    await db.purgeItemObject.updateMany({ where: { itemId: item.id }, data: { objectKey: null } });
    const n = await db.purgeItem.updateMany({
      where: { id: item.id, leaseOwner: owner, status: "IN_PROGRESS" },
      data: {
        status: "COMPLETED",
        phase: "COMPLETED",
        lateObjectsDeleted: { increment: after - before },
        completedAt: new Date(),
        leaseOwner: null,
        leaseExpiresAt: null,
        lastError: null,
        nextAttemptAt: null,
      },
    });
    if (n.count !== 1) throw new LeaseLostError(item.id);
    return { itemId: item.id, status: "COMPLETED", phase: "COMPLETED", detail: null };
  } catch (err) {
    if (err instanceof LeaseLostError) return { itemId: item.id, status: "IN_PROGRESS", phase: current.phase, detail: err.message };
    return await scheduleRetryOrDeadLetter(item, owner, errorSummary(err), deps);
  }
}

// ---------------------------------------------------------------------------
// Run処理・集計
// ---------------------------------------------------------------------------

export function newLeaseOwner(context: PurgeRunContext): string {
  return `${context.hostname}:${context.pid}:${randomUUID().slice(0, 8)}`;
}

export interface PurgeRunSummaryView {
  runId: string;
  runStatus: string;
  planDigest: string;
  byStatus: Record<string, number>;
  byPhase: Record<string, number>;
  auditPending: number;
  driftItems: number;
  lateObjectsDeleted: number;
  objectsVerifiedAbsent: number;
  exitCode: number;
}

export async function getPurgeRunSummary(runId: string): Promise<PurgeRunSummaryView> {
  const run = await db.purgeRun.findUniqueOrThrow({ where: { id: runId } });
  const items = await db.purgeItem.findMany({ where: { runId } });
  const byStatus: Record<string, number> = {};
  const byPhase: Record<string, number> = {};
  let auditPending = 0;
  let driftItems = 0;
  let lateObjectsDeleted = 0;
  for (const i of items) {
    byStatus[i.status] = (byStatus[i.status] ?? 0) + 1;
    byPhase[i.phase] = (byPhase[i.phase] ?? 0) + 1;
    if (!i.auditRecorded) auditPending++;
    if ((i.driftCount ?? 0) > 0) driftItems++;
    lateObjectsDeleted += i.lateObjectsDeleted;
  }
  const objectsVerifiedAbsent = await db.purgeItemObject.count({ where: { item: { runId }, status: "VERIFIED_ABSENT" } });
  let exitCode: number = PURGE_EXIT.OK;
  if (items.some((i) => i.status !== "COMPLETED")) exitCode |= PURGE_EXIT.NOT_PURGED;
  if (auditPending > 0) exitCode |= PURGE_EXIT.AUDIT_FAILED;
  return { runId, runStatus: run.status, planDigest: run.planDigest, byStatus, byPhase, auditPending, driftItems, lateObjectsDeleted, objectsVerifiedAbsent, exitCode };
}

/** 未完了itemが無くなったらRunを完了させる(COMPLETED/COMPLETED_WITH_EXCEPTIONS)。 */
export async function finalizePurgeRunIfDone(runId: string): Promise<string> {
  const open = await db.purgeItem.count({ where: { runId, status: { in: ["PENDING", "IN_PROGRESS", "RETRY_WAIT"] } } });
  const run = await db.purgeRun.findUniqueOrThrow({ where: { id: runId } });
  if (open > 0) return run.status;
  const notCompleted = await db.purgeItem.count({ where: { runId, OR: [{ status: { not: "COMPLETED" } }, { auditRecorded: false }] } });
  const status = notCompleted === 0 ? "COMPLETED" : "COMPLETED_WITH_EXCEPTIONS";
  await db.purgeRun.update({ where: { id: runId }, data: { status, finishedAt: run.finishedAt ?? new Date() } });
  return status;
}

export interface ProcessPurgeRunParams extends Omit<ProcessPurgeItemDeps, "owner"> {
  runId: string;
  /** 今回の呼出しで処理する最大件数(既定はrunのbatch_size)。 */
  limit?: number;
  onItem?: (result: ProcessPurgeItemResult, userId: string) => void;
}

/** runの実行可能itemをbatch size件まで順に処理する(再開時も同じ関数)。 */
export async function processPurgeRun(params: ProcessPurgeRunParams): Promise<PurgeRunSummaryView> {
  const run = await db.purgeRun.findUniqueOrThrow({ where: { id: params.runId } });
  const limit = params.limit ?? run.batchSize;
  const owner = newLeaseOwner(params.context);
  for (let processed = 0; processed < limit; processed++) {
    const item = await claimNextPurgeItem(params.runId, owner, params.leaseMs ?? DEFAULT_PURGE_LEASE_MS);
    if (!item) break;
    const result = await processPurgeItem(item, { ...params, owner });
    params.onItem?.(result, item.user_id);
  }
  await finalizePurgeRunIfDone(params.runId);
  return getPurgeRunSummary(params.runId);
}
