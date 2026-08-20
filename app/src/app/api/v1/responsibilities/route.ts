import type { NextRequest } from "next/server";
import { z } from "zod";
import { db } from "@/lib/db";
import { debugServer, redactSensitive } from "@/lib/debugServer";
import { requireAuth, requireCsrf } from "@/lib/auth/guard";
import { ensureDefaultWorkspace } from "@/lib/workspace";
import { apiOk, apiError } from "@/lib/auth/response";
import { RESPONSIBILITY_TYPES, initialStatusFor } from "@/lib/responsibility";

const CreateSchema = z.object({
  type: z.enum(RESPONSIBILITY_TYPES),
  title: z.string().min(1).max(300),
  description: z.string().max(20000).optional(),
  domainId: z.string().uuid().optional(),
  importance: z.number().int().min(1).max(5).optional(),
  hardDeadlineAt: z.string().datetime().optional(),
  targetAt: z.string().datetime().optional(),
  startAfterAt: z.string().datetime().optional(),
  originCaptureId: z.string().uuid().optional(),
});

const LIST_DEFAULT_LIMIT = 50;
const LIST_MAX_LIMIT = 100;

/** API-RESP-01: POST /responsibilities 責任の作成。 */
export async function POST(req: NextRequest) {
  const auth = await requireAuth(req);
  if (!auth.authenticated) {
    return apiError("AUTH_REQUIRED", "ログインが必要です");
  }
  if (!requireCsrf(req)) {
    return apiError("ACCESS_DENIED", "CSRFトークンが不正です");
  }

  const json = await req.json().catch(() => null);
  debugServer.input("POST /responsibilities", "requestBody", redactSensitive(json));
  const parsed = CreateSchema.safeParse(json);
  if (!parsed.success) {
    return apiError("VALIDATION_FAILED", "入力内容を確認してください", {
      fieldErrors: Object.fromEntries(
        Object.entries(parsed.error.flatten().fieldErrors).map(([k, v]) => [k, v?.[0] ?? "不正な値です"]),
      ),
    });
  }
  const {
    type,
    title,
    description,
    domainId,
    importance,
    hardDeadlineAt,
    targetAt,
    startAfterAt,
    originCaptureId,
  } = parsed.data;

  const { workspaceId, domainId: defaultDomainId } = await ensureDefaultWorkspace(
    auth.user.userId,
    auth.user.email,
  );

  let resolvedDomainId = defaultDomainId;
  if (domainId) {
    const domain = await db.domain.findFirst({
      where: { id: domainId, workspaceId, deletedAt: null },
      select: { id: true },
    });
    if (!domain) {
      return apiError("VALIDATION_FAILED", "指定されたdomainIdが存在しません", {
        fieldErrors: { domainId: "許可されていないDomainです" },
      });
    }
    resolvedDomainId = domain.id;
  }

  if (originCaptureId) {
    const capture = await db.capture.findFirst({
      where: { id: originCaptureId, workspaceId, deletedAt: null },
      select: { id: true },
    });
    if (!capture) {
      return apiError("VALIDATION_FAILED", "指定されたoriginCaptureIdが存在しません", {
        fieldErrors: { originCaptureId: "存在しないCaptureです" },
      });
    }
  }

  const created = await db.$transaction(async (tx) => {
    const responsibility = await tx.responsibility.create({
      data: {
        workspaceId,
        domainId: resolvedDomainId,
        originCaptureId: originCaptureId ?? null,
        type,
        title,
        description: description ?? null,
        status: initialStatusFor(type),
        importance: importance ?? null,
        sourceKind: "USER",
        hardDeadlineAt: hardDeadlineAt ? new Date(hardDeadlineAt) : null,
        targetAt: targetAt ? new Date(targetAt) : null,
        startAfterAt: startAfterAt ? new Date(startAfterAt) : null,
        createdById: auth.user.userId,
        updatedById: auth.user.userId,
      },
    });
    debugServer.state("POST /responsibilities", "Responsibility.status", {
      id: responsibility.id,
      status: responsibility.status,
    });

    await tx.eventLog.create({
      data: {
        aggregateType: "Responsibility",
        aggregateId: responsibility.id,
        eventType: "RESPONSIBILITY_CREATED",
        afterJson: { type: responsibility.type, title: responsibility.title, status: responsibility.status },
        actorType: "USER",
        actorId: auth.user.userId,
        correlationId: req.headers.get("x-correlation-id") ?? undefined,
      },
    });
    debugServer.event("POST /responsibilities", "RESPONSIBILITY_CREATED", { aggregateId: responsibility.id });

    await tx.outboxEvent.create({
      data: {
        eventName: "ResponsibilityCreated.v1",
        eventVersion: "1",
        aggregateId: responsibility.id,
        aggregateVersion: responsibility.version,
        correlationId: req.headers.get("x-correlation-id") ?? undefined,
        payload: {
          responsibilityId: responsibility.id,
          workspaceId,
          domainId: resolvedDomainId,
          type: responsibility.type,
        },
      },
    });
    debugServer.event("POST /responsibilities", "ResponsibilityCreated.v1", { aggregateId: responsibility.id });

    return responsibility;
  });

  return apiOk(
    {
      id: created.id,
      type: created.type,
      title: created.title,
      status: created.status,
      version: created.version,
      createdAt: created.createdAt,
    },
    { status: 201 },
  );
}

