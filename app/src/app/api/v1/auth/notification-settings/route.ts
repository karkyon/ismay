import type { NextRequest } from "next/server";
import { z } from "zod";
import { db } from "@/lib/db";
import { debugServer, redactSensitive } from "@/lib/debugServer";
import { requireAuth, requireCsrf } from "@/lib/auth/guard";
import { apiOk, apiError } from "@/lib/auth/response";

const HHMM_PATTERN = /^([01]\d|2[0-3]):([0-5]\d)$/;
const HHMM = z.string().regex(HHMM_PATTERN, "HH:MM形式で指定してください");

/**
 * API-NTF-04: PATCH /auth/notification-settings(2026-08-22新設)。
 * FN-NTF-01のquietHours(静穏時間帯)・bundleWindow(まとめ通知の時間窓)を
 * 本人設定として更新する。両方nullを渡すことで静穏時間を解除できる
 * (開始・終了は必ず対で指定/解除する。片方だけの指定は許可しない)。
 */
const UpdateSchema = z.object({
  notifyQuietHoursStart: HHMM.nullable().optional(),
  notifyQuietHoursEnd: HHMM.nullable().optional(),
  notifyBundleWindowMinutes: z.number().int().min(0).max(240).optional(),
});

export async function PATCH(req: NextRequest) {
  const auth = await requireAuth(req);
  if (!auth.authenticated) {
    return apiError("AUTH_REQUIRED", "ログインが必要です");
  }
  if (!requireCsrf(req)) {
    return apiError("ACCESS_DENIED", "CSRFトークンが不正です");
  }

  const json = await req.json().catch(() => null);
  debugServer.input("PATCH /auth/notification-settings", "requestBody", redactSensitive(json));
  const parsed = UpdateSchema.safeParse(json);
  if (!parsed.success) {
    return apiError("VALIDATION_FAILED", "入力内容を確認してください", {
      fieldErrors: Object.fromEntries(
        Object.entries(parsed.error.flatten().fieldErrors).map(([k, v]) => [k, v?.[0] ?? "不正な値です"]),
      ),
    });
  }
  const { notifyQuietHoursStart, notifyQuietHoursEnd, notifyBundleWindowMinutes } = parsed.data;

  const hasStart = notifyQuietHoursStart !== undefined;
  const hasEnd = notifyQuietHoursEnd !== undefined;
  if (hasStart !== hasEnd) {
    return apiError("VALIDATION_FAILED", "静穏時間の開始・終了は両方指定するか、両方省略してください", {
      fieldErrors: { notifyQuietHoursEnd: "開始・終了は対で指定してください" },
    });
  }

  const updated = await db.user.update({
    where: { id: auth.user.userId },
    data: {
      ...(hasStart ? { notifyQuietHoursStart, notifyQuietHoursEnd } : {}),
      ...(notifyBundleWindowMinutes !== undefined ? { notifyBundleWindowMinutes } : {}),
    },
    select: { notifyQuietHoursStart: true, notifyQuietHoursEnd: true, notifyBundleWindowMinutes: true },
  });
  debugServer.state("PATCH /auth/notification-settings", "User通知設定", {
    userId: auth.user.userId,
    ...updated,
  });

  return apiOk(updated);
}
