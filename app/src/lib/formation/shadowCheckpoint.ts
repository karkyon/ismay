import { createHash } from "node:crypto";
import { db } from "@/lib/db";
import type { Prisma } from "@/generated/prisma/client";
import { debugServer } from "@/lib/debugServer";
import { ResponsibilityCandidateSchema, type ResponsibilityCandidate } from "@/lib/ai/schema";
import { checkAiPolicyAndConsent } from "@/lib/ai/consentPolicy";
import { writeShadowFormationSession, type ShadowSourceCaptureContext } from "@/lib/formation/shadowWrite";

/**
 * app/src/lib/formation/shadowCheckpoint.ts
 *
 * V5-M1-B6C-1 Shadow Reconciliation/Checkpoint。
 * 出典: Claude向け ISMAY c503e72以降 M1-B6C・全残件連続実装指示(2026-08-31)
 *       §3 Gate M1-B6C-1。
 *
 * [設計方針] `writeShadowFormationSession`(shadowWrite.ts)は現在、内部の失敗を
 * 握り潰さずthrowする(2026-08-31是正)。この module はその呼び出しを
 * `FormationShadowCheckpoint`行のライフサイクル(PENDING→RUNNING→SUCCEEDED/
 * RETRY_WAIT/DEAD_LETTER/CANCELLED)として管理し、次を保証する:
 *
 * 1. Capture/AiInference本体transaction確定後に必ずcheckpoint行が存在する
 *    (`createShadowCheckpoint`は呼び出し元の既存txの中で呼ばれる)。
 * 2. checkpointのclaim(PENDING/RETRY_WAIT→RUNNING)はupdateManyのWHERE句自体で
 *    atomicに行われるため、複数Workerが同時に同じcheckpointをclaimしても
 *    片方しか成功しない(同時Worker二重claim→1処理のみ)。
 * 3. 同一AiRunに対するFormationSession再作成は
 *    `formation_sessions_idempotency_uq`(workspaceId, captureId, clientSessionKey)
 *    により自然に防がれるが、この module はさらにclaim前に既存Session存在を
 *    確認することで、無駄な再実行(と、その結果としてのP2002例外)自体を避ける。
 * 4. claim直後にConsentを再評価する(Provider呼出しは行わないため外部送信自体は
 *    発生しないが、Formation Learning/Formation投影を「解析許可が既に撤回された
 *    Capture」に対して行わないという契約を守るため)。
 * 5. claim時にAiInference側の実データからrequestHashを再計算し、checkpoint
 *    作成時のhashと不一致ならCORRUPTED_CHECKPOINT_DATAとしてfail-closedで
 *    DEAD_LETTERにする(R1-01/02と同じ「想像で処理を継続しない」方針)。
 */

const RECONCILIATION_BATCH_SIZE = 10;
const STALE_RUNNING_MS = 10 * 60 * 1000; // 10分。crashしたWorkerのRUNNING行をRETRY_WAITへ回収するまでの猶予。
const BASE_BACKOFF_MS = 30 * 1000; // 30秒

export type ShadowCheckpointStatus = "PENDING" | "RUNNING" | "SUCCEEDED" | "RETRY_WAIT" | "DEAD_LETTER" | "CANCELLED";

export interface CreateShadowCheckpointParams {
  workspaceId: string;
  captureId: string;
  aiRunId: string;
  schemaVersion: string;
  candidateCount: number;
}

/**
 * checkpoint行のrequestHash算出(純関数)。候補件数+schemaVersionを含めることで、
 * 「作成時に想定していたAiInference行数」と「claim時に実際にDBへ存在する行数」の
 * driftを検知できる(通常は不変のはずだが、想定外のデータ変化を無条件に信頼しない)。
 */
export function computeShadowCheckpointRequestHash(input: {
  workspaceId: string;
  captureId: string;
  aiRunId: string;
  schemaVersion: string;
  candidateCount: number;
}): string {
  return createHash("sha256")
    .update(
      JSON.stringify({
        workspaceId: input.workspaceId,
        captureId: input.captureId,
        aiRunId: input.aiRunId,
        schemaVersion: input.schemaVersion,
        candidateCount: input.candidateCount,
      }),
    )
    .digest("hex");
}

