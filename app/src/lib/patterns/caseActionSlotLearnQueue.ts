/**
 * Case Pattern ActionSlot Learn Queue(PATTERN-ACTIONSLOT-LEARN-01新設・
 * 2026-09-17)。
 * 出典: Claude向け_ISMAY_d68e9bf以降_ActionSlot正本準拠・CasePattern実分解
 * 完遂・残工程連続実装指示_2026-09-17.md Gate 5。
 *
 * [設計判断] caseDetectQueue.ts(CasePatternDetectJob)と同一の状態機械設計
 * (PENDING/PROCESSING/DONE/FAILED/DEAD_LETTER、部分unique indexによる
 * 「アクティブJobは1件まで」、coalescing時のgeneration増加、FOR UPDATE
 * SKIP LOCKEDでのバッチclaim、指数backoff、attempt上限でのdead letter)を、
 * ActionSlot学習の単位(workspaceId, patternId)向けに再実装したもの。
 * caseDetectQueueとの統合(汎用queueテーブル化)は将来の別Gateで検討する
 * (caseDetectQueue.tsの既存コメントと同じ先送り方針)。
 *
 * [scope宣言] このファイルはqueue管理層(enqueue/claim/complete/fail)のみを
 * 実装する。実際の学習アルゴリズム(grouping・統計算出)は
 * casePatternActionSlotLearnService.tsで実装する(想像で先行実装しない)。
 */
import { db } from "@/lib/db";
import type { Prisma } from "@/generated/prisma/client";
import { createHash } from "node:crypto";

/**
 * 本Gateで配線する唯一のreason。splitFormationCandidateがattributedCasePatternId
 * 付きでSPLITを確定した直後にenqueueする(casePatternTriggers.tsと同じ
 * 「欠落enqueue契機を都度追加する」方針)。MANUAL_REBUILD等はGate 10で追加する。
 */
export const CASE_PATTERN_ACTION_SLOT_LEARN_REASON_CODES = ["SPLIT_ATTRIBUTED"] as const;
export type CasePatternActionSlotLearnReasonCode = (typeof CASE_PATTERN_ACTION_SLOT_LEARN_REASON_CODES)[number];

export const CASE_PATTERN_ACTION_SLOT_LEARN_JOB_STATUSES = ["PENDING", "PROCESSING", "DONE", "FAILED", "DEAD_LETTER"] as const;
export type CasePatternActionSlotLearnJobStatus = (typeof CASE_PATTERN_ACTION_SLOT_LEARN_JOB_STATUSES)[number];

/**
 * caseActionSlotLearnQueueJob.tsがclaim済みJobのid/generationを、学習の
 * DB確定処理へ引き渡すための共有型(caseDetectQueue.tsのCaseDetectJobGenerationContext
 * と同じ設計)。直接呼び出し元(verify script等)には存在しないため、各関数側
 * ではoptionalとして扱う。
 */
export interface CaseActionSlotLearnJobGenerationContext {
  jobId: string;
  generation: number;
}

export class CaseActionSlotLearnJobGenerationStaleError extends Error {
  constructor(jobId: string, expectedGeneration: number, actualGeneration: number | null) {
    super(
      `CasePatternActionSlotLearnJob(id=${jobId})のgenerationが処理中に更新されました` +
        `(claim時=${expectedGeneration}, 現在=${actualGeneration ?? "行が存在しない"})。` +
        `このtransactionの副作用はcommitせず、旧generationの結果は破棄します。`,
    );
    this.name = "CaseActionSlotLearnJobGenerationStaleError";
  }
}

/**
 * 呼び出し元の既存transaction(tx)の先頭で呼ぶ。`SELECT ... FOR UPDATE`で
 * 対象Jobの行をlockし、claim時のgenerationと現在のgenerationが一致するかを
 * 検証する(caseDetectQueue.ts::assertCaseDetectJobGenerationCurrentと同じ
 * 設計、03Cで確立したgeneration原子性パターンをこのqueueにも適用する)。
 */
