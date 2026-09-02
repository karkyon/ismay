import type { NextRequest } from "next/server";
import { db } from "@/lib/db";
import { requireAuth } from "@/lib/auth/guard";
import { ensureDefaultWorkspace } from "@/lib/workspace";
import { apiOk, apiError } from "@/lib/auth/response";

/**
 * V5-M1-A4 API: GET /project-contexts/{id}/external-references/{refId}/conflicts
 * 出典: DOC-04 4章、EVAL・受入テスト仕様書 EV-C-005。
 * 既定でPENDINGのみ返す(候補差分として本人へ提示する対象)。
 * `?status=RESOLVED`または`?status=ALL`で解決済み・全件も取得できる。
 */
export async function GET(
  req: NextRequest,
  ctx: { params: Promise<{ id: string; refId: string }> },
) {
  const auth = await requireAuth(req);
  if (!auth.authenticated) {
    return apiError("AUTH_REQUIRED", "ログインが必要です");
  }

  const { id: contextId, refId } = await ctx.params;
  const { workspaceId } = await ensureDefaultWorkspace(auth.user.userId, auth.user.email);

  const context = await db.projectContext.findFirst({ where: { id: contextId, workspaceId, deletedAt: null } });
  if (!context) {
    return apiError("RESOURCE_NOT_FOUND", "指定されたProject Contextが見つかりません");
  }
  const reference = await db.externalContextReference.findFirst({ where: { id: refId, workspaceId, contextId } });
  if (!reference) {
    return apiError("RESOURCE_NOT_FOUND", "指定された外部参照が見つかりません");
  }

  const url = new URL(req.url);
  const statusParam = url.searchParams.get("status");
  const where =
    statusParam === "ALL"
      ? { workspaceId, referenceId: refId }
      : { workspaceId, referenceId: refId, status: statusParam === "RESOLVED" ? "RESOLVED" : "PENDING" };

  const conflicts = await db.externalReferenceConflict.findMany({
    where,
    orderBy: { detectedAt: "desc" },
    select: {
      id: true,
      previousObservedVersion: true,
      newSourceVersion: true,
      newSnapshotRevisionId: true,
      status: true,
      resolutionAction: true,
      resolvedById: true,
      resolvedAt: true,
      detectedAt: true,
    },
  });

  return apiOk({ conflicts });
}
