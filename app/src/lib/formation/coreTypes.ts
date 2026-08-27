/**
 * V5-M1-B1 Formation Session: 共通enum・状態機械・語彙定義。
 * 出典: ISMAY-V5-DOC-03(Formation Session仕様書) 3章(状態機械)・4章(論理データ契約)・
 *       5章(Atomicity Assessment)、ISMAY-V5-DOC-02(用語・状態・EventCode定義書)
 *       6章(Formation・Context・Pattern状態)・7.3節(Formation Event Catalog)。
 *
 * 既存 app/src/lib/projectContext/coreTypes.ts と同じ「as const + type + validator」方式。
 * db.ts を import しないこと(tsxのdb非依存test runnerで検証できるようにするため。
 * 既存 pem/coreTypes.ts・projectContext/coreTypes.ts と同じパターンを踏襲)。
 *
 * このファイルはM1-B1(shadow Session生成のみ)のdomain基盤であり、API/UI/実際の
 * Capture・AI抽出フローへの配線(CHG-010〜012)は含まない。
 */

/** FormationSession状態(DOC-02 6章、DOC-03 3章)。 */
export const FORMATION_SESSION_STATES = [
  "DRAFT",
  "ANALYZING",
  "CLARIFYING",
  "REVIEW_READY",
  "PARTIALLY_CONFIRMED",
  "CONFIRMED",
  "DISMISSED",
  "DEFERRED",
  "FAILED",
] as const;
export type FormationSessionState = (typeof FORMATION_SESSION_STATES)[number];

export function isValidFormationSessionState(value: string): value is FormationSessionState {
  return (FORMATION_SESSION_STATES as readonly string[]).includes(value);
}

/**
 * FormationSessionの操作(DOC-03 3章「操作」列)。
 * (from, operation) の組が一意にtoを決める(下記FORMATION_SESSION_TRANSITIONS参照)。
 */
export const FORMATION_SESSION_OPERATIONS = [
  "ANALYZE",
  "ANALYSIS_SUCCESS_NO_QUESTION",
  "ANALYSIS_SUCCESS_QUESTION",
  "ANALYSIS_FAILURE",
  "ANSWER",
  "ANSWER_ENOUGH",
  "PARTIAL_DECISIONS",
  "COMMIT",
  "DEFER",
  "DISMISS",
  "RETRY",
] as const;
export type FormationSessionOperation = (typeof FORMATION_SESSION_OPERATIONS)[number];

/**
 * DOC-03 3章の状態機械表をそのまま正本化したもの。
 * 「任意非終端からdefer/dismiss可能」は、終端でない各状態
 * (DRAFT/ANALYZING/CLARIFYING/REVIEW_READY/PARTIALLY_CONFIRMED/FAILED)ごとに
 * 明示的な行として展開する(暗黙のワイルドカード規則を作らず、全遷移をテーブル駆動で
 * 検証可能にするため。既存coreTypesの設計方針を踏襲)。
 * 真の終端(以降どの操作でも遷移しない)は CONFIRMED / DISMISSED / DEFERRED の3つ。
 */
const NON_TERMINAL_STATES_FOR_DEFER_DISMISS: readonly FormationSessionState[] = [
  "DRAFT",
  "ANALYZING",
  "CLARIFYING",
  "REVIEW_READY",
  "PARTIALLY_CONFIRMED",
  "FAILED",
];

