/**
 * PEM Phase 0C-1-2(Reason独立Ledger化) 不変条件テスト。
 * 実行: npx tsx src/lib/pem/__tests__/phase0c1_2Invariants.test.ts
 * (npm run test:pem-phase0c1-2)
 *
 * recordReasonPromptAndAnswerはdb依存のため、ここではdecidePromptOutcome
 * (db非依存の純粋判定)とREASON_PROMPT_STATESの語彙のみ検証する。
 */
import assert from "node:assert/strict";
import { decidePromptOutcome, REASON_PROMPT_STATES } from "@/lib/pem/reasonLedger";

let passed = 0;
function check(name: string, fn: () => void): void {
  fn();
  passed++;
  console.log(`  ok - ${name}`);
}

console.log("PEM Phase 0C-1-2 不変条件テスト");

check("reasonが指定されていればANSWERED", () => {
  assert.equal(decidePromptOutcome("会議が長引いたため"), "ANSWERED");
});

check("reasonがundefined/null/空文字/空白のみはSKIPPED", () => {
  assert.equal(decidePromptOutcome(undefined), "SKIPPED");
  assert.equal(decidePromptOutcome(null), "SKIPPED");
  assert.equal(decidePromptOutcome(""), "SKIPPED");
  assert.equal(decidePromptOutcome("   "), "SKIPPED");
});

check("REASON_PROMPT_STATESはv4.0 8.2節の7値ちょうどである", () => {
  assert.deepEqual(
    [...REASON_PROMPT_STATES].sort(),
    ["ANSWERED", "DELIVERED", "DELIVERY_FAILED", "DISPLAYED", "EXPIRED", "SKIPPED", "TRIGGERED"].sort(),
  );
});

console.log(`\n${passed}件すべて成功`);
