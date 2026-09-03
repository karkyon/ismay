import type { NextRequest } from "next/server";
import { randomUUID, createHash } from "node:crypto";
import { z } from "zod";
import { db } from "@/lib/db";
import type { Prisma } from "@/generated/prisma/client";
import { debugServer, redactSensitive } from "@/lib/debugServer";
import { requireAuth, requireCsrf } from "@/lib/auth/guard";
import { ensureDefaultWorkspace } from "@/lib/workspace";
import { apiOk, apiError } from "@/lib/auth/response";
import {
  transitionsForType,
  isTypeSpecificTerminalStatus,
  ACTIONS_REQUIRING_REASON,
  ACTIONS_REQUIRING_OUTCOME_REASON,
  isValidLifecycleOutcomeReason,
  SELECTABLE_LIFECYCLE_OUTCOME_REASONS,
} from "@/lib/responsibility";
import { recordExecutionLedgerEvent } from "@/lib/pem/executionLedger";
import { projectAndPersistExecutionSessions } from "@/lib/pem/sessionPersistence";
import { buildPemAuthorizationContext } from "@/lib/pem/authorizationBoundary";
import { isExecutionLedgerApplicableType } from "@/lib/pem/eventDefinitionRegistry";

const TransitionSchema = z.object({
  action: z.enum([
    // 共通状態(TASK/EVENT/CONCERN/HABIT/IDEA)
    "START",
    "COMPLETE",
    "PARTIAL_COMPLETE",
    "DEFER",
    "INTERRUPT",
    "RESUME",
    "MARK_NOT_NEEDED",
    "REOPEN",
    // COMMITMENT
    "MARK_AT_RISK",
    "MARK_ACTIVE",
    "FULFILL",
    "BREAK",
    // DECISION
    "START_GATHERING",
    "DECIDE",
    // WAITING
    "MARK_FOLLOW_UP_DUE",
    "RESOLVE",
    // RISK
    "START_MONITORING",
    "MITIGATE",
    "OCCUR",
    "CLOSE",
  ]),
  occurredAt: z.string().datetime(),
  reason: z.string().max(2000).optional(),
  // [M1-OUTCOME新設] MARK_NOT_NEEDED時に必須の選択式Reason Code。
  // 自由入力(reason)とは別に、正本§7.4の7語彙から選ぶ(下でrefineする)。
  outcomeReasonCode: z.string().max(64).optional(),
  completedScope: z.string().max(2000).optional(),
  remainingWork: z.string().max(2000).optional(),
  newTargetAt: z.string().datetime().optional(),
  version: z.number().int(),
});

/**
 * API-RESP-03: POST /responsibilities/{id}/transitions
 * 共通状態(FN-WK-01、機能別詳細設計書v1.1 4章)に加え、COMMITMENT/DECISION/WAITING/RISKの
 * 種別固有遷移(2026-08-19、カルキョンさんと合意のうえ新規設計。lib/responsibility.ts参照)
 * に対応する。
 */