/** API-RESP-01: GET /responsibilities 一覧(UI-05等)。cursor方式・既定50/最大100。 */
export async function GET(req: NextRequest) {
  const auth = await requireAuth(req);
  if (!auth.authenticated) {
    return apiError("AUTH_REQUIRED", "ログインが必要です");
  }

  const url = new URL(req.url);
  const type = url.searchParams.get("type") ?? undefined;
  const status = url.searchParams.get("status") ?? undefined;
  const domainId = url.searchParams.get("domainId") ?? undefined;
  const from = url.searchParams.get("from") ?? undefined;
  const to = url.searchParams.get("to") ?? undefined;
  const sortParam = url.searchParams.get("sort") ?? "updatedAt";
  const includeDeleted = url.searchParams.get("deleted") === "true";
  const cursor = url.searchParams.get("cursor") ?? undefined;
  const limitParam = Number(url.searchParams.get("limit"));
  const limit = Math.min(
    Math.max(Number.isFinite(limitParam) && limitParam > 0 ? limitParam : LIST_DEFAULT_LIMIT, 1),
    LIST_MAX_LIMIT,
  );

  const { workspaceId } = await ensureDefaultWorkspace(auth.user.userId, auth.user.email);

  // API・イベント設計書v1.1 5章: sortはtarget_at、importance、updated_atのみ許可
  const orderBy =
    sortParam === "targetAt"
      ? ({ targetAt: "desc" } as const)
      : sortParam === "importance"
        ? ({ importance: "desc" } as const)
        : ({ updatedAt: "desc" } as const);

  const rows = await db.responsibility.findMany({
    where: {
      workspaceId,
      ...(includeDeleted ? {} : { deletedAt: null }),
      ...(type ? { type } : {}),
      ...(status ? { status } : {}),
      ...(domainId ? { domainId } : {}),
      ...(from || to
        ? {
            targetAt: {
              ...(from ? { gte: new Date(from) } : {}),
              ...(to ? { lte: new Date(to) } : {}),
            },
          }
        : {}),
    },
    orderBy,
    take: limit + 1,
    ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
    select: {
      id: true,
      type: true,
      title: true,
      status: true,
      importance: true,
      domainId: true,
      hardDeadlineAt: true,
      targetAt: true,
      startAfterAt: true,
      completedAt: true,
      version: true,
      createdAt: true,
      updatedAt: true,
    },
  });

  const hasNext = rows.length > limit;
  const page = hasNext ? rows.slice(0, limit) : rows;
  const nextCursor = hasNext ? page[page.length - 1]?.id : undefined;

  return apiOk({ responsibilities: page }, { extraMeta: nextCursor ? { nextCursor } : {} });
}
