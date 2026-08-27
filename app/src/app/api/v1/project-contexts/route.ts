import type { NextRequest } from "next/server";
import { z } from "zod";
import { db } from "@/lib/db";
import type { Prisma } from "@/generated/prisma/client";
import { debugServer, redactSensitive } from "@/lib/debugServer";
import { requireAuth, requireCsrf } from "@/lib/auth/guard";
import { ensureDefaultWorkspace } from "@/lib/workspace";
import { apiOk, apiError } from "@/lib/auth/response";
import { VISIBILITIES } from "@/lib/projectContext/coreTypes";

/**
 * V5-M1-A2 Project Context API(Context CRUD・link・external-reference)。
 * 出典・パス正本: ISMAY_統合正本仕様書_v5_0 21.2節。
 *
 * [DEC-6] DOC-04(Project Context・外部連携境界仕様書)7章・DOC-11(API・Event仕様書)3章
 *   (API-C01〜C06)は `/:id/transitions`、`/:id/responsibilities/:rid`、
 *   `/:id/external-references/:refId/refresh`、`/:id/activity` を含むが、
 *   統合正本仕様書21.2節「新規API群」にはこれらが存在せず、代わりに
 *   `/:id/links`、`DELETE /:id/links/:responsibilityId` のみが列挙されている。
 *   統合正本仕様書28章「本書に反する分冊は無効である」により、パス形状は
 *   21.2節を正本として採用する。DOC-04/DOC-11相当の`/transitions`
 *   `/responsibilities/:rid`はこのGateでは実装しない(下記[DEC-7]参照)。
 * [DEC-7] lifecycleState変更用の専用`/transitions`エンドポイントは21.2節に
 *   存在しないため新設しない。既存Responsibility PATCH(version CAS)と同じ設計で、
 *   PATCH /project-contexts/{id} のlifecycleStateフィールドとして受け付け、
 *   coreTypes.isValidProjectContextLifecycleTransitionで検証する。
 * [DEC-11] 統合正本仕様書21.1節「mutationはrequestId、idempotencyKey、
 *   expectedVersionを持つ」は理念としては全mutationに適用されうるが、
 *   M1-A1で実際にidempotency_key/request_payload_hash列を持つのは
 *   ProjectContextLinkEventのみである(ProjectContext自体にもEventLogにも
 *   その列は無い)。既存Responsibility POST/PATCHも同様にidempotencyKey
 *   ヘッダを要求していない。このため、Context自体のPOST/PATCHでは
 *   Idempotency-Keyヘッダを必須としない(既存踏襲、[DEC-12]参照)。
 *   link/unlinkはスキーマがidempotency_key列を持つため必須とする。
 */

const LIST_DEFAULT_LIMIT = 50;
const LIST_MAX_LIMIT = 100;

const CreateSchema = z.object({
  name: z.string().min(1).max(300),
  description: z.string().max(20000).nullable().optional(),
  domainId: z.string().uuid().optional(),
  visibility: z.enum(VISIBILITIES).optional(),
  startedAt: z.string().datetime().nullable().optional(),
  targetEndAt: z.string().datetime().nullable().optional(),
});

