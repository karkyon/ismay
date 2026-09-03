/**
 * PEM Projection Recompute Queue(PEM-RECOMPUTE-QUEUE新設・2026-09-03)。
 * 出典: ISMAY_統合正本仕様書_v5_0 §22.3「Recompute QueueはPENDING/PROCESSING
 * だけを対象とする部分一意制約、FOR UPDATE SKIP LOCKED、lease、heartbeat、
 * 指数backoff、attempt上限、dead letter、generationを持つ。coalescing時に
 * generationを増加し、古いWorker結果をcommitさせない。」、DOC-05
 * (Execution Event・Session Projection仕様書) 8章「Projection Jobは
 * (workspaceId,responsibilityId,sourceGlobalSequence,derivationVersion)で
 * 冪等。障害時は最後の成功checkpointから再開。新Correctionは影響範囲を
 * mark staleし、read APIはprojectionStatus=FRESH/STALE/REBUILDING/FAILED
 * を返す。再計算中も原Eventを表示可能にする。」
 *
 * [scope宣言] このファイルはqueue管理層(enqueue/claim/complete/fail/status)
 * のみを実装する。実際の再計算アルゴリズムは既存のsessionPersistence.ts
 * projectAndPersistExecutionSessions(insert-only・内容不変なら追記しない)を
 * そのまま呼び出す(recomputeQueueJob.ts参照。想像で新しい再計算アルゴリズムを
 * 作らない)。
 *
 * [設計判断・FOR UPDATE SKIP LOCKED] shadow checkpoint(shadowCheckpoint.ts)は
 * updateManyのWHERE句自体をCASとして使う軽量な方式だったが、正本§22.3は
 * 「FOR UPDATE SKIP LOCKED」を名指しで要求している(複数Workerが同時に
 * バッチclaimする場合、単純CASより行ロック粒度の競合が少ない)。このGateでは
 * 正本の文言通り生SQLでFOR UPDATE SKIP LOCKEDを使う。
 */
import { db } from "@/lib/db";
import type { Prisma } from "@/generated/prisma/client";
import { createHash } from "node:crypto";

export const RECOMPUTE_PROJECTION_TYPES = ["EXECUTION_SESSION"] as const;
export type RecomputeProjectionType = (typeof RECOMPUTE_PROJECTION_TYPES)[number];

export const RECOMPUTE_REASON_CODES = [
  "CORRECTION",
  "DELAYED_EVENT",
  "MANUAL_REBUILD",
  "DERIVATION_VERSION_CHANGE",
] as const;
export type RecomputeReasonCode = (typeof RECOMPUTE_REASON_CODES)[number];

export const RECOMPUTE_JOB_STATUSES = ["PENDING", "PROCESSING", "DONE", "FAILED", "DEAD_LETTER"] as const;
export type RecomputeJobStatus = (typeof RECOMPUTE_JOB_STATUSES)[number];

/** DOC-05 8章のread API契約。latest job行が無い(=一度もmark staleされていない)場合はFRESH。 */
export const PROJECTION_STATUS_VALUES = ["FRESH", "STALE", "REBUILDING", "FAILED"] as const;
export type ProjectionStatus = (typeof PROJECTION_STATUS_VALUES)[number];

const LEASE_MS = 5 * 60 * 1000; // 5分。単一Responsibilityの再投影は短時間で終わるため十分に長く取る。
const BASE_BACKOFF_MS = 30 * 1000; // 30秒(shadowCheckpoint.tsと同じ基準値)。

/** 30s, 60s, 120s, ... 最大30分でcap(shadowCheckpoint.ts backoffMsと同じ方針)。 */
function backoffMs(attempt: number): number {
  return Math.min(BASE_BACKOFF_MS * 2 ** Math.max(0, attempt - 1), 30 * 60 * 1000);
}

function classifyError(err: unknown): { code: string; digest: string } {
  const message = err instanceof Error ? err.message : String(err);
  return { code: message.slice(0, 100), digest: createHash("sha256").update(message).digest("hex").slice(0, 16) };
}

export interface EnqueueRecomputeParams {
  workspaceId: string;
  responsibilityId: string;
  subjectUserId: string;
  derivationVersion: string;
  projectionType?: RecomputeProjectionType;
  reasonCode: RecomputeReasonCode;
}

export interface EnqueueRecomputeResult {
  id: string;
  generation: number;
  /** trueの場合、既存のPENDING/PROCESSING行のgenerationを増やしただけ(新規行は作られていない)。 */
  coalesced: boolean;
}

/**
 * 「影響範囲をmark stale」する。既にPENDING/PROCESSINGの行があれば
 * generationを増やして前倒しする(coalescing、正本§22.3)。無ければ新規PENDING行を作る。
 * 呼び出し元の既存transaction(tx)の中で呼ぶ想定(Correction等と原子的に記録するため)。
 * txを渡さない場合はdb直下で単発transactionとして実行する(MANUAL_REBUILD等)。
 */
