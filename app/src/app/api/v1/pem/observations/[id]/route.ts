import type { NextRequest } from "next/server";
import { z } from "zod";
import { db } from "@/lib/db";
import { debugServer, redactSensitive } from "@/lib/debugServer";
import { requireAuth, requireCsrf } from "@/lib/auth/guard";
import { apiOk, apiError } from "@/lib/auth/response";
import { deleteObservationEvidence } from "@/lib/pem/evidenceDeletionService";

/**
 * V5新設 API: DELETE /pem/observations/{id} 個別Evidence削除。
 * 出典: PEMサブシステム統合正本仕様書v4.0 16.3節・16.4節、
 * DOC-09(Consent・Data Governance仕様書) 9章「deletion graphの全nodeが完了
 * または明示retain reasonを持つ」。実処理はevidenceDeletionService.tsに
 * 委譲する(scope宣言もそちら参照)。
 */

const DeleteObservationSchema = z.object({
  reason: z.string().max(2000).optional(),
});

export async function DELETE(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const auth = await requireAuth(req);
  if (!auth.authenticated) {
    return apiError("AUTH_REQUIRED", "ログインが必要です");
  }
  if (!requireCsrf(req)) {
    return apiError("ACCESS_DENIED", "CSRFトークンが不正です");
  }

  const json = await req.json().catch(() => ({}));
  debugServer.input("DELETE /pem/observations/[id]", "requestBody", redactSensitive(json));
  const parsed = DeleteObservationSchema.safeParse(json);
  if (!parsed.success) {
    return apiError("VALIDATION_FAILED", "入力内容を確認してください", {
      fieldErrors: Object.fromEntries(
        Object.entries(parsed.error.flatten().fieldErrors).map(([k, v]) => [k, v?.[0] ?? "不正な値です"]),
      ),
    });
  }

  const { id } = await ctx.params;
  const userId = auth.user.userId;

  const result = await deleteObservationEvidence({ userId, observationId: id, reason: parsed.data.reason });
  if (!result.ok) {
    return apiError("RESOURCE_NOT_FOUND", "指定された観察・事実が見つかりません");
  }

  if (!result.alreadyDeleted) {
    await db.auditLog.create({
      data: {
        actorUserId: userId,
        actorType: "USER",
        action: "PEM_EVIDENCE_DELETED",
        targetType: "PemObservation",
        targetId: id,
        result: "SUCCESS",
        reason: parsed.data.reason,
      },
    });
    debugServer.state("DELETE /pem/observations/[id]", "Evidence削除完了", {
      id,
      userId,
      hypothesesInvalidated: result.hypothesesInvalidated,
      weeklyReviewsInvalidated: result.weeklyReviewsInvalidated,
    });
  }

  return apiOk({
    id,
    deleted: true,
    alreadyDeleted: result.alreadyDeleted,
    ...(result.alreadyDeleted
      ? {}
      : { hypothesesInvalidated: result.hypothesesInvalidated, weeklyReviewsInvalidated: result.weeklyReviewsInvalidated }),
  });
}
