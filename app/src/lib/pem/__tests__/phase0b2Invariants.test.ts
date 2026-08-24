/**
 * PEM Phase 0B-2(Session Projection拡張) 不変条件テスト。
 * 実行: npx tsx src/lib/pem/__tests__/phase0b2Invariants.test.ts
 * (npm run test:pem-phase0b2)
 *
 * sessionPersistence.tsはdb依存(実DBへのwrite)のため、ここではdb非依存の
 * sessionProjection.ts側(異常検出・executionPresence純粋ロジック)のみを検証する。
 * 実際のIdentity/Revision書き込み挙動は、サンドボックスがPrismaクエリエンジンを
 * ネットワーク制約で取得できないため統合テストできない。omega-dev2側での
 * 手動確認を申し送り事項とする。
 */
import assert from "node:assert/strict";
import { computeExecutionSessions, deriveExecutionPresence } from "@/lib/pem/sessionProjection";
import type { ExecutionSessionSourceEvent } from "@/lib/pem/sessionProjection";

let passed = 0;
function check(name: string, fn: () => void): void {
  fn();
  passed++;
  console.log(`  ok - ${name}`);
}

console.log("PEM Phase 0B-2 不変条件テスト");

function ev(
  seq: number,
  eventType: string,
  fromState: string,
  toState: string,
  at: string,
  quality = "HIGH",
): ExecutionSessionSourceEvent {
  return {
    id: `ev-${seq}`,
    eventType,
    fromState,
    toState,
    effectiveOccurredAt: new Date(at),
    occurredAtQuality: quality,
    responsibilitySequence: seq,
  };
}

check("終了イベントが開始イベントより前の時刻(負duration)はanomalyDetected=true・durationMs=null・quality=LOWになる(以前のMath.max(0,...)による無音丸めを是正)", () => {
  const events = [
    ev(1, "START", "PLANNED", "IN_PROGRESS", "2026-08-24T10:00:00Z"),
    ev(2, "COMPLETE", "IN_PROGRESS", "COMPLETED", "2026-08-24T09:00:00Z"), // 開始より前
  ];
  const sessions = computeExecutionSessions("resp-anomaly", events);
  assert.equal(sessions.length, 1);
  assert.equal(sessions[0]!.anomalyDetected, true);
  assert.equal(sessions[0]!.durationMs, null);
  assert.equal(sessions[0]!.measurementQuality, "LOW");
});

check("正常なdurationはanomalyDetected=falseのまま", () => {
  const events = [
    ev(1, "START", "PLANNED", "IN_PROGRESS", "2026-08-24T09:00:00Z"),
    ev(2, "COMPLETE", "IN_PROGRESS", "COMPLETED", "2026-08-24T10:00:00Z"),
  ];
  const sessions = computeExecutionSessions("resp-normal", events);
  assert.equal(sessions[0]!.anomalyDetected, false);
  assert.equal(sessions[0]!.durationMs, 60 * 60 * 1000);
});

check("deriveExecutionPresence: nullはUNKNOWN、OPENはACTIVE_SESSION、それ以外はNO_ACTIVE_SESSION", () => {
  assert.equal(deriveExecutionPresence(null), "UNKNOWN");
  assert.equal(deriveExecutionPresence("OPEN"), "ACTIVE_SESSION");
  assert.equal(deriveExecutionPresence("CLOSED_CONFIRMED"), "NO_ACTIVE_SESSION");
  assert.equal(deriveExecutionPresence("CLOSED_UNCONFIRMED"), "NO_ACTIVE_SESSION");
});

console.log(`\n${passed}件すべて成功`);
