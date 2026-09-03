/**
 * Case Pattern Catalog(M4) — casePatternMath.ts 不変条件テスト。
 * 既存 formation/__tests__/coreInvariants.test.ts と同じdb非依存パターン
 * (npx tsx で直接実行、DATABASE_URL不要)。
 * 出典: DOC-06 §6「可変Window・確度」、§10「受入条件」。
 */
import {
  CASE_PATTERN_WINDOW_CYCLES,
  CASE_PATTERN_NULL_INTERVAL_CONFIDENCE_CAP,
  CASE_PATTERN_STAGES,
  computeObservedIntervalDays,
  computeCasePatternConfidence,
  classifyCasePatternStage,
  displayCasePatternConfidence,
  type CasePatternOccurrence,
} from "../casePatternMath";

let passed = 0;
let failed = 0;
const failures: string[] = [];

function ok(name: string, cond: boolean, detail?: string): void {
  if (cond) {
    passed++;
    console.log(`  ok - ${name}`);
  } else {
    failed++;
    failures.push(name + (detail ? ` (${detail})` : ""));
    console.log(`  NG - ${name}${detail ? ` :: ${detail}` : ""}`);
  }
}

function approxEqual(a: number, b: number, epsilon = 1e-6): boolean {
  return Math.abs(a - b) < epsilon;
}

function day(offsetFromEpoch: string): Date {
  return new Date(offsetFromEpoch);
}

console.log("Case Pattern Catalog(M4) casePatternMath 不変条件テスト(DOC-06 §6準拠)");

// -------------------------------------------------------------------
// 定数
// -------------------------------------------------------------------
ok("CASE_PATTERN_WINDOW_CYCLESは12(§6数式)", CASE_PATTERN_WINDOW_CYCLES === 12);
ok("CASE_PATTERN_NULL_INTERVAL_CONFIDENCE_CAPは0.25(§6)", CASE_PATTERN_NULL_INTERVAL_CONFIDENCE_CAP === 0.25);
ok("CASE_PATTERN_STAGESは4値ちょうど", CASE_PATTERN_STAGES.length === 4);

// -------------------------------------------------------------------
// computeObservedIntervalDays: 連続差分の中央値
// -------------------------------------------------------------------
ok("occurrence 0件はnull", computeObservedIntervalDays([]) === null);
ok(
  "occurrence 1件はnull(差分が1件も取れない)",
  computeObservedIntervalDays([{ occurredAt: day("2026-01-01T00:00:00Z"), qualityWeight: 1, independenceWeight: 1 }]) === null,
);
{
  // 2件、10日間隔 → 差分1件=10日 → 中央値10日
  const result = computeObservedIntervalDays([
    { occurredAt: day("2026-01-01T00:00:00Z"), qualityWeight: 1, independenceWeight: 1 },
    { occurredAt: day("2026-01-11T00:00:00Z"), qualityWeight: 1, independenceWeight: 1 },
  ]);
  ok("2件・10日間隔は10日", result !== null && approxEqual(result, 10));
}
{
  // 3件(奇数差分2件): 1/1, 1/11(+10日), 1/21(+10日) → 差分[10,10] → 中央値10
  const result = computeObservedIntervalDays([
    { occurredAt: day("2026-01-21T00:00:00Z"), qualityWeight: 1, independenceWeight: 1 }, // 順不同でもソートされる
    { occurredAt: day("2026-01-01T00:00:00Z"), qualityWeight: 1, independenceWeight: 1 },
    { occurredAt: day("2026-01-11T00:00:00Z"), qualityWeight: 1, independenceWeight: 1 },
  ]);
  ok("3件・等間隔10日(順不同入力)は10日(内部ソート確認)", result !== null && approxEqual(result, 10));
}
{
  // 4件(差分3件、偶数個): 1/1, 1/6(+5), 1/16(+10), 1/26(+10) → 差分[5,10,10] → ソート[5,10,10] → 中央値=10(奇数個なので中央1件)
  const result = computeObservedIntervalDays([
    { occurredAt: day("2026-01-01T00:00:00Z"), qualityWeight: 1, independenceWeight: 1 },
    { occurredAt: day("2026-01-06T00:00:00Z"), qualityWeight: 1, independenceWeight: 1 },
    { occurredAt: day("2026-01-16T00:00:00Z"), qualityWeight: 1, independenceWeight: 1 },
    { occurredAt: day("2026-01-26T00:00:00Z"), qualityWeight: 1, independenceWeight: 1 },
  ]);
  ok("4件・差分[5,10,10]の中央値は10", result !== null && approxEqual(result, 10));
}

