/**
 * PEM Execution Event Definition Registry(Phase 0G・v2)。
 * 出典: ISMAY_PEMサブシステム_統合正本仕様書_v4_0 5.2節・5.3節、
 *       ISMAY_PEM_v3_3_1整合性修正_用語コード定義書_v1_0 第II部(項目定義)。
 *
 * v1(733959a)からの修正点:
 *  - 独自の状態enumを廃止し、既存 lib/responsibility.ts の COMMON_STATUS を
 *    そのまま参照する(状態体系を1つに統合)。
 *  - Execution Ledgerのスコープを「共通状態型(TASK/EVENT/CONCERN/HABIT/IDEA)のみ」に
 *    明示的に限定した(COMMITMENT/DECISION/WAITING/RISK等の種別固有状態遷移は
 *    Execution Ledgerの対象外。これらは開始/進行中/完了という実行セッション概念を
 *    持たないため。先送りではなく確定した設計判断)。
 *  - RESPONSIBILITY_ABANDON は既存の MARK_NOT_NEEDED と同じ終端状態 NOT_NEEDED へ
 *    遷移する(架空のABANDONED状態を作らない)。
 *  - Registryを配列からRecord<ExecutionEventType, Definition> satisfies化し、
 *    イベント種別を追加した際に定義漏れがあればコンパイルエラーになるようにした。
 *  - allowedLedger/requiresConsent/metadataSchemaKey/piiClassification/
 *    retentionClass/introducedVersion/labelJa/labelEn/definition/allowedSourcesを追加。
 *  - 検証関数を1つ(assertExecutionLedgerWriteAllowed)へ統合し、呼び忘れを防止。
 */
import { isCommonStatusType } from "@/lib/responsibility";
import {
  EXCLUDED_FROM_EXECUTION_LEDGER,
  EXECUTION_EVENT_TYPES,
  type ActorType,
  type EventSource,
  type EvidenceClass,
  type EvidenceDeletionMode,
  type EvidenceStorageTarget,
  type ExecutionEventType,
  type PemConsentType,
  type PiiClassification,
} from "./coreTypes";

/**
 * Execution Ledgerが扱うResponsibility状態は、既存
 * lib/responsibility.ts の COMMON_STATUS(INBOX/PLANNED/IN_PROGRESS/DEFERRED/
 * COMPLETED/NOT_NEEDED/CANCELLED)をそのまま用いる。新規enumは作らない。
 * CANCELLEDは現行コードのどの遷移からも到達しない未使用値だが、将来のために
 * 状態集合には残す(Execution Event Definitionの許可from/toには含めない)。
 */
export const EXECUTION_LEDGER_STATES = [
  "INBOX",
  "PLANNED",
  "IN_PROGRESS",
  "DEFERRED",
  "COMPLETED",
  "NOT_NEEDED",
] as const;
export type ExecutionLedgerState = (typeof EXECUTION_LEDGER_STATES)[number];

/**
 * Execution Ledgerの対象Responsibility型(Phase 0G-Aの決定事項)。
 * 種別固有状態型(COMMITMENT/DECISION/WAITING/RISK)はここに含まれない
 * (v4.0のExecution Ledgerは「実行中/中断/再開」という開始-進行-完了型の
 *  ライフサイクルを前提としており、これらの型には該当する概念が無いため)。
 */
export function isExecutionLedgerApplicableType(type: string): boolean {
  return isCommonStatusType(type);
}

export interface ExecutionEventDefinition {
  eventType: ExecutionEventType;
  labelJa: string;
  labelEn: string;
  definition: string;

  /** Execution Ledger上の全イベントはFACTのみ(v4.0 2.1節)。 */
  evidenceClass: EvidenceClass;
  /** 保存先。Execution Ledger定義である以上、常にEXECUTION_LEDGER。 */
  allowedLedger: EvidenceStorageTarget;

  /** 許可されるfrom状態の集合(既存COMMON_STATUSのサブセット)。 */
  fromStates: readonly ExecutionLedgerState[];
  toState: ExecutionLedgerState;
  isTerminal: boolean;

  allowedActors: readonly ActorType[];
  allowedSources: readonly EventSource[];

  /** 中断・延期・再開・放棄時に理由確認(ReasonPrompt)を提示するか(v4.0 8.2節・8.3節)。 */
  requiresReasonPrompt: boolean;
  /** このイベントの生成に必要なConsent種別。無ければnull。 */
  requiresConsent: PemConsentType | null;

