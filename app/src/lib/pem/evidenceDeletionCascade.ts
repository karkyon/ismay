/**
 * PEM Evidence Deletion Cascade(Phase 0C-2b)。
 * 出典: ISMAY_PEMサブシステム_統合正本仕様書_v4_0 16.4節「削除影響伝播」。
 *
 * 16.4節はSession、Segment、Reason、Metric、Observation、Hypothesis、
 * Temporary State、Prediction、Planning監査の有効性、Experiment結果、
 * Weekly Review、North Starの順次失効・再計算を要求する。実コード調査の結果、
 * このうちSession/Segment/Reason/Temporary State/Prediction/Planning監査/
 * Experiment/North Starはコード上に実体が無い(未着手、またはEvidence削除と
 * 無関係)ため、想像で伝播対象に加えない。実際に伝播できるのはMetric
 * (sourceMetric一致によるHypothesis失効)とWeekly Reviewのみ。
 *
 * [現状の制約] PemObservationの削除書き込みはreset/route.ts(全PEMデータ一括
 * リセット)の1箇所のみで、そこでは元々Hypothesis・Weekly Reviewも「全件」
 * 削除しているため、本関数の呼び出しは実質的に冗長(重複防止の安全策)である。
 * 「部分的な証拠削除→関連する仮説・週次レビューだけを選択的に無効化する」という
 * 個別削除APIは現状存在しないため、その場合の動作確認はまだできていない。
 * 将来そのAPIができた際にそのまま使えるよう、汎用関数として用意しておく。
 */
import type { Prisma } from "@/generated/prisma/client";

export interface PropagateEvidenceDeletionResult {
  hypothesesInvalidated: number;
  weeklyReviewsInvalidated: number;
}

/**
 * 削除された(EXCLUDED_FROM_USE等になった)PemObservation(OBSERVATION型)のidを
 * 受け取り、それらのmetricに由来するまだ有効なPemHypothesisを失効させ
 * (validUntilを現在時刻にする。物理削除はしない=v4.0のinsert-only精神を踏襲)、
 * 週次レビューキャッシュを無効化する(削除のみ行い、ここでは再生成しない。
 * AI-08の「無ければ生成、あれば再利用」設計により次回アクセス時に再生成される)。
 */
export async function propagateEvidenceDeletion(
  tx: Prisma.TransactionClient,
  userId: string,
  deletedObservationIds: readonly string[],
): Promise<PropagateEvidenceDeletionResult> {
  if (deletedObservationIds.length === 0) {
    return { hypothesesInvalidated: 0, weeklyReviewsInvalidated: 0 };
  }

  const deletedObservations = await tx.pemObservation.findMany({
    where: { id: { in: [...deletedObservationIds] }, observationType: "OBSERVATION" },
    select: { payload: true },
  });

  const affectedMetricKeys = new Set<string>();
  for (const obs of deletedObservations) {
    const metric = (obs.payload as { metric?: unknown } | null)?.metric;
    if (typeof metric === "string") affectedMetricKeys.add(metric);
  }

  let hypothesesInvalidated = 0;
  const now = new Date();
  for (const metricKey of affectedMetricKeys) {
    const result = await tx.pemHypothesis.updateMany({
      where: { userId, sourceMetric: metricKey, validUntil: null, deletedAt: null },
      data: { validUntil: now },
    });
    hypothesesInvalidated += result.count;
  }

  const reviewResult = await tx.pemWeeklyReview.deleteMany({ where: { userId } });

  return { hypothesesInvalidated, weeklyReviewsInvalidated: reviewResult.count };
}
