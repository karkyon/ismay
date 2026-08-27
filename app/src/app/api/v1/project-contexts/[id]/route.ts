import type { NextRequest } from "next/server";
import { z } from "zod";
import { db } from "@/lib/db";
import { debugServer, redactSensitive } from "@/lib/debugServer";
import { requireAuth, requireCsrf } from "@/lib/auth/guard";
import { ensureDefaultWorkspace } from "@/lib/workspace";
import { apiOk, apiError } from "@/lib/auth/response";
import {
  VISIBILITIES,
  PROJECT_CONTEXT_LIFECYCLE_STATES,
  isValidProjectContextLifecycleTransition,
} from "@/lib/projectContext/coreTypes";

/** V5-M1-A2: GET /project-contexts/{id} 詳細。active linkのみ同梱する(DOC-04 2章)。 */
export async function GET(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const auth = await requireAuth(req);
  if (!auth.authenticated) {
    return apiError("AUTH_REQUIRED", "ログインが必要です");
  }
  const { id } = await ctx.params;
  const { workspaceId } = await ensureDefaultWorkspace(auth.user.userId, auth.user.email);

  const context = await db.projectContext.findFirst({
    where: { id, workspaceId, deletedAt: null },
    include: {
      links: {
        where: { unlinkedAt: null },
        select: {
          id: true,
          responsibilityId: true,
          role: true,
          sourceKind: true,
          linkedAt: true,
          responsibility: { select: { id: true, title: true, type: true, status: true } },
        },
        orderBy: { linkedAt: "asc" },
      },
      externalReferences: {
        select: {
          id: true,
          provider: true,
          externalWorkspaceKey: true,
          externalProjectKey: true,
          canonicalUrl: true,
          direction: true,
          syncPolicy: true,
          status: true,
          createdAt: true,
        },
        orderBy: { createdAt: "asc" },
      },
    },
  });
  if (!context) {
    // 他Workspaceのcontext IDを推測されても存在有無を漏らさない(既存responsibilities/[id]と同じIDOR対策)。
    return apiError("RESOURCE_NOT_FOUND", "指定されたProject Contextが見つかりません");
  }

  return apiOk({ projectContext: context });
}

const UpdateSchema = z.object({
  name: z.string().min(1).max(300).optional(),
  description: z.string().max(20000).nullable().optional(),
  domainId: z.string().uuid().optional(),
  visibility: z.enum(VISIBILITIES).optional(),
  startedAt: z.string().datetime().nullable().optional(),
  targetEndAt: z.string().datetime().nullable().optional(),
  lifecycleState: z.enum(PROJECT_CONTEXT_LIFECYCLE_STATES).optional(),
  version: z.number().int(),
});

/**
 * V5-M1-A2: PATCH /project-contexts/{id} 更新。楽観ロック(version)必須。
 * [DEC-7] lifecycleState変更もこのエンドポイントで受け付ける(専用/transitionsは新設しない)。
 * [DEC-12] Idempotency-Keyヘッダは要求しない(理由は route.ts冒頭コメント参照)。
 */
