import type { NextRequest } from "next/server";
import { z } from "zod";
import { requireAuth, requireCsrf } from "@/lib/auth/guard";
import { ensureDefaultWorkspace } from "@/lib/workspace";
import { apiOk, apiError } from "@/lib/auth/response";
import { RESPONSIBILITY_TYPES } from "@/lib/responsibility";
import { mergeFormationCandidates } from "@/lib/formation/mergeCorrection";

/**
 * V5-M1-C2B: POST /formation-sessions/{id}/candidates/merge
 * 出典: 2026-08-30確定指示書 DEC-MERGE-001。
 *
 * split(`/candidates/{candidateId}/split`)と対称に、複数の親candidateIdを
 * 統合するため、対象candidateIdを1つに固定できない。このためsplitとは異なり
 * URLに単一candidateIdを含めず、bodyでparents配列を受け取る。
 */

const MergeParentSchema = z.object({
  candidateId: z.string().min(1),
  revision: z.number().int().min(1),
});

const MergedContentSchema = z.object({
  type: z.enum(RESPONSIBILITY_TYPES),
  title: z.string().min(1).max(300),
  description: z.string().max(20000).optional(),
  completionCondition: z.string().max(2000).optional(),
});

const MergeRequestSchema = z.object({
  clientEventId: z.string().min(1).max(200),
  parents: z.array(MergeParentSchema).min(2).max(10),
  merged: MergedContentSchema,
  reasonCode: z.string().max(100).optional(),
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
  const parsed = MergeRequestSchema.safeParse(json);
  if (!parsed.success) {
    return apiError("VALIDATION_FAILED", "入力内容を確認してください(統合には2件以上の候補が必要です)", {
      fieldErrors: Object.fromEntries(
        Object.entries(parsed.error.flatten().fieldErrors).map(([k, v]) => [k, v?.[0] ?? "不正な値です"]),
      ),
    });
  }

  const { id: sessionId } = await ctx.params;
  const { workspaceId } = await ensureDefaultWorkspace(auth.user.userId, auth.user.email);

  const result = await mergeFormationCandidates({
    sessionId,
    workspaceId,
    clientEventId: parsed.data.clientEventId,
    parents: parsed.data.parents.map((p) => ({ candidateId: p.candidateId, expectedRevision: p.revision })),
    merged: parsed.data.merged,
    reasonCode: parsed.data.reasonCode,
    actorUserId: auth.user.userId,
  });

  if (!result.ok) {
    switch (result.error) {
      case "NOT_FOUND":
        return apiError("RESOURCE_NOT_FOUND", "指定された候補またはSessionが見つかりません");
      case "INVALID_MERGE_PARTS":
        return apiError("VALIDATION_FAILED", result.reason);
      case "DUPLICATE_PARENT_CANDIDATE":
        return apiError("VALIDATION_FAILED", "同じ候補が重複して指定されています");
      case "INVALID_SESSION_STATE":
        return apiError("STATE_TRANSITION_INVALID", `このSessionは現在${result.sessionState}のため統合できません`);
      case "REVISION_CONFLICT":
        return apiError("VERSION_CONFLICT", "候補が更新されています。最新のRevisionを取得してください", {
          retryable: true,
          extra: { candidateId: result.candidateId, latestRevision: result.latestRevision },
        });
      case "ALREADY_DECIDED":
        return apiError(
          "STATE_TRANSITION_INVALID",
          `候補の一部(${result.candidateId})は既に${result.existingDecision}として処理済みです`,
        );
      case "ALREADY_MATERIALIZED_BY_LEGACY":
      case "ALREADY_DECIDED_BY_LEGACY":
      case "LEGACY_PROJECTION_CONFLICT":
        return apiError(
          "STATE_TRANSITION_INVALID",
          `候補の一部(${result.candidateId})は旧経路(inferenceId=${result.legacyInferenceId})で既に${result.legacyDecision}として処理済みです`,
          { retryable: false, extra: { candidateId: result.candidateId, legacyInferenceId: result.legacyInferenceId, legacyDecision: result.legacyDecision } },
        );
      case "IDEMPOTENCY_KEY_REUSED":
        return apiError("IDEMPOTENCY_KEY_REUSED", "同一clientEventIdで異なる内容のリクエストが送信されました");
    }
  }

  return apiOk(
    {
      newCandidateId: result.newCandidateId,
      newCandidateKey: result.newCandidateKey,
      newRevisionId: result.newRevisionId,
      parentDecisionEventIds: result.parentDecisionEventIds,
      replay: result.replay,
    },
    { status: result.replay ? 200 : 201 },
  );
}
