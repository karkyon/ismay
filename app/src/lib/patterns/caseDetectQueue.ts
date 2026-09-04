/**
 * Case Pattern Detect Queue(PATTERN-DETECT-01B新設・2026-09-03)。
 * 出典: Claude向け_ISMAY_0fcea2b以降_再監査是正・PATTERN-DETECT連続実装指示_2026-09-03.md
 * §6 PATTERN-DETECT-01B「既存ProjectionRecomputeJobのlease、heartbeat、
 * coalescing、generation、retry、dead-letterを再利用する」。
 *
 * [設計判断] app/src/lib/pem/recomputeQueue.tsと同一の状態機械設計
 * (PENDING/PROCESSING/DONE/FAILED/DEAD_LETTER、部分unique indexによる
 * 「アクティブJobは1件まで」、coalescing時のgeneration増加、FOR UPDATE
 * SKIP LOCKEDでのバッチclaim、claim時と完了時のgeneration不一致検出、
 * 指数backoff、attempt上限でのdead letter)を、Case Pattern検出の単位
 * (workspaceId, ownerSubjectUserId)向けに再実装したもの。
 * schema.prisma CasePatternDetectJobモデルのコメントに記載の通り、queue
 * テーブル自体をProjectionRecomputeJobと統合するかは将来の別Gateで検討する。
 *
 * [scope宣言] このファイルはqueue管理層(enqueue/claim/complete/fail)のみを
 * 実装する。実際の検出アルゴリズム(集計・クラスタリング)は
 * PATTERN-DETECT-01C/01Dで実装する(app/src/lib/worker/caseDetectQueueJob.ts
 * のno-opプレースホルダハンドラ参照。想像で先行実装しない)。
 */
import { db } from "@/lib/db";
import type { Prisma } from "@/generated/prisma/client";
import { createHash } from "node:crypto";

/**
 * [PATTERN-DETECT-02B拡張・2026-09-04] PRIMARY link作成・解除に加え、
 * Pattern入力(Responsibility.title等)に影響するCorrection、Evidence
 * (Responsibility)削除の2種を追加する。出典: Claude向け_ISMAY_3b695d9以降_
 * 再監査是正・CasePattern実機能完遂指示_2026-09-04.md §4 reason一覧。
 * PATTERN_REVISION_CHANGED/EMBEDDING_MODEL_CHANGED/
 * EMBEDDING_SOURCE_VERSION_CHANGED/MANUAL_REBUILDは、対応するtrigger配線元
 * (Pattern編集API・AI Provider設定変更経路・管理操作)の個別精査が別途必要
 * なため本Gateでは追加しない(想像で先行実装しない、次Gateで追加)。
 */
export const CASE_PATTERN_DETECT_REASON_CODES = [
  "PRIMARY_LINKED",
  "PRIMARY_UNLINKED",
  "RESPONSIBILITY_CORRECTED",
  "EVIDENCE_EXCLUDED",
] as const;
export type CasePatternDetectReasonCode = (typeof CASE_PATTERN_DETECT_REASON_CODES)[number];

export const CASE_PATTERN_DETECT_JOB_STATUSES = ["PENDING", "PROCESSING", "DONE", "FAILED", "DEAD_LETTER"] as const;
export type CasePatternDetectJobStatus = (typeof CASE_PATTERN_DETECT_JOB_STATUSES)[number];

const LEASE_MS = 5 * 60 * 1000;
const BASE_BACKOFF_MS = 30 * 1000;

/** recomputeQueue.tsと同じ方針: 30s, 60s, 120s, ... 最大30分でcap。 */
function backoffMs(attempt: number): number {
  return Math.min(BASE_BACKOFF_MS * 2 ** Math.max(0, attempt - 1), 30 * 60 * 1000);
}

function classifyError(err: unknown): { code: string; digest: string } {
  const message = err instanceof Error ? err.message : String(err);
  return { code: message.slice(0, 100), digest: createHash("sha256").update(message).digest("hex").slice(0, 16) };
}

export interface EnqueueCaseDetectParams {
  workspaceId: string;
  ownerSubjectUserId: string;
  reasonCode: CasePatternDetectReasonCode;
}

export interface EnqueueCaseDetectResult {
  id: string;
  generation: number;
  /** trueの場合、既存のPENDING/PROCESSING行のgenerationを増やしただけ(新規行は作られていない)。 */
  coalesced: boolean;
}

/**
 * この本人(ownerSubjectUserId)向けのCase Pattern検出を「要再実行」としてmarkする。
 * 既にPENDING/PROCESSINGの行があればgenerationを増やして前倒しする(coalescing)。
 * 呼び出し元の既存transaction(tx)の中で呼ぶ想定(Link作成/解除と原子的に記録するため)。
 */