// -------------------------------------------------------------------
// computeCasePatternConfidence: golden dataset(手計算値との突合、1e-6以内)
// -------------------------------------------------------------------
{
  // observedIntervalDays=null(1件)の場合、weightedSupport=0・confidence=0・
  // halfLifeDays/windowFrom=null(数式が定義不能なため)。
  const now = day("2026-09-03T00:00:00Z");
  const result = computeCasePatternConfidence(
    [{ occurredAt: day("2026-09-01T00:00:00Z"), qualityWeight: 1, independenceWeight: 1 }],
    now,
  );
  ok("[interval=null] rawSampleSizeは1", result.rawSampleSize === 1);
  ok("[interval=null] observedIntervalDaysはnull", result.observedIntervalDays === null);
  ok("[interval=null] halfLifeDaysはnull(数式が定義不能)", result.halfLifeDays === null);
  ok("[interval=null] windowFromはnull", result.windowFrom === null);
  ok("[interval=null] confidenceは0(rawの計算結果、表示上限とは別)", result.confidence === 0);
}
{
  // 手計算golden dataset:
  // occurrence 2件、10日間隔 → observedIntervalDays=10, halfLifeDays=60。
  // now=2026-01-11(2件目と同時刻)。
  //   1件目: ageDays=10, recencyWeight=0.5^(10/60)=0.5^0.16666...=0.891049633...
  //   2件目: ageDays=0,  recencyWeight=0.5^0=1
  //   quality=1, independence=1 それぞれ
  //   weightedSupport = 0.891049633... + 1 = 1.891049633...
  //   confidence = min(1, 1.891049633/6) = 0.315174939...
  const now = day("2026-01-11T00:00:00Z");
  const occurrences: CasePatternOccurrence[] = [
    { occurredAt: day("2026-01-01T00:00:00Z"), qualityWeight: 1, independenceWeight: 1 },
    { occurredAt: day("2026-01-11T00:00:00Z"), qualityWeight: 1, independenceWeight: 1 },
  ];
  const result = computeCasePatternConfidence(occurrences, now);
  const expectedRecency1 = Math.pow(0.5, 10 / 60);
  const expectedWeightedSupport = expectedRecency1 + 1;
  const expectedConfidence = Math.min(1, expectedWeightedSupport / 6);

  ok("[golden] observedIntervalDaysは10", result.observedIntervalDays !== null && approxEqual(result.observedIntervalDays, 10));
  ok("[golden] halfLifeDaysは60(observedIntervalDays*6)", result.halfLifeDays !== null && approxEqual(result.halfLifeDays, 60));
  ok(
    "[golden] windowFromはnow - 10*12日 = 120日前",
    result.windowFrom !== null && approxEqual(result.windowFrom.getTime(), now.getTime() - 120 * 24 * 60 * 60 * 1000, 1),
  );
  ok(
    "[golden] weightedSupportは手計算値と1e-6以内で一致",
    approxEqual(result.weightedSupport, expectedWeightedSupport),
    `actual=${result.weightedSupport} expected=${expectedWeightedSupport}`,
  );
  ok(
    "[golden] confidenceは手計算値と1e-6以内で一致",
    approxEqual(result.confidence, expectedConfidence),
    `actual=${result.confidence} expected=${expectedConfidence}`,
  );
}
{
  // confidenceは1.0でcapされる(weightedSupport>6となる大量occurrenceケース)。
  const now = day("2026-09-03T00:00:00Z");
  const occurrences: CasePatternOccurrence[] = Array.from({ length: 20 }, (_, i) => ({
    occurredAt: new Date(now.getTime() - i * 24 * 60 * 60 * 1000), // 直近20日、1日おき
    qualityWeight: 1,
    independenceWeight: 1,
  }));
  const result = computeCasePatternConfidence(occurrences, now);
  ok("[cap] confidenceは1.0を超えない", result.confidence <= 1.0);
}
{
  // qualityWeight/independenceWeightが0なら、そのoccurrenceはweightedSupportへ寄与しない。
  const now = day("2026-01-11T00:00:00Z");
  const occurrences: CasePatternOccurrence[] = [
    { occurredAt: day("2026-01-01T00:00:00Z"), qualityWeight: 0, independenceWeight: 1 },
    { occurredAt: day("2026-01-11T00:00:00Z"), qualityWeight: 1, independenceWeight: 1 },
  ];
  const result = computeCasePatternConfidence(occurrences, now);
  ok("[quality=0] weightedSupportはquality=1の1件分のみ(=1)", approxEqual(result.weightedSupport, 1));
}

