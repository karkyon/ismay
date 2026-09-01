import type { NextRequest } from "next/server";
import { z } from "zod";
import { requireAuth, requireCsrf } from "@/lib/auth/guard";
import { ensureDefaultWorkspace } from "@/lib/workspace";
import { apiOk, apiError } from "@/lib/auth/response";
import { retryFormationSession } from "@/lib/formation/sessionLifecycle";
import { orchestrateRetryAnalysis } from "@/lib/formation/retryOrchestration";

/**
 * V5-M1-B6B: POST /formation-sessions/{id}/retry
 * 出典: Claude向け ISMAY 69b5a87以降 監査是正・M1-B6完遂・PEM-0連続実装指示
 *       (2026-08-31) Gate M1-B6B Session Lifecycle。
 * FAILED --RETRY--> ANALYZING。
 *
 * [M1-B6C-4 §6.3是正・2026-09-01] 従来このrouteは状態遷移とEvent記録のみを行い、
 * 実際の再解析を起動しなかった(「別途手動または既存のCapture解析flowから行う
 * 想定」)。retryFormationSessionのlifecycle transactionが確定した"後"に、
 * `orchestrateRetryAnalysis`で既存のOutbox/Job基盤(relay.ts→aiExtractJob.ts→
 * extract.ts)へ抽出Jobを冪等投入し、実際にAI再抽出(Provider stubを含む既存
 * pipeline)が起動するところまで閉じる。「旧Event/Candidateを失わない」性質は
 * 変更なし(retryFormationSession自体もorchestrateRetryAnalysisも削除処理を
 * 一切含まない)。「新AiRunを同一Sessionの新analysis attemptとして記録する」は
 * shadowWrite.tsのattachToSessionId機構で実現する(新規Session重複作成を防ぐ)。
 *
 * [Job投入失敗時] Session状態遷移は既に確定済みであり、それを巻き戻さない
 * (courseypes transitionは既に確定した事実であり、Job投入の成否とは独立)。
 * 投入に失敗した場合はレスポンスの`analysisQueued:false`で示し、
 * `reconcileStuckRetryOrchestrations`(worker/index.tsから定期実行)が
 * 「Session=ANALYZINGだがCaptureはFAILEDのまま」を検出して自動的に再試行する。
 */

const RetryRequestSchema = z.object({
  clientEventId: z.string().min(1).max(200),
  expectedVersion: z.number().int().min(0),
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
    expectedVersion: parsed.data.expectedVersion,
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
      case "VERSION_CONFLICT":
        return apiError("VERSION_CONFLICT", "他の更新と競合しました。最新の状態を取得してください", {
          retryable: true,
          extra: { latestVersion: result.latestVersion },
        });
      case "COREYPES_TRANSITION_UNDEFINED":
        return apiError("VALIDATION_FAILED", "この状態からのretryは定義されていません。管理者へご連絡ください", { retryable: false });
    }
  }

  // [M1-B6C-4新設・§6.3] lifecycle transaction確定後にOutbox/Jobを冪等投入する。
  // ここが失敗してもSession状態遷移は既に確定済みのため、リクエスト自体は成功
  // として返す(analysisQueuedで実際の投入結果を示す)。
  const orchestration = await orchestrateRetryAnalysis({ sessionId, workspaceId });
  const analysisQueued = orchestration.ok ? orchestration.queued : false;

  return apiOk(
    { fromState: result.fromState, toState: result.toState, replay: result.replay, analysisQueued },
    { status: result.replay ? 200 : 201 },
  );
}