export async function enqueueCaseDetect(
  txOrDb: Prisma.TransactionClient | typeof db,
  params: EnqueueCaseDetectParams,
): Promise<EnqueueCaseDetectResult> {
  const existing = await txOrDb.casePatternDetectJob.findFirst({
    where: {
      workspaceId: params.workspaceId,
      ownerSubjectUserId: params.ownerSubjectUserId,
      status: { in: ["PENDING", "PROCESSING"] },
    },
  });

  if (existing) {
    const updated = await txOrDb.casePatternDetectJob.update({
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
    const created = await txOrDb.casePatternDetectJob.create({
      data: {
        workspaceId: params.workspaceId,
        ownerSubjectUserId: params.ownerSubjectUserId,
        status: "PENDING",
        generation: 1,
        attempt: 0,
        nextAttemptAt: new Date(),
        reasonCode: params.reasonCode,
      },
    });
    return { id: created.id, generation: created.generation, coalesced: false };
  } catch (err) {
    // [並行競合対策] recomputeQueue.tsと同じフォールバック。部分一意制約
    // (case_pattern_detect_jobs_active_uq)により、findFirstとcreateの間に
    // 別tx/リクエストが同一キーで先にPENDING行を作成した場合はP2002になり
    // 得るため、その場合はcoalesceへフォールバックする。
    if ((err as { code?: string }).code === "P2002") {
      const raceWinner = await txOrDb.casePatternDetectJob.findFirst({
        where: {
          workspaceId: params.workspaceId,
          ownerSubjectUserId: params.ownerSubjectUserId,
          status: { in: ["PENDING", "PROCESSING"] },
        },
      });
      if (raceWinner) {
        const updated = await txOrDb.casePatternDetectJob.update({
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

export interface ClaimedCaseDetectJob {
  id: string;
  workspaceId: string;
  ownerSubjectUserId: string;
  generation: number;
  attempt: number;
  maxAttempts: number;
}

/**
 * PENDING(next_attempt_at到来分)、またはlease切れのPROCESSING(crashしたWorkerの
 * 孤立行)を、FOR UPDATE SKIP LOCKEDでバッチclaimする(recomputeQueue.tsと同一設計)。
 * 複数Worker/複数プロセスから同時に呼ばれても重複claimしない(二重workerでも
 * 1件だけclaim、PATTERN-DETECT-01B受入条件)。
 */
export async function claimCaseDetectJobs(workerId: string, limit = 10): Promise<ClaimedCaseDetectJob[]> {
  return db.$transaction(async (tx: Prisma.TransactionClient): Promise<ClaimedCaseDetectJob[]> => {
    const now = new Date();
    const rows = await tx.$queryRaw<{ id: string }[]>`
      SELECT "id" FROM "case_pattern_detect_jobs"
      WHERE ("status" = 'PENDING' AND "next_attempt_at" <= ${now})
         OR ("status" = 'PROCESSING' AND "lease_expires_at" < ${now})
      ORDER BY "next_attempt_at" ASC
      LIMIT ${limit}
      FOR UPDATE SKIP LOCKED
    `;
    if (rows.length === 0) return [];

    const leaseExpiresAt = new Date(now.getTime() + LEASE_MS);
    const claimed: ClaimedCaseDetectJob[] = [];
    for (const row of rows) {
      const updated = await tx.casePatternDetectJob.update({
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
        ownerSubjectUserId: updated.ownerSubjectUserId,
        generation: updated.generation,
        attempt: updated.attempt,
        maxAttempts: updated.maxAttempts,
      });
    }
    return claimed;
  });
}

/**
 * 検出処理成功時。claim時点のgenerationと現在のgenerationが一致していれば
 * DONEへ確定する。処理中にenqueueCaseDetectでcoalescingされていた(=generation
 * が進んでいた)場合は、古いWorker結果をcommitさせずPENDINGへ差し戻す
 * (PD-07「generation更新後、旧worker結果のcommit0」)。
 */
export async function completeCaseDetectJob(
  jobId: string,
  observedGeneration: number,
): Promise<{ status: "DONE" | "PENDING" }> {
  return db.$transaction(async (tx: Prisma.TransactionClient): Promise<{ status: "DONE" | "PENDING" }> => {
    const current = await tx.casePatternDetectJob.findUnique({ where: { id: jobId } });
    if (!current) return { status: "DONE" };

    if (current.generation !== observedGeneration) {
      await tx.casePatternDetectJob.update({
        where: { id: jobId },
        data: { status: "PENDING", leaseOwner: null, leaseExpiresAt: null, nextAttemptAt: new Date() },
      });
      return { status: "PENDING" };
    }

    await tx.casePatternDetectJob.update({
      where: { id: jobId },
      data: { status: "DONE", completedAt: new Date(), leaseOwner: null, leaseExpiresAt: null },
    });
    return { status: "DONE" };
  });
}

/**
 * 検出処理失敗時。attempt(claim時に既に+1済み)がmaxAttemptsへ到達していれば
 * DEAD_LETTERへ確定する。それ未満なら指数backoffでPENDINGへ戻す。
 */
export async function failCaseDetectJob(
  jobId: string,
  err: unknown,
): Promise<{ status: "PENDING" | "DEAD_LETTER" }> {
  const { code, digest } = classifyError(err);
  return db.$transaction(async (tx: Prisma.TransactionClient): Promise<{ status: "PENDING" | "DEAD_LETTER" }> => {
    const current = await tx.casePatternDetectJob.findUnique({ where: { id: jobId } });
    if (!current) return { status: "PENDING" };

    if (current.attempt >= current.maxAttempts) {
      await tx.casePatternDetectJob.update({
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

    await tx.casePatternDetectJob.update({
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
