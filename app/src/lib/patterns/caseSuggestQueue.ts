/**
 * Case Pattern Suggest Job Queue(PATTERN-SUGGEST-01B新設・2026-09-05)。
 * 出典: Claude向け_ISMAY_3b695d9以降_再監査是正・CasePattern実機能完遂指示_
 * 2026-09-04.md §6 PATTERN-SUGGEST-01B「新しいFormationCandidateRevisionが
 * 生成された時点で照合」。
 *
 * [設計判断] caseDetectQueue.ts(CasePatternDetectJob、本人単位の再集計queue)
 * と同一のlease/generation/backoff/dead-letter状態機械を、
 * FormationCandidateIdentity単位のSuggestion生成queue向けに再実装したもの。
 * 別concept(本人単位の「既存Pattern再集計」 vs candidate単位の「この分解案は
 * 既存Patternに一致するか」)であり、既存queueへ混在させない
 * (2026-09-05 PATTERN-SUGGEST-01B事前調査で確認済み)。
 *
 * [scope宣言] このファイルはqueue管理層(enqueue/claim/complete/fail)のみを
 * 実装する。実際のSuggestion生成(Pattern照合・decompositionProposal組立て・
 * CasePatternSuggestionIdentity/Revision書込み)は別モジュール
 * (casePatternSuggestionGenerationService.ts)で実装する(想像で先行実装しない)。
 */
import { db } from "@/lib/db";
import type { Prisma } from "@/generated/prisma/client";
import { createHash } from "node:crypto";

export const CASE_PATTERN_SUGGEST_REASON_CODES = ["CANDIDATE_REVISION_CREATED"] as const;
export type CasePatternSuggestReasonCode = (typeof CASE_PATTERN_SUGGEST_REASON_CODES)[number];

export const CASE_PATTERN_SUGGEST_JOB_STATUSES = ["PENDING", "PROCESSING", "DONE", "FAILED", "DEAD_LETTER"] as const;
export type CasePatternSuggestJobStatus = (typeof CASE_PATTERN_SUGGEST_JOB_STATUSES)[number];

const LEASE_MS = 5 * 60 * 1000;
const BASE_BACKOFF_MS = 30 * 1000;

/** caseDetectQueue.tsと同じ方針: 30s, 60s, 120s, ... 最大30分でcap。 */
function backoffMs(attempt: number): number {
  return Math.min(BASE_BACKOFF_MS * 2 ** Math.max(0, attempt - 1), 30 * 60 * 1000);
}

function classifyError(err: unknown): { code: string; digest: string } {
  const message = err instanceof Error ? err.message : String(err);
  return { code: message.slice(0, 100), digest: createHash("sha256").update(message).digest("hex").slice(0, 16) };
}

export interface EnqueueCaseSuggestionMatchParams {
  workspaceId: string;
  ownerSubjectUserId: string;
  candidateId: string;
  reasonCode: CasePatternSuggestReasonCode;
}

export interface EnqueueCaseSuggestionMatchResult {
  id: string;
  generation: number;
  /** trueの場合、既存のPENDING/PROCESSING行のgenerationを増やしただけ(新規行は作られていない)。 */
  coalesced: boolean;
}

/**
 * このCandidate(candidateId)向けのSuggestion照合を「要実行」としてmarkする。
 * 既にPENDING/PROCESSINGの行があればgenerationを増やして前倒しする(coalescing、
 * 同一candidateへ短時間に複数revisionが作られた場合は最新1回分の照合で済む)。
 * 呼び出し元の既存transaction(tx)の中で呼ぶ想定(FormationCandidateRevision
 * 作成と原子的に記録するため。caseDetectQueue.enqueueCaseDetectと同じ設計)。
 */
