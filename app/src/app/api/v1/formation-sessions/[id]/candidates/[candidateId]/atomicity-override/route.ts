import type { NextRequest } from "next/server";
import { z } from "zod";
import { requireAuth, requireCsrf } from "@/lib/auth/guard";
import { ensureDefaultWorkspace } from "@/lib/workspace";
import { apiOk, apiError } from "@/lib/auth/response";
import { recordAtomicityOverride } from "@/lib/formation/atomicityOverride";

/**
 * V5-M1-C2A: POST /formation-sessions/{id}/candidates/{candidateId}/atomicity-override
 * 出典: 2026-08-30確定指示書 Gate M1-C2A。
 */

const OverrideRequestSchema = z.object({
  revision: z.number().int().min(1),
  reasonCode: z.string().min(1).max(100),
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
  const parsed = OverrideRequestSchema.safeParse(json);
  if (!parsed.success) {
    return apiError("VALIDATION_FAILED", "入力内容を確認してください", {
      fieldErrors: Object.fromEntries(
        Object.entries(parsed.error.flatten().fieldErrors).map(([k, v]) => [k, v?.[0] ?? "不正な値です"]),
      ),
    });
  }

  const { id: sessionId, candidateId } = await ctx.params;
  const { workspaceId } = await ensureDefaultWorkspace(auth.user.userId, auth.user.email);

  const result = await recordAtomicityOverride({
    sessionId,
    workspaceId,
    candidateId,
    expectedRevision: parsed.data.revision,
    reasonCode: parsed.data.reasonCode,
    actorUserId: auth.user.userId,
  });

  if (!result.ok) {
    switch (result.error) {
      case "NOT_FOUND":
        return apiError("RESOURCE_NOT_FOUND", "指定された候補が見つかりません");
      case "REVISION_CONFLICT":
        return apiError("VERSION_CONFLICT", "候補が更新されています。最新のRevisionを取得してください", {
          retryable: true,
          extra: { latestRevision: result.latestRevision },
        });
      case "OVERRIDE_NOT_APPLICABLE":
        return apiError(
          "VALIDATION_FAILED",
          `この候補は現在${result.assessment}のためoverrideは不要です`,
        );
    }
  }

  return apiOk({ overrideId: result.overrideId, assessment: result.assessment }, { status: 201 });
}
