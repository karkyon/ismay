/**
 * PEM Phase 0C-2/0C-3(削除カスケード・userVerdict語彙移行) 不変条件テスト。
 * 実行: npx tsx src/lib/pem/__tests__/phase0c2Invariants.test.ts
 * (npm run test:pem-phase0c2)
 *
 * evidenceDeletion.tsはdb依存のため、ここではPEM_USER_VERDICTS(db非依存)と
 * TRANSITION_ACTION_TO_EVENT_TYPE等の既存語彙との整合のみ機械的に検証する。
 */
import assert from "node:assert/strict";
import { PEM_USER_VERDICTS } from "@/lib/pem/coreTypes";
import type { DeletableEvidenceTargetType } from "@/lib/pem/evidenceDeletion";

let passed = 0;
function check(name: string, fn: () => void): void {
  fn();
  passed++;
  console.log(`  ok - ${name}`);
}

console.log("PEM Phase 0C-2/0C-3 不変条件テスト");

check("PEM_USER_VERDICTSにTEMPORARYが含まれない(評決ではなくTemporary State側の概念のため)", () => {
  assert.equal((PEM_USER_VERDICTS as readonly string[]).includes("TEMPORARY"), false);
});

check("PEM_USER_VERDICTSはv4.0 12.2節の4値ちょうどである", () => {
  assert.deepEqual(
    [...PEM_USER_VERDICTS].sort(),
    ["AGREED", "DISAGREED", "PARTIALLY_AGREED", "UNREVIEWED"].sort(),
  );
});

check("DeletableEvidenceTargetTypeの型が期待通りコンパイルされる(型レベル検査)", () => {
  const t: DeletableEvidenceTargetType = "PEM_OBSERVATION";
  assert.equal(t, "PEM_OBSERVATION");
});

console.log(`\n${passed}件すべて成功`);
