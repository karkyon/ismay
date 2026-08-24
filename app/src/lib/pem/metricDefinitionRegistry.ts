/**
 * PEM Metric Definition Registry(Phase 0D-1)。
 * 出典: ISMAY_PEMサブシステム_統合正本仕様書_v4_0 21章「実装ゲート」Phase 0D、
 *       consent.ts の isMetricEnabled が参照する「metricの実体」。
 *
 * 現時点のスコープ: 既存 lib/pem.ts recomputeAggregates() にハードコードされていた
 * 唯一の指標(DEFER_RATE_BY_ESTIMATE)を、Event Definition Registryと同じ形式で
 * 正式なカタログエントリとして宣言する。計算アルゴリズム自体(bucket比較)は
 * まだ汎用化していない(v4.0のMetric Catalogアーキテクチャ章を未参照のまま
 * 計算の抽象化まで進めると、仕様を想像で埋めることになるため、閾値・識別子の
 * カタログ化までに留める)。
 *
 * metric単位OFF(v3.3.1整合性修正17.2節、consent.ts参照)の実装には、ユーザーごとに
 * どのmetricを無効化しているかの永続化先(新規テーブルまたは列)が必要だが、
 * その保存形式はv4.0の該当章を確認してから決める(本Phaseでは未実装のまま)。
 */

export interface MetricDefinition {
  metricKey: string;
  labelJa: string;
  labelEn: string;
  description: string;
  /** この指標が対象とするResponsibility型。 */
  appliesToResponsibilityType: string;
  /** この指標が参照するPemObservation.observationType。 */
  sourceObservationType: "TRANSITION";
  /** 集計対象の遡り期間(日数)。 */
  windowDays: number;
  /** これ未満では観察を生成しない(AI・PEM設計書v1.0 9章「初期表示の推奨母数5」)。 */
  minSampleSize: number;
  /** 対照群との差がこのポイント(pp)未満なら「強い要因ではない」として観察化しない。 */
  minGapPercentagePoints: number;
  introducedVersion: string;
}

export const METRIC_DEFINITIONS = {
  DEFER_RATE_BY_ESTIMATE: {
    metricKey: "DEFER_RATE_BY_ESTIMATE",
    labelJa: "所要時間見積による延期率の差",
    labelEn: "Defer rate by time estimate",
    description:
      "所要時間見積が30分以上、または未設定のTASKと、それ未満のTASKとで、延期される割合に" +
      "有意な差があるかを比較する(AI・PEM設計書v1.0 9章の代表例)。",
    appliesToResponsibilityType: "TASK",
    sourceObservationType: "TRANSITION",
    windowDays: 28,
    minSampleSize: 5,
    minGapPercentagePoints: 20,
    introducedVersion: "v1.0",
  },
} as const satisfies Record<string, MetricDefinition>;

export type MetricKey = keyof typeof METRIC_DEFINITIONS;

export function getMetricDefinition(metricKey: string): MetricDefinition | undefined {
  return (METRIC_DEFINITIONS as Record<string, MetricDefinition>)[metricKey];
}

export function isKnownMetricKey(metricKey: string): metricKey is MetricKey {
  return Object.prototype.hasOwnProperty.call(METRIC_DEFINITIONS, metricKey);
}

/**
 * metric単位OFFの永続化先が未実装のため、現時点では「登録済みmetricかどうか」だけを
 * 判定する(未知のmetricKeyは安全側でfalseを返す)。ユーザーごとの個別無効化は、
 * 永続化設計確定後に別パッチで追加する(consent.tsのevaluateFeatureGateから呼ばれる)。
 */
export function isMetricEnabledByDefault(metricKey: string): boolean {
  return isKnownMetricKey(metricKey);
}
