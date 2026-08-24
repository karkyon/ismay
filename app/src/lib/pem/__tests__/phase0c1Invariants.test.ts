/**
 * PEM Phase 0C-1(Reason Capture) 不変条件テスト。
 * 実行: npx tsx src/lib/pem/__tests__/phase0c1Invariants.test.ts
 * (npm run test:pem-phase0c1)
 */
import assert from "node:assert/strict";
import { buildExecutionEventMetadata } from "@/lib/pem/executionLedgerMapping";

let passed = 0;
function check(name: string, fn: () => void): void {
  fn();
  passed++;
  console.log(`  ok - ${name}`);
}

console.log("PEM Phase 0C-1(Reason Capture) 不変条件テスト");

check("reasonが指定されていればmetadataへ格納される", () => {
  const metadata = buildExecutionEventMetadata("会議が長引いたため");
  assert.deepEqual(metadata, { reason: "会議が長引いたため" });
});

check("reasonが前後空白のみの場合はtrimされ、空になればundefinedを返す", () => {
  assert.deepEqual(buildExecutionEventMetadata("   "), undefined);
  assert.deepEqual(buildExecutionEventMetadata("  会議  "), { reason: "会議" });
});

check("reasonがundefined/null/空文字の場合はundefinedを返す(metadata列をnullのままにする)", () => {
  assert.deepEqual(buildExecutionEventMetadata(undefined), undefined);
  assert.deepEqual(buildExecutionEventMetadata(null), undefined);
  assert.deepEqual(buildExecutionEventMetadata(""), undefined);
});

console.log(`\n${passed}件すべて成功`);
