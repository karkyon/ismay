/**
 * PEM Execution Event Correction service(v5新設)。
 * 出典: DOC-11(API・Event仕様書) 3章「API-E03 | POST `/execution-events/:id/corrections`
 * | correctionType/payload | Lifecycle Event」、DOC-05(Execution Event・Session
 * Projection仕様書) 8章「新しいCorrectionは影響範囲をmark staleし…」・11章
 * 「訂正後再計算で旧Revisionが残り、latestだけが切り替わる」。
 *
 * [scope宣言] `ResponsibilityLifecycleEvent`(kind=CORRECTION)モデル自体は
 * Completion Gate 2.1で新設済みで、`bulkOperations.ts`のBulk Complete Undoが
 * receipt方式で既に使っている(correctionType=REVOKE、対象=COMPLETE Event)。
 * このファイルは、Bulk方式(receiptに基づく複数件一括Undo)とは別に、
 * DOC-11 API-E03が要求する「特定のExecution Event 1件を直接指定して訂正する」
 * 単発APIを実装する。CORRECTION_TYPES(coreTypes.ts)のうちREPLACE/SPLIT/
 * MERGE_REQUESTは、対象Eventの種類ごとに「何を置き換えるのか」「分割・統合とは
 * 何を意味するのか」の具体的契約が正本のどこにも記載されておらず、想像で
 * 意味論を発明することになるため、このGateでは実装しない(値としては
 * coreTypes.tsに既に予約済み)。REVOKEのみを実装する。理由:
 *  (a) bulkOperations.tsの既存実装(COMPLETE Eventの取消→REOPEN)という
 *      確立された意味論が既に存在し、それを単発API向けに一般化するだけで済む。
 *  (b) 「取り消す」という操作の意味が明確(Bulk Undoと同一)。
 *  (c) 対象をeventType=COMPLETEに限定する(他のeventTypeの「逆操作」は
 *      eventDefinitionRegistry.ts上で1対1に定まらない場合があり、
 *      想像でマッピングを発明しない)。
 */
import { randomUUID } from "node:crypto";
import { db } from "@/lib/db";
import type { Prisma } from "@/generated/prisma/client";
import { recordExecutionLedgerEvent } from "./executionLedger";
import { projectAndPersistExecutionSessions } from "./sessionPersistence";
import type { PemAuthorizationContext } from "./authorizationBoundary";

export interface RevokeCompleteEventParams {
  workspaceId: string;
  ctx: PemAuthorizationContext;
  /** 取消対象のResponsibilityExecutionEvent.id(eventType=COMPLETEである必要がある)。 */
  targetEventId: string;
  reason?: string;
  idempotencyKey: string;
  requestPayloadHash: string;
}

export type RevokeCompleteEventResult =
  | { ok: true; lifecycleEventId: string; resultingEventId: string | null; replay: boolean }
  | { ok: false; error: "NOT_FOUND" }
  | { ok: false; error: "NOT_COMPLETE_EVENT" }
  | { ok: false; error: "ALREADY_CORRECTED" }
  | { ok: false; error: "STATE_CHANGED" }
  | { ok: false; error: "IDEMPOTENCY_KEY_REUSED" };

/**
 * 指定されたCOMPLETE Eventを取り消す(REVOKE)。対象ResponsibilityがCOMPLETED状態を
 * 維持したままである場合のみ許可し(他の操作が割り込んでいれば拒否)、insert-onlyで
 * REOPEN Event(resultingEvent)とLifecycle Event(監査証跡)を追記する。
 * Execution Ledgerの行を直接UPDATE/DELETEしない(DOC-05 8.1節「元Evidenceを
 * 更新せず、Correction Eventを追記する」)。
 */