export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const auth = await requireAuth(req);
  if (!auth.authenticated) {
    return apiError("AUTH_REQUIRED", "ログインが必要です");
  }
  if (!requireCsrf(req)) {
    return apiError("ACCESS_DENIED", "CSRFトークンが不正です");
  }

  const json = await req.json().catch(() => null);
  debugServer.input("POST /responsibilities/[id]/transitions", "requestBody", redactSensitive(json));
  const parsed = TransitionSchema.safeParse(json);
  if (!parsed.success) {
    return apiError("VALIDATION_FAILED", "入力内容を確認してください", {
      fieldErrors: Object.fromEntries(
        Object.entries(parsed.error.flatten().fieldErrors).map(([k, v]) => [k, v?.[0] ?? "不正な値です"]),
      ),
    });
  }
  const { action, reason, completedScope, remainingWork, newTargetAt, version } = parsed.data;
  // [2026-08-24追加・Phase 0A是正2、v4.0 5.3節] Execution Ledgerのrequest_id/
  // request_payload_hash列用。x-request-idヘッダがあれば優先し、無ければ要求ごとに発行する。
  const pemRequestId = req.headers.get("x-request-id") ?? randomUUID();
  const pemRequestPayloadHash = createHash("sha256").update(JSON.stringify(parsed.data)).digest("hex");

  // API・イベント設計書v1.1 4.3節: PARTIAL_COMPLETEはcompletedScope/remainingWorkの一方以上が必須
  if (action === "PARTIAL_COMPLETE" && !completedScope && !remainingWork) {
    return apiError(
      "VALIDATION_FAILED",
      "部分完了にはcompletedScopeまたはremainingWorkのいずれかが必要です",
      { fieldErrors: { completedScope: "completedScopeかremainingWorkを指定してください" } },
    );
  }

  // DECISION完了条件(Webシステム要件定義書v2.1 7.1節「選択と理由が記録」): DECIDEはreason必須
  if (ACTIONS_REQUIRING_REASON.includes(action) && !reason) {
    return apiError("VALIDATION_FAILED", "この操作には理由(reason)の入力が必要です", {
      fieldErrors: { reason: "reasonを指定してください" },
    });
  }

  // [M1-OUTCOME新設・統合正本v5.0 §7.4] MARK_NOT_NEEDEDはLifecycle Outcome
  // Reason Codeの選択が必須。自由入力metadataではなく選択式の正式語彙にする
  // (「単なる不要化」と「履行断念」等を区別できるようにする)。
  if (ACTIONS_REQUIRING_OUTCOME_REASON.includes(action)) {
    if (!parsed.data.outcomeReasonCode) {
      return apiError(
        "VALIDATION_FAILED",
        "この操作には理由区分(outcomeReasonCode)の選択が必要です",
        {
          fieldErrors: {
            outcomeReasonCode: `次のいずれかを指定してください: ${SELECTABLE_LIFECYCLE_OUTCOME_REASONS.join(", ")}`,
          },
        },
      );
    }
    if (!isValidLifecycleOutcomeReason(parsed.data.outcomeReasonCode) || parsed.data.outcomeReasonCode === "UNKNOWN_LEGACY") {
      // UNKNOWN_LEGACYは既存データの移行専用であり、本人が新規に選ぶことはできない。
      return apiError(
        "VALIDATION_FAILED",
        "指定された理由区分は無効です",
        {
          fieldErrors: {
            outcomeReasonCode: `次のいずれかを指定してください: ${SELECTABLE_LIFECYCLE_OUTCOME_REASONS.join(", ")}`,
          },
        },
      );
    }
  }

  const { id } = await ctx.params;
  const { workspaceId } = await ensureDefaultWorkspace(auth.user.userId, auth.user.email);

  const existing = await db.responsibility.findFirst({ where: { id, workspaceId, deletedAt: null } });
  if (!existing) {
    return apiError("RESOURCE_NOT_FOUND", "指定された責任が見つかりません");
  }

  const rule = transitionsForType(existing.type).find(
    (r) => r.action === action && (r.from as readonly string[]).includes(existing.status),
  );
  if (!rule) {
    return apiError(
      "STATE_TRANSITION_INVALID",
      `${existing.type}の現在の状態(${existing.status})から${action}へは遷移できません`,
    );
  }

  // [2026-08-25追加・Completion Gate 1、v4.0 5.5節「idempotency response contract」]
  // Responsibility.versionの楽観ロックは、同一リクエストの再送(retry)であっても
  // versionが既に進んでいればVERSION_CONFLICTとして弾いてしまい、v4.0が要求する
  // 「同一key・同一payloadなら元の成功応答を返す」という冪等再送にならない。
  // Execution Ledger対象型(TASK/EVENT/CONCERN/HABIT/IDEA)に限り、楽観ロックの
  // 試行前にidempotencyKeyで既存Eventを検索し、再送か否かを先に判定する。
  // 対象外型(COMMITMENT等、Execution Eventを持たない)は従来通りVERSION_CONFLICT
  // 経路のみとなる(このEvent Ledgerを使わないためidempotencyKey突合が出来ない)。
  if (isExecutionLedgerApplicableType(existing.type)) {
    const idempotencyKey = `${id}:${action}:${version}`;
    const existingEvent = await db.responsibilityExecutionEvent.findFirst({
      where: { workspaceId, subjectUserId: auth.user.userId, idempotencyKey },
      select: { requestPayloadHash: true },
    });
    if (existingEvent) {
      if (existingEvent.requestPayloadHash === pemRequestPayloadHash) {
        // 同一key・同一payload: 冪等再送とみなし、新たな更新は行わず現在の状態を返す。
        const current = await db.responsibility.findUniqueOrThrow({
          where: { id },
          select: { id: true, status: true, version: true },
        });
        return apiOk(current);
      }
      // 同一key・異なるpayload: 呼び出し元の実装不備の疑いがあるため409で拒否する。
      // [2026-08-25是正・Completion Gate 2.1] エラーコードをv4.0正式語彙の
      // IDEMPOTENCY_KEY_REUSEDへ統一(response.ts参照)。
      return apiError(
        "IDEMPOTENCY_KEY_REUSED",
        "同一のリクエストキーで内容の異なるリクエストが送信されました",
      );
    }
  }
  const nextStatus = typeof rule.to === "function" ? rule.to(existing.status) : rule.to;

  // completedAt: 共通状態のCOMPLETED、または種別固有の終端状態(FULFILLED/DECIDED/RESOLVED/
  // MITIGATED/OCCURRED/CLOSED等)に到達した時点を「完了日時」として記録する。REOPENでは解除する。
  const reachesTerminal = nextStatus === "COMPLETED" || isTypeSpecificTerminalStatus(existing.type, nextStatus);
  const completedAtValue = reachesTerminal ? new Date() : action === "REOPEN" ? null : undefined;
  // [M1-OUTCOME新設] NOT_NEEDEDへ遷移する時のみ設定する。REOPEN等で他の状態へ
  // 戻る場合はクリアする(統合正本v5.0 §7.4の意味論はNOT_NEEDED状態に紐づく
  // ものであり、他状態へ遷移した後も古いreasonが残ると誤解を招くため)。
  const outcomeReasonCodeValue =
    nextStatus === "NOT_NEEDED" ? parsed.data.outcomeReasonCode : action === "REOPEN" ? null : undefined;

  const result = await db.$transaction(async (tx: Prisma.TransactionClient) => {
    const updateResult = await tx.responsibility.updateMany({
      where: { id, version },
      data: {
        status: nextStatus,
        completedAt: completedAtValue,
        outcomeReasonCode: outcomeReasonCodeValue,
        targetAt: newTargetAt ? new Date(newTargetAt) : undefined,
        updatedById: auth.user.userId,
        version: { increment: 1 },
      },
    });
    if (updateResult.count === 0) return null;

    const updated = await tx.responsibility.findUniqueOrThrow({ where: { id } });
    debugServer.state("POST /responsibilities/[id]/transitions", "Responsibility.status", {
      id,
      action,
      from: existing.status,
      to: updated.status,
    });

    await tx.eventLog.create({
      data: {
        aggregateType: "Responsibility",
        aggregateId: id,
        eventType:
          action === "PARTIAL_COMPLETE"
            ? "PARTIALLY_COMPLETED"
            : action === "DEFER" || action === "INTERRUPT"
              ? "DEFERRED"
              : "STATUS_CHANGED",
        beforeJson: { status: existing.status },
        afterJson: { status: updated.status, completedScope, remainingWork },
        actorType: "USER",
        actorId: auth.user.userId,
        reason,
        correlationId: req.headers.get("x-correlation-id") ?? undefined,
      },
    });
    debugServer.event("POST /responsibilities/[id]/transitions", "STATUS_CHANGED(EventLog)", { aggregateId: id, action });

    await tx.outboxEvent.create({
      data: {
        eventName: "ResponsibilityTransitioned.v1",
        eventVersion: "1",
        aggregateId: id,
        aggregateVersion: updated.version,
        correlationId: req.headers.get("x-correlation-id") ?? undefined,
        payload: { responsibilityId: id, action, fromStatus: existing.status, toStatus: updated.status },
      },
    });
    debugServer.event("POST /responsibilities/[id]/transitions", "ResponsibilityTransitioned.v1", { aggregateId: id });

    // [2026-08-24是正・外部批評4.1対応] 従来はここをtry/catchで囲み、記録失敗を
    // debugServer.eventへ記録するだけで握り潰していた。これにより「Responsibility状態は
    // 変わったがPEM正本には記録されていない」という無音の欠損が起こり得た。
    // recordExecutionLedgerEvent自身は、意図的スキップ(対象外型/action未対応/未同意)を
    // 例外ではなくnull返却で表現するため、ここでtry/catchを外しても正当なスキップは
    // 壊れない。対象内かつ同意済みでの本物の失敗は、トランザクション全体を
    // rollbackさせる(批評が推奨する「同意済みかつ対象内: 同一トランザクションで必須成功」)。
    const pemCtx = await buildPemAuthorizationContext(auth.user.userId, auth.user.userId);
    const pemLedgerResult = await recordExecutionLedgerEvent({
      tx,
      ctx: pemCtx,
      responsibilityId: id,
      responsibilityType: existing.type,
      action,
      fromState: existing.status,
      toState: updated.status,
      versionBefore: existing.version,
      versionAfter: updated.version,
      clientOccurredAt: new Date(parsed.data.occurredAt),
      actorType: "USER",
      source: "WEB",
      correlationId: req.headers.get("x-correlation-id") ?? undefined,
      reason,
      requestId: pemRequestId,
      requestPayloadHash: pemRequestPayloadHash,
    });
    // [2026-08-24追加・Phase 0B-2] Execution Eventが実際に記録された場合のみ
    // Session Identity/Revisionを再投影・永続化する(v4.0 7.2節・7.3節)。
    // recordExecutionLedgerEventがnullを返す(対象外型/action未対応/未同意による
    // 意図的スキップ)場合は、記録された事実が無いため呼ばない。
    if (pemLedgerResult) {
      await projectAndPersistExecutionSessions(tx, pemCtx, id);
    }

    return updated;
  });

  if (!result) {
    const latest = await db.responsibility.findUnique({
      where: { id },
      select: { version: true, status: true },
    });
    return apiError("VERSION_CONFLICT", "他の更新と競合しました。最新の状態を取得してください", {
      retryable: true,
      extra: { latestVersion: latest?.version, status: latest?.status },
    });
  }

  return apiOk({ id: result.id, status: result.status, version: result.version, outcomeReasonCode: result.outcomeReasonCode });
}
