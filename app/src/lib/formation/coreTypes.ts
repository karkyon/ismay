/**
 * V5-M1-B1/B5 Formation Session: 共通enum・状態機械・語彙定義。
 *
 * [2026-08-30是正・契約正規化] 出典を`ISMAY-V5-DOC-03`から`ISMAY_統合正本仕様書_v5_0.md`
 * §6(Formation Session)・§11.1(Atomicity Assessment)へ切り替えた。
 *
 * 正本規則(統合正本§0.2): 「統合正本の状態遷移・データ契約 > v5分冊の承認済み仕様 > … >
 * 現行コード」。DOC-03(v5分冊)はこのファイルの旧版の出典だったが、統合正本と食い違う
 * 箇所が複数見つかったため、監査(2026-08-30 M1-B5a指示書)に基づき統合正本を正として
 * 全面是正した。「現行コードに存在することだけではv5仕様への適合を意味しない」
 * (統合正本§0.2)という明記に従い、旧DOC-03語彙をそのまま延命しない。
 *
 * [是正した3項目]
 *   1. FormationSession状態機械(§6.3): 操作語彙を`ANALYZE/ANSWER/ANSWER_ENOUGH/COMMIT`等の
 *      DOC-03語彙から、`START_ANALYSIS/QUESTIONS_READY/ANSWER_SUBMITTED/CONFIRM_ALL`等の
 *      統合正本語彙へ全面置換した。最大の意味変化は「CLARIFYING --ANSWER_SUBMITTED--> ANALYZING」
 *      (回答のたびに一旦ANALYZINGへ戻り、Question Policyを再評価してから次の質問または
 *      REVIEW_READYへ進む)。DOC-03は「CLARIFYING --answer--> CLARIFYING」
 *      (CLARIFYING内で完結)だったが、これは統合正本と矛盾するため置換した。
 *   2. QuestionAnswer種別(§6.4): `ANSWERED/UNKNOWN/DEFERRED/DO_NOT_MATERIALIZE`から
 *      `SELECTED/FREE_TEXT/UNKNOWN/DEFERRED/DO_NOT_MATERIALIZE`へ拡張した
 *      (選択式回答と自由文回答を区別する)。
 *   3. AtomicityAssessment判定値(§11.1): `ATOMIC/NEEDS_SPLIT/NEEDS_CLARIFICATION/
 *      TOO_FINE/NOT_ACTIONABLE`(DOC-03語彙、実際にはこのDOC-03語彙自体が統合正本とは
 *      別物だった)から`ATOMIC/PROBABLY_ATOMIC/NEEDS_CLARIFICATION/SHOULD_DECOMPOSE/
 *      CONTEXT_LIKE`(統合正本§11.1の実際の語彙)へ置換した。
 *
 * [このPatchでは変更しなかったもの・理由] `CandidateDecisionEvent`の語彙
 * (`ACCEPTED/REJECTED/DEFERRED/DO_NOT_MATERIALIZE`)は、統合正本§6.6では
 * `ACCEPT/EDIT/REJECT/MERGE/SPLIT/DEFER`(動詞形、EDIT/MERGE/SPLIT追加)と
 * 定義されているが、このPatchでは意図的に変更していない。理由:
 *   - 現行の`ACCEPTED/REJECTED/DEFERRED/DO_NOT_MATERIALIZE`は`materialize.ts`
 *     (931行)・2本の決定API route・bulk-decisions route・`FormationSessionPanel.tsx`・
 *     8本の既存回帰script(合計164件のassertion、Gate M1-B3〜B4.3で既にPASS実績あり)に
 *     広く実使用されている「生きた」語彙であり、今回是正した3項目(state機械・
 *     answer種別・atomicity)とは異なり、まだ一切使われていない「休眠」語彙ではない。
 *   - `MERGE/SPLIT`はAtomicity Assessment(M1-C、このリポジトリでは未実装)に
 *     依存する概念であり、対応する分解/統合transactionが存在しない状態で
 *     語彙だけ追加しても実体が伴わない。
 *   - 1つのPatchで「新規に安全な語彙変更」と「広範囲・高リスクなrename」を混在させず、
 *     blast radiusを最小化する既存の運用方針(B4→B4.1→B4.2→B4.2b→B4.3の細分と同じ
 *     考え方)に従う。
 * この語彙差分は次のGate(CandidateDecisionEvent正規化、M1-B5a本体着手前に実施予定)で
 * 独立して扱う。想像で先送りしているのではなく、明示的にscope外としている。
 *
 * db.ts を import しないこと(tsxのdb非依存test runnerで検証できるようにするため。
 * 既存 pem/coreTypes.ts・projectContext/coreTypes.ts と同じパターンを踏襲)。
 */

/** FormationSession状態(統合正本§6.2)。DOC-03と同一9値のため変更なし。 */
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
 * FormationSessionの操作(統合正本§6.3「許可遷移」action列)。
 * [2026-08-30是正] DOC-03語彙(ANALYZE/ANSWER/ANSWER_ENOUGH/PARTIAL_DECISIONS/COMMIT等)から
 * 統合正本語彙へ全面置換。
 */