  /** このイベントのmetadataスキーマを参照するキー(Phase 0A以降でJSON Schemaを確定)。 */
  metadataSchemaKey: string;
  piiClassification: PiiClassification;
  /** 既定の削除mode(本人が削除要求した場合の初期値。個別設定で上書き可能)。 */
  defaultDeletionMode: EvidenceDeletionMode;

  introducedVersion: string;
  deprecatedVersion?: string;
  replacementCode?: ExecutionEventType;
}

/**
 * v4.0 5.2節「許可遷移」表の実装。Record satisfies化により、
 * EXECUTION_EVENT_TYPESへ新種別を追加した際、ここへの定義追加を忘れると
 * コンパイルエラーになる(v1の配列方式では検出できなかった不備を修正)。
 */
export const EXECUTION_EVENT_DEFINITIONS = {
  START: {
    eventType: "START",
    labelJa: "開始",
    labelEn: "Start",
    definition: "未着手の責任に着手する。",
    evidenceClass: "FACT",
    allowedLedger: "EXECUTION_LEDGER",
    fromStates: ["INBOX", "PLANNED"],
    toState: "IN_PROGRESS",
    isTerminal: false,
    allowedActors: ["USER"],
    allowedSources: ["WEB", "MOBILE", "API"],
    requiresReasonPrompt: false,
    requiresConsent: "PEM_DATA_COLLECTION",
    metadataSchemaKey: "START_V1",
    piiClassification: "LOW",
    defaultDeletionMode: "EXCLUDED_FROM_USE",
    introducedVersion: "v4.0",
  },
  RESUME: {
    eventType: "RESUME",
    labelJa: "再開",
    labelEn: "Resume",
    definition: "延期・中断していた責任を再開する。",
    evidenceClass: "FACT",
    allowedLedger: "EXECUTION_LEDGER",
    fromStates: ["DEFERRED"],
    toState: "IN_PROGRESS",
    isTerminal: false,
    allowedActors: ["USER"],
    allowedSources: ["WEB", "MOBILE", "API"],
    requiresReasonPrompt: false,
    requiresConsent: "PEM_DATA_COLLECTION",
    metadataSchemaKey: "RESUME_V1",
    piiClassification: "LOW",
    defaultDeletionMode: "EXCLUDED_FROM_USE",
    introducedVersion: "v4.0",
  },
  INTERRUPT: {
    eventType: "INTERRUPT",
    labelJa: "中断",
    labelEn: "Interrupt",
    definition: "作業中の責任を中断する。",
    evidenceClass: "FACT",
    allowedLedger: "EXECUTION_LEDGER",
    fromStates: ["IN_PROGRESS"],
    toState: "DEFERRED",
    isTerminal: false,
    allowedActors: ["USER"],
    allowedSources: ["WEB", "MOBILE", "API"],
    requiresReasonPrompt: true,
    requiresConsent: "PEM_DATA_COLLECTION",
    metadataSchemaKey: "INTERRUPT_V1",
    piiClassification: "LOW",
    defaultDeletionMode: "EXCLUDED_FROM_USE",
    introducedVersion: "v4.0",
  },
  DEFER: {
    eventType: "DEFER",
    labelJa: "延期",
    labelEn: "Defer",
    definition: "着手前または作業中の責任を延期する。",
    evidenceClass: "FACT",
    allowedLedger: "EXECUTION_LEDGER",
    fromStates: ["INBOX", "PLANNED", "IN_PROGRESS"],
    toState: "DEFERRED",
    isTerminal: false,
    allowedActors: ["USER"],
    allowedSources: ["WEB", "MOBILE", "API"],
    requiresReasonPrompt: true,
    requiresConsent: "PEM_DATA_COLLECTION",
    metadataSchemaKey: "DEFER_V1",
    piiClassification: "LOW",
    defaultDeletionMode: "EXCLUDED_FROM_USE",
    introducedVersion: "v4.0",
  },
  SWITCH_OUT: {
    eventType: "SWITCH_OUT",
    labelJa: "切替による中断",
    labelEn: "Switch out",
    definition: "別の責任へ切り替えたことによる中断。",
    evidenceClass: "FACT",
    allowedLedger: "EXECUTION_LEDGER",
    fromStates: ["IN_PROGRESS"],
    toState: "DEFERRED",
    isTerminal: false,
    allowedActors: ["USER"],
    allowedSources: ["WEB", "MOBILE", "API"],
    requiresReasonPrompt: false,
    requiresConsent: "PEM_DATA_COLLECTION",
    metadataSchemaKey: "SWITCH_OUT_V1",
    piiClassification: "LOW",
    defaultDeletionMode: "EXCLUDED_FROM_USE",
    introducedVersion: "v4.0",
  },
  COMPLETE: {
    eventType: "COMPLETE",
    labelJa: "完了",
    labelEn: "Complete",
    definition: "作業中の責任を完了する。",
    evidenceClass: "FACT",
    allowedLedger: "EXECUTION_LEDGER",
    fromStates: ["IN_PROGRESS"],
    toState: "COMPLETED",
    isTerminal: true,
    allowedActors: ["USER"],
    allowedSources: ["WEB", "MOBILE", "API"],
    requiresReasonPrompt: false,
    requiresConsent: "PEM_DATA_COLLECTION",
    metadataSchemaKey: "COMPLETE_V1",
    piiClassification: "LOW",
    defaultDeletionMode: "EXCLUDED_FROM_USE",
    introducedVersion: "v4.0",
  },
  REOPEN: {
    eventType: "REOPEN",
    labelJa: "再開(完了後)",
    labelEn: "Reopen",
    definition: "完了済み、または不要化した責任を再度計画状態へ戻す。",
    evidenceClass: "FACT",
    allowedLedger: "EXECUTION_LEDGER",
    // 既存 COMMON_TRANSITIONS: { from: ["COMPLETED","NOT_NEEDED"], action:"REOPEN", to:"PLANNED" }
    // と一致させる(v1はCOMPLETEDのみで、NOT_NEEDEDからの再開を扱えなかった不備を修正)。
    fromStates: ["COMPLETED", "NOT_NEEDED"],
    toState: "PLANNED",
    isTerminal: false,
    allowedActors: ["USER"],
    allowedSources: ["WEB", "MOBILE", "API"],
    requiresReasonPrompt: true,
    requiresConsent: "PEM_DATA_COLLECTION",
    metadataSchemaKey: "REOPEN_V1",
    piiClassification: "LOW",
    defaultDeletionMode: "EXCLUDED_FROM_USE",
    introducedVersion: "v4.0",
  },
  RESPONSIBILITY_ABANDON: {
    eventType: "RESPONSIBILITY_ABANDON",
    labelJa: "責任の放棄",
    labelEn: "Abandon responsibility",
    definition:
      "本人が履行を断念する。既存の MARK_NOT_NEEDED アクションと同じ終端状態(NOT_NEEDED)へ" +
      "遷移する(v4.0が定義する独立したABANDONED状態は、現行DBに存在しないため導入しない。" +
      "PEM観察上は『放棄』という文脈情報をmetadataへ残すことで区別する)。",
    evidenceClass: "FACT",
    allowedLedger: "EXECUTION_LEDGER",
    fromStates: ["INBOX", "PLANNED", "IN_PROGRESS", "DEFERRED"],
    toState: "NOT_NEEDED",
    isTerminal: true,
    allowedActors: ["USER"],
    allowedSources: ["WEB", "MOBILE", "API"],
    requiresReasonPrompt: true,
    requiresConsent: "PEM_DATA_COLLECTION",
    metadataSchemaKey: "RESPONSIBILITY_ABANDON_V1",
    piiClassification: "LOW",
    defaultDeletionMode: "EXCLUDED_FROM_USE",
    introducedVersion: "v4.0",
  },
  AUTO_PAUSE_CONFIRMED: {
    eventType: "AUTO_PAUSE_CONFIRMED",
    labelJa: "自動一時停止・確認済",
    labelEn: "Auto-pause confirmed",
    definition:
      "無活動検知の提示(Intervention Ledger)に対し、本人が『離れていました』と確認回答した" +
      "結果として初めて記録される事実。提示自体・否定回答はここに含まれない(v4.0 6.3節)。",
    evidenceClass: "FACT",
    allowedLedger: "EXECUTION_LEDGER",
    fromStates: ["IN_PROGRESS"],
    toState: "DEFERRED",
    isTerminal: false,
    allowedActors: ["USER"],
    allowedSources: ["WEB", "MOBILE", "API"],
    requiresReasonPrompt: false,
    requiresConsent: "PEM_DATA_COLLECTION",
    metadataSchemaKey: "AUTO_PAUSE_CONFIRMED_V2",
    piiClassification: "LOW",
    defaultDeletionMode: "EXCLUDED_FROM_USE",
    introducedVersion: "v3.3.1",
  },
} satisfies Record<ExecutionEventType, ExecutionEventDefinition>;

