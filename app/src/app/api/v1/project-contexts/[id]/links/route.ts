import type { NextRequest } from "next/server";
import { createHash } from "node:crypto";
import { z } from "zod";
import { db } from "@/lib/db";
import { Prisma } from "@/generated/prisma/client";
import { debugServer, redactSensitive } from "@/lib/debugServer";
import { requireAuth, requireCsrf } from "@/lib/auth/guard";
import { ensureDefaultWorkspace } from "@/lib/workspace";
import { apiOk, apiError } from "@/lib/auth/response";
import {
  PROJECT_CONTEXT_LINK_ROLES,
  PROJECT_CONTEXT_LINK_SOURCE_KINDS,
  hasConflictingActivePrimaryLink,
  hasConflictingActiveLinkForSamePair,
} from "@/lib/projectContext/coreTypes";
import { enqueueCaseDetect } from "@/lib/patterns/caseDetectQueue";

/**
 * V5-M1-A2 API-C04相当(パスは統合正本21.2節に合わせ`/links`): POST /project-contexts/{id}/links
 *
 * [DEC-11] このエンドポイントはProjectContextLinkEventが
 *   idempotency_key/request_payload_hash列を持つため、統合正本21.1節の
 *   「mutationはidempotencyKeyを持つ」・DOC-11 1章「commandはIdempotency-Keyヘッダを
 *   受ける」に従い、クライアント指定のIdempotency-Keyヘッダを必須とする。
 */

const LinkSchema = z.object({
  responsibilityId: z.string().uuid(),
  role: z.enum(PROJECT_CONTEXT_LINK_ROLES),
  sourceKind: z.enum(PROJECT_CONTEXT_LINK_SOURCE_KINDS).optional(),
});