export async function assertCaseActionSlotLearnJobGenerationCurrent(
  tx: Prisma.TransactionClient,
  jobId: string,
  expectedGeneration: number,
): Promise<void> {
  const rows = await tx.$queryRaw<{ generation: number }[]>`
    SELECT "generation" FROM "case_pattern_action_slot_learn_jobs" WHERE "id" = ${jobId} FOR UPDATE
  `;
  const current = rows[0]?.generation ?? null;
  if (current === null || current !== expectedGeneration) {
    throw new CaseActionSlotLearnJobGenerationStaleError(jobId, expectedGeneration, current);
  }
}

/** CaseActionSlotLearnJobGenerationStaleError検出時にworkerから呼ぶ。backoff・attempt増加なしで即座にPENDINGへ戻す。 */
export async function requeueCaseActionSlotLearnJobForStaleGeneration(jobId: string): Promise<{ status: "PENDING" }> {
  await db.casePatternActionSlotLearnJob.update({
    where: { id: jobId },
    data: { status: "PENDING", leaseOwner: null, leaseExpiresAt: null, nextAttemptAt: new Date() },
  });
  return { status: "PENDING" };
}

const LEASE_MS = 5 * 60 * 1000;
const BASE_BACKOFF_MS = 30 * 1000;

/** recomputeQueue.ts/caseDetectQueue.tsと同じ方針: 30s, 60s, 120s, ... 最大30分でcap。 */
function backoffMs(attempt: number): number {
  return Math.min(BASE_BACKOFF_MS * 2 ** Math.max(0, attempt - 1), 30 * 60 * 1000);
}

function classifyError(err: unknown): { code: string; digest: string } {
  const message = err instanceof Error ? err.message : String(err);
  return { code: message.slice(0, 100), digest: createHash("sha256").update(message).digest("hex").slice(0, 16) };
}

export interface EnqueueCaseActionSlotLearnParams {
  workspaceId: string;
  patternId: string;
  reasonCode: CasePatternActionSlotLearnReasonCode;
}

export interface EnqueueCaseActionSlotLearnResult {
  id: string;
  generation: number;
  /** trueの場合、既存のPENDING/PROCESSING行のgenerationを増やしただけ(新規行は作られていない)。 */
  coalesced: boolean;
}

/**
 * このPattern(patternId)向けのActionSlot学習を「要再実行」としてmarkする。
 * 既にPENDING/PROCESSINGの行があればgenerationを増やして前倒しする
 * (coalescing、caseDetectQueue.ts::enqueueCaseDetectと同じ設計)。呼び出し元の
 * 既存transaction(tx)の中で呼ぶ想定(SPLIT確定と原子的に記録するため)。
 */
