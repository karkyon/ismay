/**
 * PEM 批評対応8・9・10 不変条件テスト。
 * 実行: npx tsx src/lib/pem/__tests__/phase8_9_10Invariants.test.ts
 * (npm run test:pem-8-9-10)
 */
import assert from "node:assert/strict";
import { METRIC_DEFINITIONS, getMetricDefinition } from "@/lib/pem/metricDefinitionRegistry";

let passed = 0;
function check(name: string, fn: () => void): void {
  fn();
  passed++;
  console.log(`  ok - ${name}`);
}

console.log("PEM 批評対応8・9・10 不変条件テスト");

check("DEFER_RATE_BY_ESTIMATE_BUCKETがv4.0 10.3節の正式名称で登録されている", () => {
  const def = METRIC_DEFINITIONS.DEFER_RATE_BY_ESTIMATE_BUCKET;
  assert.equal(def.metricKey, "DEFER_RATE_BY_ESTIMATE_BUCKET");
  assert.equal(getMetricDefinition("DEFER_RATE_BY_ESTIMATE"), undefined, "旧名は登録されていないはず");
});

check("MetricDefinitionがv4.0 10章必須項目を持つ(型レベル・値レベル両方)", () => {
  const def = METRIC_DEFINITIONS.DEFER_RATE_BY_ESTIMATE_BUCKET;
  for (const field of [
    "version", "valueType", "unit", "directionality", "numerator", "denominator",
    "opportunity", "calculatorKey", "implementationVersion", "parameterSchemaVersion",
    "eligibility", "exclusion", "qualityPolicy", "attribution", "independentUnit",
    "minSampleForDisplay", "effectiveFrom", "lifecycleStatus",
  ] as const) {
    assert.ok(field in def, `${field}が無い`);
  }
  assert.equal(def.independentUnit, "DISTINCT_RESPONSIBILITY");
  assert.equal(def.lifecycleStatus, "ACTIVE");
});

check("従来の閾値(windowDays=28, minSampleForDisplay=5, minGapPercentagePoints=20)は不変", () => {
  const def = METRIC_DEFINITIONS.DEFER_RATE_BY_ESTIMATE_BUCKET;
  assert.equal(def.windowDays, 28);
  assert.equal(def.minSampleForDisplay, 5);
  assert.equal(def.minGapPercentagePoints, 20);
});

console.log(`\n${passed}件すべて成功`);
