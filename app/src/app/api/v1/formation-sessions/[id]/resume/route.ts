import type { NextRequest } from "next/server";
import { z } from "zod";
import { requireAuth, requireCsrf } from "@/lib/auth/guard";
import { ensureDefaultWorkspace } from "@/lib/workspace";
import { apiOk, apiError } from "@/lib/auth/response";
import { resumeFormationSession } from "@/lib/formation/sessionLifecycle";

/**
 * V5-M1-B6B: POST /formation-sessions/{id}/resume
 * 出典: Claude向け ISMAY 69b5a87以降 監査是正・M1-B6完遂・PEM-0連続実装指示
 *       (2026-08-31) Gate M1-B6B Session Lifecycle。
 * DEFERRED --RESUME--> {ANALYZING|CLARIFYING|REVIEW_READY}(defer直前の実状態から
 * 機械的に復元。想像で常にREVIEW_READYへ戻さない、sessionLifecycle.ts参照)。
 */

const ResumeRequestSchema = z.object({
  clientEventId: z.string().min(1).max(200),
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
  const parsed = ResumeRequestSchema.safeParse(json);
  if (!parsed.success) {
    return apiError("VALIDATION_FAILED", "入力内容を確認してください", {
      fieldErrors: Object.fromEntries(
        Object.entries(parsed.error.flatten().fieldErrors).map(([k, v]) => [k, v?.[0] ?? "不正な値です"]),
      ),
    });
  }

  const { id: sessionId } = await ctx.params;
  const { workspaceId } = await ensureDefaultWorkspace(auth.user.userId, auth.user.email);

  const result = await resumeFormationSession({
    sessionId,
    workspaceId,
    clientEventId: parsed.data.clientEventId,
    actorUserId: auth.user.userId,
  });

  if (!result.ok) {
    switch (result.error) {
      case "NOT_FOUND":
        return apiError("RESOURCE_NOT_FOUND", "指定されたSessionが見つかりません");
      case "INVALID_SESSION_STATE":
        return apiError(
          "STATE_TRANSITION_INVALID",
          `このSessionは現在${result.sessionState}のためresumeできません(DEFERREDのみ対象)`,
        );
      case "IDEMPOTENCY_KEY_REUSED":
        return apiError("IDEMPOTENCY_KEY_REUSED", "同一clientEventIdで異なる内容のリクエストが送信されました");
      case "COREYPES_TRANSITION_UNDEFINED":
        return apiError(
          "VALIDATION_FAILED",
          "defer前の状態を復元できませんでした。管理者へご連絡ください",
          { retryable: false },
        );
    }
  }

  return apiOk(
    { fromState: result.fromState, toState: result.toState, replay: result.replay },
    { status: result.replay ? 200 : 201 },
  );
}