/** V5-M1-A2: POST /project-contexts 作成。 */
export async function POST(req: NextRequest) {
  const auth = await requireAuth(req);
  if (!auth.authenticated) {
    return apiError("AUTH_REQUIRED", "ログインが必要です");
  }
  if (!requireCsrf(req)) {
    return apiError("ACCESS_DENIED", "CSRFトークンが不正です");
  }

  const json = await req.json().catch(() => null);
  debugServer.input("POST /project-contexts", "requestBody", redactSensitive(json));
  const parsed = CreateSchema.safeParse(json);
  if (!parsed.success) {
    return apiError("VALIDATION_FAILED", "入力内容を確認してください", {
      fieldErrors: Object.fromEntries(
        Object.entries(parsed.error.flatten().fieldErrors).map(([k, v]) => [k, v?.[0] ?? "不正な値です"]),
      ),
    });
  }
  const { name, description, domainId, visibility, startedAt, targetEndAt } = parsed.data;

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

  const created = await db.$transaction(async (tx: Prisma.TransactionClient) => {
    const context = await tx.projectContext.create({
      data: {
        workspaceId,
        domainId: resolvedDomainId,
        ownerSubjectUserId: auth.user.userId,
        name,
        description: description ?? null,
        visibility: visibility ?? "PRIVATE",
        startedAt: startedAt ? new Date(startedAt) : null,
        targetEndAt: targetEndAt ? new Date(targetEndAt) : null,
        createdById: auth.user.userId,
      },
    });
    debugServer.state("POST /project-contexts", "ProjectContext", {
      id: context.id,
      lifecycleState: context.lifecycleState,
    });

    // Event Code: DOC-02(用語・状態・EventCode定義書) 7.4節 Project Context Event。
    await tx.eventLog.create({
      data: {
        aggregateType: "ProjectContext",
        aggregateId: context.id,
        eventType: "CONTEXT_CREATED",
        afterJson: { name: context.name, lifecycleState: context.lifecycleState, visibility: context.visibility },
        actorType: "USER",
        actorId: auth.user.userId,
        correlationId: req.headers.get("x-correlation-id") ?? undefined,
      },
    });
    debugServer.event("POST /project-contexts", "CONTEXT_CREATED", { aggregateId: context.id });

    await tx.outboxEvent.create({
      data: {
        eventName: "ProjectContextCreated.v1",
        eventVersion: "1",
        aggregateId: context.id,
        aggregateVersion: context.version,
        correlationId: req.headers.get("x-correlation-id") ?? undefined,
        payload: { contextId: context.id, workspaceId, domainId: resolvedDomainId },
      },
    });
    debugServer.event("POST /project-contexts", "ProjectContextCreated.v1", { aggregateId: context.id });

    return context;
  });

  return apiOk(
    {
      id: created.id,
      name: created.name,
      description: created.description,
      lifecycleState: created.lifecycleState,
      visibility: created.visibility,
      domainId: created.domainId,
      startedAt: created.startedAt,
      targetEndAt: created.targetEndAt,
      version: created.version,
      createdAt: created.createdAt,
    },
    { status: 201 },
  );
}

/** V5-M1-A2: GET /project-contexts 一覧。cursor方式・既定50/最大100(既存responsibilities一覧と同じ規約)。 */
export async function GET(req: NextRequest) {
  const auth = await requireAuth(req);
  if (!auth.authenticated) {
    return apiError("AUTH_REQUIRED", "ログインが必要です");
  }

  const url = new URL(req.url);
  const lifecycleState = url.searchParams.get("lifecycleState") ?? undefined;
  const domainId = url.searchParams.get("domainId") ?? undefined;
  const cursor = url.searchParams.get("cursor") ?? undefined;
  const limitParam = Number(url.searchParams.get("limit"));
  const limit = Math.min(
    Math.max(Number.isFinite(limitParam) && limitParam > 0 ? limitParam : LIST_DEFAULT_LIMIT, 1),
    LIST_MAX_LIMIT,
  );

  const { workspaceId } = await ensureDefaultWorkspace(auth.user.userId, auth.user.email);

  const rows = await db.projectContext.findMany({
    where: {
      workspaceId,
      deletedAt: null,
      ...(lifecycleState ? { lifecycleState } : {}),
      ...(domainId ? { domainId } : {}),
    },
    orderBy: { updatedAt: "desc" },
    take: limit + 1,
    ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
    select: {
      id: true,
      name: true,
      description: true,
      lifecycleState: true,
      visibility: true,
      domainId: true,
      startedAt: true,
      targetEndAt: true,
      version: true,
      createdAt: true,
      updatedAt: true,
    },
  });

  const hasNext = rows.length > limit;
  const page = hasNext ? rows.slice(0, limit) : rows;
  const nextCursor = hasNext ? page[page.length - 1]?.id : undefined;

  return apiOk({ projectContexts: page }, { extraMeta: nextCursor ? { nextCursor } : {} });
}