export async function revokeCompleteEvent(
  params: RevokeCompleteEventParams,
): Promise<RevokeCompleteEventResult> {
  const { workspaceId, ctx, targetEventId, reason, idempotencyKey, requestPayloadHash } = params;

  // [冪等再送判定] rle_idempotency_uq(workspaceId, subjectUserId, idempotencyKey)を
  // 使う既存パターン(bulkCompleteUndoDecision.ts等)を踏襲する。
  const existing = await db.responsibilityLifecycleEvent.findFirst({
    where: { workspaceId, subjectUserId: ctx.subjectUserId, idempotencyKey },
    select: { id: true, resultingEventId: true, requestPayloadHash: true },
  });
  if (existing) {
    if (existing.requestPayloadHash !== requestPayloadHash) {
      return { ok: false, error: "IDEMPOTENCY_KEY_REUSED" };
    }
    return {
      ok: true,
      lifecycleEventId: existing.id,
      resultingEventId: existing.resultingEventId,
      replay: true,
    };
  }

  return await db.$transaction(async (tx: Prisma.TransactionClient) => {
    const targetEvent = await tx.responsibilityExecutionEvent.findFirst({
      where: { id: targetEventId, workspaceId },
    });
    if (!targetEvent) return { ok: false, error: "NOT_FOUND" } as const;
    if (targetEvent.eventType !== "COMPLETE") {
      return { ok: false, error: "NOT_COMPLETE_EVENT" } as const;
    }

    // [二重取消防止] 既にこのEventを対象にしたCorrectionが存在しないか確認する。
    const alreadyCorrected = await tx.responsibilityLifecycleEvent.findFirst({
      where: { correctionOfEventId: targetEventId, workspaceId },
      select: { id: true },
    });
    if (alreadyCorrected) return { ok: false, error: "ALREADY_CORRECTED" } as const;

    const resp = await tx.responsibility.findFirst({
      where: { id: targetEvent.responsibilityId, workspaceId, deletedAt: null },
    });
    if (!resp) return { ok: false, error: "NOT_FOUND" } as const;
    // [設計判断] 対象EventのtoState(COMPLETED)から現在のResponsibility.statusが
    // 変わっていない場合のみ許可する。他の操作(再度REOPEN済み等)が割り込んでいれば
    // 単純な取消は安全でないため拒否する(想像で複雑な状態解決をしない)。
    if (resp.status !== "COMPLETED") return { ok: false, error: "STATE_CHANGED" } as const;

    const lockResult = await tx.responsibility.updateMany({
      where: { id: resp.id, workspaceId, version: resp.version },
      data: { version: { increment: 1 } },
    });
    if (lockResult.count === 0) return { ok: false, error: "STATE_CHANGED" } as const;

    const resolvedReason = reason ?? "Execution Event訂正によるCOMPLETE取消";

    // [既存パターン踏襲・bulkOperations.ts] COMPLETEDからの取消はREOPEN
    // (eventDefinitionRegistry.ts: fromStates含む[COMPLETED,NOT_NEEDED], toState=PLANNED)。
    const reopenEvent = await recordExecutionLedgerEvent({
      tx,
      ctx,
      responsibilityId: resp.id,
      responsibilityType: resp.type,
      action: "REOPEN",
      fromState: "COMPLETED",
      toState: "PLANNED",
      versionBefore: resp.version,
      versionAfter: resp.version + 1,
      clientOccurredAt: new Date(),
      actorType: "USER",
      source: "API",
      requestId: randomUUID(),
      requestPayloadHash,
      reason: resolvedReason,
    });

    if (reopenEvent) {
      await projectAndPersistExecutionSessions(tx, ctx, resp.id);
    }

    await tx.responsibility.update({
      where: { id: resp.id },
      data: { status: "PLANNED" },
    });

    // [DOC-05 8.1節「Correction Eventを追記する」・監査証跡]
    // Lifecycle Eventはresponsibility_execution_events.correctionOfEventId経由の
    // 複合FK(id, workspaceId)参照先制約があるため、targetEventが実在確認済みの
    // このタイミングでのみ作成可能(既に上でNOT_FOUND判定済み)。
    const lifecycleEvent = await tx.responsibilityLifecycleEvent.create({
      data: {
        workspaceId,
        subjectUserId: ctx.subjectUserId,
        responsibilityId: resp.id,
        kind: "CORRECTION",
        correctionType: "REVOKE",
        correctionOfEventId: targetEventId,
        resultingEventId: reopenEvent?.id ?? null,
        fromState: "COMPLETED",
        toState: "PLANNED",
        reason: resolvedReason,
        actorType: "USER",
        actorUserId: ctx.actorUserId,
        idempotencyKey,
        requestPayloadHash,
      },
    });

    return {
      ok: true,
      lifecycleEventId: lifecycleEvent.id,
      resultingEventId: reopenEvent?.id ?? null,
      replay: false,
    } as const;
  });
}
