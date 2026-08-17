import type { NextRequest } from "next/server";
import { requireAuth, requireCsrf } from "@/lib/auth/guard";
import { revokeSession } from "@/lib/auth/session";
import { clearAuthCookies } from "@/lib/auth/cookies";
import { apiOk, apiError } from "@/lib/auth/response";

export async function POST(req: NextRequest) {
  const auth = await requireAuth(req);
  if (!auth.authenticated) {
    // 既に未認証ならログアウト済みとみなし成功として扱う(冪等性)
    return apiOk({ loggedOut: true });
  }
  if (!requireCsrf(req)) {
    return apiError("ACCESS_DENIED", "CSRFトークンが不正です");
  }

  await revokeSession(auth.user.sessionId, "LOGOUT");

  const res = apiOk({ loggedOut: true });
  clearAuthCookies(res);
  return res;
}
