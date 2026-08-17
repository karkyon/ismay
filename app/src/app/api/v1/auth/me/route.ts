import type { NextRequest } from "next/server";
import { db } from "@/lib/db";
import { requireAuth } from "@/lib/auth/guard";
import { apiOk, apiError } from "@/lib/auth/response";

export async function GET(req: NextRequest) {
  const auth = await requireAuth(req);
  if (!auth.authenticated) {
    return apiError("AUTH_REQUIRED", "ログインが必要です");
  }
  const user = await db.user.findUnique({ where: { id: auth.user.userId } });
  if (!user || user.deletedAt) {
    return apiError("AUTH_REQUIRED", "ログインが必要です");
  }
  const totp = await db.userTotpSecret.findUnique({ where: { userId: user.id } });
  return apiOk({
    user: { id: user.id, email: user.email, displayName: user.displayName },
    mfaEnabled: !!totp && !totp.disabledAt,
  });
}
