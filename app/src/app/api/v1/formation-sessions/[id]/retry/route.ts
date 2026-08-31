import type { NextRequest } from "next/server";
import { z } from "zod";
import { requireAuth, requireCsrf } from "@/lib/auth/guard";
import { ensureDefaultWorkspace } from "@/lib/workspace";
import { apiOk, apiError } from "@/lib/auth/response";
import { retryFormationSession } from "@/lib/formation/sessionLifecycle";

/**
 * V5-M1-B6B: POST /formation-sessions/{id}/retry
 * 出典: Claude向け ISMAY 69b5a87以降 監査是正・M1-B6完遂・PEM-0連続実装指示
 *       (2026-08-31) Gate M1-B6B Session Lifecycle。
 * FAILED --RETRY--> ANALYZING。
 *
 * [scope・重要] このrouteは状態遷移とEvent記録のみを行う。「同じSessionで
 * 新AiRunを作り、旧Event/Candidateを失わない」の後半(旧Event/Candidate保持)は
 * このrouteの実装(遷移のみ・削除処理を一切含まない)により自動的に満たされる。
 * 前半(新AiRunの実際の起動=既存extract.tsパイプラインの呼出し)は、AI課金を
 * 伴う実Provider呼出しのため、このPatchでは意図的に実装しない
 * (INTEGRATION-EVIDENCE-PENDING。ユーザー明示承認なしにAI Providerを呼ばない、
 * という既存方針に従う)。状態がANALYZINGへ遷移した後、実際の再抽出起動は
 * 別途手動または既存のCapture解析flowから行う想定。
 */

const RetryRequestSchema = z.object({
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
  const parsed = RetryRequestSchema.safeParse(json);
  if (!parsed.success) {
    return apiError("VALIDATION_FAILED", "入力内容を確認してください", {
      fieldErrors: Object.fromEntries(
        Object.entries(parsed.error.flatten().fieldErrors).map(([k, v]) => [k, v?.[0] ?? "不正な値です"]),
      ),
    });
  }

  const { id: sessionId } = await ctx.params;
  const { workspaceId } = await ensureDefaultWorkspace(auth.user.userId, auth.user.email);

  const result = await retryFormationSession({
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
          `このSessionは現在${result.sessionState}のためretryできません(FAILEDのみ対象)`,
        );
      case "IDEMPOTENCY_KEY_REUSED":
        return apiError("IDEMPOTENCY_KEY_REUSED", "同一clientEventIdで異なる内容のリクエストが送信されました");
      case "COREYPES_TRANSITION_UNDEFINED":
        return apiError("VALIDATION_FAILED", "この状態からのretryは定義されていません。管理者へご連絡ください", { retryable: false });
    }
  }

  return apiOk(
    { fromState: result.fromState, toState: result.toState, replay: result.replay },
    { status: result.replay ? 200 : 201 },
  );
}