/** 既存transaction(tx)の中でPENDING checkpoint行を作成する。 */
export async function createShadowCheckpoint(
  tx: Prisma.TransactionClient,
  params: CreateShadowCheckpointParams,
): Promise<{ id: string }> {
  const requestHash = computeShadowCheckpointRequestHash(params);
  const checkpoint = await tx.formationShadowCheckpoint.create({
    data: {
      workspaceId: params.workspaceId,
      captureId: params.captureId,
      aiRunId: params.aiRunId,
      requestHash,
      status: "PENDING",
      nextRunAt: new Date(),
    },
  });
  return { id: checkpoint.id };
}

function classifyError(err: unknown): { code: string; digest: string } {
  const message = err instanceof Error ? err.message : String(err);
  const code = message.slice(0, 100);
  const digest = createHash("sha256").update(message).digest("hex").slice(0, 16);
  return { code, digest };
}

function backoffMs(attempt: number): number {
  // 30s, 60s, 120s, 240s, ... 最大30分でcap。
  return Math.min(BASE_BACKOFF_MS * 2 ** Math.max(0, attempt - 1), 30 * 60 * 1000);
}

/**
 * PENDING/RETRY_WAIT(nextRunAt<=now)のcheckpointをRUNNINGへclaimする。
 * updateManyのWHERE句自体がatomicなCASであるため、同時に複数呼び出しても
 * count===1になるのは1回だけ(二重claim防止)。
 */
async function claimShadowCheckpoint(checkpointId: string): Promise<boolean> {
  const now = new Date();
  const claimed = await db.formationShadowCheckpoint.updateMany({
    where: {
      id: checkpointId,
      status: { in: ["PENDING", "RETRY_WAIT"] },
      OR: [{ nextRunAt: null }, { nextRunAt: { lte: now } }],
    },
    data: { status: "RUNNING", attempt: { increment: 1 } },
  });
  return claimed.count === 1;
}

/**
 * crash等でRUNNINGのまま更新が止まったcheckpointを検出し、RETRY_WAITへ戻す。
 * (「crash後に安全に再開できる」の実装。attemptは既にclaim時に加算済みのため
 * ここでは増やさない=無限に加算され続けてmaxAttemptsへ即到達することを防ぐ)。
 */
export async function reclaimStaleRunningCheckpoints(): Promise<{ reclaimed: number }> {
  const staleBefore = new Date(Date.now() - STALE_RUNNING_MS);
  const stale = await db.formationShadowCheckpoint.findMany({
    where: { status: "RUNNING", updatedAt: { lt: staleBefore } },
    select: { id: true },
    take: RECONCILIATION_BATCH_SIZE,
  });
  let reclaimed = 0;
  for (const row of stale) {
    const result = await db.formationShadowCheckpoint.updateMany({
      where: { id: row.id, status: "RUNNING", updatedAt: { lt: staleBefore } },
      data: { status: "RETRY_WAIT", nextRunAt: new Date() },
    });
    reclaimed += result.count;
  }
  if (reclaimed > 0) {
    debugServer.event("formation/shadowCheckpoint", "STALE_RUNNING_RECLAIMED", { reclaimed });
  }
  return { reclaimed };
}

export type ProcessShadowCheckpointOutcome =
  | "SUCCEEDED"
  | "ALREADY_DONE"
  | "CANCELLED"
  | "RETRY_WAIT"
  | "DEAD_LETTER"
  | "NOT_CLAIMABLE"
  | "NOT_FOUND";

/**
 * checkpointを1件処理する(claim→consent再評価→整合性検証→候補復元→
 * shadow書込み→結果反映)。この関数自体は例外をthrowしない
 * (全ての失敗をcheckpoint行の状態遷移として表現する)。
 */
