import type { NextRequest } from "next/server";
import { z } from "zod";
import { debugServer, redactSensitive } from "@/lib/debugServer";
import { requireAuth, requireCsrf } from "@/lib/auth/guard";
import { ensureDefaultWorkspace } from "@/lib/workspace";
import { apiOk, apiError } from "@/lib/auth/response";
import { CASE_PATTERN_FEEDBACK_VERDICTS } from "@/lib/patterns/coreTypes";
import { recordCasePatternFeedback, computeCasePatternFeedbackPayloadHash } from "@/lib/patterns/casePatternFeedbackService";

/**
 * POST /api/v1/case-patterns/suggestions/{id}/feedback(PATTERN-SUGGEST-01C新設・2026-09-05)。
 * 出典: ISMAY_ハンドオフ資料_2026-09-05.md §5-2。
 *
 * [既存規約に倣う] CSRF必須(既存merge/split/decisionsと同じ)、Idempotency-Key
 * ヘッダ必須(既存merge/splitと同じ、DEC-11踏襲)、revisionによる
 * optimistic concurrency(既存candidates/decisionsのrevisionパターンと同じ)。
 */

const FeedbackRequestSchema = z.object({
  revision: z.number().int().min(1),
  verdict: z.enum(CASE_PATTERN_FEEDBACK_VERDICTS),
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

  const { id: suggestionId } = await ctx.params;
  const json = await req.json().catch(() => null);
  debugServer.input("POST /case-patterns/suggestions/[id]/feedback", "requestBody", redactSensitive(json));
  const parsed = FeedbackRequestSchema.safeParse(json);
  if (!parsed.success) {
    return apiError("VALIDATION_FAILED", "入力内容を確認してください", {
      fieldErrors: Object.fromEntries(
        Object.entries(parsed.error.flatten().fieldErrors).map(([k, v]) => [k, v?.[0] ?? "不正な値です"]),
      ),
    });
  }
  const requestPayloadHash = computeCasePatternFeedbackPayloadHash(parsed.data);

  const { workspaceId } = await ensureDefaultWorkspace(auth.user.userId, auth.user.email);

  const result = await recordCasePatternFeedback({
    workspaceId,
    suggestionId,
    actorUserId: auth.user.userId,
    expectedRevision: parsed.data.revision,
    verdict: parsed.data.verdict,
    idempotencyKey,
    requestPayloadHash,
  });

  if (!result.ok) {
    switch (result.error) {
      case "NOT_FOUND":
        return apiError("RESOURCE_NOT_FOUND", "指定された提案が見つかりません");
      case "FORBIDDEN":
        return apiError("ACCESS_DENIED", "この提案に対する操作権限がありません");
      case "REVISION_CONFLICT":
        return apiError("VERSION_CONFLICT", "提案が更新されています。最新の状態を取得してください", {
          retryable: true,
          extra: { latestRevision: result.latestRevision },
        });
      case "SUGGESTION_NOT_MATCHED":
        return apiError(
          "STATE_TRANSITION_INVALID",
          "この提案は候補が確定していない(複数Pattern候補で判定保留中)ため、フィードバックを記録できません",
        );
      case "IDEMPOTENCY_KEY_REUSED":
        return apiError("IDEMPOTENCY_KEY_REUSED", "同一のリクエストキーで内容の異なるリクエストが送信されました");
    }
  }

  debugServer.event("POST /case-patterns/suggestions/[id]/feedback", "CASE_PATTERN_FEEDBACK_RECORDED", {
    suggestionId,
    feedbackEventId: result.feedbackEventId,
    verdict: parsed.data.verdict,
    replay: result.replay,
  });

  return apiOk(
    { feedbackEventId: result.feedbackEventId, suggestionState: result.suggestionState },
    { status: result.replay ? 200 : 201 },
  );
}
