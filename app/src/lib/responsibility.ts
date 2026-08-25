/**
 * Responsibility(責任)の種別・状態定義。
 * 出典: ISMAY_用語_状態_コード定義書_v1.1 2章・3章、
 *       ISMAY_機能別詳細設計書_v1.1 4章(FN-WK-01 状態遷移表)。
 */

export const RESPONSIBILITY_TYPES = [
  "TASK",
  "COMMITMENT",
  "DECISION",
  "WAITING",
  "EVENT",
  "RISK",
  "CONCERN",
  "HABIT",
  "IDEA",
] as const;
export type ResponsibilityType = (typeof RESPONSIBILITY_TYPES)[number];

/** 共通状態(用語・状態・コード定義書v1.1 3章)。TASK/EVENT/CONCERN/HABIT/IDEAが使う。 */
export const COMMON_STATUS = [
  "INBOX",
  "PLANNED",
  "IN_PROGRESS",
  "DEFERRED",
  "COMPLETED",
  "NOT_NEEDED",
  "CANCELLED",
] as const;

/** 種別固有状態(同3章「種別固有」)。COMMITMENT/DECISION/WAITING/RISKが使う。 */
export const TYPE_SPECIFIC_STATUS: Partial<Record<ResponsibilityType, readonly string[]>> = {
  COMMITMENT: ["ACTIVE", "AT_RISK", "FULFILLED", "BROKEN"],
  DECISION: ["OPEN", "EVIDENCE_GATHERING", "DECIDED", "REOPENED"],
  WAITING: ["WAITING", "FOLLOW_UP_DUE", "RESOLVED"],
  RISK: ["OPEN", "MONITORING", "MITIGATED", "OCCURRED", "CLOSED"],
};

const COMMON_STATUS_TYPES: readonly ResponsibilityType[] = ["TASK", "EVENT", "CONCERN", "HABIT", "IDEA"];

export function isCommonStatusType(type: string): boolean {
  return (COMMON_STATUS_TYPES as readonly string[]).includes(type);
}

/**
 * [2026-08-25新設・外部監査P1是正] 指定statusがその責任種別で有効な値かを検証する。
 * 出典: 用語・状態・コード定義書v1.1 3章(COMMON_STATUS/TYPE_SPECIFIC_STATUS)。
 *
 * bulkOperations.ts executeCompleteUndoが、種別固有型(COMMITMENT等、Execution
 * Ledger対象外)についてクライアントから受け取ったsnapshot.statusを検証無しで
 * 直接DBへ書き戻していた問題の是正に使う。「型として定義されている値集合」以外を
 * 許可しない、という既存のTYPE_SPECIFIC_STATUS定義をそのまま検証に転用するだけであり、
 * 新しい値集合を想像で作らない。
 */
export function isValidStatusForType(type: string, status: string): boolean {
  if (isCommonStatusType(type)) {
    return (COMMON_STATUS as readonly string[]).includes(status);
  }
  const allowed = TYPE_SPECIFIC_STATUS[type as ResponsibilityType];
  return allowed ? (allowed as readonly string[]).includes(status) : false;
}

/** 作成時の初期状態。 */
export function initialStatusFor(type: string): string {
  switch (type) {
    case "COMMITMENT":
      return "ACTIVE";
    case "DECISION":
      return "OPEN";
    case "WAITING":
      return "WAITING";
    case "RISK":
      return "OPEN";
    default:
      return "INBOX"; // TASK/EVENT/CONCERN/HABIT/IDEA
  }
}

export type TransitionAction =
  | "START"
  | "COMPLETE"
  | "PARTIAL_COMPLETE"
  | "DEFER"
  | "INTERRUPT"
  | "RESUME"
  | "MARK_NOT_NEEDED"
  | "REOPEN"
  // COMMITMENT専用
  | "MARK_AT_RISK"
  | "MARK_ACTIVE"
  | "FULFILL"
  | "BREAK"
  // DECISION専用
  | "START_GATHERING"
  | "DECIDE"
  // WAITING専用
  | "MARK_FOLLOW_UP_DUE"
  | "RESOLVE"
  // RISK専用
  | "START_MONITORING"
  | "MITIGATE"
  | "OCCUR"
  | "CLOSE";

interface TransitionRule {
  from: readonly string[];
  action: TransitionAction;
  to: string | ((current: string) => string);
}

/**
 * FN-WK-01状態遷移表の実装。共通状態グループ(TASK/EVENT/CONCERN/HABIT/IDEA)専用。
 * API・イベント設計書v1.1 4.3節のaction列挙(START/COMPLETE/PARTIAL_COMPLETE/
 * DEFER/INTERRUPT/RESUME/MARK_NOT_NEEDED)にREOPEN(機能別詳細設計書表内・
 * Webシステム要件定義書v2.1 7.3節「完了後も再開できる」)を加えて実装した。
 * INTERRUPT/RESUMEはDEFER/RESUMEのIN_PROGRESS向け別名として扱う。
 */