export async function enqueueCaseActionSlotLearn(
  txOrDb: Prisma.TransactionClient | typeof db,
  params: EnqueueCaseActionSlotLearnParams,
): Promise<EnqueueCaseActionSlotLearnResult> {
  const existing = await txOrDb.casePatternActionSlotLearnJob.findFirst({
    where: {
      workspaceId: params.workspaceId,
      patternId: params.patternId,
      status: { in: ["PENDING", "PROCESSING"] },
    },
  });

  if (existing) {
    const updated = await txOrDb.casePatternActionSlotLearnJob.update({
      where: { id: existing.id },
      data: {
        generation: { increment: 1 },
        reasonCode: params.reasonCode,
        ...(existing.status === "PENDING" ? { nextAttemptAt: new Date() } : {}),
      },
    });
    return { id: updated.id, generation: updated.generation, coalesced: true };
  }

  try {
    const created = await txOrDb.casePatternActionSlotLearnJob.create({
      data: {
        workspaceId: params.workspaceId,
        patternId: params.patternId,
        status: "PENDING",
        generation: 1,
        attempt: 0,
        nextAttemptAt: new Date(),
        reasonCode: params.reasonCode,
      },
    });
    return { id: created.id, generation: created.generation, coalesced: false };
  } catch (err) {
    // [並行競合対策] recomputeQueue.ts/caseDetectQueue.tsと同じフォールバック。
    if ((err as { code?: string }).code === "P2002") {
      const raceWinner = await txOrDb.casePatternActionSlotLearnJob.findFirst({
        where: {
          workspaceId: params.workspaceId,
          patternId: params.patternId,
          status: { in: ["PENDING", "PROCESSING"] },
        },
      });
      if (raceWinner) {
        const updated = await txOrDb.casePatternActionSlotLearnJob.update({
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

export interface ClaimedCaseActionSlotLearnJob {
  id: string;
  workspaceId: string;
  patternId: string;
  generation: number;
  attempt: number;
  maxAttempts: number;
}

/**
 * PENDING(next_attempt_at到来分)、またはlease切れのPROCESSING(crashしたWorkerの
 * 孤立行)を、FOR UPDATE SKIP LOCKEDでバッチclaimする(caseDetectQueue.ts::
 * claimCaseDetectJobsと同一設計)。
 */
export async function claimCaseActionSlotLearnJobs(workerId: string, limit = 10): Promise<ClaimedCaseActionSlotLearnJob[]> {
  return db.$transaction(async (tx: Prisma.TransactionClient): Promise<ClaimedCaseActionSlotLearnJob[]> => {
    const now = new Date();
    const rows = await tx.$queryRaw<{ id: string }[]>`
      SELECT "id" FROM "case_pattern_action_slot_learn_jobs"
      WHERE ("status" = 'PENDING' AND "next_attempt_at" <= ${now})
         OR ("status" = 'PROCESSING' AND "lease_expires_at" < ${now})
      ORDER BY "next_attempt_at" ASC
      LIMIT ${limit}
      FOR UPDATE SKIP LOCKED
    `;
    if (rows.length === 0) return [];

    const leaseExpiresAt = new Date(now.getTime() + LEASE_MS);
    const claimed: ClaimedCaseActionSlotLearnJob[] = [];
    for (const row of rows) {
      const updated = await tx.casePatternActionSlotLearnJob.update({
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
        patternId: updated.patternId,
        generation: updated.generation,
        attempt: updated.attempt,
        maxAttempts: updated.maxAttempts,
      });
    }
    return claimed;
  });
}

/**
 * 学習処理成功時。claim時点のgenerationと現在のgenerationが一致していれば
 * DONEへ確定する。処理中にenqueueCaseActionSlotLearnでcoalescingされていた
 * 場合は、古いWorker結果をcommitさせずPENDINGへ差し戻す
 * (caseDetectQueue.ts::completeCaseDetectJobと同じ設計)。
 */
export async function completeCaseActionSlotLearnJob(
  jobId: string,
  observedGeneration: number,
): Promise<{ status: "DONE" | "PENDING" }> {
  return db.$transaction(async (tx: Prisma.TransactionClient): Promise<{ status: "DONE" | "PENDING" }> => {
    const current = await tx.casePatternActionSlotLearnJob.findUnique({ where: { id: jobId } });
    if (!current) return { status: "DONE" };

    if (current.generation !== observedGeneration) {
      await tx.casePatternActionSlotLearnJob.update({
        where: { id: jobId },
        data: { status: "PENDING", leaseOwner: null, leaseExpiresAt: null, nextAttemptAt: new Date() },
      });
      return { status: "PENDING" };
    }

    await tx.casePatternActionSlotLearnJob.update({
      where: { id: jobId },
      data: { status: "DONE", completedAt: new Date(), leaseOwner: null, leaseExpiresAt: null },
    });
    return { status: "DONE" };
  });
}

/**
 * 学習処理失敗時。attempt(claim時に既に+1済み)がmaxAttemptsへ到達していれば
 * DEAD_LETTERへ確定する。それ未満なら指数backoffでPENDINGへ戻す
 * (caseDetectQueue.ts::failCaseDetectJobと同じ設計)。
 */
export async function failCaseActionSlotLearnJob(
  jobId: string,
  err: unknown,
): Promise<{ status: "PENDING" | "DEAD_LETTER" }> {
  const { code, digest } = classifyError(err);
  return db.$transaction(async (tx: Prisma.TransactionClient): Promise<{ status: "PENDING" | "DEAD_LETTER" }> => {
    const current = await tx.casePatternActionSlotLearnJob.findUnique({ where: { id: jobId } });
    if (!current) return { status: "PENDING" };

    if (current.attempt >= current.maxAttempts) {
      await tx.casePatternActionSlotLearnJob.update({
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

    await tx.casePatternActionSlotLearnJob.update({
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