export async function PATCH(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const auth = await requireAuth(req);
  if (!auth.authenticated) {
    return apiError("AUTH_REQUIRED", "ログインが必要です");
  }
  if (!requireCsrf(req)) {
    return apiError("ACCESS_DENIED", "CSRFトークンが不正です");
  }

  const json = await req.json().catch(() => null);
  debugServer.input("PATCH /project-contexts/[id]", "requestBody", redactSensitive(json));
  const parsed = UpdateSchema.safeParse(json);
  if (!parsed.success) {
    return apiError("VALIDATION_FAILED", "入力内容を確認してください", {
      fieldErrors: Object.fromEntries(
        Object.entries(parsed.error.flatten().fieldErrors).map(([k, v]) => [k, v?.[0] ?? "不正な値です"]),
      ),
    });
  }
  const { version, domainId, lifecycleState, ...rest } = parsed.data;

  const { id } = await ctx.params;
  const { workspaceId } = await ensureDefaultWorkspace(auth.user.userId, auth.user.email);

  const existing = await db.projectContext.findFirst({ where: { id, workspaceId, deletedAt: null } });
  if (!existing) {
    return apiError("RESOURCE_NOT_FOUND", "指定されたProject Contextが見つかりません");
  }

  let resolvedDomainId: string | undefined;
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

  // DOC-04 3章のlifecycle遷移表(coreTypes.PROJECT_CONTEXT_LIFECYCLE_TRANSITIONS)で検証する。
  // Context lifecycle変更はResponsibility状態を連鎖変更しない(DOC-04 3章、[DEC]済み既定動作:
  // このエンドポイントはProjectContext行のみを更新し、配下Responsibilityには一切触れない)。
  if (lifecycleState && lifecycleState !== existing.lifecycleState) {
    if (!isValidProjectContextLifecycleTransition(existing.lifecycleState, lifecycleState)) {
      return apiError(
        "STATE_TRANSITION_INVALID",
        `現在の状態(${existing.lifecycleState})から${lifecycleState}へは遷移できません`,
      );
    }
  }

  const updateResult = await db.projectContext.updateMany({
    where: { id, version },
    data: {
      ...(rest.name !== undefined ? { name: rest.name } : {}),
      ...(rest.description !== undefined ? { description: rest.description } : {}),
      ...(rest.visibility !== undefined ? { visibility: rest.visibility } : {}),
      ...(rest.startedAt !== undefined ? { startedAt: rest.startedAt ? new Date(rest.startedAt) : null } : {}),
      ...(rest.targetEndAt !== undefined ? { targetEndAt: rest.targetEndAt ? new Date(rest.targetEndAt) : null } : {}),
      ...(resolvedDomainId ? { domainId: resolvedDomainId } : {}),
      ...(lifecycleState !== undefined ? { lifecycleState } : {}),
      version: { increment: 1 },
    },
  });

  if (updateResult.count === 0) {
    const latest = await db.projectContext.findUnique({ where: { id }, select: { version: true } });
    return apiError("VERSION_CONFLICT", "他の更新と競合しました。最新の状態を取得してください", {
      retryable: true,
      extra: { latestVersion: latest?.version },
    });
  }

  const updated = await db.projectContext.findUniqueOrThrow({ where: { id } });
  debugServer.state("PATCH /project-contexts/[id]", "ProjectContext", { id, lifecycleState: updated.lifecycleState });

  // Event Code: 名称変更・lifecycle変更はDOC-02 7.4節の専用codeを使う。
  // それ以外(description/visibility/startedAt/targetEndAt等)は、既存Responsibility PATCH
  // (RESPONSIBILITY_CHANGED)と同じ汎用catch-all方式を踏襲する([DEC-14])。
  // DOC-02 7.4節にはこれらの単独変更用codeが列挙されておらず、CHG-005が要求する
  // 「Catalogにある値だけを使う」原則と「未登録値0件」原則の間で、既存コードベースの
  // 確立された前例(汎用_CHANGED)に倣うことで想像による新語彙発明を避けた。
  let eventType = "PROJECT_CONTEXT_CHANGED";
  if (lifecycleState !== undefined && lifecycleState !== existing.lifecycleState) {
    eventType =
      lifecycleState === "PAUSED"
        ? "CONTEXT_PAUSED"
        : lifecycleState === "ACTIVE"
          ? "CONTEXT_RESUMED"
          : lifecycleState === "COMPLETED"
            ? "CONTEXT_COMPLETED"
            : "CONTEXT_ARCHIVED";
  } else if (rest.name !== undefined && rest.name !== existing.name) {
    eventType = "CONTEXT_RENAMED";
  }

  await db.eventLog.create({
    data: {
      aggregateType: "ProjectContext",
      aggregateId: id,
      eventType,
      beforeJson: { name: existing.name, lifecycleState: existing.lifecycleState, visibility: existing.visibility },
      afterJson: { name: updated.name, lifecycleState: updated.lifecycleState, visibility: updated.visibility },
      actorType: "USER",
      actorId: auth.user.userId,
      correlationId: req.headers.get("x-correlation-id") ?? undefined,
    },
  });
  debugServer.event("PATCH /project-contexts/[id]", eventType, { aggregateId: id });

  return apiOk({
    projectContext: {
      id: updated.id,
      name: updated.name,
      description: updated.description,
      lifecycleState: updated.lifecycleState,
      visibility: updated.visibility,
      domainId: updated.domainId,
      startedAt: updated.startedAt,
      targetEndAt: updated.targetEndAt,
      version: updated.version,
      updatedAt: updated.updatedAt,
    },
  });
}
