import type { NextRequest } from "next/server";
import { z } from "zod";
import { db } from "@/lib/db";
import { debugServer, redactSensitive } from "@/lib/debugServer";
import { requireAuth, requireCsrf } from "@/lib/auth/guard";
import { ensureDefaultWorkspace } from "@/lib/workspace";
import { apiOk, apiError } from "@/lib/auth/response";
import {
  resolveExternalReferenceConflict,
  type ResolveExternalReferenceConflictParams,
} from "@/lib/projectContext/externalReferenceSync";

/**
 * V5-M1-A4 API: POST
 * /project-contexts/{id}/external-references/{refId}/conflicts/{conflictId}/resolve
 * 出典: DOC-04 4章、EVAL・受入テスト仕様書 EV-C-005。
 * 本人が明示的にKEEP_LOCAL/APPLY_REMOTEを選ぶことでLWWを回避する。
 */

const ResolveSchema = z.object({
  action: z.enum(["KEEP_LOCAL", "APPLY_REMOTE"]),
});

export async function POST(
  req: NextRequest,
  ctx: { params: Promise<{ id: string; refId: string; conflictId: string }> },
) {
  const auth = await requireAuth(req);
  if (!auth.authenticated) {
    return apiError("AUTH_REQUIRED", "ログインが必要です");
  }
  if (!requireCsrf(req)) {
    return apiError("ACCESS_DENIED", "CSRFトークンが不正です");
  }

  const json = await req.json().catch(() => null);
  debugServer.input(
    "POST /project-contexts/[id]/external-references/[refId]/conflicts/[conflictId]/resolve",
    "requestBody",
    redactSensitive(json),
  );
  const parsed = ResolveSchema.safeParse(json);
  if (!parsed.success) {
    return apiError("VALIDATION_FAILED", "入力内容を確認してください", {
      fieldErrors: Object.fromEntries(
        Object.entries(parsed.error.flatten().fieldErrors).map(([k, v]) => [k, v?.[0] ?? "不正な値です"]),
      ),
    });
  }

  const { id: contextId, refId, conflictId } = await ctx.params;
  const { workspaceId } = await ensureDefaultWorkspace(auth.user.userId, auth.user.email);

  const context = await db.projectContext.findFirst({ where: { id: contextId, workspaceId, deletedAt: null } });
  if (!context) {
    return apiError("RESOURCE_NOT_FOUND", "指定されたProject Contextが見つかりません");
  }
  const reference = await db.externalContextReference.findFirst({ where: { id: refId, workspaceId, contextId } });
  if (!reference) {
    return apiError("RESOURCE_NOT_FOUND", "指定された外部参照が見つかりません");
  }
  const conflict = await db.externalReferenceConflict.findFirst({ where: { id: conflictId, workspaceId, referenceId: refId } });
  if (!conflict) {
    return apiError("RESOURCE_NOT_FOUND", "指定されたconflictが見つかりません");
  }

  const resolveParams: ResolveExternalReferenceConflictParams = {
    workspaceId,
    conflictId,
    action: parsed.data.action,
    actorUserId: auth.user.userId,
  };
  const result = await resolveExternalReferenceConflict(resolveParams);

  if (!result.ok) {
    switch (result.error) {
      case "NOT_FOUND":
        return apiError("RESOURCE_NOT_FOUND", "指定されたconflictが見つかりません");
      case "ALREADY_RESOLVED":
        return apiError("STATE_TRANSITION_INVALID", "このconflictは既に解決済みです");
    }
  }

  debugServer.event(
    "POST /project-contexts/[id]/external-references/[refId]/conflicts/[conflictId]/resolve",
    "EXTERNAL_SNAPSHOT_CONFLICT_RESOLVED",
    { conflictId, action: parsed.data.action },
  );

  return apiOk({ conflictId, action: parsed.data.action, referenceLastObservedVersion: result.referenceLastObservedVersion });
}
