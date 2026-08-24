/**
 * PEM Phase 0A 不変条件テスト。
 * 実行: npx tsx src/lib/pem/__tests__/phase0aInvariants.test.ts
 * (npm run test:pem-phase0a)
 *
 * 実データ(lib/responsibility.tsのCOMMON_TRANSITIONS)とeventDefinitionRegistry.tsの
 * fromStates/toStateが一致することを機械的に検証する。Phase 0Gで一度取り違えた
 * 実例があったための再発防止テスト。
 */
import assert from "node:assert/strict";
import { COMMON_TRANSITIONS } from "@/lib/responsibility";
import { EXECUTION_EVENT_DEFINITIONS } from "@/lib/pem/eventDefinitionRegistry";
import { TRANSITION_ACTION_TO_EVENT_TYPE, computeEffectiveOccurredAt } from "@/lib/pem/executionLedgerMapping";
// 注意: "@/lib/pem/executionLedger"はdb.ts(実Prismaクライアント)へ連鎖するため、
// tsx実行テストではimportしない(consent.tsと同じ理由)。

let passed = 0;
function check(name: string, fn: () => void): void {
  fn();
  passed++;
  console.log(`  ok - ${name}`);
}

console.log("PEM Phase 0A 不変条件テスト");

check("TRANSITION_ACTION_TO_EVENT_TYPEでマップされる全actionはCOMMON_TRANSITIONSに実在する", () => {
  const commonActions = new Set(COMMON_TRANSITIONS.map((r) => r.action));
  for (const action of Object.keys(TRANSITION_ACTION_TO_EVENT_TYPE)) {
    assert.ok(commonActions.has(action as never), `action=${action} がCOMMON_TRANSITIONSに無い`);
  }
});

check("マップされた各actionのfromStatesがEXECUTION_EVENT_DEFINITIONSと実データで一致する", () => {
  for (const rule of COMMON_TRANSITIONS) {
    const eventType = TRANSITION_ACTION_TO_EVENT_TYPE[rule.action];
    if (!eventType) continue;
    const def = EXECUTION_EVENT_DEFINITIONS[eventType];
    const defFromSet = new Set(def.fromStates as readonly string[]);
    const ruleFromSet = new Set(rule.from as readonly string[]);
    assert.deepEqual(
      [...defFromSet].sort(),
      [...ruleFromSet].sort(),
      `eventType=${eventType}(action=${rule.action}): Registry=${[...defFromSet]} vs 実データ=${[...ruleFromSet]}`,
    );
  }
});

check("PARTIAL_COMPLETEはExecution Event種別へマップされない(状態不変のため意図的に対象外)", () => {
  assert.equal(TRANSITION_ACTION_TO_EVENT_TYPE["PARTIAL_COMPLETE"], undefined);
});

check("computeEffectiveOccurredAt: 5分以内の乖離はHIGH品質でclientOccurredAtを採用", () => {
  const client = new Date("2026-08-24T10:00:00Z");
  const server = new Date("2026-08-24T10:02:00Z");
  const result = computeEffectiveOccurredAt(client, server);
  assert.equal(result.occurredAtQuality, "HIGH");
  assert.equal(result.effectiveOccurredAt.getTime(), client.getTime());
});

check("computeEffectiveOccurredAt: 5分超の乖離はLOW品質でserverRecordedAtを採用", () => {
  const client = new Date("2026-08-24T09:00:00Z");
  const server = new Date("2026-08-24T10:02:00Z");
  const result = computeEffectiveOccurredAt(client, server);
  assert.equal(result.occurredAtQuality, "LOW");
  assert.equal(result.effectiveOccurredAt.getTime(), server.getTime());
});

console.log(`PEM Phase 0A: ${passed}件のテストがすべて成功しました`);
