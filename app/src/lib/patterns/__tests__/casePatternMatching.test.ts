/**
 * Case Pattern Catalog(M4) — casePatternMatching.ts(classifyCasePatternMatch
 * Candidates)不変条件テスト。DB非依存パターン(npx tsx で直接実行、
 * DATABASE_URL不要)。
 * 出典: Claude向け_ISMAY_0fcea2b以降_再監査是正・PATTERN-DETECT連続実装指示_2026-09-03.md
 * §5 DR-B v1判定契約テーブル、§7 受入条件 PD-09/PD-10。
 *
 * [設計方針] pgvector経由のsimilarity計算(matchCasePattern、DB依存・
 * float4丸め誤差あり)と、閾値・曖昧性判定そのもの(この関数、DB非依存・
 * JS double精度)を分離しているため、ここでは厳密な境界値(0.879999は
 * 不一致・0.88は一致)をfloat4丸め誤差の心配なく検証できる。
 * DB経由の統合的な挙動(current revisionのみ・owner分離・model/dimensions/
 * sourceVersion不一致除外・provider失敗時の扱い)はscripts/
 * verify_gate_pattern_detect_01d.tsで別途検証する(重複しない)。
 */
import {
  classifyCasePatternMatchCandidates,
  CASE_PATTERN_MATCH_CANDIDATE_THRESHOLD,
  CASE_PATTERN_MATCH_AMBIGUITY_MARGIN,
  CASE_PATTERN_MATCH_POLICY_VERSION,
  type CasePatternMatchCandidate,
} from "../casePatternMatchPolicy";

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

console.log("Case Pattern Catalog(M4) casePatternMatching 不変条件テスト(DR-B v1判定契約準拠)");

ok("CASE_PATTERN_MATCH_CANDIDATE_THRESHOLDは0.88", CASE_PATTERN_MATCH_CANDIDATE_THRESHOLD === 0.88);
ok("CASE_PATTERN_MATCH_AMBIGUITY_MARGINは0.03", CASE_PATTERN_MATCH_AMBIGUITY_MARGIN === 0.03);
ok("CASE_PATTERN_MATCH_POLICY_VERSIONはcase-pattern-match-v1", CASE_PATTERN_MATCH_POLICY_VERSION === "case-pattern-match-v1");

// -------------------------------------------------------------------
// candidates 0件
// -------------------------------------------------------------------
{
  const result = classifyCasePatternMatchCandidates([]);
  ok("候補0件はNO_MATCH", result.kind === "NO_MATCH");
}

// -------------------------------------------------------------------
// PD-09: similarity 0.879999は不一致、0.88は候補一致(厳密な境界値)
// -------------------------------------------------------------------
{
  const single = (similarity: number): CasePatternMatchCandidate[] => [{ patternId: "p1", revisionId: "r1", similarity }];

  const belowResult = classifyCasePatternMatchCandidates(single(0.879999));
  ok("[PD-09] similarity=0.879999はNO_MATCH", belowResult.kind === "NO_MATCH", `kind=${belowResult.kind}`);

  const atResult = classifyCasePatternMatchCandidates(single(0.88));
  ok("[PD-09] similarity=0.88ちょうどはMATCHED(以上判定)", atResult.kind === "MATCHED", `kind=${atResult.kind}`);
  if (atResult.kind === "MATCHED") {
    ok("[PD-09] MATCHEDのpatternIdが正しい", atResult.patternId === "p1");
    ok("[PD-09] MATCHEDのsimilarityが正しい", atResult.similarity === 0.88);
  }

  const aboveResult = classifyCasePatternMatchCandidates(single(0.880001));
  ok("[PD-09] similarity=0.880001はMATCHED", aboveResult.kind === "MATCHED", `kind=${aboveResult.kind}`);
}

