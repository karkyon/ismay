/**
 * V5-M1-B1 Formation Session Domain基盤 不変条件テスト。
 * 既存 projectContext/__tests__/coreInvariants.test.ts と同じdb非依存パターン
 * (npx tsx で直接実行、DATABASE_URL不要)。
 */
import {
  FORMATION_SESSION_STATES,
  FORMATION_SESSION_TRANSITIONS,
  resolveFormationSessionTransition,
  isValidFormationSessionTransition,
  isValidFormationSessionState,
  FORMATION_MAX_QUESTIONS,
  isValidFormationQuestionOrdinal,
  FORMATION_ANSWER_KINDS,
  isValidFormationAnswerKind,
  CANDIDATE_DECISION_STATES,
  CANDIDATE_DECISION_EVENT_VALUES,
  isValidCandidateDecisionEventValue,
  ATOMICITY_ASSESSMENTS,
  isValidAtomicityAssessment,
  FORMATION_EVENT_TYPES,
  isValidFormationEventType,
  FORMATION_SOURCE_ANCHOR_KINDS,
  isValidFormationSourceAnchorKind,
  isValidTextOffsetRange,
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

console.log("V5-M1-B1 Formation Session Domain基盤 不変条件テスト");

// -------------------------------------------------------------------
// FormationSession状態
// -------------------------------------------------------------------
ok("FormationSession状態は9値ちょうど", FORMATION_SESSION_STATES.length === 9);
ok("DRAFTは有効な状態", isValidFormationSessionState("DRAFT"));
ok("未知の状態は無効", !isValidFormationSessionState("BOGUS"));

// -------------------------------------------------------------------
// 状態機械(DOC-03 3章の表を1行ずつ検証)
// -------------------------------------------------------------------
ok(
  "DRAFT --analyze--> ANALYZING",
  resolveFormationSessionTransition("DRAFT", "ANALYZE") === "ANALYZING",
);
ok(
  "ANALYZING --success/no question--> REVIEW_READY",
  resolveFormationSessionTransition("ANALYZING", "ANALYSIS_SUCCESS_NO_QUESTION") === "REVIEW_READY",
);
ok(
  "ANALYZING --success/question--> CLARIFYING",
  resolveFormationSessionTransition("ANALYZING", "ANALYSIS_SUCCESS_QUESTION") === "CLARIFYING",
);
ok(
  "ANALYZING --failure--> FAILED",
  resolveFormationSessionTransition("ANALYZING", "ANALYSIS_FAILURE") === "FAILED",
);
ok(
  "CLARIFYING --answer--> CLARIFYING(未回答あり、上限内)",
  resolveFormationSessionTransition("CLARIFYING", "ANSWER") === "CLARIFYING",
);
ok(
  "CLARIFYING --enough--> REVIEW_READY",
  resolveFormationSessionTransition("CLARIFYING", "ANSWER_ENOUGH") === "REVIEW_READY",
);
ok(
  "REVIEW_READY --partial decisions--> PARTIALLY_CONFIRMED",
  resolveFormationSessionTransition("REVIEW_READY", "PARTIAL_DECISIONS") === "PARTIALLY_CONFIRMED",
);
ok(
  "REVIEW_READY --commit--> CONFIRMED",
  resolveFormationSessionTransition("REVIEW_READY", "COMMIT") === "CONFIRMED",
);
ok(
  "PARTIALLY_CONFIRMED --commit--> CONFIRMED",
  resolveFormationSessionTransition("PARTIALLY_CONFIRMED", "COMMIT") === "CONFIRMED",
);
ok(
  "FAILED --retry--> ANALYZING(新AiRun、同じSession)",
  resolveFormationSessionTransition("FAILED", "RETRY") === "ANALYZING",
);

// 任意非終端からdefer/dismissできる(6状態 × 2操作)
for (const from of ["DRAFT", "ANALYZING", "CLARIFYING", "REVIEW_READY", "PARTIALLY_CONFIRMED", "FAILED"] as const) {
  ok(`${from} --defer--> DEFERRED`, resolveFormationSessionTransition(from, "DEFER") === "DEFERRED");
  ok(`${from} --dismiss--> DISMISSED`, resolveFormationSessionTransition(from, "DISMISS") === "DISMISSED");
}

// 終端CONFIRMED/DISMISSED/DEFERREDから直接戻せない(DOC-03 3章「終端から直接戻さない」)
for (const terminal of ["CONFIRMED", "DISMISSED", "DEFERRED"] as const) {
  const outgoing = FORMATION_SESSION_TRANSITIONS.filter((t) => t.from === terminal);
  ok(`${terminal}からの遷移は定義されていない(終端)`, outgoing.length === 0, `outgoing=${outgoing.length}`);
}

ok(
  "不正な(from,operation)の組はundefinedを返す",
  resolveFormationSessionTransition("CONFIRMED", "ANALYZE") === undefined,
);
ok("isValidFormationSessionTransitionは真偽値のみを返す", isValidFormationSessionTransition("DRAFT", "ANALYZE") === true);
ok(
  "isValidFormationSessionTransitionは不正遷移でfalse",
  isValidFormationSessionTransition("CONFIRMED", "DEFER") === false,
);

ok(
  "全遷移行のfrom/toはFORMATION_SESSION_STATESに含まれる",
  FORMATION_SESSION_TRANSITIONS.every(
    (t) =>
      (FORMATION_SESSION_STATES as readonly string[]).includes(t.from) &&
      (FORMATION_SESSION_STATES as readonly string[]).includes(t.to),
  ),
);

// -------------------------------------------------------------------
// Question上限・ordinal
// -------------------------------------------------------------------
ok("FORMATION_MAX_QUESTIONSは3", FORMATION_MAX_QUESTIONS === 3);
ok("ordinal=1は有効", isValidFormationQuestionOrdinal(1));
ok("ordinal=3は有効", isValidFormationQuestionOrdinal(3));
ok("ordinal=4は無効(EV-F-002「4問目拒否」相当)", !isValidFormationQuestionOrdinal(4));
ok("ordinal=0は無効", !isValidFormationQuestionOrdinal(0));
ok("ordinal=1.5(非整数)は無効", !isValidFormationQuestionOrdinal(1.5));

// -------------------------------------------------------------------
// QuestionAnswer / CandidateDecision
// -------------------------------------------------------------------
ok("FORMATION_ANSWER_KINDSは4値ちょうど", FORMATION_ANSWER_KINDS.length === 4);
ok("ANSWEREDは有効なanswerKind", isValidFormationAnswerKind("ANSWERED"));
ok("未知のanswerKindは無効", !isValidFormationAnswerKind("MAYBE"));

ok("CANDIDATE_DECISION_STATESは5値(PENDING含む)ちょうど", CANDIDATE_DECISION_STATES.length === 5);
ok(
  "CANDIDATE_DECISION_EVENT_VALUESはPENDINGを含まない4値ちょうど",
  CANDIDATE_DECISION_EVENT_VALUES.length === 4 && !(CANDIDATE_DECISION_EVENT_VALUES as readonly string[]).includes("PENDING"),
);
ok("ACCEPTEDは有効なdecision event値", isValidCandidateDecisionEventValue("ACCEPTED"));
ok("PENDINGはdecision event値として無効(既定Projection値でEvent化しない)", !isValidCandidateDecisionEventValue("PENDING"));

// -------------------------------------------------------------------
// Atomicity Assessment
// -------------------------------------------------------------------
ok("ATOMICITY_ASSESSMENTSは5値ちょうど", ATOMICITY_ASSESSMENTS.length === 5);
ok("ATOMICは有効な判定値", isValidAtomicityAssessment("ATOMIC"));
ok("NEEDS_SPLITは有効な判定値", isValidAtomicityAssessment("NEEDS_SPLIT"));
ok("未知の判定値は無効", !isValidAtomicityAssessment("MAYBE_SPLIT"));

// -------------------------------------------------------------------
// Formation Event Catalog
// -------------------------------------------------------------------
ok("FORMATION_EVENT_TYPESは16値ちょうど(DOC-02 7.3節)", FORMATION_EVENT_TYPES.length === 16);
ok("FORMATION_CREATEDは有効なEvent種別", isValidFormationEventType("FORMATION_CREATED"));
ok("MATERIALIZATION_COMMITTEDは有効なEvent種別", isValidFormationEventType("MATERIALIZATION_COMMITTED"));
ok("未知のEvent種別は無効", !isValidFormationEventType("CANDIDATE_DELETED"));
ok(
  "FORMATION_EVENT_TYPESに重複がない",
  new Set(FORMATION_EVENT_TYPES).size === FORMATION_EVENT_TYPES.length,
);

// -------------------------------------------------------------------
// Source Anchor
// -------------------------------------------------------------------
ok("FORMATION_SOURCE_ANCHOR_KINDSは4値ちょうど", FORMATION_SOURCE_ANCHOR_KINDS.length === 4);
ok("TEXT_OFFSETは有効なsourceKind", isValidFormationSourceAnchorKind("TEXT_OFFSET"));
ok("未知のsourceKindは無効", !isValidFormationSourceAnchorKind("PDF_PAGE"));

ok("text offset: 0<=start<end<=sourceLengthを満たせば有効", isValidTextOffsetRange(0, 10, 20));
ok("text offset: start===endは無効(空区間)", !isValidTextOffsetRange(5, 5, 20));
ok("text offset: end>sourceLengthは無効", !isValidTextOffsetRange(0, 25, 20));
ok("text offset: start<0は無効", !isValidTextOffsetRange(-1, 10, 20));
ok("text offset: 非整数は無効", !isValidTextOffsetRange(0.5, 10, 20));

console.log(`\n${passed}件成功 / ${failed}件失敗`);
if (failed > 0) {
  console.log("\n失敗した項目:");
  for (const f of failures) console.log(`  - ${f}`);
  process.exit(1);
}
