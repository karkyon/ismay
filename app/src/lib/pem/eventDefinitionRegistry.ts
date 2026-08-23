/**
 * PEM Execution Event Definition Registry(Phase 0G)。
 * 出典: ISMAY_PEMサブシステム_統合正本仕様書_v4_0 5.2節・5.3節。
 *
 * Execution Ledgerに保存を許可されるイベントはFACTのみであり、
 * AUTO_PAUSE_PROPOSED/AUTO_PAUSE_REJECTED/SESSION_TIMEOUT_CLOSE/heartbeat/AI推定は
 * ここに含まれない(v4.0 5.2節「Execution Ledgerへ保存しない」)。
 *
 * 本Registryは「定義」のみを提供する。実際のDB書き込み・状態遷移適用・
 * 楽観ロック(v4.0 5.4節)・冪等性(5.5節)・SWITCH原子性(5.6節)は、
 * Phase 0A(Execution Event Ledger実装、DBスキーマ追加を伴う)で
 * このRegistryを参照する形で実装する。
 */
import {
  EXCLUDED_FROM_EXECUTION_LEDGER,
  EXECUTION_EVENT_TYPES,
  type ActorType,
  type EvidenceClass,
  type ExecutionEventType,
  type ExecutionResponsibilityState,
} from "./coreTypes";

export interface ExecutionEventDefinition {
  eventType: ExecutionEventType;
  /** Execution Ledger上の全イベントはFACTのみ(v4.0 2.1節)。 */
  evidenceClass: EvidenceClass;
  /** 許可されるfrom状態の集合。COMPLETEのみ複数(IN_PROGRESS/DEFERRED)。 */
  fromStates: readonly ExecutionResponsibilityState[];
  toState: ExecutionResponsibilityState;
  isTerminal: boolean;
  allowedActors: readonly ActorType[];
  /** 中断・延期・再開後・放棄時に理由確認(ReasonPrompt)を提示するか(v4.0 8.2節・8.3節)。 */
  requiresReasonPrompt: boolean;
}

/** v4.0 5.2節「許可遷移」表のコード化。 */
export const EXECUTION_EVENT_DEFINITIONS: readonly ExecutionEventDefinition[] = [
  {
    eventType: "START",
    evidenceClass: "FACT",
    fromStates: ["PLANNED"],
    toState: "IN_PROGRESS",
    isTerminal: false,
    allowedActors: ["USER"],
    requiresReasonPrompt: false,
  },
  {
    eventType: "RESUME",
    evidenceClass: "FACT",
    fromStates: ["DEFERRED"],
    toState: "IN_PROGRESS",
    isTerminal: false,
    allowedActors: ["USER"],
    requiresReasonPrompt: false,
  },
  {
    eventType: "INTERRUPT",
    evidenceClass: "FACT",
    fromStates: ["IN_PROGRESS"],
    toState: "DEFERRED",
    isTerminal: false,
    allowedActors: ["USER"],
    requiresReasonPrompt: true,
  },
  {
    eventType: "DEFER",
    evidenceClass: "FACT",
    fromStates: ["IN_PROGRESS"],
    toState: "DEFERRED",
    isTerminal: false,
    allowedActors: ["USER"],
    requiresReasonPrompt: true,
  },
  {
    eventType: "SWITCH_OUT",
    evidenceClass: "FACT",
    fromStates: ["IN_PROGRESS"],
    toState: "DEFERRED",
    isTerminal: false,
    allowedActors: ["USER"],
    requiresReasonPrompt: false,
  },
  {
    eventType: "COMPLETE",
    evidenceClass: "FACT",
    fromStates: ["IN_PROGRESS", "DEFERRED"],
    toState: "COMPLETED",
    isTerminal: true,
    allowedActors: ["USER"],
    requiresReasonPrompt: false,
  },
  {
    eventType: "REOPEN",
    evidenceClass: "FACT",
    fromStates: ["COMPLETED"],
    toState: "PLANNED",
    isTerminal: false,
    allowedActors: ["USER"],
    requiresReasonPrompt: true,
  },
  {
    eventType: "RESPONSIBILITY_ABANDON",
    evidenceClass: "FACT",
    fromStates: ["PLANNED", "IN_PROGRESS", "DEFERRED"],
    toState: "ABANDONED",
    isTerminal: true,
    allowedActors: ["USER"],
    requiresReasonPrompt: true,
  },
  {
    eventType: "AUTO_PAUSE_CONFIRMED",
    evidenceClass: "FACT",
    fromStates: ["IN_PROGRESS"],
    toState: "DEFERRED",
    // 本人が「離れていました」と確認回答した結果として初めてExecution Ledgerへ
    // 記録される事実(v4.0 6.3節)。提示(AUTO_PAUSE_PROPOSED)・否定回答
    // (AUTO_PAUSE_REJECTED)はここに含まれずIntervention/Model Feedback Ledgerへ。
    isTerminal: false,
    allowedActors: ["USER"],
    requiresReasonPrompt: false,
  },
];

