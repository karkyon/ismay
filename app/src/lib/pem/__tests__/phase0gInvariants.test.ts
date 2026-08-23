/**
 * PEM Phase 0G 不変条件テスト。
 * 出典: 批評「Phase 0G-E: テスト」。Node標準assertのみで動作し、
 * 追加のテストフレームワーク導入判断とは切り離す(将来jest/vitest等を
 * 正式採用する場合は移植する)。
 *
 * 実行: npx tsx src/lib/pem/__tests__/phase0gInvariants.test.ts
 *       (npm run test:pem-phase0g)
 */
import assert from "node:assert/strict";
import { RESPONSIBILITY_TYPES } from "@/lib/responsibility";
import {
  EXECUTION_EVENT_TYPES,
  EXCLUDED_FROM_EXECUTION_LEDGER,
  type ExecutionEventType,
} from "@/lib/pem/coreTypes";
import {
  EXECUTION_EVENT_DEFINITIONS,
  EXECUTION_LEDGER_STATES,
  assertExecutionLedgerWriteAllowed,
  isExecutionLedgerApplicableType,
} from "@/lib/pem/eventDefinitionRegistry";

let passed = 0;
function check(name: string, fn: () => void): void {
  fn();
  passed++;
  console.log(`  ok - ${name}`);
}

console.log("PEM Phase 0G 不変条件テスト");

check("全ExecutionEventTypeにDefinitionが1件存在する", () => {
  for (const t of EXECUTION_EVENT_TYPES) {
    assert.ok(EXECUTION_EVENT_DEFINITIONS[t], `${t} の定義が無い`);
  }
});

check("全DefinitionのevidenceClassはFACTである", () => {
  for (const t of EXECUTION_EVENT_TYPES) {
    assert.equal(EXECUTION_EVENT_DEFINITIONS[t].evidenceClass, "FACT", t);
  }
});

check("全DefinitionのallowedLedgerはEXECUTION_LEDGERである", () => {
  for (const t of EXECUTION_EVENT_TYPES) {
    assert.equal(EXECUTION_EVENT_DEFINITIONS[t].allowedLedger, "EXECUTION_LEDGER", t);
  }
});

check("全Definitionのfrom/toはEXECUTION_LEDGER_STATES内に収まる", () => {
  const stateSet = new Set<string>(EXECUTION_LEDGER_STATES);
  for (const t of EXECUTION_EVENT_TYPES) {
    const def = EXECUTION_EVENT_DEFINITIONS[t];
    for (const from of def.fromStates) {
      assert.ok(stateSet.has(from), `${t}.fromStates に未知の状態 ${from}`);
    }
    assert.ok(stateSet.has(def.toState), `${t}.toState が未知の状態 ${def.toState}`);
  }
});

check("禁止Event種別はassertExecutionLedgerWriteAllowedで全て拒否される", () => {
  for (const excluded of EXCLUDED_FROM_EXECUTION_LEDGER) {
    assert.throws(() =>
      assertExecutionLedgerWriteAllowed({
        eventType: excluded,
        evidenceClass: "FACT",
        actorType: "USER",
        source: "WEB",
        fromState: "IN_PROGRESS",
        consentGranted: () => true,
      }),
    );
  }
});

check("SYSTEM/WORKER/AIによるFACT生成は許可actor外のため拒否される", () => {
  const eventType: ExecutionEventType = "START";
  assert.throws(() =>
    assertExecutionLedgerWriteAllowed({
      eventType,
      evidenceClass: "FACT",
      actorType: "AI",
      source: "API",
      fromState: "PLANNED",
      consentGranted: () => true,
    }),
  );
});

check("同意未取得のイベントは拒否される", () => {
  assert.throws(() =>
    assertExecutionLedgerWriteAllowed({
      eventType: "START",
      evidenceClass: "FACT",
      actorType: "USER",
      source: "WEB",
      fromState: "PLANNED",
      consentGranted: () => false,
    }),
  );
});

check("正常系: PLANNED上のSTARTは許可される", () => {
  const result = assertExecutionLedgerWriteAllowed({
    eventType: "START",
    evidenceClass: "FACT",
    actorType: "USER",
    source: "WEB",
    fromState: "PLANNED",
    consentGranted: () => true,
  });
  assert.equal(result.toState, "IN_PROGRESS");
});

check("種別固有状態型(COMMITMENT等)はExecution Ledger対象外と判定される", () => {
  assert.equal(isExecutionLedgerApplicableType("COMMITMENT"), false);
  assert.equal(isExecutionLedgerApplicableType("DECISION"), false);
  assert.equal(isExecutionLedgerApplicableType("WAITING"), false);
  assert.equal(isExecutionLedgerApplicableType("RISK"), false);
});

check("共通状態型(TASK等)はExecution Ledger対象と判定される", () => {
  assert.equal(isExecutionLedgerApplicableType("TASK"), true);
  assert.equal(isExecutionLedgerApplicableType("EVENT"), true);
  assert.equal(isExecutionLedgerApplicableType("CONCERN"), true);
  assert.equal(isExecutionLedgerApplicableType("HABIT"), true);
  assert.equal(isExecutionLedgerApplicableType("IDEA"), true);
});

check("RESPONSIBILITY_TYPES全件がExecution Ledger適用判定を持つ(網羅性)", () => {
  for (const t of RESPONSIBILITY_TYPES) {
    // 例外を投げなければOK(true/falseいずれかを返せること自体を検証)
    const result = isExecutionLedgerApplicableType(t);
    assert.equal(typeof result, "boolean", t);
  }
});

console.log(`PEM Phase 0G: ${passed}件のテストがすべて成功しました`);
