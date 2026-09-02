import type { NextRequest } from "next/server";
import { createHash } from "node:crypto";
import { z } from "zod";
import { db } from "@/lib/db";
import { debugServer, redactSensitive } from "@/lib/debugServer";
import { requireAuth, requireCsrf } from "@/lib/auth/guard";
import { buildPemAuthorizationContext } from "@/lib/pem/authorizationBoundary";
import { revokeCompleteEvent } from "@/lib/pem/executionCorrection";
import { apiOk, apiError } from "@/lib/auth/response";

/**
 * V5 API: POST /execution-events/{id}/corrections
 * 出典: DOC-11(API・Event仕様書) 3章 API-E03。
 *
 * [scope宣言] 現時点でcorrectionType="REVOKE"のみを受け付ける
 * (executionCorrection.ts冒頭コメント参照)。対象EventはeventType=COMPLETEの
 * ものに限る。
 */

const CorrectionSchema = z.object({
  correctionType: z.literal("REVOKE"),
  reason: z.string().max(2000).optional(),
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
  debugServer.input("POST /execution-events/[id]/corrections", "requestBody", redactSensitive(json));
  const parsed = CorrectionSchema.safeParse(json);
  if (!parsed.success) {
    return apiError("VALIDATION_FAILED", "入力内容を確認してください(現時点ではcorrectionType=REVOKEのみ対応)", {
      fieldErrors: Object.fromEntries(
        Object.entries(parsed.error.flatten().fieldErrors).map(([k, v]) => [k, v?.[0] ?? "不正な値です"]),
      ),
    });
  }

  const { id: targetEventId } = await ctx.params;
  const requestPayloadHash = createHash("sha256").update(JSON.stringify(parsed.data)).digest("hex");

  const pemCtx = await buildPemAuthorizationContext(auth.user.userId, auth.user.userId);

  // [IDOR対策] tenant一致は先に確認する(他workspaceのEvent IDを推測されても
  // 存在有無を漏らさない、既存responsibilities/[id]と同じ設計)。
  const targetEvent = await db.responsibilityExecutionEvent.findFirst({
    where: { id: targetEventId, workspaceId: pemCtx.tenantId },
    select: { id: true },
  });
  if (!targetEvent) {
    return apiError("RESOURCE_NOT_FOUND", "指定されたExecution Eventが見つかりません");
  }

  const result = await revokeCompleteEvent({
    workspaceId: pemCtx.tenantId,
    ctx: pemCtx,
    targetEventId,
    reason: parsed.data.reason,
    idempotencyKey,
    requestPayloadHash,
  });

  if (!result.ok) {
    switch (result.error) {
      case "NOT_FOUND":
        return apiError("RESOURCE_NOT_FOUND", "指定されたExecution Eventが見つかりません");
      case "NOT_COMPLETE_EVENT":
        return apiError("VALIDATION_FAILED", "指定されたEventはCOMPLETE種別ではないため取消できません(現時点の対応範囲外)");
      case "ALREADY_CORRECTED":
        return apiError("STATE_TRANSITION_INVALID", "指定されたEventは既に訂正済みです");
      case "STATE_CHANGED":
        return apiError("VERSION_CONFLICT", "対象責任の状態が変化しているため取消できません。最新の状態を確認してください", {
          retryable: true,
        });
      case "IDEMPOTENCY_KEY_REUSED":
        return apiError("IDEMPOTENCY_KEY_REUSED", "同一のリクエストキーで内容の異なるリクエストが送信されました");
    }
  }

  debugServer.event("POST /execution-events/[id]/corrections", "RESPONSIBILITY_LIFECYCLE_CORRECTION", {
    targetEventId,
    lifecycleEventId: result.lifecycleEventId,
  });

  return apiOk(
    { lifecycleEventId: result.lifecycleEventId, resultingEventId: result.resultingEventId },
    { status: result.replay ? 200 : 201 },
  );
}
