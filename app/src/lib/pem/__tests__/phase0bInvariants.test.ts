/**
 * PEM Phase 0B 不変条件テスト。
 * 実行: npx tsx src/lib/pem/__tests__/phase0bInvariants.test.ts
 * (npm run test:pem-phase0b)
 *
 * v4.0 3.2節が明示する代表事例「09:00開始→09:30中断→13:00再開→14:00完了」を
 * 誤って5時間と測定しないことを機械的に検証する(90分が正)。
 */
import assert from "node:assert/strict";
import {
  computeExecutionSessions,
  sumActiveDurationMsAsOf,
  sumClosedSessionDurationMs,
  type ExecutionSessionSourceEvent,
} from "@/lib/pem/sessionProjection";

let passed = 0;
function check(name: string, fn: () => void): void {
  fn();
  passed++;
  console.log(`  ok - ${name}`);
}

console.log("PEM Phase 0B 不変条件テスト");

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

check("v4.0 3.2節の代表事例: 開始→中断→再開→完了は90分(5時間ではない)", () => {
  const events = [
    ev(1, "START", "PLANNED", "IN_PROGRESS", "2026-08-24T09:00:00Z"),
    ev(2, "INTERRUPT", "IN_PROGRESS", "DEFERRED", "2026-08-24T09:30:00Z"),
    ev(3, "RESUME", "DEFERRED", "IN_PROGRESS", "2026-08-24T13:00:00Z"),
    ev(4, "COMPLETE", "IN_PROGRESS", "COMPLETED", "2026-08-24T14:00:00Z"),
  ];
  const sessions = computeExecutionSessions("resp-1", events);
  assert.equal(sessions.length, 2, "セッションは2件(開始〜中断、再開〜完了)であるべき");
  assert.equal(sessions[0].durationMs, 30 * 60 * 1000);
  assert.equal(sessions[1].durationMs, 60 * 60 * 1000);
  const totalMs = sumClosedSessionDurationMs(sessions);
  assert.equal(totalMs, 90 * 60 * 1000, "合計は90分であるべき(5時間ではない)");
  assert.equal(sessions.every((s) => !s.isOpen), true);
});

check("イベント順が入力配列の並びと逆でもresponsibilitySequenceで正しく並び替える", () => {
  const events = [
    ev(2, "COMPLETE", "IN_PROGRESS", "COMPLETED", "2026-08-24T10:00:00Z"),
    ev(1, "START", "PLANNED", "IN_PROGRESS", "2026-08-24T09:00:00Z"),
  ];
  const sessions = computeExecutionSessions("resp-2", events);
  assert.equal(sessions.length, 1);
  assert.equal(sessions[0].durationMs, 60 * 60 * 1000);
});

check("進行中セッション(未終了)はisOpen=true・durationMs=nullとなる", () => {
  const events = [ev(1, "START", "PLANNED", "IN_PROGRESS", "2026-08-24T09:00:00Z")];
  const sessions = computeExecutionSessions("resp-3", events);
  assert.equal(sessions.length, 1);
  assert.equal(sessions[0].isOpen, true);
  assert.equal(sessions[0].durationMs, null);
});

check("sumActiveDurationMsAsOfは進行中セッションをasOf時点で打ち切って合算する", () => {
  const events = [ev(1, "START", "PLANNED", "IN_PROGRESS", "2026-08-24T09:00:00Z")];
  const sessions = computeExecutionSessions("resp-4", events);
  const totalMs = sumActiveDurationMsAsOf(sessions, new Date("2026-08-24T09:45:00Z"));
  assert.equal(totalMs, 45 * 60 * 1000);
});

check("asOfがセッション開始より前でも負値にならない(0として扱う)", () => {
  const events = [ev(1, "START", "PLANNED", "IN_PROGRESS", "2026-08-24T09:00:00Z")];
  const sessions = computeExecutionSessions("resp-5", events);
  const totalMs = sumActiveDurationMsAsOf(sessions, new Date("2026-08-24T08:00:00Z"));
  assert.equal(totalMs, 0);
});

check("occurredAtQualityがLOWの端点を含むセッションはmeasurementQuality=LOWになる", () => {
  const events = [
    ev(1, "START", "PLANNED", "IN_PROGRESS", "2026-08-24T09:00:00Z", "HIGH"),
    ev(2, "COMPLETE", "IN_PROGRESS", "COMPLETED", "2026-08-24T10:00:00Z", "LOW"),
  ];
  const sessions = computeExecutionSessions("resp-6", events);
  assert.equal(sessions[0].measurementQuality, "LOW");
});

console.log(`\n${passed}件すべて成功`);
