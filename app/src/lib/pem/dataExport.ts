/**
 * PEM Machine-readable Data Export(v5新設)。
 * 出典: DOC-09(Consent・Data Governance仕様書) 9章「exportに原データ、
 * Event、同意、派生根拠、削除履歴が含まれる」、CHG-076「Export/Delete API:
 * machine-readable export、削除進捗、失敗再試行追加」。FR-AUTH-05
 * 「アカウントをエクスポート・削除できる」のうち、削除はauth/account/
 * delete/route.tsで既存実装済みだが、エクスポートは未実装だった。
 *
 * [scope宣言] DOC-09はPEMサブシステム固有のConsent・Data Governance仕様書
 * であるため、本エクスポートはPEM関連データに限定する(FormationのCapture/
 * Responsibility本体等、PEM以外のドメインデータのエクスポートは別の関心事
 * であり、想像でスコープを広げない)。
 *
 * 受入条件の各項目とのマッピング:
 *   - 原データ・Event → PemObservation(FACT/OBSERVATION/TRANSITION全て。
 *     TRANSITION型はResponsibilityExecutionEventの投影であり、生の
 *     Execution Ledger自体を別途含めるとPEM以外のドメインデータまで
 *     エクスポート範囲が広がるため、PEMが取り込んだ形のみを対象とする)
 *   - 同意 → PemConsentEvent、PemMetricConsentEvent
 *   - 派生根拠 → PemHypothesis
 *   - 削除履歴 → PemEvidenceDeletionEvent
 * 加えてPemWeeklyReview(派生キャッシュ)も参考情報として含める。
 *
 * [削除進捗・失敗再試行(CHG-076後半)] エクスポートは同期的な一括取得のみを
 * 実装する。大規模データに対する非同期ジョブ化・進捗追跡は、現状のPEMデータ
 * 量(個人の観察・仮説データ)が同期取得で十分実用的なサイズであるため、
 * このGateのscope外とする。
 */
import { db } from "@/lib/db";

export interface PemDataExport {
  exportedAt: string;
  userId: string;
  observations: unknown[];
  consentEvents: unknown[];
  metricConsentEvents: unknown[];
  hypotheses: unknown[];
  evidenceDeletionEvents: unknown[];
  weeklyReviews: unknown[];
}

export async function buildPemDataExport(userId: string): Promise<PemDataExport> {
  const [observations, consentEvents, metricConsentEvents, hypotheses, evidenceDeletionEvents, weeklyReviews] =
    await Promise.all([
      db.pemObservation.findMany({ where: { userId }, orderBy: { occurredAt: "asc" } }),
      db.pemConsentEvent.findMany({ where: { userId }, orderBy: { occurredAt: "asc" } }),
      db.pemMetricConsentEvent.findMany({ where: { userId }, orderBy: { occurredAt: "asc" } }),
      db.pemHypothesis.findMany({ where: { userId }, orderBy: { createdAt: "asc" } }),
      db.pemEvidenceDeletionEvent.findMany({ where: { userId }, orderBy: { occurredAt: "asc" } }),
      db.pemWeeklyReview.findMany({ where: { userId }, orderBy: { weekStart: "asc" } }),
    ]);

  return {
    exportedAt: new Date().toISOString(),
    userId,
    observations,
    consentEvents,
    metricConsentEvents,
    hypotheses,
    evidenceDeletionEvents,
    weeklyReviews,
  };
}
