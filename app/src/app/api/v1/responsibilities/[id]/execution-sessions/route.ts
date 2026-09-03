import type { NextRequest } from "next/server";
import { db } from "@/lib/db";
import { requireAuth } from "@/lib/auth/guard";
import { apiOk, apiError } from "@/lib/auth/response";
import { buildPemAuthorizationContext, assertSelfOnlyAccess } from "@/lib/pem/authorizationBoundary";
import { getProjectionStatus } from "@/lib/pem/recomputeQueue";

/**
 * V5 API: GET /responsibilities/{id}/execution-sessions
 * 出典: DOC-05(Execution Event・Session Projection仕様書) 9章
 * 「GET `/responsibilities/:id/execution-sessions` | v5追加。latest revision既定」、
 * 8章「read APIは`projectionStatus=FRESH/STALE/REBUILDING/FAILED`を返す。
 * 再計算中も原Eventを表示可能にする。」。
 *
 * [scope宣言] 「latest revision既定」に従い、各ExecutionSessionIdentityにつき
 * 最新revisionのみを返す(全revision履歴が必要な場合の専用queryは対象外、
 * 正本にその契約の記載が無いため想像で追加しない)。
 */
export async function GET(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const auth = await requireAuth(req);
  if (!auth.authenticated) {
    return apiError("AUTH_REQUIRED", "ログインが必要です");
  }

  const { id: responsibilityId } = await ctx.params;
  const pemCtx = await buildPemAuthorizationContext(auth.user.userId, auth.user.userId);
  assertSelfOnlyAccess(pemCtx);

  const responsibility = await db.responsibility.findFirst({
    where: { id: responsibilityId, workspaceId: pemCtx.tenantId, deletedAt: null },
    select: { id: true },
  });
  if (!responsibility) {
    return apiError("RESOURCE_NOT_FOUND", "指定された責任が見つかりません");
  }

  const identities = await db.executionSessionIdentity.findMany({
    where: { workspaceId: pemCtx.tenantId, responsibilityId },
    orderBy: { createdAt: "asc" },
    include: {
      revisions: { orderBy: { revision: "desc" }, take: 1 },
    },
  });

  type IdentityWithLatestRevision = (typeof identities)[number];

  const sessions = identities
    .filter((identity: IdentityWithLatestRevision) => identity.revisions.length > 0)
    .map((identity: IdentityWithLatestRevision) => {
      const latest = identity.revisions[0]!;
      return {
        sessionIdentityId: identity.id,
        startEventId: identity.startEventId,
        status: latest.status,
        startedAt: latest.startedAt,
        endedAt: latest.endedAt,
        endReason: latest.endReason,
        rawElapsedSeconds: latest.rawElapsedSeconds,
        correctedActiveSeconds: latest.correctedActiveSeconds,
        measurementMode: latest.measurementMode,
        measurementQuality: latest.measurementQuality,
        qualityReasonCodes: latest.qualityReasonCodes,
        revision: latest.revision,
        derivationVersion: latest.derivationVersion,
      };
    });

  // [DOC-05 8章「再計算中も原Eventを表示可能にする」] projectionStatusが
  // STALE/REBUILDINGでも、上のsessionsは(再計算前の)最後に永続化された
  // latest revisionをそのまま返す(この応答をブロックしない)。DOC-05 9章の
  // `GET /responsibilities/:id/execution-events`は本Gateのscope外
  // (このGateはRecompute Queueとprojection statusの可視化のみが対象、
  // 想像で追加実装しない)。原Eventは既存の`ResponsibilityExecutionEvent`
  // テーブルに保存済みだが、専用read APIは別Gateの対象とする。
  const projectionStatus = await getProjectionStatus(pemCtx.tenantId, responsibilityId, "EXECUTION_SESSION");

  return apiOk({ sessions, projectionStatus });
}
