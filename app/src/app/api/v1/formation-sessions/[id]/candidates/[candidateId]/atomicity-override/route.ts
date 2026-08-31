import type { NextRequest } from "next/server";
import { z } from "zod";
import { requireAuth, requireCsrf } from "@/lib/auth/guard";
import { ensureDefaultWorkspace } from "@/lib/workspace";
import { apiOk, apiError } from "@/lib/auth/response";
import { recordAtomicityOverride } from "@/lib/formation/atomicityOverride";

/**
 * V5-M1-C2A: POST /formation-sessions/{id}/candidates/{candidateId}/atomicity-override
 * 出典: 2026-08-30確定指示書 Gate M1-C2A。
 *
 * [R1-02是正・監査是正指示書2026-08-31] clientEventIdを必須化し、merge API
 * (`/candidates/merge`)と同じidempotency契約へ揃えた。
 */

const OverrideRequestSchema = z.object({
  clientEventId: z.string().min(1).max(200),
  revision: z.number().int().min(1),
  reasonCode: z.string().min(1).max(100),
});

export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string; candidateId: string }> }) {
  const auth = await requireAuth(req);
  if (!auth.authenticated) {
    return apiError("AUTH_REQUIRED", "ログインが必要です");
  }
  if (!requireCsrf(req)) {
    return apiError("ACCESS_DENIED", "CSRFトークンが不正です");
  }

  const json = await req.json().catch(() => null);
  const parsed = OverrideRequestSchema.safeParse(json);
  if (!parsed.success) {
    return apiError("VALIDATION_FAILED", "入力内容を確認してください", {
      fieldErrors: Object.fromEntries(
        Object.entries(parsed.error.flatten().fieldErrors).map(([k, v]) => [k, v?.[0] ?? "不正な値です"]),
      ),
    });
  }

  const { id: sessionId, candidateId } = await ctx.params;
  const { workspaceId } = await ensureDefaultWorkspace(auth.user.userId, auth.user.email);

  const result = await recordAtomicityOverride({
    sessionId,
    workspaceId,
    candidateId,
    expectedRevision: parsed.data.revision,
    reasonCode: parsed.data.reasonCode,
    actorUserId: auth.user.userId,
    clientEventId: parsed.data.clientEventId,
  });

  if (!result.ok) {
    switch (result.error) {
      case "NOT_FOUND":
        return apiError("RESOURCE_NOT_FOUND", "指定された候補が見つかりません");
      case "INVALID_REASON_CODE":
        return apiError("VALIDATION_FAILED", "reasonCodeを入力してください");
      case "INVALID_SESSION_STATE":
        return apiError("STATE_TRANSITION_INVALID", `このSessionは現在${result.sessionState}のためoverrideできません`);
      case "REVISION_CONFLICT":
        return apiError("VERSION_CONFLICT", "候補が更新されています。最新のRevisionを取得してください", {
          retryable: true,
          extra: { latestRevision: result.latestRevision },
        });
      case "ALREADY_DECIDED":
        return apiError("STATE_TRANSITION_INVALID", `この候補は既に${result.existingDecision}として処理済みです`);
      case "ALREADY_MATERIALIZED_BY_LEGACY":
      case "ALREADY_DECIDED_BY_LEGACY":
      case "LEGACY_PROJECTION_CONFLICT":
        return apiError(
          "STATE_TRANSITION_INVALID",
          `この候補は旧経路(inferenceId=${result.legacyInferenceId})で既に${result.legacyDecision}として処理済みです`,
          { retryable: false, extra: { legacyInferenceId: result.legacyInferenceId, legacyDecision: result.legacyDecision } },
        );
      case "CORRUPTED_CANDIDATE_DATA":
        return apiError("VALIDATION_FAILED", "候補データが破損しているためoverrideできません。管理者へご連絡ください", {
          retryable: false,
        });
      case "OVERRIDE_NOT_APPLICABLE":
        return apiError(
          "VALIDATION_FAILED",
          `この候補は現在${result.assessment}のためoverrideは不要です`,
        );
      case "IDEMPOTENCY_KEY_REUSED":
        return apiError("IDEMPOTENCY_KEY_REUSED", "同一clientEventIdで異なる内容のリクエストが送信されました");
    }
  }

  return apiOk(
    { overrideId: result.overrideId, assessment: result.assessment, replay: result.replay },
    { status: result.replay ? 200 : 201 },
  );
}