// -------------------------------------------------------------------
// PD-10: best-secondBest<0.03は自動帰属0(AMBIGUOUS)。
// margin=0.03ちょうどはAMBIGUOUSにならない(以上判定=帰属可)ことも確認する。
// -------------------------------------------------------------------
{
  // best=0.95, second=0.93 → 差0.02 < 0.03 → AMBIGUOUS
  const ambiguous = classifyCasePatternMatchCandidates([
    { patternId: "pA", revisionId: "rA", similarity: 0.95 },
    { patternId: "pB", revisionId: "rB", similarity: 0.93 },
  ]);
  ok("[PD-10] best-second=0.02(<margin)はAMBIGUOUS", ambiguous.kind === "AMBIGUOUS", `kind=${ambiguous.kind}`);
  if (ambiguous.kind === "AMBIGUOUS") {
    ok("[PD-10] AMBIGUOUSのcandidatesは2件とも含まれる", ambiguous.candidates.length === 2);
  }

  // best=0.95, second=0.921 → 差0.029(<margin) → AMBIGUOUS
  // (「ちょうど0.03」でのテストは浮動小数点減算の丸め誤差で不安定になるため、
  // marginを明確に挟む値を使う。PD-09と異なりPD-10自体はulpレベルの厳密な
  // 境界一致を要求していない)。
  const justBelowMargin = classifyCasePatternMatchCandidates([
    { patternId: "pA", revisionId: "rA", similarity: 0.95 },
    { patternId: "pB", revisionId: "rB", similarity: 0.921 },
  ]);
  ok("[PD-10境界] best-second=0.029(<margin)はAMBIGUOUS", justBelowMargin.kind === "AMBIGUOUS", `kind=${justBelowMargin.kind}`);

  // best=0.95, second=0.919 → 差0.031(>margin) → MATCHED
  const justAboveMargin = classifyCasePatternMatchCandidates([
    { patternId: "pA", revisionId: "rA", similarity: 0.95 },
    { patternId: "pB", revisionId: "rB", similarity: 0.919 },
  ]);
  ok("[PD-10境界] best-second=0.031(>margin)はMATCHED", justAboveMargin.kind === "MATCHED", `kind=${justAboveMargin.kind}`);

  // best=0.95, second=0.91 → 差0.04(>margin) → MATCHED
  const clear = classifyCasePatternMatchCandidates([
    { patternId: "pA", revisionId: "rA", similarity: 0.95 },
    { patternId: "pB", revisionId: "rB", similarity: 0.91 },
  ]);
  ok("[PD-10] best-second=0.04(>margin)はMATCHED", clear.kind === "MATCHED", `kind=${clear.kind}`);
}

// -------------------------------------------------------------------
// threshold未満はcandidates件数によらずNO_MATCH(ambiguity判定より閾値判定が優先)
// -------------------------------------------------------------------
{
  const belowThresholdWithSecond = classifyCasePatternMatchCandidates([
    { patternId: "pA", revisionId: "rA", similarity: 0.5 },
    { patternId: "pB", revisionId: "rB", similarity: 0.49 },
  ]);
  ok(
    "[閾値優先] best<thresholdならsecondとの差が僅かでもAMBIGUOUSにせずNO_MATCH",
    belowThresholdWithSecond.kind === "NO_MATCH",
    `kind=${belowThresholdWithSecond.kind}`,
  );
}

// -------------------------------------------------------------------
// candidates 1件のみ(ambiguity判定不可、閾値さえ満たせばMATCHED)
// -------------------------------------------------------------------
{
  const onlyOne = classifyCasePatternMatchCandidates([{ patternId: "p1", revisionId: "r1", similarity: 0.99 }]);
  ok("[候補1件] 閾値を満たせばAMBIGUOUS判定なしでMATCHED", onlyOne.kind === "MATCHED");
}

console.log(`\n合計: ${passed} passed, ${failed} failed`);
if (failed > 0) {
  console.log("\n失敗した項目:");
  for (const f of failures) console.log(`  - ${f}`);
  process.exit(1);
}
