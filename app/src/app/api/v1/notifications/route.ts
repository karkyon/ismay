import type { NextRequest } from "next/server";
import { db } from "@/lib/db";
import { requireAuth } from "@/lib/auth/guard";
import { apiOk, apiError } from "@/lib/auth/response";

const LIST_LIMIT = 30;

/**
 * API-NTF-01: GET /notifications(2026-08-22新設)。
 * FN-NTF-01 通知センターUI向け一覧。SCHEDULED(quietHours中で未送達)は表示対象外とし、
 * SENT/READのみを返す(「送達済み」のものだけが本人の目に触れるべきという設計)。
 * unreadCountはSENT(未読)件数。
 */
export async function GET(req: NextRequest) {
  const auth = await requireAuth(req);
  if (!auth.authenticated) {
    return apiError("AUTH_REQUIRED", "ログインが必要です");
  }

  const [notifications, unreadCount] = await Promise.all([
    db.notification.findMany({
      where: { userId: auth.user.userId, status: { in: ["SENT", "READ"] } },
      orderBy: { scheduledAt: "desc" },
      take: LIST_LIMIT,
    }),
    db.notification.count({
      where: { userId: auth.user.userId, status: "SENT" },
    }),
  ]);

  type NotificationRow = {
    id: string;
    type: string;
    payload: unknown;
    status: string;
    scheduledAt: Date;
    sentAt: Date | null;
    readAt: Date | null;
  };
  return apiOk({
    notifications: (notifications as NotificationRow[]).map((n: NotificationRow) => ({
      id: n.id,
      type: n.type,
      payload: n.payload,
      status: n.status,
      scheduledAt: n.scheduledAt,
      sentAt: n.sentAt,
      readAt: n.readAt,
    })),
    unreadCount,
  });
}