const DEFINITION_BY_TYPE: ReadonlyMap<ExecutionEventType, ExecutionEventDefinition> = new Map(
  EXECUTION_EVENT_DEFINITIONS.map((d) => [d.eventType, d]),
);

export function getExecutionEventDefinition(eventType: ExecutionEventType): ExecutionEventDefinition {
  const def = DEFINITION_BY_TYPE.get(eventType);
  if (!def) {
    throw new Error(`未定義のExecution Event種別です: ${eventType}`);
  }
  return def;
}

/**
 * v4.0 4.1節「SYSTEM、WORKER、AIは明示的に許可されたevent typeのみ生成できる」の
 * 機械的ガード。Execution Ledger書き込み経路の入口で必ず通すことを想定する。
 */
export function assertActorAllowed(eventType: ExecutionEventType, actorType: ActorType): void {
  const def = getExecutionEventDefinition(eventType);
  if (!def.allowedActors.includes(actorType)) {
    throw new Error(
      `actorType=${actorType} はeventType=${eventType} を生成できません(許可actor: ${def.allowedActors.join(", ")})`,
    );
  }
}

/**
 * v4.0 5.2節の許可遷移表に基づき、fromState→eventTypeの遷移が許可されているかを
 * 検証する。不一致の場合はPhase 0Aの実装でVERSION_CONFLICT(409)等へマッピングする。
 */
export function assertTransitionAllowed(
  eventType: ExecutionEventType,
  fromState: ExecutionResponsibilityState,
): ExecutionResponsibilityState {
  const def = getExecutionEventDefinition(eventType);
  if (!def.fromStates.includes(fromState)) {
    throw new Error(
      `eventType=${eventType} はfromState=${fromState} から実行できません(許可: ${def.fromStates.join(", ")})`,
    );
  }
  return def.toState;
}

/**
 * v4.0 2.1節「Execution Ledgerに保存できるのはFACTのみ」・
 * 5.2節「AUTO_PAUSE_PROPOSED、AUTO_PAUSE_REJECTED、SESSION_TIMEOUT_CLOSE、heartbeat、
 * AI推定はExecution Ledgerへ保存しない」の機械的ガード。
 * Execution Ledger書き込み経路の入口で必ずこの関数を通すことを想定する。
 */
export function assertEvidenceClassIsFact(candidateEventType: string): asserts candidateEventType is ExecutionEventType {
  if ((EXCLUDED_FROM_EXECUTION_LEDGER as readonly string[]).includes(candidateEventType)) {
    throw new Error(
      `eventType=${candidateEventType} はExecution Ledgerへの保存が明示的に禁止されています` +
        `(v4.0 5.2節。Intervention/Model Feedback/Activity Evidence Ledgerのいずれかへ保存してください)`,
    );
  }
  if (!(EXECUTION_EVENT_TYPES as readonly string[]).includes(candidateEventType)) {
    throw new Error(`eventType=${candidateEventType} はExecution Ledgerの定義済み種別ではありません`);
  }
}