export const FORMATION_SESSION_TRANSITIONS: ReadonlyArray<{
  from: FormationSessionState;
  operation: FormationSessionOperation;
  to: FormationSessionState;
  guard: string;
}> = [
  { from: "DRAFT", operation: "ANALYZE", to: "ANALYZING", guard: "Capture存在・scope一致" },
  { from: "ANALYZING", operation: "ANALYSIS_SUCCESS_NO_QUESTION", to: "REVIEW_READY", guard: "Candidate>=1" },
  { from: "ANALYZING", operation: "ANALYSIS_SUCCESS_QUESTION", to: "CLARIFYING", guard: "questionCount<=3" },
  { from: "ANALYZING", operation: "ANALYSIS_FAILURE", to: "FAILED", guard: "error記録済み" },
  { from: "CLARIFYING", operation: "ANSWER", to: "CLARIFYING", guard: "未回答あり、上限内" },
  { from: "CLARIFYING", operation: "ANSWER_ENOUGH", to: "REVIEW_READY", guard: "未解決必須項目なし" },
  { from: "REVIEW_READY", operation: "PARTIAL_DECISIONS", to: "PARTIALLY_CONFIRMED", guard: "acceptedとpending混在" },
  { from: "REVIEW_READY", operation: "COMMIT", to: "CONFIRMED", guard: "accepted>=1、atomicity解決" },
  { from: "PARTIALLY_CONFIRMED", operation: "COMMIT", to: "CONFIRMED", guard: "accepted>=1、atomicity解決" },
  { from: "FAILED", operation: "RETRY", to: "ANALYZING", guard: "新AiRun、同じSession" },
  ...NON_TERMINAL_STATES_FOR_DEFER_DISMISS.map((from) => ({
    from,
    operation: "DEFER" as const,
    to: "DEFERRED" as const,
    guard: "理由任意",
  })),
  ...NON_TERMINAL_STATES_FOR_DEFER_DISMISS.map((from) => ({
    from,
    operation: "DISMISS" as const,
    to: "DISMISSED" as const,
    guard: "候補を責任化しない",
  })),
];

/**
 * (from, operation)から遷移先stateを引く純粋関数。該当行が無ければundefined
 * (=不正な遷移)。DOC-03 3章「終端CONFIRMED/DISMISSEDから直接戻さない」は、
 * これらのstateをfromに持つ行が表に存在しないことで自然に保証される。
 */
export function resolveFormationSessionTransition(
  from: string,
  operation: string,
): FormationSessionState | undefined {
  return FORMATION_SESSION_TRANSITIONS.find((t) => t.from === from && t.operation === operation)?.to;
}

export function isValidFormationSessionTransition(from: string, operation: string): boolean {
  return resolveFormationSessionTransition(from, operation) !== undefined;
}

/** Question上限(DOC-03 2章UX契約3「最大3件」、3章Guard「questionCount<=3」)。 */
export const FORMATION_MAX_QUESTIONS = 3;

export function isValidFormationQuestionOrdinal(ordinal: number): boolean {
  return Number.isInteger(ordinal) && ordinal >= 1 && ordinal <= FORMATION_MAX_QUESTIONS;
}

/** QuestionAnswer種別(DOC-02 6章)。自由文の場合はANSWEREDを用いる(既存PEMの
 * ReasonPromptStateEventと同じ「ANSWERED/SKIPPED的分離」設計を踏襲)。 */
export const FORMATION_ANSWER_KINDS = ["ANSWERED", "UNKNOWN", "DEFERRED", "DO_NOT_MATERIALIZE"] as const;
export type FormationAnswerKind = (typeof FORMATION_ANSWER_KINDS)[number];

export function isValidFormationAnswerKind(value: string): value is FormationAnswerKind {
  return (FORMATION_ANSWER_KINDS as readonly string[]).includes(value);
}

/**
 * CandidateDecision(DOC-02 6章)。PENDINGは「未決定」を表す既定Projection値であり、
 * CandidateDecisionEventとしては記録しない(schema.prisma該当modelコメント参照)。
 * このためEvent用の許容値集合はPENDINGを除いた4値。
 */
export const CANDIDATE_DECISION_STATES = ["PENDING", "ACCEPTED", "REJECTED", "DEFERRED", "DO_NOT_MATERIALIZE"] as const;
export type CandidateDecisionState = (typeof CANDIDATE_DECISION_STATES)[number];

