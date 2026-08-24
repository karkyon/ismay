import type { NextRequest } from "next/server";
import { z } from "zod";
import { db } from "@/lib/db";
import { debugServer, redactSensitive } from "@/lib/debugServer";
import { requireAuth, requireCsrf } from "@/lib/auth/guard";
import { ensureDefaultWorkspace } from "@/lib/workspace";
import { apiOk, apiError } from "@/lib/auth/response";
import {
  transitionsForType,
  isTypeSpecificTerminalStatus,
  ACTIONS_REQUIRING_REASON,
} from "@/lib/responsibility";
import { recordExecutionLedgerEvent } from "@/lib/pem/executionLedger";
import { buildPemAuthorizationContext } from "@/lib/pem/authorizationBoundary";

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
  const nextStatus = typeof rule.to === "function" ? rule.to(existing.status) : rule.to;

  // completedAt: 共通状態のCOMPLETED、または種別固有の終端状態(FULFILLED/DECIDED/RESOLVED/
  // MITIGATED/OCCURRED/CLOSED等)に到達した時点を「完了日時」として記録する。REOPENでは解除する。
  const reachesTerminal = nextStatus === "COMPLETED" || isTypeSpecificTerminalStatus(existing.type, nextStatus);
  const completedAtValue = reachesTerminal ? new Date() : action === "REOPEN" ? null : undefined;

  const result = await db.$transaction(async (tx) => {
    const updateResult = await tx.responsibility.updateMany({
      where: { id, version },
      data: {
        status: nextStatus,
        completedAt: completedAtValue,
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

    try {
      const pemCtx = await buildPemAuthorizationContext(auth.user.userId, auth.user.userId);
      await recordExecutionLedgerEvent({
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
      });
    } catch (e) {
      debugServer.event("POST /responsibilities/[id]/transitions", "PemExecutionLedgerRecordFailed", {
        aggregateId: id,
        error: e instanceof Error ? e.message : String(e),
      });
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

  return apiOk({ id: result.id, status: result.status, version: result.version });
}
