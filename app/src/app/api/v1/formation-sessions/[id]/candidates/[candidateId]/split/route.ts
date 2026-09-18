import type { NextRequest } from "next/server";
import { z } from "zod";
import { requireAuth, requireCsrf } from "@/lib/auth/guard";
import { ensureDefaultWorkspace } from "@/lib/workspace";
import { apiOk, apiError } from "@/lib/auth/response";
import { RESPONSIBILITY_TYPES } from "@/lib/responsibility";
import { splitFormationCandidate } from "@/lib/formation/splitCorrection";
import { computeCasePatternFeedbackPayloadHash } from "@/lib/patterns/casePatternFeedbackService";

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
  /** [PATTERN-ACTIONSLOT-LEARN-01/PATTERN-APPLY-02B新設] 本人が明示的に
   *  選択した、またはmatched suggestionを起点に適用されたCase Pattern。 */
  attributedCasePatternId: z.string().min(1).optional(),
  /** [PATTERN-APPLY-02B新設・2026-09-18] Preview(decomposition proposal)から
   *  このSplitを確定した場合のSuggestion識別子。指定時はattributedCasePatternId
   *  も必須、かつIdempotency-Keyヘッダが必須(既存feedback APIと同じ規約)。 */
  suggestionFeedback: z
    .object({
      suggestionId: z.string().min(1),
      expectedSuggestionRevision: z.number().int().min(1),
    })
    .optional(),
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

  // [PATTERN-APPLY-02B新設・2026-09-18] suggestionFeedback指定時のみ
  // Idempotency-Keyヘッダを必須にする(既存case-patterns/suggestions/{id}/
  // feedback routeと同じ規約。attributedCasePatternIdのみの通常Split
  // ではIdempotency-Key不要のまま、既存呼び出し元との後方互換を保つ)。
  let suggestionFeedbackParams: { suggestionId: string; expectedSuggestionRevision: number; idempotencyKey: string; requestPayloadHash: string } | undefined;
  if (parsed.data.suggestionFeedback) {
    const idempotencyKey = req.headers.get("idempotency-key");
    if (!idempotencyKey) {
      return apiError("VALIDATION_FAILED", "Idempotency-Keyヘッダが必要です", {
        fieldErrors: { "Idempotency-Key": "必須ヘッダです" },
      });
    }
    suggestionFeedbackParams = {
      suggestionId: parsed.data.suggestionFeedback.suggestionId,
      expectedSuggestionRevision: parsed.data.suggestionFeedback.expectedSuggestionRevision,
      idempotencyKey,
      requestPayloadHash: computeCasePatternFeedbackPayloadHash(parsed.data.suggestionFeedback),
    };
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
    attributedCasePatternId: parsed.data.attributedCasePatternId,
    suggestionFeedback: suggestionFeedbackParams,
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
      case "ATTRIBUTED_PATTERN_NOT_FOUND":
        // [PATTERN-ACTIONSLOT-LEARN-01新設・2026-09-17]
        return apiError("VALIDATION_FAILED", "指定されたCase Patternが見つかりません", { retryable: false });
      // [PATTERN-APPLY-02B新設・2026-09-18] suggestionFeedback関連エラー。
      // 既存feedback route(case-patterns/suggestions/[id]/feedback)と
      // 同じエラーcode対応にする(想像で新しい対応表を発明しない)。
      case "SUGGESTION_NOT_FOUND":
        return apiError("RESOURCE_NOT_FOUND", "指定された提案が見つかりません");
      case "SUGGESTION_FORBIDDEN":
        return apiError("ACCESS_DENIED", "この提案に対する操作権限がありません");
      case "SUGGESTION_REVISION_CONFLICT":
        return apiError("VERSION_CONFLICT", "提案が更新されています。最新の状態を取得してください", {
          retryable: true,
          extra: { latestRevision: result.latestRevision },
        });
      case "SUGGESTION_NOT_MATCHED":
        return apiError(
          "STATE_TRANSITION_INVALID",
          "この提案は候補が確定していない、またはActionSlotの学習データが無いため、この経路でのFeedback記録はできません",
        );
      case "SUGGESTION_PATTERN_MISMATCH":
        return apiError("VALIDATION_FAILED", "指定されたPatternと提案の照合先Patternが一致しません", { retryable: false });
      case "SUGGESTION_IDEMPOTENCY_KEY_REUSED":
        return apiError("IDEMPOTENCY_KEY_REUSED", "同一のリクエストキーで内容の異なるリクエストが送信されました");
    }
  }

  return apiOk(
    { decisionEventId: result.decisionEventId, sessionState: result.sessionState, newCandidates: result.newCandidates },
    { status: 201 },
  );
}
