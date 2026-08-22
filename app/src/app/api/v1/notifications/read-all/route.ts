import type { NextRequest } from "next/server";
import { db } from "@/lib/db";
import { debugServer } from "@/lib/debugServer";
import { requireAuth, requireCsrf } from "@/lib/auth/guard";
import { apiOk, apiError } from "@/lib/auth/response";

/** API-NTF-03: POST /notifications/read-all(2026-08-22新設)。未読(SENT)を一括既読化する。 */
export async function POST(req: NextRequest) {
  const auth = await requireAuth(req);
  if (!auth.authenticated) {
    return apiError("AUTH_REQUIRED", "ログインが必要です");
  }
  if (!requireCsrf(req)) {
    return apiError("ACCESS_DENIED", "CSRFトークンが不正です");
  }

  const result = await db.notification.updateMany({
    where: { userId: auth.user.userId, status: "SENT" },
    data: { status: "READ", readAt: new Date() },
  });
  debugServer.state("POST /notifications/read-all", "Notification.status一括更新", {
    userId: auth.user.userId,
    count: result.count,
  });

  return apiOk({ updated: result.count });
}
