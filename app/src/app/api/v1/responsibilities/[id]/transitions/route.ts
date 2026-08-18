import type { NextRequest } from "next/server";
import { z } from "zod";
import { db } from "@/lib/db";
import { requireAuth, requireCsrf } from "@/lib/auth/guard";
import { ensureDefaultWorkspace } from "@/lib/workspace";
import { apiOk, apiError } from "@/lib/auth/response";
import { isCommonStatusType, COMMON_TRANSITIONS } from "@/lib/responsibility";

const TransitionSchema = z.object({
  action: z.enum([
    "START",
    "COMPLETE",
    "PARTIAL_COMPLETE",
    "DEFER",
    "INTERRUPT",
    "RESUME",
    "MARK_NOT_NEEDED",
    "REOPEN",
  ]),
  occurredAt: z.string().datetime(),
  reason: z.string().max(2000).optional(),
  completedScope: z.string().max(2000).optional(),
  remainingWork: z.string().max(2000).optional(),
  newTargetAt: z.string().datetime().optional(),
  version: z.number().int(),
});

/**
 * API-RESP-03: POST /responsibilities/{id}/transitions (機能別詳細設計書v1.1 FN-WK-01)
 *
 * [スコープ] 共通状態(TASK/EVENT/CONCERN/HABIT/IDEA)のみ対応。
 * COMMITMENT/DECISION/WAITING/RISKは種別固有の状態語彙を持ち別の遷移規則が
 * 必要なため今回は未実装(次回対応)。該当種別への遷移要求は明示的に拒否する。
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

  const { id } = await ctx.params;
  const { workspaceId } = await ensureDefaultWorkspace(auth.user.userId, auth.user.email);

  const existing = await db.responsibility.findFirst({ where: { id, workspaceId, deletedAt: null } });
  if (!existing) {
    return apiError("RESOURCE_NOT_FOUND", "指定された責任が見つかりません");
  }

  if (!isCommonStatusType(existing.type)) {
    return apiError(
      "STATE_TRANSITION_INVALID",
      `${existing.type}の状態遷移は現在未対応です(次回実装予定)`,
    );
  }

  const rule = COMMON_TRANSITIONS.find(
    (r) => r.action === action && (r.from as readonly string[]).includes(existing.status),
  );
  if (!rule) {
    return apiError(
      "STATE_TRANSITION_INVALID",
      `現在の状態(${existing.status})から${action}へは遷移できません`,
    );
  }
  const nextStatus = typeof rule.to === "function" ? rule.to(existing.status) : rule.to;

  const result = await db.$transaction(async (tx) => {
    const updateResult = await tx.responsibility.updateMany({
      where: { id, version },
      data: {
        status: nextStatus,
        completedAt: nextStatus === "COMPLETED" ? new Date() : action === "REOPEN" ? null : undefined,
        targetAt: newTargetAt ? new Date(newTargetAt) : undefined,
        updatedById: auth.user.userId,
        version: { increment: 1 },
      },
    });
    if (updateResult.count === 0) return null;

    const updated = await tx.responsibility.findUniqueOrThrow({ where: { id } });

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