export const COMMON_TRANSITIONS: readonly TransitionRule[] = [
  { from: ["INBOX", "PLANNED"], action: "START", to: "IN_PROGRESS" },
  { from: ["IN_PROGRESS"], action: "COMPLETE", to: "COMPLETED" },
  { from: ["IN_PROGRESS"], action: "PARTIAL_COMPLETE", to: (current) => current },
  { from: ["INBOX", "PLANNED", "IN_PROGRESS"], action: "DEFER", to: "DEFERRED" },
  { from: ["IN_PROGRESS"], action: "INTERRUPT", to: "DEFERRED" },
  { from: ["DEFERRED"], action: "RESUME", to: "IN_PROGRESS" },
  { from: ["INBOX", "PLANNED", "IN_PROGRESS", "DEFERRED"], action: "MARK_NOT_NEEDED", to: "NOT_NEEDED" },
  { from: ["COMPLETED", "NOT_NEEDED"], action: "REOPEN", to: "PLANNED" },
];

/**
 * COMMITMENT/DECISION/WAITING/RISKの種別固有状態遷移表。
 * 用語・状態・コード定義書v1.1 3章の状態一覧・Webシステム要件定義書v2.1 7.1節の
 * 完了条件(「成果証拠＋相手への履行」「選択と理由が記録」「回答・条件成立」
 * 「解消・受容・発生」)を踏まえ、遷移規則自体は本パッチで新規に設計した
 * (FN-WK-01は共通状態専用のため、種別固有の遷移表は設計書に明記が無かった。
 * 2026-08-19、カルキョンさんに提案し合意のうえ確定)。
 */
export const COMMITMENT_TRANSITIONS: readonly TransitionRule[] = [
  { from: ["ACTIVE"], action: "MARK_AT_RISK", to: "AT_RISK" },
  { from: ["AT_RISK"], action: "MARK_ACTIVE", to: "ACTIVE" },
  { from: ["ACTIVE", "AT_RISK"], action: "FULFILL", to: "FULFILLED" },
  { from: ["ACTIVE", "AT_RISK"], action: "BREAK", to: "BROKEN" },
  { from: ["FULFILLED", "BROKEN"], action: "REOPEN", to: "ACTIVE" },
];

export const DECISION_TRANSITIONS: readonly TransitionRule[] = [
  { from: ["OPEN", "REOPENED"], action: "START_GATHERING", to: "EVIDENCE_GATHERING" },
  { from: ["OPEN", "EVIDENCE_GATHERING", "REOPENED"], action: "DECIDE", to: "DECIDED" },
  { from: ["DECIDED"], action: "REOPEN", to: "REOPENED" },
];

export const WAITING_TRANSITIONS: readonly TransitionRule[] = [
  { from: ["WAITING"], action: "MARK_FOLLOW_UP_DUE", to: "FOLLOW_UP_DUE" },
  { from: ["WAITING", "FOLLOW_UP_DUE"], action: "RESOLVE", to: "RESOLVED" },
  { from: ["RESOLVED"], action: "REOPEN", to: "WAITING" },
];

export const RISK_TRANSITIONS: readonly TransitionRule[] = [
  { from: ["OPEN"], action: "START_MONITORING", to: "MONITORING" },
  { from: ["OPEN", "MONITORING"], action: "MITIGATE", to: "MITIGATED" },
  { from: ["OPEN", "MONITORING"], action: "OCCUR", to: "OCCURRED" },
  { from: ["OPEN", "MONITORING", "MITIGATED", "OCCURRED"], action: "CLOSE", to: "CLOSED" },
  { from: ["MITIGATED", "OCCURRED", "CLOSED"], action: "REOPEN", to: "OPEN" },
];

/** typeに応じた遷移表を返す。共通状態型はCOMMON_TRANSITIONS、種別固有型は専用表。 */
export function transitionsForType(type: string): readonly TransitionRule[] {
  switch (type) {
    case "COMMITMENT":
      return COMMITMENT_TRANSITIONS;
    case "DECISION":
      return DECISION_TRANSITIONS;
    case "WAITING":
      return WAITING_TRANSITIONS;
    case "RISK":
      return RISK_TRANSITIONS;
    default:
      return COMMON_TRANSITIONS; // TASK/EVENT/CONCERN/HABIT/IDEA
  }
}

/** 到達すると「完了」扱いになる終端状態(completedAt設定・REOPEN対象の判定に使う)。 */
const TYPE_SPECIFIC_TERMINAL_STATUS: Partial<Record<ResponsibilityType, readonly string[]>> = {
  COMMITMENT: ["FULFILLED", "BROKEN"],
  DECISION: ["DECIDED"],
  WAITING: ["RESOLVED"],
  RISK: ["MITIGATED", "OCCURRED", "CLOSED"],
};

export function isTypeSpecificTerminalStatus(type: string, status: string): boolean {
  const terminals = TYPE_SPECIFIC_TERMINAL_STATUS[type as ResponsibilityType];
  return terminals ? (terminals as readonly string[]).includes(status) : false;
}

/** reasonの入力(選択理由)を必須とするアクション。DECISION完了条件「選択と理由が記録」に対応。 */
export const ACTIONS_REQUIRING_REASON: readonly TransitionAction[] = ["DECIDE"];