// -------------------------------------------------------------------
// classifyCasePatternStage: §6段階表
// -------------------------------------------------------------------
ok(
  "raw sample<2はNONE",
  classifyCasePatternStage({ rawSampleSize: 1, observedIntervalDays: null, distinctContextCount: 1, confidence: 0, recentAdoptionRate: null }) ===
    "NONE",
);
ok(
  "observedIntervalDays=nullはraw sample>=2でもCANDIDATE_DISPLAY止まり(ACTIVE化禁止)",
  classifyCasePatternStage({
    rawSampleSize: 100,
    observedIntervalDays: null,
    distinctContextCount: 100,
    confidence: 1,
    recentAdoptionRate: 1,
  }) === "CANDIDATE_DISPLAY",
);
ok(
  "raw sample>=2・observedIntervalDaysありはCANDIDATE_DISPLAY(ACTIVE条件未満)",
  classifyCasePatternStage({
    rawSampleSize: 2,
    observedIntervalDays: 10,
    distinctContextCount: 1,
    confidence: 0.1,
    recentAdoptionRate: null,
  }) === "CANDIDATE_DISPLAY",
);
ok(
  "raw sample=5・distinctContext=3・confidence=0.50ちょうどはACTIVE(境界値・以上判定)",
  classifyCasePatternStage({
    rawSampleSize: 5,
    observedIntervalDays: 10,
    distinctContextCount: 3,
    confidence: 0.5,
    recentAdoptionRate: null,
  }) === "ACTIVE",
);
ok(
  "raw sample=4はACTIVE未満(distinctContext/confidence満たしても)",
  classifyCasePatternStage({
    rawSampleSize: 4,
    observedIntervalDays: 10,
    distinctContextCount: 10,
    confidence: 0.9,
    recentAdoptionRate: 1,
  }) === "CANDIDATE_DISPLAY",
);
ok(
  "distinctContext=2はACTIVE未満(raw sample/confidence満たしても)",
  classifyCasePatternStage({
    rawSampleSize: 100,
    observedIntervalDays: 10,
    distinctContextCount: 2,
    confidence: 0.9,
    recentAdoptionRate: 1,
  }) === "CANDIDATE_DISPLAY",
);
ok(
  "confidence=0.49はACTIVE未満",
  classifyCasePatternStage({
    rawSampleSize: 100,
    observedIntervalDays: 10,
    distinctContextCount: 100,
    confidence: 0.49,
    recentAdoptionRate: 1,
  }) === "CANDIDATE_DISPLAY",
);
ok(
  "raw sample=10・distinctContext=5・confidence=0.67・採用率=0.60ちょうどはSTRONG_SUGGESTION(境界値)",
  classifyCasePatternStage({
    rawSampleSize: 10,
    observedIntervalDays: 10,
    distinctContextCount: 5,
    confidence: 0.67,
    recentAdoptionRate: 0.6,
  }) === "STRONG_SUGGESTION",
);
ok(
  "ACTIVE条件は満たすがSTRONG条件未満(採用率0.59)はACTIVE止まり",
  classifyCasePatternStage({
    rawSampleSize: 10,
    observedIntervalDays: 10,
    distinctContextCount: 5,
    confidence: 0.67,
    recentAdoptionRate: 0.59,
  }) === "ACTIVE",
);
ok(
  "採用率未計測(null)はSTRONG_SUGGESTIONにならない(未計測を0%と偽装しないが、昇格も許可しない)",
  classifyCasePatternStage({
    rawSampleSize: 10,
    observedIntervalDays: 10,
    distinctContextCount: 5,
    confidence: 0.67,
    recentAdoptionRate: null,
  }) === "ACTIVE",
);

// -------------------------------------------------------------------
// displayCasePatternConfidence: 表示上限0.25の適用
// -------------------------------------------------------------------
ok(
  "observedIntervalDays=nullの場合、confidenceが0.25超でも表示は0.25でcapされる",
  displayCasePatternConfidence({ observedIntervalDays: null, confidence: 0.9 }) === 0.25,
);
ok(
  "observedIntervalDays=nullでもconfidenceが0.25未満ならそのまま",
  displayCasePatternConfidence({ observedIntervalDays: null, confidence: 0.1 }) === 0.1,
);
ok(
  "observedIntervalDaysがある場合はcapしない",
  displayCasePatternConfidence({ observedIntervalDays: 10, confidence: 0.9 }) === 0.9,
);

console.log(`\n${passed}件成功 / ${failed}件失敗`);
if (failed > 0) {
  console.log("\n失敗した項目:");
  for (const f of failures) console.log(`  - ${f}`);
  process.exit(1);
}
