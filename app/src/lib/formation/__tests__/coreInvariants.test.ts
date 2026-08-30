/**
 * V5-M1-B1/B5 Formation Session Domain基盤 不変条件テスト。
 * 既存 projectContext/__tests__/coreInvariants.test.ts と同じdb非依存パターン
 * (npx tsx で直接実行、DATABASE_URL不要)。
 *
 * [2026-08-30是正] coreTypes.tsの統合正本§6/§11.1移行に合わせて全面更新。
 */
import {
  FORMATION_SESSION_STATES,
  FORMATION_SESSION_TRANSITIONS,
  resolveFormationSessionTransition,
  isValidFormationSessionTransition,
  isValidFormationSessionTransitionTriple,
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

console.log("V5-M1-B1/B5 Formation Session Domain基盤 不変条件テスト(統合正本§6/§11.1準拠)");

// -------------------------------------------------------------------
// FormationSession状態
// -------------------------------------------------------------------
ok("FormationSession状態は9値ちょうど", FORMATION_SESSION_STATES.length === 9);
ok("DRAFTは有効な状態", isValidFormationSessionState("DRAFT"));
ok("未知の状態は無効", !isValidFormationSessionState("BOGUS"));

// -------------------------------------------------------------------
// 状態機械(統合正本§6.3の表を1行ずつ検証)
// -------------------------------------------------------------------
ok(
  "DRAFT --START_ANALYSIS--> ANALYZING",
  resolveFormationSessionTransition("DRAFT", "START_ANALYSIS") === "ANALYZING",
);
ok(
  "ANALYZING --QUESTIONS_READY--> CLARIFYING",
  resolveFormationSessionTransition("ANALYZING", "QUESTIONS_READY") === "CLARIFYING",
);
ok(
  "ANALYZING --NO_QUESTIONS_NEEDED--> REVIEW_READY",
  resolveFormationSessionTransition("ANALYZING", "NO_QUESTIONS_NEEDED") === "REVIEW_READY",
);
ok(
  "ANALYZING --ANALYSIS_FAILED--> FAILED",
  resolveFormationSessionTransition("ANALYZING", "ANALYSIS_FAILED") === "FAILED",
);
ok(
  "CLARIFYING --ANSWER_SUBMITTED--> ANALYZING(回答のたびに再評価のためANALYZINGへ戻る、統合正本§6.3の核心)",
  resolveFormationSessionTransition("CLARIFYING", "ANSWER_SUBMITTED") === "ANALYZING",
);
ok(
  "CLARIFYING --DEFER_SESSION--> DEFERRED",
  resolveFormationSessionTransition("CLARIFYING", "DEFER_SESSION") === "DEFERRED",
);
ok(
  "REVIEW_READY --CONFIRM_ALL--> CONFIRMED",
  resolveFormationSessionTransition("REVIEW_READY", "CONFIRM_ALL") === "CONFIRMED",
);
ok(
  "REVIEW_READY --CONFIRM_SOME--> PARTIALLY_CONFIRMED",
  resolveFormationSessionTransition("REVIEW_READY", "CONFIRM_SOME") === "PARTIALLY_CONFIRMED",
);
ok(
  "REVIEW_READY --DISMISS_ALL--> DISMISSED",
  resolveFormationSessionTransition("REVIEW_READY", "DISMISS_ALL") === "DISMISSED",
);
ok(
  "REVIEW_READY --DEFER_SESSION--> DEFERRED",
  resolveFormationSessionTransition("REVIEW_READY", "DEFER_SESSION") === "DEFERRED",
);
ok(
  "PARTIALLY_CONFIRMED --DEFER_REMAINING--> DEFERRED",
  resolveFormationSessionTransition("PARTIALLY_CONFIRMED", "DEFER_REMAINING") === "DEFERRED",
);
ok(
  "FAILED --RETRY--> ANALYZING(新AiRun、同じSession)",
  resolveFormationSessionTransition("FAILED", "RETRY") === "ANALYZING",
);

// -------------------------------------------------------------------
// 多終端操作(RESOLVE_REMAINING / RESUME): 単純解決不能・triple検証のみ可能
// -------------------------------------------------------------------
ok(
  "PARTIALLY_CONFIRMED --RESOLVE_REMAINING--> は多終端のためresolveFormationSessionTransitionはundefined",
  resolveFormationSessionTransition("PARTIALLY_CONFIRMED", "RESOLVE_REMAINING") === undefined,
);
ok(
  "(PARTIALLY_CONFIRMED, RESOLVE_REMAINING, CONFIRMED)は表に実在する",
  isValidFormationSessionTransitionTriple("PARTIALLY_CONFIRMED", "RESOLVE_REMAINING", "CONFIRMED"),
);
ok(
  "(PARTIALLY_CONFIRMED, RESOLVE_REMAINING, DISMISSED)は表に実在する",
  isValidFormationSessionTransitionTriple("PARTIALLY_CONFIRMED", "RESOLVE_REMAINING", "DISMISSED"),
);
ok(
  "(PARTIALLY_CONFIRMED, RESOLVE_REMAINING, FAILED)は表に存在しない",
  !isValidFormationSessionTransitionTriple("PARTIALLY_CONFIRMED", "RESOLVE_REMAINING", "FAILED"),
);
ok(
  "DEFERRED --RESUME--> は多終端のためresolveFormationSessionTransitionはundefined",
  resolveFormationSessionTransition("DEFERRED", "RESUME") === undefined,
);
for (const to of ["ANALYZING", "CLARIFYING", "REVIEW_READY"] as const) {
  ok(`(DEFERRED, RESUME, ${to})は表に実在する`, isValidFormationSessionTransitionTriple("DEFERRED", "RESUME", to));
}
ok(
  "(DEFERRED, RESUME, CONFIRMED)は表に存在しない(RESUMEはANALYZING/CLARIFYING/REVIEW_READYのみ)",
  !isValidFormationSessionTransitionTriple("DEFERRED", "RESUME", "CONFIRMED"),
);

// 終端CONFIRMED/DISMISSED/DEFERREDから直接戻さない(統合正本§6.3、終端に出発点行が無い)
for (const terminal of ["CONFIRMED", "DISMISSED", "DEFERRED"] as const) {
  const outgoing = FORMATION_SESSION_TRANSITIONS.filter((t) => t.from === terminal);
  if (terminal === "DEFERRED") {
    // DEFERREDだけはRESUMEで非終端へ戻れる(統合正本§6.3、真の終端はCONFIRMED/DISMISSEDのみ)。
    ok(`${terminal}からの遷移はRESUME(3行)のみ`, outgoing.length === 3, `outgoing=${outgoing.length}`);
  } else {
    ok(`${terminal}からの遷移は定義されていない(真の終端)`, outgoing.length === 0, `outgoing=${outgoing.length}`);
  }
}

ok(
  "不正な(from,operation)の組はundefinedを返す",
  resolveFormationSessionTransition("CONFIRMED", "START_ANALYSIS") === undefined,
);
ok("isValidFormationSessionTransitionは真偽値のみを返す", isValidFormationSessionTransition("DRAFT", "START_ANALYSIS") === true);
ok(
  "isValidFormationSessionTransitionは不正遷移でfalse",
  isValidFormationSessionTransition("CONFIRMED", "DEFER_SESSION") === false,
);
ok(
  "isValidFormationSessionTransitionは多終端操作では解決不能としてfalseを返す(triple版を使うべき、という設計意図の確認)",
  isValidFormationSessionTransition("PARTIALLY_CONFIRMED", "RESOLVE_REMAINING") === false,
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
ok("FORMATION_ANSWER_KINDSは5値ちょうど(統合正本§6.4、SELECTED/FREE_TEXT分離)", FORMATION_ANSWER_KINDS.length === 5);
ok("SELECTEDは有効なanswerKind", isValidFormationAnswerKind("SELECTED"));
ok("FREE_TEXTは有効なanswerKind", isValidFormationAnswerKind("FREE_TEXT"));
ok("旧DOC-03語彙ANSWEREDはもはや無効(統合正本移行の確認)", !isValidFormationAnswerKind("ANSWERED"));
ok("未知のanswerKindは無効", !isValidFormationAnswerKind("MAYBE"));

ok("CANDIDATE_DECISION_STATESは7値(PENDING含む、M1-CでSPLIT/MERGED追加)ちょうど", CANDIDATE_DECISION_STATES.length === 7);
ok(
  "CANDIDATE_DECISION_EVENT_VALUESはPENDINGを含まない6値ちょうど(M1-CでSPLIT/MERGED追加、既存4値のrenameは引き続きscope外)",
  CANDIDATE_DECISION_EVENT_VALUES.length === 6 && !(CANDIDATE_DECISION_EVENT_VALUES as readonly string[]).includes("PENDING"),
);
ok("ACCEPTEDは有効なdecision event値", isValidCandidateDecisionEventValue("ACCEPTED"));
ok("SPLITは有効なdecision event値(M1-C新設)", isValidCandidateDecisionEventValue("SPLIT"));
ok("MERGEDは有効なdecision event値(M1-C新設・値の予約のみ、transaction未実装)", isValidCandidateDecisionEventValue("MERGED"));
ok("PENDINGはdecision event値として無効(既定Projection値でEvent化しない)", !isValidCandidateDecisionEventValue("PENDING"));

// -------------------------------------------------------------------
// Atomicity Assessment(統合正本§11.1)
// -------------------------------------------------------------------
ok("ATOMICITY_ASSESSMENTSは5値ちょうど", ATOMICITY_ASSESSMENTS.length === 5);
ok("ATOMICは有効な判定値", isValidAtomicityAssessment("ATOMIC"));
ok("PROBABLY_ATOMICは有効な判定値(統合正本§11.1)", isValidAtomicityAssessment("PROBABLY_ATOMIC"));
ok("SHOULD_DECOMPOSEは有効な判定値(統合正本§11.1)", isValidAtomicityAssessment("SHOULD_DECOMPOSE"));
ok("CONTEXT_LIKEは有効な判定値(統合正本§11.1)", isValidAtomicityAssessment("CONTEXT_LIKE"));
ok("旧DOC-03語彙NEEDS_SPLITはもはや無効(統合正本移行の確認)", !isValidAtomicityAssessment("NEEDS_SPLIT"));
ok("旧DOC-03語彙TOO_FINEはもはや無効(統合正本移行の確認)", !isValidAtomicityAssessment("TOO_FINE"));
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