export const FORMATION_SESSION_OPERATIONS = [
  "START_ANALYSIS",
  "QUESTIONS_READY",
  "NO_QUESTIONS_NEEDED",
  "ANALYSIS_FAILED",
  "ANSWER_SUBMITTED",
  "DEFER_SESSION",
  "CONFIRM_ALL",
  "CONFIRM_SOME",
  "DISMISS_ALL",
  "RESOLVE_REMAINING",
  "DEFER_REMAINING",
  "RESUME",
  "RETRY",
] as const;
export type FormationSessionOperation = (typeof FORMATION_SESSION_OPERATIONS)[number];

/**
 * 統合正本§6.3の表をそのまま正本化したもの。
 *
 * [多終端操作について] `RESOLVE_REMAINING`(PARTIALLY_CONFIRMED起点)と`RESUME`
 * (DEFERRED起点)は、統合正本の表自体が「to」列に複数値を「/」区切りで記載しており
 * (例: 「CONFIRMED / DISMISSED」)、(from, operation)の組だけでは遷移先が一意に
 * 決まらない。これは想像で単純化せず、複数行として忠実にテーブル化する
 * (`resolveFormationSessionTransition`は単一解決可能な操作のみを解決し、
 * 多終端操作は`isValidFormationSessionTransitionTriple`で個別に検証する設計)。
 */
export const FORMATION_SESSION_TRANSITIONS: ReadonlyArray<{
  from: FormationSessionState;
  operation: FormationSessionOperation;
  to: FormationSessionState;
  guard: string;
}> = [
  { from: "DRAFT", operation: "START_ANALYSIS", to: "ANALYZING", guard: "Capture存在・scope一致" },
  { from: "ANALYZING", operation: "QUESTIONS_READY", to: "CLARIFYING", guard: "Question Policyが質問を生成" },
  { from: "ANALYZING", operation: "NO_QUESTIONS_NEEDED", to: "REVIEW_READY", guard: "Candidate>=1、質問なし" },
  { from: "ANALYZING", operation: "ANALYSIS_FAILED", to: "FAILED", guard: "error記録済み" },
  { from: "CLARIFYING", operation: "ANSWER_SUBMITTED", to: "ANALYZING", guard: "回答Event追記済み(再評価のためANALYZINGへ戻る)" },
  { from: "CLARIFYING", operation: "DEFER_SESSION", to: "DEFERRED", guard: "理由任意" },
  { from: "REVIEW_READY", operation: "CONFIRM_ALL", to: "CONFIRMED", guard: "accepted>=1、pending=0" },
  { from: "REVIEW_READY", operation: "CONFIRM_SOME", to: "PARTIALLY_CONFIRMED", guard: "acceptedとpending混在" },
  { from: "REVIEW_READY", operation: "DISMISS_ALL", to: "DISMISSED", guard: "候補を責任化しない" },
  { from: "REVIEW_READY", operation: "DEFER_SESSION", to: "DEFERRED", guard: "理由任意" },
  { from: "PARTIALLY_CONFIRMED", operation: "RESOLVE_REMAINING", to: "CONFIRMED", guard: "残りpendingがaccepted側で解決" },
  { from: "PARTIALLY_CONFIRMED", operation: "RESOLVE_REMAINING", to: "DISMISSED", guard: "残りpendingがdismiss側で解決" },
  { from: "PARTIALLY_CONFIRMED", operation: "DEFER_REMAINING", to: "DEFERRED", guard: "理由任意" },
  { from: "DEFERRED", operation: "RESUME", to: "ANALYZING", guard: "defer前がANALYZING相当" },
  { from: "DEFERRED", operation: "RESUME", to: "CLARIFYING", guard: "defer前がCLARIFYING" },
  { from: "DEFERRED", operation: "RESUME", to: "REVIEW_READY", guard: "defer前がREVIEW_READY/PARTIALLY_CONFIRMED" },
  { from: "FAILED", operation: "RETRY", to: "ANALYZING", guard: "新AiRun、同じSession" },
];

/**
 * (from, operation)から遷移先stateを引く純粋関数。該当行が無ければ、または複数行が
 * マッチする(多終端操作)場合はundefinedを返す(=単純解決不能。多終端操作は
 * `isValidFormationSessionTransitionTriple`で呼び出し元が文脈から決めた`to`を
 * 個別に検証すること)。
 */
export function resolveFormationSessionTransition(
  from: string,
  operation: string,
): FormationSessionState | undefined {
  const matches = FORMATION_SESSION_TRANSITIONS.filter((t) => t.from === from && t.operation === operation);
  if (matches.length !== 1) return undefined;
  return matches[0].to;
}

export function isValidFormationSessionTransition(from: string, operation: string): boolean {
  return resolveFormationSessionTransition(from, operation) !== undefined;
}

