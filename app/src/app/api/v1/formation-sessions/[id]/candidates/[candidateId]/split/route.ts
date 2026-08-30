import type { NextRequest } from "next/server";
import { z } from "zod";
import { requireAuth, requireCsrf } from "@/lib/auth/guard";
import { ensureDefaultWorkspace } from "@/lib/workspace";
import { apiOk, apiError } from "@/lib/auth/response";
import { RESPONSIBILITY_TYPES } from "@/lib/responsibility";
import { splitFormationCandidate } from "@/lib/formation/splitCorrection";

/**
 * V5-M1-C: POST /formation-sessions/{id}/candidates/{candidateId}/split
 * 出典: ISMAY_統合正本仕様書_v5_0.md §11.4「分解Transaction」。
 *
 * 既存`/candidates/{candidateId}/decisions`(ACCEPT/REJECT/DEFER/DO_NOT_MATERIALIZE)
 * とは別のAPIとして新設する。SPLITは複数の新規候補を同一transaction内で
 * 作るという性質上、既存decisions APIの単純な「1つのdecision文字列を送るだけ」の
 * 入出力形とは異なるため(§11.4「新しい…群とRelationを同一transactionで作る」)。
 */

const SplitPartSchema = z.object({
  type: z.enum(RESPONSIBILITY_TYPES),
  title: z.string().min(1).max(300),
  description: z.string().max(20000).optional(),
  completionCondition: z.string().max(2000).optional(),
});

const SplitRequestSchema = z.object({
  revision: z.number().int().min(1),
  parts: z.array(SplitPartSchema).min(2).max(10),
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
  const parsed = SplitRequestSchema.safeParse(json);
  if (!parsed.success) {
    return apiError("VALIDATION_FAILED", "入力内容を確認してください(分解には2件以上の部分が必要です)", {
      fieldErrors: Object.fromEntries(
        Object.entries(parsed.error.flatten().fieldErrors).map(([k, v]) => [k, v?.[0] ?? "不正な値です"]),
      ),
    });
  }

  const { id: sessionId, candidateId } = await ctx.params;
  const { workspaceId } = await ensureDefaultWorkspace(auth.user.userId, auth.user.email);

  const result = await splitFormationCandidate({
    sessionId,
    workspaceId,
    candidateId,
    expectedRevision: parsed.data.revision,
    parts: parsed.data.parts,
    reasonCode: parsed.data.reasonCode,
    actorUserId: auth.user.userId,
  });

  if (!result.ok) {
    switch (result.error) {
      case "NOT_FOUND":
        return apiError("RESOURCE_NOT_FOUND", "指定された候補が見つかりません");
      case "INVALID_SPLIT_PARTS":
        return apiError("VALIDATION_FAILED", result.reason);
      case "INVALID_SESSION_STATE":
        return apiError(
          "STATE_TRANSITION_INVALID",
          `このSessionは現在${result.sessionState}のため分解できません`,
        );
      case "REVISION_CONFLICT":
        return apiError("VERSION_CONFLICT", "候補が更新されています。最新のRevisionを取得してください", {
          retryable: true,
          extra: { latestRevision: result.latestRevision },
        });
      case "ALREADY_DECIDED":
        return apiError("STATE_TRANSITION_INVALID", `この候補は既に${result.existingDecision}として処理済みです`);
      case "ALREADY_MATERIALIZED_BY_LEGACY":
        return apiError(
          "STATE_TRANSITION_INVALID",
          `この候補は旧経路(inferenceId=${result.legacyInferenceId})で既に${result.legacyDecision}として処理済みです`,
          { retryable: false, extra: { legacyInferenceId: result.legacyInferenceId, legacyDecision: result.legacyDecision } },
        );
      case "ALREADY_DECIDED_BY_LEGACY":
        return apiError(
          "STATE_TRANSITION_INVALID",
          `この候補は旧経路(inferenceId=${result.legacyInferenceId})で既に${result.legacyDecision}として処理済みです`,
          { retryable: false, extra: { legacyInferenceId: result.legacyInferenceId, legacyDecision: result.legacyDecision } },
        );
      case "LEGACY_PROJECTION_CONFLICT":
        return apiError(
          "STATE_TRANSITION_INVALID",
          `旧経路データの整合性が確認できません(inferenceId=${result.legacyInferenceId}、decision=${result.legacyDecision}のResponsibilityが見つかりません)`,
          { retryable: false, extra: { legacyInferenceId: result.legacyInferenceId, legacyDecision: result.legacyDecision } },
        );
      case "CORRUPTED_CANDIDATE_DATA":
        // [2026-08-30新設・M1-C2C是正]
        return apiError("VALIDATION_FAILED", "候補データが破損しているため分解できません。管理者へご連絡ください", { retryable: false });
    }
  }

  return apiOk(
    { decisionEventId: result.decisionEventId, sessionState: result.sessionState, newCandidates: result.newCandidates },
    { status: 201 },
  );
}
