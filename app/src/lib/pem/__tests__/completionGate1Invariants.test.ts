/**
 * PEM Phase0S/0A Completion Gate 1 不変条件テスト。
 * 実行: npx tsx src/lib/pem/__tests__/completionGate1Invariants.test.ts
 * (npm run test:pem-completion-gate-1)
 *
 * db依存の関数(recordConsentEvent等)は実DB統合検証(サンドボックスの実Postgres、
 * 別途実施済み)に委ね、ここではdb非依存の語彙・型のみ検証する。
 */
import assert from "node:assert/strict";
import { PEM_CONSENT_TYPES, PEM_CONSENT_ACTIONS, PEM_CONSENT_POLICY_VERSION } from "@/lib/pem/coreTypes";

let passed = 0;
function check(name: string, fn: () => void): void {
  fn();
  passed++;
  console.log(`  ok - ${name}`);
}

console.log("PEM Phase0S/0A Completion Gate 1 不変条件テスト");

check("PEM_CONSENT_POLICY_VERSIONが空でない(policy version有効性判定の基盤)", () => {
  assert.ok(PEM_CONSENT_POLICY_VERSION.length > 0);
});

check("PEM_CONSENT_TYPES/PEM_CONSENT_ACTIONSは既存語彙のまま不変", () => {
  assert.deepEqual(
    [...PEM_CONSENT_TYPES].sort(),
    [
      "PEM_AI_PROCESSING",
      "PEM_DATA_COLLECTION",
      "PEM_EXPERIMENT",
      "PEM_PLANNING_APPLICATION",
      "SENSITIVE_SELF_REPORT",
    ].sort(),
  );
  assert.deepEqual([...PEM_CONSENT_ACTIONS].sort(), ["GRANTED", "WITHDRAWN"].sort());
});

console.log(`\n${passed}件すべて成功`);
