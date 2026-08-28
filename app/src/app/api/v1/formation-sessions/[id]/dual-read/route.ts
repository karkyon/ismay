import type { NextRequest } from "next/server";
import { requireAuth } from "@/lib/auth/guard";
import { ensureDefaultWorkspace } from "@/lib/workspace";
import { apiOk, apiError } from "@/lib/auth/response";
import { buildFormationDualReadProjection } from "@/lib/formation/dualRead";

/**
 * V5-M1-B2: GET /formation-sessions/{id}/dual-read
 * 出典: ISMAY-V5-DOC-03(Formation Session仕様書) 10章「B2は既存Inference decisionと
 *       dual-read」。
 *
 * [スコープの明示的な境界] このエンドポイントはDOC-03 7章のAPI契約表にある
 * `GET /formation-sessions/:id`(Eventからの現Projection取得、ETag=version)の
 * 正式実装ではない。それは将来のGate(B3以降、UIがSession Review UIへ置換される
 * CHG-014のタイミング)で、Event-sourced Projectorを伴う正式なProjection APIとして
 * 別途実装する。このエンドポイントは、B2の狭いスコープ「既存Inference decisionとの
 * dual-read」を診断・検証するための読み取り専用API(開発者向け)であり、
 * `/dual-read`という別pathで明示的に区別する。
 *
 * このエンドポイントはいかなるテーブルへも書込みを行わない(読み取り専用)。
 * 既存の`/inferences/[id]/decision`(採否)route.tsの挙動には一切影響しない。
 */
export async function GET(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const auth = await requireAuth(req);
  if (!auth.authenticated) {
    return apiError("AUTH_REQUIRED", "ログインが必要です");
  }
  const { id } = await ctx.params;
  const { workspaceId } = await ensureDefaultWorkspace(auth.user.userId, auth.user.email);

  const projection = await buildFormationDualReadProjection(id, workspaceId);
  if (!projection) {
    // 他Workspaceのsession IDを推測されても存在有無を漏らさない(既存route群と同じIDOR対策)。
    return apiError("RESOURCE_NOT_FOUND", "指定されたFormation Sessionが見つかりません");
  }

  return apiOk({ dualRead: projection });
}