export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const auth = await requireAuth(req);
  if (!auth.authenticated) {
    return apiError("AUTH_REQUIRED", "ログインが必要です");
  }
  if (!requireCsrf(req)) {
    return apiError("ACCESS_DENIED", "CSRFトークンが不正です");
  }

  const idempotencyKey = req.headers.get("idempotency-key");
  if (!idempotencyKey) {
    return apiError("VALIDATION_FAILED", "Idempotency-Keyヘッダが必要です", {
      fieldErrors: { "Idempotency-Key": "必須ヘッダです" },
    });
  }

  const json = await req.json().catch(() => null);
  debugServer.input("POST /project-contexts/[id]/links", "requestBody", redactSensitive(json));
  const parsed = LinkSchema.safeParse(json);
  if (!parsed.success) {
    return apiError("VALIDATION_FAILED", "入力内容を確認してください", {
      fieldErrors: Object.fromEntries(
        Object.entries(parsed.error.flatten().fieldErrors).map(([k, v]) => [k, v?.[0] ?? "不正な値です"]),
      ),
    });
  }
  const { responsibilityId, role, sourceKind } = parsed.data;
  const requestPayloadHash = createHash("sha256").update(JSON.stringify(parsed.data)).digest("hex");

  const { id: contextId } = await ctx.params;
  const { workspaceId } = await ensureDefaultWorkspace(auth.user.userId, auth.user.email);

  const context = await db.projectContext.findFirst({ where: { id: contextId, workspaceId, deletedAt: null } });
  if (!context) {
    return apiError("RESOURCE_NOT_FOUND", "指定されたProject Contextが見つかりません");
  }
  const responsibility = await db.responsibility.findFirst({
    where: { id: responsibilityId, workspaceId, deletedAt: null },
    select: { id: true },
  });
  if (!responsibility) {
    return apiError("VALIDATION_FAILED", "指定されたresponsibilityIdが存在しません", {
      fieldErrors: { responsibilityId: "このWorkspaceに存在する責任のみ指定できます" },
    });
  }

  // 冪等再送判定(既存responsibilities/[id]/transitionsと同じ設計: 同一key・同一payloadは
  // 現在の状態を返す。同一key・異payloadは409)。
  const existingEvent = await db.projectContextLinkEvent.findFirst({
    where: { workspaceId, contextId, idempotencyKey },
    select: { requestPayloadHash: true, responsibilityId: true },
  });
  if (existingEvent) {
    if (existingEvent.requestPayloadHash === requestPayloadHash) {
      const current = await db.projectContextLink.findFirst({
        where: { workspaceId, contextId, responsibilityId: existingEvent.responsibilityId, unlinkedAt: null },
        select: { id: true, responsibilityId: true, role: true, sourceKind: true, linkedAt: true },
      });
      return apiOk({ link: current });
    }
    return apiError("IDEMPOTENCY_KEY_REUSED", "同一のリクエストキーで内容の異なるリクエストが送信されました");
  }

  try {
    const created = await db.$transaction(async (tx: Prisma.TransactionClient) => {
      // DB側のpartial unique indexが最終防御(project_context_links_one_active_primary /
      // project_context_links_one_active_per_context_responsibility)。ここではapplication層
      // での事前検出を行う(coreTypes.ts純粋関数、M1-A1指示書2.4節の設計を再利用)。
      const [primaryConflictRows, samePairRows] = await Promise.all([
        role === "PRIMARY"
          ? tx.projectContextLink.findMany({
              where: { workspaceId, responsibilityId, unlinkedAt: null },
              select: { role: true, unlinkedAt: true, responsibilityId: true },
            })
          : Promise.resolve([]),
        tx.projectContextLink.findMany({
          where: { workspaceId, contextId, responsibilityId, unlinkedAt: null },
          select: { role: true, unlinkedAt: true, responsibilityId: true },
        }),
      ]);
      if (role === "PRIMARY" && hasConflictingActivePrimaryLink(primaryConflictRows, responsibilityId)) {
        throw new PrimaryContextConflictError();
      }
      if (hasConflictingActiveLinkForSamePair(samePairRows, responsibilityId)) {
        throw new PrimaryContextConflictError(
          "この責任は既にこのContextへactiveなLinkを持っています(role変更はunlink後に再linkしてください)",
        );
      }

      const link = await tx.projectContextLink.create({
        data: {
          workspaceId,
          contextId,
          responsibilityId,
          role,
          sourceKind: sourceKind ?? "USER",
        },
      });

      await tx.projectContextLinkEvent.create({
        data: {
          workspaceId,
          contextId,
          responsibilityId,
          eventType: "LINK",
          role,
          afterSnapshot: { role, sourceKind: link.sourceKind, linkedAt: link.linkedAt.toISOString() },
          actorType: "USER",
          actorUserId: auth.user.userId,
          idempotencyKey,
          requestPayloadHash,
        },
      });
      debugServer.event("POST /project-contexts/[id]/links", "RESPONSIBILITY_LINKED", { contextId, responsibilityId });

      await tx.outboxEvent.create({
        data: {
          eventName: "ProjectContextResponsibilityLinked.v1",
          eventVersion: "1",
          aggregateId: contextId,
          aggregateVersion: context.version,
          correlationId: req.headers.get("x-correlation-id") ?? undefined,
          payload: { contextId, responsibilityId, role },
        },
      });

      // [PATTERN-DETECT-01B新設・2026-09-03] PRIMARY link作成は、この本人の
      // Case Pattern候補occurrenceが1件増える可能性がある契機(DR-A)のため、
      // 検出Jobをenqueueする(既存PENDING/PROCESSING行があればcoalescing)。
      // SUPPORTING/REFERENCEはoccurrenceとして計上されない(DR-A)ため対象外。
      if (role === "PRIMARY") {
        await enqueueCaseDetect(tx, {
          workspaceId,
          ownerSubjectUserId: context.ownerSubjectUserId,
          reasonCode: "PRIMARY_LINKED",
        });
      }

      return link;
    });

    return apiOk(
      {
        link: {
          id: created.id,
          responsibilityId: created.responsibilityId,
          role: created.role,
          sourceKind: created.sourceKind,
          linkedAt: created.linkedAt,
        },
      },
      { status: 201 },
    );
  } catch (err) {
    if (err instanceof PrimaryContextConflictError) {
      return apiError("PRIMARY_CONTEXT_CONFLICT", err.message);
    }
    // DBのpartial unique index違反(application層の事前検出をすり抜けた並行実行分)。
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") {
      return apiError(
        "PRIMARY_CONTEXT_CONFLICT",
        "他のリクエストと競合しました(active PRIMARY Linkは1件までです)。最新の状態を取得してください",
      );
    }
    throw err;
  }
}

/** DOC-02 8章 `409 PRIMARY_CONTEXT_CONFLICT` に対応する内部例外(応答コード変換用)。 */
class PrimaryContextConflictError extends Error {
  constructor(message = "この責任には既にactiveなPRIMARY Linkが存在します(workspace内で最大1件)") {
    super(message);
    this.name = "PrimaryContextConflictError";
  }
}
