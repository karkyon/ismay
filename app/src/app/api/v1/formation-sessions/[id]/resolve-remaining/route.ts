import type { NextRequest } from "next/server";
import { z } from "zod";
import { requireAuth, requireCsrf } from "@/lib/auth/guard";
import { ensureDefaultWorkspace } from "@/lib/workspace";
import { apiOk, apiError } from "@/lib/auth/response";
import { resolveRemainingCandidates } from "@/lib/formation/resolveRemaining";

/**
 * V5-M1-B6C-4 §6.4: POST /formation-sessions/{id}/resolve-remaining
 * 出典: Claude向け ISMAY c503e72以降 M1-B6C・全残件連続実装指示(2026-08-31) §6.4。
 *
 * PARTIALLY_CONFIRMED --RESOLVE_REMAINING--> {CONFIRMED|DISMISSED}。
 * 残っているpending候補全件をDEFERRED/DO_NOT_MATERIALIZEとして明示的に決定
 * した場合のみSessionを終端する(詳細はresolveRemaining.ts参照)。
 */

const ResolveRemainingItemSchema = z.object({
  candidateId: z.string().min(1),
  revision: z.number().int().min(1),
  resolution: z.enum(["DEFERRED", "DO_NOT_MATERIALIZE"]),
  reasonCode: z.string().max(500).optional(),
});

const ResolveRemainingRequestSchema = z.object({
  clientEventId: z.string().min(1).max(200),
  expectedVersion: z.number().int().min(0),
  items: z.array(ResolveRemainingItemSchema).min(1).max(50),
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
  const parsed = ResolveRemainingRequestSchema.safeParse(json);
  if (!parsed.success) {
    return apiError("VALIDATION_FAILED", "入力内容を確認してください", {
      fieldErrors: Object.fromEntries(
        Object.entries(parsed.error.flatten().fieldErrors).map(([k, v]) => [k, v?.[0] ?? "不正な値です"]),
      ),
    });
  }

  const { id: sessionId } = await ctx.params;
  const { workspaceId } = await ensureDefaultWorkspace(auth.user.userId, auth.user.email);

  const result = await resolveRemainingCandidates({
    sessionId,
    workspaceId,
    clientEventId: parsed.data.clientEventId,
    expectedVersion: parsed.data.expectedVersion,
    actorUserId: auth.user.userId,
    items: parsed.data.items.map((item) => ({
      candidateId: item.candidateId,
      expectedRevision: item.revision,
      resolution: item.resolution,
      reasonCode: item.reasonCode,
    })),
  });

  if (!result.ok) {
    switch (result.error) {
      case "NOT_FOUND":
        return apiError("RESOURCE_NOT_FOUND", "指定されたSessionが見つかりません");
      case "INVALID_SESSION_STATE":
        return apiError(
          "STATE_TRANSITION_INVALID",
          `このSessionは現在${result.sessionState}のためresolve-remainingできません(PARTIALLY_CONFIRMEDのみ対象)`,
        );
      case "VERSION_CONFLICT":
        return apiError("VERSION_CONFLICT", "他の更新と競合しました。最新の状態を取得してください", {
          retryable: true,
          extra: { latestVersion: result.latestVersion },
        });
      case "IDEMPOTENCY_KEY_REUSED":
        return apiError("IDEMPOTENCY_KEY_REUSED", "同一clientEventIdで異なる内容のリクエストが送信されました");
      case "EMPTY_ITEMS":
        return apiError("VALIDATION_FAILED", "解決する候補を1件以上指定してください");
      case "MISSING_PENDING_CANDIDATES":
        return apiError(
          "VALIDATION_FAILED",
          "未決定の候補が指定に含まれていません。残っている候補すべてに決定を指定してください",
          { retryable: false, extra: { missingCandidateIds: result.missingCandidateIds } },
        );
      case "UNKNOWN_CANDIDATE":
        return apiError("RESOURCE_NOT_FOUND", "指定された候補が見つかりません(既に決定済みの可能性があります)", {
          extra: { candidateId: result.candidateId },
        });
      case "REVISION_CONFLICT":
        return apiError("VERSION_CONFLICT", "候補が更新されています。最新のRevisionを取得してください", {
          retryable: true,
          extra: { candidateId: result.candidateId, latestRevision: result.latestRevision },
        });
      case "ALREADY_DECIDED":
        return apiError("STATE_TRANSITION_INVALID", "この候補は既に決定済みです", {
          extra: { candidateId: result.candidateId },
        });
      case "COREYPES_TRANSITION_UNDEFINED":
        return apiError("VALIDATION_FAILED", "この状態からのresolve-remainingは定義されていません。管理者へご連絡ください", { retryable: false });
    }
  }

  return apiOk(
    { toState: result.toState, resolvedCount: result.resolvedCount, replay: result.replay },
    { status: result.replay ? 200 : 201 },
  );
}
