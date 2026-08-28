import type { NextRequest } from "next/server";
import { z } from "zod";
import { requireAuth, requireCsrf } from "@/lib/auth/guard";
import { ensureDefaultWorkspace } from "@/lib/workspace";
import { apiOk, apiError } from "@/lib/auth/response";
import { materializeFormationSession } from "@/lib/formation/materialize";

/**
 * V5-M1-B3: POST /formation-sessions/{id}/materialize
 * 出典: ISMAY-V5-DOC-03(Formation Session仕様書) 7章 API-F06
 *       「POST /:id/materialize | operationId, accepted revisions, version | Receipt/items」、
 *       6章(Materialization Transaction)、10章「B3はMaterialize serviceへsingle-write」。
 *
 * ACCEPTED決定済みの候補(直前の`/candidates/:cid/decisions`で記録済み)を一括して
 * Responsibility化する。「accepted revisions」の個別指定はこのGateでは受け取らず、
 * 常に「その時点でACCEPTEDかつ未Materializeの候補すべて」を対象にする(部分指定は
 * 想像で仕様を拡張することになるため、DOC-03 7章の記載どおり最小実装とする)。
 */

const MaterializeRequestSchema = z.object({
  operationId: z.string().min(1).max(200),
  version: z.number().int().min(0),
});

export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const auth = await requireAuth(req);
  if (!auth.authenticated) {
    return apiError("AUTH_REQUIRED", "ログインが必要です");
  }
  if (!requireCsrf(req)) {
    return apiError("ACCESS_DENIED", "CSRFトークンが不正です");
  }

  const json = await req.json().catch(() => null);
  const parsed = MaterializeRequestSchema.safeParse(json);
  if (!parsed.success) {
    return apiError("VALIDATION_FAILED", "入力内容を確認してください", {
      fieldErrors: Object.fromEntries(
        Object.entries(parsed.error.flatten().fieldErrors).map(([k, v]) => [k, v?.[0] ?? "不正な値です"]),
      ),
    });
  }

  const { id: sessionId } = await ctx.params;
  const { workspaceId } = await ensureDefaultWorkspace(auth.user.userId, auth.user.email);

  const result = await materializeFormationSession({
    sessionId,
    workspaceId,
    operationId: parsed.data.operationId,
    expectedVersion: parsed.data.version,
    actorUserId: auth.user.userId,
  });

  if (!result.ok) {
    switch (result.error) {
      case "NOT_FOUND":
        return apiError("RESOURCE_NOT_FOUND", "指定されたFormation Sessionが見つかりません");
      case "VERSION_CONFLICT":
        return apiError("VERSION_CONFLICT", "他の操作と競合しました。最新の状態を取得してください", {
          retryable: true,
        });
      case "INVALID_SESSION_STATE":
        return apiError(
          "STATE_TRANSITION_INVALID",
          `このSessionは現在${result.sessionState}のためMaterializeできません`,
        );
      case "NO_ACCEPTED_CANDIDATES":
        return apiError("VALIDATION_FAILED", "承認済み(ACCEPTED)の候補がありません");
      case "IDEMPOTENCY_KEY_REUSED":
        return apiError("IDEMPOTENCY_KEY_REUSED", "同一operationIdで異なる内容のリクエストが送信されました");
      case "CORRUPTED_CANDIDATE_DATA":
        return apiError("VALIDATION_FAILED", "候補データが不正なためMaterializeできません");
    }
  }

  return apiOk(
    { receiptId: result.receiptId, operationId: result.operationId, items: result.items, replay: result.replay },
    { status: result.replay ? 200 : 201 },
  );
}
