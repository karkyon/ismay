/**
 * PEM Metric Definition Registry(Phase 0D-2)。
 * 出典: ISMAY_PEMサブシステム_統合正本仕様書_v4_0 10章、
 *       consent.ts の isMetricEnabled が参照する「metricの実体」。
 *
 * [2026-08-24改訂・Phase 0D-2] 10章必須項目(metricKey/version/valueType/unit/
 * directionality/numerator/denominator/opportunity/calculatorKey/
 * implementationVersion/parameterSchemaVersion/eligibility/exclusion/
 * qualityPolicy/window/attribution/独立単位/最低表示母数/最低Planning母数/
 * uncertainty/decay/effectiveFrom-To/lifecycle status)を追加し、唯一の実装済み
 * 指標を10.3節の正式名称(DEFER_RATE_BY_ESTIMATE_BUCKET)へ改名した(旧名
 * DEFER_RATE_BY_ESTIMATE。既存データはマイグレーションでbackfill)。
 *
 * 10.3節が列挙する残り9指標(DEFERRED_RESPONSIBILITY_RATE等)は未登録のまま。
 * 「各metricの完全な分子・分母・除外・品質・表示文はMetric Catalogを実装前
 * ゲートとする」と原本が明記する通り、業務判断を要する未確定事項であり、
 * 想像で定義しない。
 */

export type MetricValueType = "RATE";
export type MetricDirectionality = "HIGHER_IS_WORSE" | "HIGHER_IS_BETTER" | "NEUTRAL";
export type MetricLifecycleStatus = "DRAFT" | "ACTIVE" | "DEPRECATED" | "RETIRED";
/** v4.0 10.2節。単純イベント数だけで母数を満たしたと判定しないための独立集計単位。 */
export type MetricIndependentUnit =
  | "DISTINCT_RESPONSIBILITY"
  | "OBSERVATION_DAY"
  | "DISTINCT_COUNTERPARTY"
  | "REPEAT_INSTANCE"
  | "PLANNING_OPPORTUNITY";

export interface MetricDefinition {
  metricKey: string;
  version: string;
  labelJa: string;
  labelEn: string;
  description: string;
  /** この指標が対象とするResponsibility型。 */
  appliesToResponsibilityType: string;
  /** この指標が参照するPemObservation.observationType。 */
  sourceObservationType: "TRANSITION";
  valueType: MetricValueType;
  unit: string;
  directionality: MetricDirectionality;
  /** 分子の定義(自然言語。計算式そのものはcalculatorKeyが指すコードが正)。 */
  numerator: string;
  /** 分母の定義。 */
  denominator: string;
  /** 「機会」の定義(この指標が発生し得た母集団)。 */
  opportunity: string;
  /** 実際に計算するコードの所在。 */
  calculatorKey: string;
  implementationVersion: string;
  /** parameterJsonのstrict schema版。parameterJson自体を使っていない場合は"NONE"。 */
  parameterSchemaVersion: string;
  eligibility: string;
  exclusion: string;
  qualityPolicy: string;
  /** 集計対象の遡り期間(日数)。 */
  windowDays: number;
  attribution: string;
  independentUnit: MetricIndependentUnit;
  /** これ未満では観察を生成しない(表示可否)。 */
  minSampleForDisplay: number;
  /** Planning適用に必要な最低母数。Planning統合が未実装のためnull許容。 */
  minSampleForPlanning: number | null;
  /** 不確実性の定量化方式。未実装のためnull許容。 */
  uncertainty: string | null;
  /** 時間経過による重み減衰方式。未実装のためnull許容。 */
  decay: string | null;
  effectiveFrom: string;
  effectiveTo: string | null;
  lifecycleStatus: MetricLifecycleStatus;
  introducedVersion: string;
  /** 対照群との差がこのポイント(pp)未満なら「強い要因ではない」として観察化しない。
   * v4.0 10章必須項目には無いが、既存の実装判断(lib/pem.ts)を保つための追加列。 */
  minGapPercentagePoints: number;
}

export const METRIC_DEFINITIONS = {
  DEFER_RATE_BY_ESTIMATE_BUCKET: {
    metricKey: "DEFER_RATE_BY_ESTIMATE_BUCKET",
    version: "v1",
    labelJa: "所要時間見積による延期率の差",
    labelEn: "Defer rate by time estimate bucket",
    description:
      "所要時間見積が30分以上、または未設定のTASKと、それ未満のTASKとで、延期される割合に" +
      "有意な差があるかを比較する(AI・PEM設計書v1.0 9章の代表例)。",
    appliesToResponsibilityType: "TASK",
    sourceObservationType: "TRANSITION",
    valueType: "RATE",
    unit: "PERCENTAGE_POINTS",
    directionality: "HIGHER_IS_WORSE",
    numerator:
      "対象窓内で見積30分以上・または未設定のTASKのうち、直近の該当遷移がDEFERだった" +
      "distinct responsibility数",
    denominator: "対象窓内で見積30分以上・または未設定のTASKのdistinct responsibility数",
    opportunity: "直近windowDays日以内にDEFERまたはCOMPLETEへ遷移したTASK",
    calculatorKey: "lib/pem.ts#recomputeAggregates",
    implementationVersion: "v1",
    parameterSchemaVersion: "NONE",
    eligibility: "responsibility.type === TASK かつ 直近windowDays日以内にDEFERまたはCOMPLETEへ遷移した",
    exclusion: "PemEvidenceDeletionEventで除外されたPemObservation(TRANSITION)は集計対象外",
    qualityPolicy: "削除済みEvidenceの除外以外の品質フィルタは未実装",
    windowDays: 28,
    attribution: "subjectUserId(個人単位)",
    independentUnit: "DISTINCT_RESPONSIBILITY",
    minSampleForDisplay: 5,
    minSampleForPlanning: null,
    uncertainty: null,
    decay: null,
    effectiveFrom: "2026-08-24",
    effectiveTo: null,
    lifecycleStatus: "ACTIVE",
    introducedVersion: "v1.0",
    minGapPercentagePoints: 20,
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
