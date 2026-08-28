import type { NextRequest } from "next/server";
import { z } from "zod";
import { requireAuth, requireCsrf } from "@/lib/auth/guard";
import { ensureDefaultWorkspace } from "@/lib/workspace";
import { apiOk, apiError } from "@/lib/auth/response";
import { CANDIDATE_DECISION_EVENT_VALUES } from "@/lib/formation/coreTypes";
import { recordCandidateDecision } from "@/lib/formation/materialize";

/**
 * V5-M1-B3: POST /formation-sessions/{id}/candidates/{candidateId}/decisions
 * 出典: ISMAY-V5-DOC-03(Formation Session仕様書) 7章 API-F05
 *       「POST /:id/candidates/:cid/decisions | revision, decision | Decision Event」。
 *
 * 既存`/inferences/[id]/decision`(旧経路)には一切影響しない。このAPIは
 * FormationCandidateDecisionEventへ書き込む新規経路であり、Responsibilityは
 * まだ生成しない(生成は`/materialize`、DOC-03 3章「REVIEW_READY/PARTIALLY_CONFIRMED
 * --commit--> CONFIRMED」の明示操作)。
 */

const DecisionRequestSchema = z.object({
  revision: z.number().int().min(1),
  decision: z.enum(CANDIDATE_DECISION_EVENT_VALUES),
  reasonCode: z.string().max(100).optional(),
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
  const parsed = DecisionRequestSchema.safeParse(json);
  if (!parsed.success) {
    return apiError("VALIDATION_FAILED", "入力内容を確認してください", {
      fieldErrors: Object.fromEntries(
        Object.entries(parsed.error.flatten().fieldErrors).map(([k, v]) => [k, v?.[0] ?? "不正な値です"]),
      ),
    });
  }

  const { id: sessionId, candidateId } = await ctx.params;
  const { workspaceId } = await ensureDefaultWorkspace(auth.user.userId, auth.user.email);

  const result = await recordCandidateDecision({
    sessionId,
    workspaceId,
    candidateId,
    expectedRevision: parsed.data.revision,
    decision: parsed.data.decision,
    reasonCode: parsed.data.reasonCode,
    actorUserId: auth.user.userId,
  });

  if (!result.ok) {
    switch (result.error) {
      case "NOT_FOUND":
        return apiError("RESOURCE_NOT_FOUND", "指定された候補が見つかりません");
      case "INVALID_DECISION_VALUE":
        return apiError("VALIDATION_FAILED", "不正な決定値です");
      case "INVALID_SESSION_STATE":
        return apiError(
          "STATE_TRANSITION_INVALID",
          `このSessionは現在${result.sessionState}のため採否できません`,
        );
      case "REVISION_CONFLICT":
        return apiError("VERSION_CONFLICT", "候補が更新されています。最新のRevisionを取得してください", {
          retryable: true,
          extra: { latestRevision: result.latestRevision },
        });
      case "ALREADY_DECIDED":
        return apiError("STATE_TRANSITION_INVALID", `この候補は既に${result.existingDecision}として処理済みです`);
    }
  }

  return apiOk(
    { decisionEventId: result.decisionEventId, sessionState: result.sessionState },
    { status: 201 },
  );
}
