/**
 * PEM Phase 0D-1(Metric Definition Registry) 不変条件テスト。
 * 実行: npx tsx src/lib/pem/__tests__/phase0d1Invariants.test.ts
 * (npm run test:pem-phase0d1)
 */
import assert from "node:assert/strict";
import {
  METRIC_DEFINITIONS,
  getMetricDefinition,
  isKnownMetricKey,
  isMetricEnabledByDefault,
} from "@/lib/pem/metricDefinitionRegistry";

let passed = 0;
function check(name: string, fn: () => void): void {
  fn();
  passed++;
  console.log(`  ok - ${name}`);
}

console.log("PEM Phase 0D-1(Metric Definition Registry) 不変条件テスト");

check("DEFER_RATE_BY_ESTIMATE_BUCKETはlib/pem.tsが従来ハードコードしていた閾値と一致する(Phase 0D-2でDEFER_RATE_BY_ESTIMATEから改名)", () => {
  const def = METRIC_DEFINITIONS.DEFER_RATE_BY_ESTIMATE_BUCKET;
  assert.equal(def.windowDays, 28, "AGGREGATE_WINDOW_DAYS=28 と一致すべき");
  assert.equal(def.minSampleForDisplay, 5, "MIN_SAMPLE_SIZE=5 と一致すべき");
  assert.equal(def.minGapPercentagePoints, 20, "MIN_GAP_PERCENTAGE_POINTS=20 と一致すべき");
  assert.equal(def.metricKey, "DEFER_RATE_BY_ESTIMATE_BUCKET");
  assert.equal(def.appliesToResponsibilityType, "TASK");
});

check("getMetricDefinitionは登録済みキーで定義を返し、未登録キーでundefinedを返す", () => {
  assert.ok(getMetricDefinition("DEFER_RATE_BY_ESTIMATE_BUCKET"));
  assert.equal(getMetricDefinition("NOT_REGISTERED_METRIC"), undefined);
});

check("isKnownMetricKeyは登録済みキーのみtrueを返す", () => {
  assert.equal(isKnownMetricKey("DEFER_RATE_BY_ESTIMATE_BUCKET"), true);
  assert.equal(isKnownMetricKey("FOO_BAR"), false);
});

check("isMetricEnabledByDefaultは未知のmetricKeyに対し安全側(false)を返す", () => {
  assert.equal(isMetricEnabledByDefault("DEFER_RATE_BY_ESTIMATE_BUCKET"), true);
  assert.equal(isMetricEnabledByDefault("TYPO_METRIC_KEY"), false);
});

console.log(`\n${passed}件すべて成功`);
