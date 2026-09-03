/**
 * Case Pattern Catalog(M4) — coreTypes.ts(語彙)不変条件テスト。
 * DB非依存パターン(npx tsx で直接実行、DATABASE_URL不要)。
 * 出典: DOC-06 §5「Case Patternデータ契約」、§7「提案契約」、
 * PATTERN-SCHEMA-01設計決定(DR-2、2026-09-03)。
 */
import {
  CASE_PATTERN_SOURCE_EVENT_KINDS,
  CASE_PATTERN_FEEDBACK_VERDICTS,
  isValidCasePatternSourceEventKind,
  isValidCasePatternFeedbackVerdict,
  requiredProvenanceFieldFor,
} from "../coreTypes";

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

console.log("Case Pattern Catalog(M4) coreTypes 不変条件テスト(DOC-06 §5/§7準拠)");

// -------------------------------------------------------------------
// CASE_PATTERN_SOURCE_EVENT_KINDS
// -------------------------------------------------------------------
ok("CASE_PATTERN_SOURCE_EVENT_KINDSは2値ちょうど", CASE_PATTERN_SOURCE_EVENT_KINDS.length === 2);
ok(
  "MATERIALIZATION_RECEIPT_ITEMが含まれる",
  CASE_PATTERN_SOURCE_EVENT_KINDS.includes("MATERIALIZATION_RECEIPT_ITEM"),
);
ok(
  "FORMATION_CANDIDATE_REVISIONが含まれる",
  CASE_PATTERN_SOURCE_EVENT_KINDS.includes("FORMATION_CANDIDATE_REVISION"),
);
ok("isValidCasePatternSourceEventKindは登録済みkindでtrue", isValidCasePatternSourceEventKind("MATERIALIZATION_RECEIPT_ITEM"));
ok("isValidCasePatternSourceEventKindは未知kindでfalse", !isValidCasePatternSourceEventKind("UNKNOWN_KIND"));
ok("isValidCasePatternSourceEventKindは空文字でfalse", !isValidCasePatternSourceEventKind(""));

// -------------------------------------------------------------------
// CASE_PATTERN_FEEDBACK_VERDICTS(DOC-06 §7)
// -------------------------------------------------------------------
ok("CASE_PATTERN_FEEDBACK_VERDICTSは5値ちょうど", CASE_PATTERN_FEEDBACK_VERDICTS.length === 5);
for (const v of ["ACCEPT", "PARTIAL_ACCEPT", "REJECT", "LATER", "NOT_RELEVANT"] as const) {
  ok(`${v}が含まれる`, CASE_PATTERN_FEEDBACK_VERDICTS.includes(v));
}
ok("isValidCasePatternFeedbackVerdictは登録済みverdictでtrue", isValidCasePatternFeedbackVerdict("ACCEPT"));
ok("isValidCasePatternFeedbackVerdictは未知verdictでfalse", !isValidCasePatternFeedbackVerdict("APPROVE"));
ok(
  "旧語彙PARTIALLY_ACCEPTED(スペルミス想定)は無効",
  !isValidCasePatternFeedbackVerdict("PARTIALLY_ACCEPTED"),
);

// -------------------------------------------------------------------
// requiredProvenanceFieldFor(DR-2: sourceEventKindごとの必須provenance列。
// migration.sqlのCHECK制約と同一の契約であることをここで固定する)
// -------------------------------------------------------------------
ok(
  "MATERIALIZATION_RECEIPT_ITEMはresponsibilityIdが必須",
  requiredProvenanceFieldFor("MATERIALIZATION_RECEIPT_ITEM") === "responsibilityId",
);
ok(
  "FORMATION_CANDIDATE_REVISIONはformationSessionIdが必須",
  requiredProvenanceFieldFor("FORMATION_CANDIDATE_REVISION") === "formationSessionId",
);

console.log(`\n${passed}件成功 / ${failed}件失敗`);
if (failed > 0) {
  console.log("\n失敗した項目:");
  for (const f of failures) console.log(`  - ${f}`);
  process.exit(1);
}