export function getExecutionEventDefinition(eventType: ExecutionEventType): ExecutionEventDefinition {
  return EXECUTION_EVENT_DEFINITIONS[eventType];
}

export interface ExecutionLedgerWriteCandidate {
  eventType: string;
  evidenceClass: EvidenceClass;
  actorType: ActorType;
  source: EventSource;
  fromState: string;
  consentGranted: (consentType: PemConsentType) => boolean;
  /** true の場合のみ responsibilityType のExecution Ledger対象性チェックを行う。 */
  responsibilityType?: string;
}

/**
 * Execution Ledger書き込み経路の唯一の入口。v1で3関数に分散していたチェックを
 * 1つへ統合し、呼び忘れを構造的に防止する(批評6への対応)。
 *
 * 検証項目: eventType存在 / evidenceClass一致 / allowedLedger一致 / actor許可 /
 * source許可 / 対象Responsibility型がExecution Ledger対象か / 状態遷移許可 /
 * 同意取得済みか。
 */
export function assertExecutionLedgerWriteAllowed(
  candidate: ExecutionLedgerWriteCandidate,
): { definition: ExecutionEventDefinition; toState: ExecutionLedgerState } {
  if ((EXCLUDED_FROM_EXECUTION_LEDGER as readonly string[]).includes(candidate.eventType)) {
    throw new Error(
      `eventType=${candidate.eventType} はExecution Ledgerへの保存が明示的に禁止されています` +
        `(v4.0 5.2節。Intervention/Model Feedback/Activity Evidence Ledgerのいずれかへ保存してください)`,
    );
  }
  if (!(EXECUTION_EVENT_TYPES as readonly string[]).includes(candidate.eventType)) {
    throw new Error(`eventType=${candidate.eventType} はExecution Ledgerの定義済み種別ではありません`);
  }
  const definition = getExecutionEventDefinition(candidate.eventType as ExecutionEventType);

  if (definition.evidenceClass !== candidate.evidenceClass) {
    throw new Error(
      `eventType=${candidate.eventType} のevidenceClassは${definition.evidenceClass}である必要があります` +
        `(指定値: ${candidate.evidenceClass})`,
    );
  }
  if (definition.allowedLedger !== "EXECUTION_LEDGER") {
    throw new Error(`eventType=${candidate.eventType} はExecution Ledgerへ保存できません`);
  }
  if (!definition.allowedActors.includes(candidate.actorType)) {
    throw new Error(
      `actorType=${candidate.actorType} はeventType=${candidate.eventType} を生成できません` +
        `(許可actor: ${definition.allowedActors.join(", ")})`,
    );
  }
  if (!definition.allowedSources.includes(candidate.source)) {
    throw new Error(
      `source=${candidate.source} はeventType=${candidate.eventType} の発生源として許可されていません`,
    );
  }
  if (
    candidate.responsibilityType &&
    !isExecutionLedgerApplicableType(candidate.responsibilityType)
  ) {
    throw new Error(
      `responsibilityType=${candidate.responsibilityType} はExecution Ledgerの対象外です` +
        `(Phase 0G-A決定: COMMITMENT/DECISION/WAITING/RISK等の種別固有状態型は対象外)`,
    );
  }
  if (!(definition.fromStates as readonly string[]).includes(candidate.fromState)) {
    throw new Error(
      `eventType=${candidate.eventType} はfromState=${candidate.fromState} から実行できません` +
        `(許可: ${definition.fromStates.join(", ")})`,
    );
  }
  if (definition.requiresConsent && !candidate.consentGranted(definition.requiresConsent)) {
    throw new Error(
      `eventType=${candidate.eventType} には同意(${definition.requiresConsent})が必要です`,
    );
  }

  return { definition, toState: definition.toState };
}
