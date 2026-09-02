import type { NextRequest } from "next/server";
import { db } from "@/lib/db";
import { debugServer } from "@/lib/debugServer";
import { requireAuth } from "@/lib/auth/guard";
import { apiOk, apiError } from "@/lib/auth/response";
import { buildPemDataExport } from "@/lib/pem/dataExport";

/**
 * V5新設 API: GET /pem/export 個人PEMデータの machine-readable export。
 * 出典: DOC-09(Consent・Data Governance仕様書) 9章「exportに原データ、
 * Event、同意、派生根拠、削除履歴が含まれる」、FR-AUTH-05
 * 「アカウントをエクスポート・削除できる」。scope宣言はdataExport.ts参照。
 */
export async function GET(req: NextRequest) {
  const auth = await requireAuth(req);
  if (!auth.authenticated) {
    return apiError("AUTH_REQUIRED", "ログインが必要です");
  }

  const userId = auth.user.userId;
  const exportData = await buildPemDataExport(userId);

  await db.auditLog.create({
    data: {
      actorUserId: userId,
      actorType: "USER",
      action: "PEM_DATA_EXPORTED",
      targetType: "User",
      targetId: userId,
      result: "SUCCESS",
    },
  });
  debugServer.state("GET /pem/export", "PEMデータexport完了", {
    userId,
    observations: exportData.observations.length,
    consentEvents: exportData.consentEvents.length,
    metricConsentEvents: exportData.metricConsentEvents.length,
    hypotheses: exportData.hypotheses.length,
    evidenceDeletionEvents: exportData.evidenceDeletionEvents.length,
    weeklyReviews: exportData.weeklyReviews.length,
  });

  return apiOk(exportData);
}
