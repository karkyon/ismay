/**
 * V5-M1-C Atomicity Assessment 不変条件テスト。
 * 既存 formation/__tests__/questionPolicy.test.ts と同じdb非依存パターン
 * (npx tsx で直接実行、DATABASE_URL不要)。
 */
import type { ResponsibilityCandidate } from "../../ai/schema";
import { ATOMICITY_ALGORITHM_VERSION, assessAtomicity } from "../atomicityAssessment";

let passed = 0;
let failed = 0;
const failures: string[] = [];

function ok(name: string, cond: boolean, detail?: string): void {
  if (cond) {
    passed++;
    console.log(`  ok - ${name}`);
  } else {
    failed++;
    failures.push(`${name}${detail ? ` (${detail})` : ""}`);
    console.log(`  FAIL - ${name}${detail ? ` (${detail})` : ""}`);
  }
}

function baseCandidate(overrides: Partial<ResponsibilityCandidate> = {}): ResponsibilityCandidate {
  return {
    candidateId: "c1",
    type: "TASK",
    title: "報告書を提出する",
    evidenceSpans: [{ start: 0, end: 5 }],
    confidence: 0.9,
    dateMentions: [],
    unknowns: [],
    blockedByCandidateIds: [],
    suggestedTags: [],
    completionCondition: "提出完了メールを受け取る",
    ...overrides,
  } as ResponsibilityCandidate;
}

console.log("=== atomicityAssessment.test.ts ===");

ok("ATOMICITY_ALGORITHM_VERSIONがv1", ATOMICITY_ALGORITHM_VERSION === "v1");

// --- (1) 通常のTASK(completionCondition有り、confidence高い) → ATOMIC ---
{
  const c = baseCandidate();
  const r = assessAtomicity(c);
  ok("completionCondition有り・confidence高い通常TASKはATOMIC", r.assessment === "ATOMIC", r.assessment);
  ok("evidenceが1件以上ある", r.evidence.length > 0);
  ok("algorithmVersionがv1", r.algorithmVersion === "v1");
}

// --- (2) HARD_DEADLINE 2件 → SHOULD_DECOMPOSE ---
{
  const c = baseCandidate({
    dateMentions: [
      { rawExpression: "来週", meaning: "HARD_DEADLINE", timezone: "Asia/Tokyo", confidence: 0.9 },
      { rawExpression: "月末", meaning: "HARD_DEADLINE", timezone: "Asia/Tokyo", confidence: 0.9 },
    ],
  });
  const r = assessAtomicity(c);
  ok("HARD_DEADLINE2件でSHOULD_DECOMPOSE", r.assessment === "SHOULD_DECOMPOSE", r.assessment);
  ok("reasonCodeがMULTIPLE_INDEPENDENT_CONSTRAINTS", r.reasonCode === "MULTIPLE_INDEPENDENT_CONSTRAINTS");
}

// --- (3) HARD_DEADLINE 1件だけなら分解しない ---
{
  const c = baseCandidate({
    dateMentions: [{ rawExpression: "来週", meaning: "HARD_DEADLINE", timezone: "Asia/Tokyo", confidence: 0.9 }],
  });
  const r = assessAtomicity(c);
  ok("HARD_DEADLINE1件だけならSHOULD_DECOMPOSEにならない", r.assessment !== "SHOULD_DECOMPOSE", r.assessment);
}

// --- (4) blockedByCandidateIds 2件 → SHOULD_DECOMPOSE ---
{
  const c = baseCandidate({ blockedByCandidateIds: ["x1", "x2"] });
  const r = assessAtomicity(c);
  ok("依存2件でSHOULD_DECOMPOSE", r.assessment === "SHOULD_DECOMPOSE", r.assessment);
}

// --- (5) unknowns 2件 → NEEDS_CLARIFICATION ---
{
  const c = baseCandidate({ unknowns: ["点1", "点2"] });
  const r = assessAtomicity(c);
  ok("unknowns2件でNEEDS_CLARIFICATION", r.assessment === "NEEDS_CLARIFICATION", r.assessment);
}

// --- (6) completionCondition欠落(対象型) → NEEDS_CLARIFICATION ---
{
  const c = baseCandidate({ type: "TASK", completionCondition: undefined });
  const r = assessAtomicity(c);
  ok("TASK+completionCondition欠落でNEEDS_CLARIFICATION", r.assessment === "NEEDS_CLARIFICATION", r.assessment);
}

// --- (7) completionCondition欠落でも対象外型(IDEA)なら発火しない ---
{
  const c = baseCandidate({ type: "IDEA", completionCondition: undefined, title: "考える" });
  const r = assessAtomicity(c);
  ok("IDEA(対象外型)はcompletionCondition欠落だけではNEEDS_CLARIFICATIONにならない", r.assessment !== "NEEDS_CLARIFICATION", r.assessment);
}

// --- (8) CONTEXT_LIKEキーワード + completionCondition/期限とも無し ---
{
  const c = baseCandidate({
    type: "TASK",
    title: "○○製作所Webシステム開発プロジェクト",
    completionCondition: undefined,
    dateMentions: [],
  });
  // ただし type=TASK は completionCondition 欠落で先にNEEDS_CLARIFICATIONへ
  // 分岐するため(優先順位2が優先順位3より先)、CONTEXT_LIKEの検証は
  // completionCondition要否対象外の型(IDEA)で行う。
  const r = assessAtomicity(c);
  ok("TASK型はcompletionCondition欠落が優先されNEEDS_CLARIFICATIONになる(CONTEXT_LIKEより優先順位が高い)", r.assessment === "NEEDS_CLARIFICATION", r.assessment);
}
{
  const c = baseCandidate({
    type: "IDEA",
    title: "○○製作所Webシステム開発プロジェクト",
    completionCondition: undefined,
    dateMentions: [],
    unknowns: [],
  });
  const r = assessAtomicity(c);
  ok("IDEA型+CONTEXT_LIKEキーワード+完了条件/締切無しでCONTEXT_LIKE", r.assessment === "CONTEXT_LIKE", r.assessment);
}

// --- (9) confidence低い・強いsignalも無い → PROBABLY_ATOMIC(既定・保守的) ---
{
  const c = baseCandidate({ confidence: 0.5 });
  const r = assessAtomicity(c);
  ok("confidence低い・強いsignal無しはPROBABLY_ATOMIC(既定)", r.assessment === "PROBABLY_ATOMIC", r.assessment);
}

// --- (10) confidenceは0〜1の範囲 ---
{
  const c = baseCandidate();
  const r = assessAtomicity(c);
  ok("assessment結果のconfidenceは0〜1の範囲", r.confidence >= 0 && r.confidence <= 1, String(r.confidence));
}

console.log(`\n=== 結果: ${passed} passed, ${failed} failed ===`);
if (failed > 0) {
  console.log("失敗一覧:");
  for (const f of failures) console.log(`  - ${f}`);
  process.exit(1);
}
