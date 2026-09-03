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

/**
 * [2026-08-26移設・外部監査Gate阻害2是正]
 * 種別ごとの「完了」に相当するaction名。元はbulkOperations.tsのプライベート定数
 * だったが、completeFromStatusesForTypeからも使うため、db非依存の語彙を集約する
 * ここ(responsibility.ts)へ移設した。
 * [2026-08-23バグ修正の経緯] 種別ごとの「完了」に相当するactionは統一されていない
 * (COMMON=COMPLETE、COMMITMENT=FULFILL、WAITING=RESOLVE、RISK=CLOSE)。
 */
const COMPLETE_ACTION_BY_TYPE: Record<string, string> = {
  COMMITMENT: "FULFILL",
  WAITING: "RESOLVE",
  RISK: "CLOSE",
};
export function completeActionFor(type: string): string {
  return COMPLETE_ACTION_BY_TYPE[type] ?? "COMPLETE";
}

/**
 * [2026-08-26新設・外部監査Gate阻害2是正]
 * 種別ごとの「完了操作(completeActionFor)の遷移元として許可されているstatus」の
 * 一覧を返す。COMMON_TRANSITIONS/COMMITMENT_TRANSITIONS等に既に定義されている
 * from配列をそのまま使うだけであり、想像で新しい値集合を作らない。
 *
 * [経緯] executeCompleteUndoの検証は、当初isValidStatusForType(その型に存在する
 * 値かどうかの単純なenum検査)しか行っていなかった。これでは、例えば
 * COMMITMENTのUndoに"status":"BROKEN"を指定すると、BROKEN自体はCOMMITMENTの
 * 有効な状態値であるため通過してしまい、FULFILLの遷移元として正しい
 * ACTIVE/AT_RISK以外の値でも復元できてしまっていた(外部監査で指摘、Gate阻害2)。
 * 是正: 「型として存在する値か」ではなく「その型の完了操作の遷移元として
 * 許可されている値か」を検証する。
 */
export function completeFromStatusesForType(type: string): readonly string[] {
  const completeAction = completeActionFor(type);
  const rule = transitionsForType(type).find((r) => r.action === completeAction);
  return rule?.from ?? [];
}

/**
 * [2026-08-26新設・外部監査再々評価で発見した重大バグの是正]
 * 種別ごとの完了操作(completeActionFor)が到達するstatus。共通状態型は
 * "COMPLETED"だが、COMMITMENT/WAITING/RISKはそれぞれ"FULFILLED"/"RESOLVED"/
 * "CLOSED"であり、"COMPLETED"ではない。
 *
 * [経緯] executeCompleteUndo(bulkOperations.ts)のdecideCompleteUndoAction呼び出しが
 * `currentStatus: t.status`をそのまま渡し、decideCompleteUndoAction側は
 * `currentStatus !== "COMPLETED"`でSKIP_NOT_COMPLETEDを判定していた。このため、
 * COMMITMENT等の種別固有型は完了してもstatusが"COMPLETED"になることが無く、
 * 常にSKIP_NOT_COMPLETEDとなり、Undo自体が一度も実行されない(restored:0のまま
 * 何も起きない)という重大な不具合になっていた(外部監査で指摘、実データでは未検証)。
 * 是正: type別の完了到達statusをここで定義し、それと一致するかどうかで
 * 「現在完了状態か」を判定する(decideCompleteUndoActionのシグネチャ自体も
 * currentStatus: stringからcurrentlyCompleted: booleanへ変更し、type依存の
 * 判断を呼び出し元(bulkOperations.ts)に押し出した。純粋関数自体は型に依存しない
 * まま保つ)。
 *
 * COMMON_TRANSITIONS等に既に定義されている"to"値をそのまま使うだけであり、
 * 想像で新しい値集合を作らない(全ての完了actionの"to"は文字列固定であり、
 * 関数ではないことをソースで確認済み)。
 */
export function completeToStatusForType(type: string): string {
  const completeAction = completeActionFor(type);
  const rule = transitionsForType(type).find((r) => r.action === completeAction);
  if (!rule) return "COMPLETED"; // 完了actionが定義されない型(DECISION)は通常ここへ来ない
  return typeof rule.to === "string" ? rule.to : "COMPLETED";
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

/**
 * [M1-OUTCOME新設・2026-09-03] Lifecycle Outcome Reason(統合正本仕様書v5.0
 * §7.4「NOT_NEEDEDへ、単なる不要化と履行断念を混在させてはならない。状態とは
 * 別にLifecycle Outcome Reasonを記録する」)。
 *
 * 正本が明記する7語彙 + 移行用のUNKNOWN_LEGACY(§27.1「既存NOT_NEEDEDは放棄か
 * 不要かを推測せずUNKNOWN_LEGACY理由とする」)。想像で他の値を追加しない。
 */
export const LIFECYCLE_OUTCOME_REASONS = [
  "NO_LONGER_NEEDED",
  "DUPLICATE",
  "SUPERSEDED",
  "ABANDONED_BY_USER",
  "CANCELLED_EXTERNALLY",
  "SCOPE_REMOVED",
  "CREATED_BY_MISTAKE",
  /** 移行専用。本人が明示的に選択することはない(§27.1参照)。 */
  "UNKNOWN_LEGACY",
] as const;
export type LifecycleOutcomeReason = (typeof LIFECYCLE_OUTCOME_REASONS)[number];

/** 本人が新規にMARK_NOT_NEEDEDする際に選択可能な語彙(UNKNOWN_LEGACYを除く)。 */
export const SELECTABLE_LIFECYCLE_OUTCOME_REASONS: readonly LifecycleOutcomeReason[] =
  LIFECYCLE_OUTCOME_REASONS.filter((r) => r !== "UNKNOWN_LEGACY");

export function isValidLifecycleOutcomeReason(value: string): value is LifecycleOutcomeReason {
  return (LIFECYCLE_OUTCOME_REASONS as readonly string[]).includes(value);
}

/**
 * outcomeReasonCode(選択式Reason Code)を必須とするアクション。§7.4の要求は
 * 「NOT_NEEDEDへの遷移」全般を指すため、MARK_NOT_NEEDEDのみが対象となる
 * (CANCELLEDは現行コードで到達経路が未実装、v5§7.2「CANCELLEDは現行で到達
 * 経路が未実装であるため、v5実装時に終了理由と共に遷移を確定する」との
 * 記載通り、このGateでは対象に含めない=想像で新しい遷移経路を作らない)。
 */
export const ACTIONS_REQUIRING_OUTCOME_REASON: readonly TransitionAction[] = ["MARK_NOT_NEEDED"];
