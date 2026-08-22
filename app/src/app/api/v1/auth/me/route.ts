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
    // FN-NTF-01(2026-08-22追加): 通知設定はDashboardClient側の設定UIが初期値として使う。
    notificationSettings: {
      notifyQuietHoursStart: user.notifyQuietHoursStart,
      notifyQuietHoursEnd: user.notifyQuietHoursEnd,
      notifyBundleWindowMinutes: user.notifyBundleWindowMinutes,
      notifyDeadlineEnabled: user.notifyDeadlineEnabled,
      notifyFollowUpEnabled: user.notifyFollowUpEnabled,
      notifyRiskEnabled: user.notifyRiskEnabled,
    },
  });
}
