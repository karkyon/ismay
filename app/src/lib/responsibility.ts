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
  | "REOPEN";

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