export async function enqueueRecompute(
  txOrDb: Prisma.TransactionClient | typeof db,
  params: EnqueueRecomputeParams,
): Promise<EnqueueRecomputeResult> {
  const projectionType = params.projectionType ?? "EXECUTION_SESSION";

  const existing = await txOrDb.projectionRecomputeJob.findFirst({
    where: {
      workspaceId: params.workspaceId,
      responsibilityId: params.responsibilityId,
      projectionType,
      status: { in: ["PENDING", "PROCESSING"] },
    },
  });

  if (existing) {
    const updated = await txOrDb.projectionRecomputeJob.update({
      where: { id: existing.id },
      data: {
        generation: { increment: 1 },
        reasonCode: params.reasonCode,
        // PENDING行はqueue先頭へ前倒しする。PROCESSING行はcomplete時に
        // generation不一致を検出して自動的にPENDINGへ差し戻される(下記completeRecomputeJob参照)。
        ...(existing.status === "PENDING" ? { nextAttemptAt: new Date() } : {}),
      },
    });
    return { id: updated.id, generation: updated.generation, coalesced: true };
  }

  try {
    const created = await txOrDb.projectionRecomputeJob.create({
      data: {
        workspaceId: params.workspaceId,
        responsibilityId: params.responsibilityId,
        subjectUserId: params.subjectUserId,
        projectionType,
        status: "PENDING",
        generation: 1,
        attempt: 0,
        nextAttemptAt: new Date(),
        derivationVersion: params.derivationVersion,
        reasonCode: params.reasonCode,
      },
    });
    return { id: created.id, generation: created.generation, coalesced: false };
  } catch (err) {
    // [並行競合対策] 部分一意制約(projection_recompute_jobs_active_uq)により、
    // findFirstとcreateの間に別tx/リクエストが同一キーで先にPENDING行を作成した
    // 場合、P2002になり得る。その場合はcoalesceへフォールバックする。
    if ((err as { code?: string }).code === "P2002") {
      const raceWinner = await txOrDb.projectionRecomputeJob.findFirst({
        where: {
          workspaceId: params.workspaceId,
          responsibilityId: params.responsibilityId,
          projectionType,
          status: { in: ["PENDING", "PROCESSING"] },
        },
      });
      if (raceWinner) {
        const updated = await txOrDb.projectionRecomputeJob.update({
          where: { id: raceWinner.id },
          data: {
            generation: { increment: 1 },
            reasonCode: params.reasonCode,
            ...(raceWinner.status === "PENDING" ? { nextAttemptAt: new Date() } : {}),
          },
        });
        return { id: updated.id, generation: updated.generation, coalesced: true };
      }
    }
    throw err;
  }
}

export interface ClaimedRecomputeJob {
  id: string;
  workspaceId: string;
  responsibilityId: string;
  subjectUserId: string;
  projectionType: string;
  generation: number;
  attempt: number;
  maxAttempts: number;
}

/**
 * PENDING(next_attempt_at到来分)、またはlease切れのPROCESSING(crashしたWorkerの
 * 孤立行)を、FOR UPDATE SKIP LOCKEDでバッチclaimする(正本§22.3)。
 * 複数Worker/複数プロセスから同時に呼ばれてもロック済み行はSKIPされるため
 * 重複claimしない。
 */
export async function claimRecomputeJobs(workerId: string, limit = 10): Promise<ClaimedRecomputeJob[]> {
  return db.$transaction(async (tx: Prisma.TransactionClient): Promise<ClaimedRecomputeJob[]> => {
    const now = new Date();
    const rows = await tx.$queryRaw<{ id: string }[]>`
      SELECT "id" FROM "projection_recompute_jobs"
      WHERE ("status" = 'PENDING' AND "next_attempt_at" <= ${now})
         OR ("status" = 'PROCESSING' AND "lease_expires_at" < ${now})
      ORDER BY "next_attempt_at" ASC
      LIMIT ${limit}
      FOR UPDATE SKIP LOCKED
    `;
    if (rows.length === 0) return [];

    const leaseExpiresAt = new Date(now.getTime() + LEASE_MS);
    const claimed: ClaimedRecomputeJob[] = [];
    for (const row of rows) {
      const updated = await tx.projectionRecomputeJob.update({
        where: { id: row.id },
        data: {
          status: "PROCESSING",
          leaseOwner: workerId,
          leaseExpiresAt,
          attempt: { increment: 1 },
        },
      });
      claimed.push({
        id: updated.id,
        workspaceId: updated.workspaceId,
        responsibilityId: updated.responsibilityId,
        subjectUserId: updated.subjectUserId,
        projectionType: updated.projectionType,
        generation: updated.generation,
        attempt: updated.attempt,
        maxAttempts: updated.maxAttempts,
      });
    }
    return claimed;
  });
}