export const CANDIDATE_DECISION_EVENT_VALUES = ["ACCEPTED", "REJECTED", "DEFERRED", "DO_NOT_MATERIALIZE"] as const;
export type CandidateDecisionEventValue = (typeof CANDIDATE_DECISION_EVENT_VALUES)[number];

export function isValidCandidateDecisionEventValue(value: string): value is CandidateDecisionEventValue {
  return (CANDIDATE_DECISION_EVENT_VALUES as readonly string[]).includes(value);
}

/** Atomicity Assessment判定値(DOC-03 5章)。 */
export const ATOMICITY_ASSESSMENTS = [
  "ATOMIC",
  "NEEDS_SPLIT",
  "NEEDS_CLARIFICATION",
  "TOO_FINE",
  "NOT_ACTIONABLE",
] as const;
export type AtomicityAssessment = (typeof ATOMICITY_ASSESSMENTS)[number];

export function isValidAtomicityAssessment(value: string): value is AtomicityAssessment {
  return (ATOMICITY_ASSESSMENTS as readonly string[]).includes(value);
}

/**
 * Formation Event Catalog(DOC-02 7.3節、v5追加・16種)。FormationSessionEvent.eventType
 * の許容値集合(schema.prisma側にDB CHECKとしても追加する。SourceAnchorはEvent化しない
 * 独立tableのためSOURCE_ANCHOR_ATTACHEDのみEvent Catalogとして存在する点に注意)。
 */
export const FORMATION_EVENT_TYPES = [
  "FORMATION_CREATED",
  "ANALYSIS_REQUESTED",
  "ANALYSIS_SUCCEEDED",
  "ANALYSIS_FAILED",
  "CANDIDATE_CREATED",
  "CANDIDATE_REVISED",
  "SOURCE_ANCHOR_ATTACHED",
  "QUESTION_ASKED",
  "ANSWER_RECORDED",
  "CANDIDATE_ACCEPTED",
  "CANDIDATE_REJECTED",
  "CANDIDATE_DEFERRED",
  "MATERIALIZATION_COMMITTED",
  "SESSION_CONFIRMED",
  "SESSION_DISMISSED",
  "SESSION_DEFERRED",
] as const;
export type FormationEventType = (typeof FORMATION_EVENT_TYPES)[number];

export function isValidFormationEventType(value: string): value is FormationEventType {
  return (FORMATION_EVENT_TYPES as readonly string[]).includes(value);
}

/**
 * FormationSourceAnchor.sourceKind(M1-LOCの4 Adapter種別、HANDOFF v1 M1
 * 「Text offset、音声timecode、会議speaker、画像page/bbox Adapter」に対応)。
 */
export const FORMATION_SOURCE_ANCHOR_KINDS = [
  "TEXT_OFFSET",
  "AUDIO_TIMECODE",
  "MEETING_SPEAKER",
  "IMAGE_BBOX",
] as const;
export type FormationSourceAnchorKind = (typeof FORMATION_SOURCE_ANCHOR_KINDS)[number];

export function isValidFormationSourceAnchorKind(value: string): value is FormationSourceAnchorKind {
  return (FORMATION_SOURCE_ANCHOR_KINDS as readonly string[]).includes(value);
}

/**
 * TEXT_OFFSET用のtext offset妥当性検証(DOC-10 6章「0<=start<end<=sourceLength」)。
 * DB CHECKでは`sourceLength`(Capture側の値)まで検証できないため、application層の
 * 純粋関数としてここに置く(呼び出し元がCapture.rawTextの長さを渡す)。
 */
export function isValidTextOffsetRange(
  startOffset: number,
  endOffset: number,
  sourceLength: number,
): boolean {
  return (
    Number.isInteger(startOffset) &&
    Number.isInteger(endOffset) &&
    startOffset >= 0 &&
    endOffset > startOffset &&
    endOffset <= sourceLength
  );
}

/** tenant scope入力の共通型(既存projectContext/coreTypes.tsと同じ形)。 */
export interface TenantScopeInput {
  workspaceId: string;
}
