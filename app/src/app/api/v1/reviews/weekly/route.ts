import type { NextRequest } from "next/server";
import { db } from "@/lib/db";
import { requireAuth } from "@/lib/auth/guard";
import { ensureDefaultWorkspace } from "@/lib/workspace";
import { apiOk, apiError } from "@/lib/auth/response";
import { getOrGenerateWeeklyReview } from "@/lib/pem";

/**
 * API-PEM-03: GET /reviews/weekly 週次レビュー(FN-PEM-03/UI-10)。
 * 出典: API・イベント設計書v1.1 4.5節、AI・PEM設計書v1.0 AI-08。
 *
 * 直近の完了済み週(月曜〜日曜)のレビューが未生成ならその場でAI-08を呼び出して生成し、
 * 既にあればキャッシュ(PemWeeklyReview)を返す(2026-08-23セッションでカルキョンさんへ
 * 説明・合意済みの同期生成方式。Worker側での事前生成はしない)。
 */
export async function GET(req: NextRequest) {
  const auth = await requireAuth(req);
  if (!auth.authenticated) {
    return apiError("AUTH_REQUIRED", "ログインが必要です");
  }

  const { workspaceId } = await ensureDefaultWorkspace(auth.user.userId, auth.user.email);
  const userRow = await db.user.findUnique({ where: { id: auth.user.userId }, select: { timeZone: true } });
  const timeZone = userRow?.timeZone ?? "Asia/Tokyo";

  const result = await getOrGenerateWeeklyReview(auth.user.userId, workspaceId, timeZone);

  return apiOk({
    weekStart: result.weekStart.toISOString(),
    weekEnd: result.weekEnd.toISOString(),
    fulfilledCount: result.fulfilledCount,
    stalledCount: result.stalledCount,
    estimateErrorPercent: result.estimateErrorPercent,
    strengthStatement: result.strengthStatement,
    experimentSuggestion: result.experimentSuggestion,
    generatedAt: result.generatedAt.toISOString(),
    available: result.available,
  });
}
