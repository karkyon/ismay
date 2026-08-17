import type { NextRequest } from "next/server";
import { requireAuth } from "@/lib/auth/guard";
import { listActiveSessions } from "@/lib/auth/session";
import { apiOk, apiError } from "@/lib/auth/response";

export async function GET(req: NextRequest) {
  const auth = await requireAuth(req);
  if (!auth.authenticated) {
    return apiError("AUTH_REQUIRED", "ログインが必要です");
  }
  const sessions = await listActiveSessions(auth.user.userId);
  type SessionRow = (typeof sessions)[number];
  return apiOk({
    sessions: sessions.map((s: SessionRow) => ({ ...s, isCurrent: s.id === auth.user.sessionId })),
  });
}