export async function processShadowCheckpoint(checkpointId: string): Promise<ProcessShadowCheckpointOutcome> {
  const claimed = await claimShadowCheckpoint(checkpointId);
  if (!claimed) {
    return "NOT_CLAIMABLE";
  }

  const checkpoint = await db.formationShadowCheckpoint.findUnique({ where: { id: checkpointId } });
  if (!checkpoint) {
    return "NOT_FOUND";
  }

  const fail = async (status: "RETRY_WAIT" | "DEAD_LETTER" | "CANCELLED", errorCode: string, errorDigest: string) => {
    const dead = status === "DEAD_LETTER" || checkpoint.attempt >= checkpoint.maxAttempts;
    await db.formationShadowCheckpoint.update({
      where: { id: checkpointId },
      data: {
        status: dead && status !== "CANCELLED" ? "DEAD_LETTER" : status,
        lastErrorCode: errorCode.slice(0, 200),
        lastErrorDigest: errorDigest,
        nextRunAt: dead || status === "CANCELLED" ? null : new Date(Date.now() + backoffMs(checkpoint.attempt)),
        completedAt: status === "CANCELLED" ? new Date() : null,
      },
    });
    if (dead && status !== "CANCELLED") {
      debugServer.error("formation/shadowCheckpoint", "DEAD_LETTER", {
        checkpointId,
        aiRunId: checkpoint.aiRunId,
        attempt: checkpoint.attempt,
        errorCode,
      });
      return "DEAD_LETTER" as const;
    }
    return status;
  };

  const succeed = async () => {
    await db.formationShadowCheckpoint.update({
      where: { id: checkpointId },
      data: { status: "SUCCEEDED", completedAt: new Date(), lastErrorCode: null, lastErrorDigest: null, nextRunAt: null },
    });
    return "SUCCEEDED" as const;
  };

  const capture = await db.capture.findUnique({ where: { id: checkpoint.captureId } });
  if (!capture || capture.deletedAt) {
    // Captureが削除済み/消失: shadow投影を捏造しない。CANCELLEDとして終端する。
    return fail("CANCELLED", "CAPTURE_UNAVAILABLE", classifyError("capture unavailable").digest);
  }
  if (!capture.domainId || !capture.rawText) {
    // domainId欠落はwriteShadowFormationSession自身が正常skipする既存契約と同じ扱い。
    // rawText欠落はここに至ることが想定されない状態のため、想像で復元せずDEAD_LETTERにする。
    if (!capture.domainId) {
      return succeed();
    }
    return fail("DEAD_LETTER", "CAPTURE_RAWTEXT_MISSING", classifyError("rawText missing at claim time").digest);
  }

  // [指示書§3.3 Consent再評価] Worker claim直後に、queue投入時点とは独立して
  // 最新のDomain AI policy/Consentを再評価する。撤回済みならCANCELLEDとし、
  // shadow投影(=Formationへの反映)を行わない。
  let policyCheck;
  try {
    policyCheck = await checkAiPolicyAndConsent(capture.id);
  } catch (err) {
    const { code, digest } = classifyError(err);
    return fail("RETRY_WAIT", code, digest);
  }
  if (!policyCheck.allowed) {
    return fail("CANCELLED", `CONSENT_DENIED: ${policyCheck.reason}`, classifyError(policyCheck.reason).digest);
  }

  const shadowContext: ShadowSourceCaptureContext = {
    id: capture.id,
    workspaceId: capture.workspaceId,
    domainId: capture.domainId,
    createdById: capture.createdById,
    rawText: capture.rawText,
    sourceType: capture.sourceType,
  };

  // [idempotent pre-check] 既にこのAiRunに対応するFormationSessionが存在するなら
  // (前回attemptがtx commit後・checkpoint更新前にcrashした等)、再実行せず
  // SUCCEEDEDへ収束させる(同一aiRun replayでCandidate/Event重複0を保証)。
  const clientSessionKey = `shadow:${checkpoint.aiRunId}`;
  const existingSession = await db.formationSession.findUnique({
    where: {
      workspaceId_captureId_clientSessionKey: {
        workspaceId: checkpoint.workspaceId,
        captureId: checkpoint.captureId,
        clientSessionKey,
      },
    },
    select: { id: true },
  });
  if (existingSession) {
    return succeed();
  }

  const aiRun = await db.aiRun.findUnique({ where: { id: checkpoint.aiRunId } });
  if (!aiRun) {
    return fail("DEAD_LETTER", "AI_RUN_NOT_FOUND", classifyError("aiRun not found").digest);
  }

  const inferences = await db.aiInference.findMany({
    where: { aiRunId: checkpoint.aiRunId, captureId: checkpoint.captureId },
    orderBy: { createdAt: "asc" },
  });

  // [fail-closed・R1-01/02と同じ方針] 作成時のrequestHashを、claim時点の実データから
  // 再計算した値と比較する。不一致は「作成後にAiInference行が想定外に変化した」
  // ことを意味し、想像で処理を継続しない。
  const recomputedHash = computeShadowCheckpointRequestHash({
    workspaceId: checkpoint.workspaceId,
    captureId: checkpoint.captureId,
    aiRunId: checkpoint.aiRunId,
    schemaVersion: aiRun.schemaVersion,
    candidateCount: inferences.length,
  });
  if (recomputedHash !== checkpoint.requestHash) {
    return fail("DEAD_LETTER", "CORRUPTED_CHECKPOINT_DATA", classifyError("requestHash mismatch").digest);
  }

  // [fail-closed] AiInference.payloadを候補として復元する際、1件でも
  // ResponsibilityCandidateSchemaに適合しなければ、部分的な捏造Evidenceを
  // 作らずDEAD_LETTERにする(R1-01のMerge Evidence方針と同じ考え方: 既に
  // persistSuccess時点で検証済みのはずのデータが後から壊れているのは、
  // 「一部だけ信頼する」より「異常として停止する」方が安全)。
  const candidates: ResponsibilityCandidate[] = [];
  for (const inference of inferences) {
    const parsed = ResponsibilityCandidateSchema.safeParse(inference.payload);
    if (!parsed.success) {
      return fail("DEAD_LETTER", "CORRUPTED_CANDIDATE_DATA", classifyError(parsed.error).digest);
    }
    candidates.push(parsed.data);
  }
  if (candidates.length === 0) {
    // 候補0件のAiRun(ANALYSIS_FAILED相当)はshadow Session自体を作らない
    // (writeShadowFormationSessionの既存契約と同じ: 候補が無い場合もSession自体は
    // 作成しFAILEDへ遷移させるため、実際にはここへは到達しない想定だが、防御的に
    // そのままwriteShadowFormationSessionへ委譲する=候補0件はエラーではない)。
  }

  try {
    await writeShadowFormationSession({
      capture: shadowContext,
      aiRunId: checkpoint.aiRunId,
      schemaVersion: aiRun.schemaVersion,
      candidates,
      captureSummary: undefined,
    });
  } catch (err) {
    const { code, digest } = classifyError(err);
    return fail("RETRY_WAIT", code, digest);
  }

  return succeed();
}

