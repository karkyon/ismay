import type { NextRequest } from "next/server";
import { createHash } from "node:crypto";
import { db } from "@/lib/db";
import type { Prisma } from "@/generated/prisma/client";
import { debugServer } from "@/lib/debugServer";
import { requireAuth, requireCsrf } from "@/lib/auth/guard";
import { ensureDefaultWorkspace } from "@/lib/workspace";
import { apiOk, apiError } from "@/lib/auth/response";
import { enqueueCaseDetect } from "@/lib/patterns/caseDetectQueue";
import { excludeCasePatternSourceLinksForResponsibility } from "@/lib/patterns/sourceLinkService";

/**
 * 統合正本仕様書21.2節: DELETE /project-contexts/{id}/links/{responsibilityId}
 * [DEC-11] links系はIdempotency-Keyヘッダ必須([id]/links/route.ts冒頭コメント参照)。
 * (Context,Responsibility)組のactive linkはroleを問わず最大1件(DOC-04 2章「active
 * linkのみ一意」・project_context_links_one_active_per_context_responsibility)のため、
 * URLのresponsibilityIdだけでunlink対象を一意に特定できる。
 */
export async function DELETE(
  req: NextRequest,
  ctx: { params: Promise<{ id: string; responsibilityId: string }> },
) {
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

  const { id: contextId, responsibilityId } = await ctx.params;
  const requestPayloadHash = createHash("sha256")
    .update(JSON.stringify({ contextId, responsibilityId, action: "UNLINK" }))
    .digest("hex");

  const { workspaceId } = await ensureDefaultWorkspace(auth.user.userId, auth.user.email);

  const context = await db.projectContext.findFirst({ where: { id: contextId, workspaceId, deletedAt: null } });
  if (!context) {
    return apiError("RESOURCE_NOT_FOUND", "指定されたProject Contextが見つかりません");
  }

  const existingEvent = await db.projectContextLinkEvent.findFirst({
    where: { workspaceId, contextId, idempotencyKey },
    select: { requestPayloadHash: true },
  });
  if (existingEvent) {
    if (existingEvent.requestPayloadHash === requestPayloadHash) {
      return apiOk({ unlinked: true });
    }
    return apiError("IDEMPOTENCY_KEY_REUSED", "同一のリクエストキーで内容の異なるリクエストが送信されました");
  }

  const activeLink = await db.projectContextLink.findFirst({
    where: { workspaceId, contextId, responsibilityId, unlinkedAt: null },
  });
  if (!activeLink) {
    return apiError("RESOURCE_NOT_FOUND", "指定されたLinkが見つかりません(既にunlink済みの可能性があります)");
  }

  await db.$transaction(async (tx: Prisma.TransactionClient) => {
    await tx.projectContextLink.update({
      where: { id: activeLink.id },
      data: { unlinkedAt: new Date() },
    });

    await tx.projectContextLinkEvent.create({
      data: {
        workspaceId,
        contextId,
        responsibilityId,
        eventType: "UNLINK",
        role: activeLink.role,
        beforeSnapshot: { role: activeLink.role, sourceKind: activeLink.sourceKind },
        actorType: "USER",
        actorUserId: auth.user.userId,
        idempotencyKey,
        requestPayloadHash,
      },
    });
    debugServer.event("DELETE /project-contexts/[id]/links/[responsibilityId]", "RESPONSIBILITY_UNLINKED", {
      contextId,
      responsibilityId,
    });

    await tx.outboxEvent.create({
      data: {
        eventName: "ProjectContextResponsibilityUnlinked.v1",
        eventVersion: "1",
        aggregateId: contextId,
        aggregateVersion: context.version,
        correlationId: req.headers.get("x-correlation-id") ?? undefined,
        payload: { contextId, responsibilityId, role: activeLink.role },
      },
    });

    // [PATTERN-DETECT-01B新設・2026-09-03] PRIMARY link解除は、この本人の
    // Case Pattern occurrence集合が1件減る契機(DR-A、PD-08「unlink後に
    // raw/weighted/confidence減少」)のため、検出Jobをenqueueする。
    // SUPPORTING/REFERENCEの解除はoccurrence計上に影響しない(DR-A)ため対象外。
    //
    // [PATTERN-INTEGRITY-03A是正・2026-09-05] 監査是正指示書(df2bb2e基準
    // 再監査是正・CasePattern閉ループ完遂指示、2026-09-05)P0-1:
    // 従来はenqueueCaseDetectのみを呼び、既存CasePatternSourceLink(この
    // Responsibility由来でexcludedAt:nullの行)を除外していなかった。
    // listEligibleMaterializationSources()はactive PRIMARYのみを列挙する
    // ため、unlink後はこのResponsibilityが検出対象から外れ、既存行が
    // 永久に残存しraw/weighted/confidenceが減少しないバグがあった。
    // excludeCasePatternSourceLinksForResponsibility(PATTERN-DETECT-02Bで
    // 新設済み、Responsibility論理削除で既に使われている唯一のSourceLink
    // 除外入口)をPRIMARY解除でも同一transaction境界で呼ぶことで是正する。
    // 新規除外関数は作らない(既存の唯一入口を再利用)。
    if (activeLink.role === "PRIMARY") {
      const { affectedOwnerIds } = await excludeCasePatternSourceLinksForResponsibility(tx, {
        workspaceId,
        responsibilityId,
        reason: "PRIMARY_UNLINKED",
      });
      // 通常はaffectedOwnerIds === [context.ownerSubjectUserId]だが(CasePattern.
      // ownerSubjectUserIdは常にPRIMARY Context.ownerSubjectUserIdと一致するため)、
      // 万一の不一致(過去データ不整合等)に備え和集合で再集計をenqueueする。
      const ownersToEnqueue = new Set<string>([context.ownerSubjectUserId, ...affectedOwnerIds]);
      for (const ownerSubjectUserId of ownersToEnqueue) {
        await enqueueCaseDetect(tx, {
          workspaceId,
          ownerSubjectUserId,
          reasonCode: "PRIMARY_UNLINKED",
        });
      }
    }
  });

  return apiOk({ unlinked: true });
}
