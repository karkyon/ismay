import type { NextRequest } from "next/server";
import { z } from "zod";
import { db } from "@/lib/db";
import { Prisma } from "@/generated/prisma/client";
import { debugServer, redactSensitive } from "@/lib/debugServer";
import { requireAuth, requireCsrf } from "@/lib/auth/guard";
import { ensureDefaultWorkspace } from "@/lib/workspace";
import { apiOk, apiError } from "@/lib/auth/response";

/**
 * API-REC-01/02: PUT/DELETE /responsibilities/{id}/recurrence(2026-08-23新設)。
 * TBL-020 recurrence_rules。FN-REC-01(機能別詳細設計書v1.1 11章)。
 * responsibilityIdが@uniqueのため、PUTはupsert(作成/更新を1本化)とする。
 */
const RecurrenceSchema = z.object({
  frequency: z.enum(["DAILY", "WEEKLY", "MONTHLY"]),
  interval: z.number().int().min(1).max(365),
  // weekdaysは0=日曜〜6=土曜(JS Date.getDay()と揃える)。frequency=WEEKLYの時のみ意味を持つ。
  weekdays: z.array(z.number().int().min(0).max(6)).max(7).nullable().optional(),
  // "YYYY-MM-DD"形式の例外日リスト。
  exceptions: z.array(z.string().regex(/^\d{4}-\d{2}-\d{2}$/)).max(100).nullable().optional(),
  pausedUntil: z.string().datetime().nullable().optional(),
  carryoverPolicy: z.enum(["CARRY", "DROP", "RENOTIFY"]),
});

/** PUT: 作成または更新(upsert)。 */
export async function PUT(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const auth = await requireAuth(req);
  if (!auth.authenticated) {
    return apiError("AUTH_REQUIRED", "ログインが必要です");
  }
  if (!requireCsrf(req)) {
    return apiError("ACCESS_DENIED", "CSRFトークンが不正です");
  }

  const json = await req.json().catch(() => null);
  debugServer.input("PUT /responsibilities/[id]/recurrence", "requestBody", redactSensitive(json));
  const parsed = RecurrenceSchema.safeParse(json);
  if (!parsed.success) {
    return apiError("VALIDATION_FAILED", "入力内容を確認してください", {
      fieldErrors: Object.fromEntries(
        Object.entries(parsed.error.flatten().fieldErrors).map(([k, v]) => [k, v?.[0] ?? "不正な値です"]),
      ),
    });
  }

  const { id } = await ctx.params;
  const { workspaceId } = await ensureDefaultWorkspace(auth.user.userId, auth.user.email);

  const responsibility = await db.responsibility.findFirst({
    where: { id, workspaceId, deletedAt: null },
    select: { id: true },
  });
  if (!responsibility) {
    return apiError("RESOURCE_NOT_FOUND", "指定された責任が見つかりません");
  }

  const { frequency, interval, weekdays, exceptions, pausedUntil, carryoverPolicy } = parsed.data;
  const rule = await db.recurrenceRule.upsert({
    where: { responsibilityId: id },
    create: {
      responsibilityId: id,
      frequency,
      interval,
      weekdays: weekdays ?? undefined,
      exceptions: exceptions ?? undefined,
      pausedUntil: pausedUntil ? new Date(pausedUntil) : null,
      carryoverPolicy,
    },
    update: {
      frequency,
      interval,
      weekdays: weekdays ?? Prisma.DbNull,
      exceptions: exceptions ?? Prisma.DbNull,
      pausedUntil: pausedUntil ? new Date(pausedUntil) : null,
      carryoverPolicy,
      version: { increment: 1 },
    },
  });
  debugServer.event("PUT /responsibilities/[id]/recurrence", "RecurrenceRule upsert", {
    responsibilityId: id,
    ruleId: rule.id,
  });

  return apiOk({
    id: rule.id,
    frequency: rule.frequency,
    interval: rule.interval,
    weekdays: rule.weekdays,
    exceptions: rule.exceptions,
    pausedUntil: rule.pausedUntil,
    carryoverPolicy: rule.carryoverPolicy,
    lastGeneratedAt: rule.lastGeneratedAt,
  });
}

/** DELETE: 定期ルールを解除する(責任自体は削除しない)。 */
export async function DELETE(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const auth = await requireAuth(req);
  if (!auth.authenticated) {
    return apiError("AUTH_REQUIRED", "ログインが必要です");
  }
  if (!requireCsrf(req)) {
    return apiError("ACCESS_DENIED", "CSRFトークンが不正です");
  }

  const { id } = await ctx.params;
  const { workspaceId } = await ensureDefaultWorkspace(auth.user.userId, auth.user.email);

  const responsibility = await db.responsibility.findFirst({
    where: { id, workspaceId, deletedAt: null },
    select: { id: true },
  });
  if (!responsibility) {
    return apiError("RESOURCE_NOT_FOUND", "指定された責任が見つかりません");
  }

  const result = await db.recurrenceRule.deleteMany({ where: { responsibilityId: id } });
  debugServer.event("DELETE /responsibilities/[id]/recurrence", "RecurrenceRule削除", {
    responsibilityId: id,
    deleted: result.count > 0,
  });

  return apiOk({ deleted: result.count > 0 });
}