/**
 * [2026-08-30新設] 多終端操作(RESOLVE_REMAINING/RESUME)向け。(from, operation, to)の
 * 三つ組が表に実在するかどうかだけを判定する(遷移先の決定はcaller側の業務ロジックに
 * 委ね、ここでは「その決定が表と矛盾していないか」だけを機械的に検証する)。
 */
export function isValidFormationSessionTransitionTriple(from: string, operation: string, to: string): boolean {
  return FORMATION_SESSION_TRANSITIONS.some((t) => t.from === from && t.operation === operation && t.to === to);
}

/** Question上限(統合正本§6.4「最大3問/Session」)。 */
export const FORMATION_MAX_QUESTIONS = 3;

export function isValidFormationQuestionOrdinal(ordinal: number): boolean {
  return Number.isInteger(ordinal) && ordinal >= 1 && ordinal <= FORMATION_MAX_QUESTIONS;
}

/**
 * QuestionAnswer種別(統合正本§6.4)。
 * [2026-08-30是正] DOC-03語彙(`ANSWERED`のみで自由文・選択式を区別しなかった)から、
 * 統合正本語彙(`SELECTED`=選択肢回答、`FREE_TEXT`=自由文回答、を区別する5値)へ拡張。
 */
export const FORMATION_ANSWER_KINDS = ["SELECTED", "FREE_TEXT", "UNKNOWN", "DEFERRED", "DO_NOT_MATERIALIZE"] as const;
export type FormationAnswerKind = (typeof FORMATION_ANSWER_KINDS)[number];

export function isValidFormationAnswerKind(value: string): value is FormationAnswerKind {
  return (FORMATION_ANSWER_KINDS as readonly string[]).includes(value);
}

/**
 * CandidateDecision(DOC-02 6章由来、このPatchでは意図的に未変更)。
 * [scope外の明記] 統合正本§6.6は`ACCEPT/EDIT/REJECT/MERGE/SPLIT/DEFER`を定義しているが、
 * このファイル冒頭コメントに記載の理由により、このPatchでは現行語彙を維持する。
 * PENDINGは「未決定」を表す既定Projection値であり、CandidateDecisionEventとしては
 * 記録しない(schema.prisma該当modelコメント参照)。このためEvent用の許容値集合は
 * PENDINGを除いた4値。
 */
export const CANDIDATE_DECISION_STATES = ["PENDING", "ACCEPTED", "REJECTED", "DEFERRED", "DO_NOT_MATERIALIZE"] as const;
export type CandidateDecisionState = (typeof CANDIDATE_DECISION_STATES)[number];

export const CANDIDATE_DECISION_EVENT_VALUES = ["ACCEPTED", "REJECTED", "DEFERRED", "DO_NOT_MATERIALIZE"] as const;
export type CandidateDecisionEventValue = (typeof CANDIDATE_DECISION_EVENT_VALUES)[number];

export function isValidCandidateDecisionEventValue(value: string): value is CandidateDecisionEventValue {
  return (CANDIDATE_DECISION_EVENT_VALUES as readonly string[]).includes(value);
}

/**
 * Atomicity Assessment判定値(統合正本§11.1)。
 * [2026-08-30是正] 旧語彙(`ATOMIC/NEEDS_SPLIT/NEEDS_CLARIFICATION/TOO_FINE/
 * NOT_ACTIONABLE`)はDOC-03由来だが、これ自体が統合正本§11.1とは別物だったため、
 * 統合正本の実際の語彙(`ATOMIC/PROBABLY_ATOMIC/NEEDS_CLARIFICATION/SHOULD_DECOMPOSE/
 * CONTEXT_LIKE`)へ置換した。M1-C(Atomicity Assessment本体)未実装のため、この定数は
 * 現時点ではどこからも参照されていない(coreTypes.ts内の定義とpure testのみ)。
 */
export const ATOMICITY_ASSESSMENTS = [
  "ATOMIC",
  "PROBABLY_ATOMIC",
  "NEEDS_CLARIFICATION",
  "SHOULD_DECOMPOSE",
  "CONTEXT_LIKE",
] as const;
export type AtomicityAssessment = (typeof ATOMICITY_ASSESSMENTS)[number];

export function isValidAtomicityAssessment(value: string): value is AtomicityAssessment {
  return (ATOMICITY_ASSESSMENTS as readonly string[]).includes(value);
}

/**
 * Formation Event Catalog(DOC-02 7.3節、v5追加・16種)。FormationSessionEvent.eventType
 * の許容値集合(schema.prisma側にDB CHECKとしても追加する。SourceAnchorはEvent化しない
 * 独立tableのためSOURCE_ANCHOR_ATTACHEDのみEvent Catalogとして存在する点に注意)。
 * このPatchでは変更なし(統合正本§6.6のEntity一覧とも矛盾しないため)。
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
 * このPatchでは変更なし。
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