/**
 * persistSuccess()がtransaction確定直後に呼ぶ、best-effortの即時1回実行。
 * processShadowCheckpoint自体は例外を投げない設計だが、予期しない例外
 * (DB接続断等)からCapture=READY確定処理を保護するため、念のためtry/catchで
 * 覆う(checkpoint行はDBに既にPENDINGとして残っているため、ここで例外が
 * 出てもWorkerが後で確実に拾う=旧来のfire-and-forgetと異なり観測可能)。
 */
export async function attemptShadowCheckpointInline(checkpointId: string): Promise<void> {
  try {
    await processShadowCheckpoint(checkpointId);
  } catch (err) {
    debugServer.error("formation/shadowCheckpoint", "INLINE_ATTEMPT_UNEXPECTED_EXCEPTION", { checkpointId, err });
  }
}

/**
 * Worker tick(shadowReconciliationJob.ts)から呼ばれるバッチ処理。
 * stale RUNNINGの回収→PENDING/RETRY_WAIT(nextRunAt<=now)のバッチ処理。
 */
export async function reconcileShadowCheckpoints(): Promise<{ processed: number; reclaimed: number }> {
  const { reclaimed } = await reclaimStaleRunningCheckpoints();

  const now = new Date();
  const candidates = await db.formationShadowCheckpoint.findMany({
    where: {
      status: { in: ["PENDING", "RETRY_WAIT"] },
      OR: [{ nextRunAt: null }, { nextRunAt: { lte: now } }],
    },
    orderBy: { createdAt: "asc" },
    take: RECONCILIATION_BATCH_SIZE,
    select: { id: true },
  });

  let processed = 0;
  for (const row of candidates) {
    const outcome = await processShadowCheckpoint(row.id);
    if (outcome !== "NOT_CLAIMABLE" && outcome !== "NOT_FOUND") {
      processed++;
    }
  }
  return { processed, reclaimed };
}
