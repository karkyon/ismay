/**
 * PEM Phase 0A是正(記録失敗の握り潰し廃止・toState検証) 不変条件テスト。
 * 実行: npx tsx src/lib/pem/__tests__/phase0aFix1Invariants.test.ts
 * (npm run test:pem-phase0a-fix1)
 *
 * assertExecutionLedgerWriteAllowedはdb非依存(eventDefinitionRegistry.ts)のため、
 * ここでは「不正なtoStateの組み合わせに対しRegistryが正しいtoStateを返す」ことを
 * 直接検証する(executionLedger.ts自体はdb依存のためtsx単体テスト対象外)。
 */
import assert from "node:assert/strict";
import { assertExecutionLedgerWriteAllowed } from "@/lib/pem/eventDefinitionRegistry";

let passed = 0;
function check(name: string, fn: () => void): void {
  fn();
  passed++;
  console.log(`  ok - ${name}`);
}

console.log("PEM Phase 0A是正 不変条件テスト");

check("assertExecutionLedgerWriteAllowedはeventType=STARTに対しtoState=IN_PROGRESSを返す(呼び出し元の誤ったtoState指定を検出する基盤)", () => {
  const result = assertExecutionLedgerWriteAllowed({
    eventType: "START",
    evidenceClass: "FACT",
    actorType: "USER",
    source: "WEB",
    fromState: "PLANNED",
    responsibilityType: "TASK",
    consentGranted: () => true,
  });
  assert.equal(result.toState, "IN_PROGRESS");
});

check("assertExecutionLedgerWriteAllowedはeventType=COMPLETEに対しtoState=COMPLETEDを返す", () => {
  const result = assertExecutionLedgerWriteAllowed({
    eventType: "COMPLETE",
    evidenceClass: "FACT",
    actorType: "USER",
    source: "WEB",
    fromState: "IN_PROGRESS",
    responsibilityType: "TASK",
    consentGranted: () => true,
  });
  assert.equal(result.toState, "COMPLETED");
});

check("assertExecutionLedgerWriteAllowedはeventType=REOPENに対しtoState=PLANNEDを返す(COMPLETED/NOT_NEEDEDどちらのfromStateでも同じtoState)", () => {
  const fromCompleted = assertExecutionLedgerWriteAllowed({
    eventType: "REOPEN",
    evidenceClass: "FACT",
    actorType: "USER",
    source: "WEB",
    fromState: "COMPLETED",
    responsibilityType: "TASK",
    consentGranted: () => true,
  });
  const fromNotNeeded = assertExecutionLedgerWriteAllowed({
    eventType: "REOPEN",
    evidenceClass: "FACT",
    actorType: "USER",
    source: "WEB",
    fromState: "NOT_NEEDED",
    responsibilityType: "TASK",
    consentGranted: () => true,
  });
  assert.equal(fromCompleted.toState, "PLANNED");
  assert.equal(fromNotNeeded.toState, "PLANNED");
});

console.log(`\n${passed}件すべて成功`);