/**
 * 再計算成功時。claim時点のgenerationと現在のgenerationが一致していれば
 * DONEへ確定する。処理中にenqueueRecomputeでcoalescingされていた(=generationが
 * 進んでいた)場合は、正本§22.3「古いWorker結果をcommitさせない」に従い
 * DONEにせずPENDINGへ差し戻す(次回claimで最新状態を前提に再計算させる。
 * 実処理自体はDBの最新状態を都度読むため、この場合でも直前の結果自体が
 * 誤りというわけではないが、mark staleされた「新しい理由」に対する再計算を
 * 保証するため確実側に倒す)。
 */
export async function completeRecomputeJob(
  jobId: string,
  observedGeneration: number,
  checkpointSequence: number | null,
): Promise<{ status: "DONE" | "PENDING" }> {
  // [是正・2026-09-03] 実Prisma Client(7.9.1)の$transaction<T>は、コールバックに
  // 明示的な戻り値型注釈が無いと、複数のreturn文(オブジェクトリテラル)から
  // 個別に幅広い型(status: string)を推論してしまい、外側の関数シグネチャ
  // Promise<{status:"DONE"|"PENDING"}>との間でTS2322になる(sandboxのany型
  // Prismaスタブでは$transaction自体がanyのため検出できず、実サーバーでの
  // tsc実行で初めて顕在化した)。コールバック自体に戻り値型を明示することで
  // 各return文がこの型へ直接contextually typedされ、想像に頼らず解消する。
  return db.$transaction(async (tx: Prisma.TransactionClient): Promise<{ status: "DONE" | "PENDING" }> => {
    const current = await tx.projectionRecomputeJob.findUnique({ where: { id: jobId } });
    if (!current) return { status: "DONE" };

    if (current.generation !== observedGeneration) {
      await tx.projectionRecomputeJob.update({
        where: { id: jobId },
        data: { status: "PENDING", leaseOwner: null, leaseExpiresAt: null, nextAttemptAt: new Date() },
      });
      return { status: "PENDING" };
    }

    await tx.projectionRecomputeJob.update({
      where: { id: jobId },
      data: {
        status: "DONE",
        completedAt: new Date(),
        leaseOwner: null,
        leaseExpiresAt: null,
        lastCheckpointSequence: checkpointSequence,
      },
    });
    return { status: "DONE" };
  });
}

/**
 * 再計算失敗時。attempt(claim時に既に+1済み)がmaxAttemptsへ到達していれば
 * DEAD_LETTERへ確定する(正本§22.3「attempt上限、dead letter」)。
 * それ未満なら指数backoffでPENDINGへ戻す。
 */
export async function failRecomputeJob(
  jobId: string,
  err: unknown,
): Promise<{ status: "PENDING" | "DEAD_LETTER" }> {
  const { code, digest } = classifyError(err);
  // [是正・2026-09-03] completeRecomputeJobと同じ理由でコールバック自体に
  // 戻り値型を明示する。
  return db.$transaction(async (tx: Prisma.TransactionClient): Promise<{ status: "PENDING" | "DEAD_LETTER" }> => {
    const current = await tx.projectionRecomputeJob.findUnique({ where: { id: jobId } });
    if (!current) return { status: "PENDING" };

    if (current.attempt >= current.maxAttempts) {
      await tx.projectionRecomputeJob.update({
        where: { id: jobId },
        data: {
          status: "DEAD_LETTER",
          lastErrorCode: code,
          lastErrorDigest: digest,
          leaseOwner: null,
          leaseExpiresAt: null,
          completedAt: new Date(),
        },
      });
      return { status: "DEAD_LETTER" };
    }

    await tx.projectionRecomputeJob.update({
      where: { id: jobId },
      data: {
        status: "PENDING",
        nextAttemptAt: new Date(Date.now() + backoffMs(current.attempt)),
        lastErrorCode: code,
        lastErrorDigest: digest,
        leaseOwner: null,
        leaseExpiresAt: null,
      },
    });
    return { status: "PENDING" };
  });
}

/**
 * DOC-05 8章のread API契約。latest job行のstatusから機械的に導出する
 * (一度もmark staleされたことがなければFRESH)。
 */
export async function getProjectionStatus(
  workspaceId: string,
  responsibilityId: string,
  projectionType: RecomputeProjectionType = "EXECUTION_SESSION",
): Promise<ProjectionStatus> {
  const latest = await db.projectionRecomputeJob.findFirst({
    where: { workspaceId, responsibilityId, projectionType },
    orderBy: { createdAt: "desc" },
    select: { status: true },
  });
  if (!latest) return "FRESH";
  switch (latest.status) {
    case "PENDING":
      return "STALE";
    case "PROCESSING":
      return "REBUILDING";
    case "DEAD_LETTER":
    case "FAILED":
      return "FAILED";
    default:
      return "FRESH";
  }
}
