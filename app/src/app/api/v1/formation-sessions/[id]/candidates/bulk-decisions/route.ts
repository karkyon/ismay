import type { NextRequest } from "next/server";
import { z } from "zod";
import { requireAuth, requireCsrf } from "@/lib/auth/guard";
import { ensureDefaultWorkspace } from "@/lib/workspace";
import { apiOk, apiError } from "@/lib/auth/response";
import { CANDIDATE_DECISION_EVENT_VALUES } from "@/lib/formation/coreTypes";
import { recordCandidateDecisionsBulk } from "@/lib/formation/materialize";

/**
 * [B4.3新設] POST /formation-sessions/{id}/candidates/bulk-decisions
 * 出典: HANDOFF_2026-08-29_B4.1_B4.2.md §4-2「Bulk ACCEPT/REJECT(監査資料B4.2
 * 受入項目9)。現在は候補ごとの個別操作のみ」。
 *
 * 既存の単一candidate用`POST /:id/candidates/:candidateId/decisions`とは別の
 * routeとして新設した(既存APIの契約・Test・呼び出し元は一切変更しない)。
 *
 * [設計方針] 内部では`recordCandidateDecisionsBulk`(materialize.ts)が、
 * 既存の`recordCandidateDecision`(候補1件ごとにSession行FOR UPDATE・旧新横断
 * guard・revision楽観ロックを行う、B31-01〜04b/B4.1 3.3節で確立済みの不変条件)を
 * 配列分だけ順番に呼ぶ。**複数candidateをまたぐall-or-nothing transactionには
 * しない**(materialize.ts側コメント参照)。レスポンスは`responsibilities/bulk`
 * (executeBulkAction)と同様、成功/失敗を候補単位でitemsに含めて返す
 * 部分成功パターンであり、HTTP status自体は200固定とする(既存bulk APIの
 * 契約パターンをそのまま踏襲する。個々の失敗理由はitems[].errorで判別できる)。
 */

const BulkDecisionItemSchema = z.object({
  candidateId: z.string().min(1),
  revision: z.number().int().min(1),
  decision: z.enum(CANDIDATE_DECISION_EVENT_VALUES),
  reasonCode: z.string().max(100).optional(),
});

const BulkDecisionRequestSchema = z.object({
  items: z.array(BulkDecisionItemSchema).min(1).max(50),
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
  const parsed = BulkDecisionRequestSchema.safeParse(json);
  if (!parsed.success) {
    return apiError("VALIDATION_FAILED", "入力内容を確認してください", {
      fieldErrors: Object.fromEntries(
        Object.entries(parsed.error.flatten().fieldErrors).map(([k, v]) => [k, v?.[0] ?? "不正な値です"]),
      ),
    });
  }

  const { id: sessionId } = await ctx.params;
  const { workspaceId } = await ensureDefaultWorkspace(auth.user.userId, auth.user.email);

  const outcomes = await recordCandidateDecisionsBulk({
    sessionId,
    workspaceId,
    actorUserId: auth.user.userId,
    items: parsed.data.items.map((item) => ({
      candidateId: item.candidateId,
      expectedRevision: item.revision,
      decision: item.decision,
      reasonCode: item.reasonCode,
    })),
  });

  const results = outcomes.map((o) => {
    if (o.result.ok) {
      return {
        candidateId: o.candidateId,
        ok: true as const,
        decisionEventId: o.result.decisionEventId,
        sessionState: o.result.sessionState,
      };
    }
    return {
      candidateId: o.candidateId,
      ok: false as const,
      error: o.result.error,
    };
  });

  const succeeded = results.filter((r) => r.ok).length;
  const failed = results.length - succeeded;

  return apiOk({ results, succeeded, failed }, { status: 200 });
}
