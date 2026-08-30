import type { NextRequest } from "next/server";
import { z } from "zod";
import { requireAuth, requireCsrf } from "@/lib/auth/guard";
import { ensureDefaultWorkspace } from "@/lib/workspace";
import { apiOk, apiError } from "@/lib/auth/response";
import { FORMATION_ANSWER_KINDS } from "@/lib/formation/coreTypes";
import { recordFormationAnswer } from "@/lib/formation/answerService";

/**
 * V5-M1-B5a: POST /formation-sessions/{id}/answers
 * 出典: ISMAY-V5-DOC-03(Formation Session仕様書) 7章「POST /:id/answers | 回答Event追加 |
 * clientEventId unique」、統合正本v5.0 §6.4「回答にはSELECTED/FREE_TEXT/UNKNOWN/
 * DEFERRED/DO_NOT_MATERIALIZEを許可する」。
 *
 * 既存`/candidates/:candidateId/decisions`(採否)とは別物(質問への回答)。
 * 採否APIと同じ認証・CSRF・エラー変換パターンを踏襲する。
 */

const AnswerRequestSchema = z.object({
  questionId: z.string().min(1),
  clientEventId: z.string().min(1).max(128),
  answerKind: z.enum(FORMATION_ANSWER_KINDS),
  // SELECTED/FREE_TEXTのみ値を持つ。UNKNOWN/DEFERRED/DO_NOT_MATERIALIZEはvalue省略可。
  value: z.unknown().optional(),
  // 訂正時のみ、訂正対象の既存FormationAnswerEvent.idを指定する。
  revisionOfId: z.string().min(1).optional(),
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
  const parsed = AnswerRequestSchema.safeParse(json);
  if (!parsed.success) {
    return apiError("VALIDATION_FAILED", "入力内容を確認してください", {
      fieldErrors: Object.fromEntries(
        Object.entries(parsed.error.flatten().fieldErrors).map(([k, v]) => [k, v?.[0] ?? "不正な値です"]),
      ),
    });
  }

  const { id: sessionId } = await ctx.params;
  const { workspaceId } = await ensureDefaultWorkspace(auth.user.userId, auth.user.email);

  const result = await recordFormationAnswer({
    sessionId,
    workspaceId,
    questionId: parsed.data.questionId,
    clientEventId: parsed.data.clientEventId,
    answerKind: parsed.data.answerKind,
    value: parsed.data.value,
    revisionOfId: parsed.data.revisionOfId,
    actorUserId: auth.user.userId,
  });

  if (!result.ok) {
    switch (result.error) {
      case "NOT_FOUND":
        return apiError("RESOURCE_NOT_FOUND", "指定されたSessionまたは質問が見つかりません");
      case "INVALID_ANSWER_KIND":
        return apiError("VALIDATION_FAILED", "不正な回答種別です");
      case "INVALID_QUESTION_CODE":
        return apiError("VALIDATION_FAILED", "このQuestionは現在のサーバーが認識できないquestionCodeを持っています");
      case "INVALID_SESSION_STATE":
        return apiError(
          "STATE_TRANSITION_INVALID",
          `このSessionは現在${result.sessionState}のため回答できません(CLARIFYING状態でのみ回答可能です)`,
        );
      case "ALREADY_ANSWERED":
        return apiError(
          "STATE_TRANSITION_INVALID",
          "この質問には既に回答済みです。訂正する場合はrevisionOfIdを指定してください",
          { retryable: false, extra: { latestAnswerEventId: result.latestAnswerEventId } },
        );
      case "REVISION_OF_NOT_LATEST":
        return apiError(
          "VERSION_CONFLICT",
          "revisionOfIdがこの質問の最新回答ではありません。最新の回答を取得してください",
          { retryable: true, extra: { latestAnswerEventId: result.latestAnswerEventId } },
        );
      case "IDEMPOTENCY_KEY_REUSED":
        return apiError("IDEMPOTENCY_KEY_REUSED", "同一clientEventIdで異なる内容の回答が既に送信されています");
      case "CORRUPTED_CANDIDATE_DATA":
        return apiError(
          "STATE_TRANSITION_INVALID",
          "候補データの整合性が確認できません(想像で補完せず停止しています)",
          { retryable: false, extra: { candidateId: result.candidateId } },
        );
    }
  }

  return apiOk(
    {
      answerEventId: result.answerEventId,
      sessionState: result.sessionState,
      replay: result.replay,
      candidateRevision: result.candidateRevision,
      questionsAskedCount: result.questionsAskedCount,
    },
    { status: 201 },
  );
}