export async function enqueueCaseSuggestionMatch(
  txOrDb: Prisma.TransactionClient | typeof db,
  params: EnqueueCaseSuggestionMatchParams,
): Promise<EnqueueCaseSuggestionMatchResult> {
  const existing = await txOrDb.casePatternSuggestJob.findFirst({
    where: {
      workspaceId: params.workspaceId,
      candidateId: params.candidateId,
      status: { in: ["PENDING", "PROCESSING"] },
    },
  });

  if (existing) {
    const updated = await txOrDb.casePatternSuggestJob.update({
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
    const created = await txOrDb.casePatternSuggestJob.create({
      data: {
        workspaceId: params.workspaceId,
        ownerSubjectUserId: params.ownerSubjectUserId,
        candidateId: params.candidateId,
        status: "PENDING",
        generation: 1,
        attempt: 0,
        nextAttemptAt: new Date(),
        reasonCode: params.reasonCode,
      },
    });
    return { id: created.id, generation: created.generation, coalesced: false };
  } catch (err) {
    // [並行競合対策] caseDetectQueue.enqueueCaseDetectと同じフォールバック。
    // 部分一意制約(case_pattern_suggest_jobs_active_uq)により、findFirstと
    // createの間に別tx/リクエストが同一candidateIdで先にPENDING行を作成した
    // 場合はP2002になり得るため、その場合はcoalesceへフォールバックする。
    if ((err as { code?: string }).code === "P2002") {
      const raceWinner = await txOrDb.casePatternSuggestJob.findFirst({
        where: {
          workspaceId: params.workspaceId,
          candidateId: params.candidateId,
          status: { in: ["PENDING", "PROCESSING"] },
        },
      });
      if (raceWinner) {
        const updated = await txOrDb.casePatternSuggestJob.update({
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

export interface ClaimedCaseSuggestJob {
  id: string;
  workspaceId: string;
  ownerSubjectUserId: string;
  candidateId: string;
  generation: number;
  attempt: number;
  maxAttempts: number;
}

/**
 * PENDING(next_attempt_at到来分)、またはlease切れのPROCESSING(crashしたWorkerの
 * 孤立行)を、FOR UPDATE SKIP LOCKEDでバッチclaimする(caseDetectQueue.tsと同一設計)。
 */
export async function claimCaseSuggestJobs(workerId: string, limit = 10): Promise<ClaimedCaseSuggestJob[]> {
  return db.$transaction(async (tx: Prisma.TransactionClient): Promise<ClaimedCaseSuggestJob[]> => {
    const now = new Date();
    const rows = await tx.$queryRaw<{ id: string }[]>`
      SELECT "id" FROM "case_pattern_suggest_jobs"
      WHERE ("status" = 'PENDING' AND "next_attempt_at" <= ${now})
         OR ("status" = 'PROCESSING' AND "lease_expires_at" < ${now})
      ORDER BY "next_attempt_at" ASC
      LIMIT ${limit}
      FOR UPDATE SKIP LOCKED
    `;
    if (rows.length === 0) return [];

    const leaseExpiresAt = new Date(now.getTime() + LEASE_MS);
    const claimed: ClaimedCaseSuggestJob[] = [];
    for (const row of rows) {
      const updated = await tx.casePatternSuggestJob.update({
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
        candidateId: updated.candidateId,
        generation: updated.generation,
        attempt: updated.attempt,
        maxAttempts: updated.maxAttempts,
      });
    }
    return claimed;
  });
}

/**
 * 照合成功時。claim時点のgenerationと現在のgenerationが一致していればDONEへ
 * 確定する。処理中にenqueueCaseSuggestionMatchでcoalescingされていた場合は、
 * 古いWorker結果をcommitさせずPENDINGへ差し戻す(caseDetectQueue.tsのPD-07と同じ設計)。
 */
export async function completeCaseSuggestJob(
  jobId: string,
  observedGeneration: number,
): Promise<{ status: "DONE" | "PENDING" }> {
  return db.$transaction(async (tx: Prisma.TransactionClient): Promise<{ status: "DONE" | "PENDING" }> => {
    const current = await tx.casePatternSuggestJob.findUnique({ where: { id: jobId } });
    if (!current) return { status: "DONE" };

    if (current.generation !== observedGeneration) {
      await tx.casePatternSuggestJob.update({
        where: { id: jobId },
        data: { status: "PENDING", leaseOwner: null, leaseExpiresAt: null, nextAttemptAt: new Date() },
      });
      return { status: "PENDING" };
    }

    await tx.casePatternSuggestJob.update({
      where: { id: jobId },
      data: { status: "DONE", completedAt: new Date(), leaseOwner: null, leaseExpiresAt: null },
    });
    return { status: "DONE" };
  });
}

/**
 * 照合失敗時。attempt(claim時に既に+1済み)がmaxAttemptsへ到達していれば
 * DEAD_LETTERへ確定する。それ未満なら指数backoffでPENDINGへ戻す。
 */
export async function failCaseSuggestJob(
  jobId: string,
  err: unknown,
): Promise<{ status: "PENDING" | "DEAD_LETTER" }> {
  const { code, digest } = classifyError(err);
  return db.$transaction(async (tx: Prisma.TransactionClient): Promise<{ status: "PENDING" | "DEAD_LETTER" }> => {
    const current = await tx.casePatternSuggestJob.findUnique({ where: { id: jobId } });
    if (!current) return { status: "PENDING" };

    if (current.attempt >= current.maxAttempts) {
      await tx.casePatternSuggestJob.update({
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

    await tx.casePatternSuggestJob.update({
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
