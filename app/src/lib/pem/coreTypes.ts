/**
 * PEMサブシステム Phase 0G: 共通enum・識別子定義(v2)。
 * 出典: ISMAY_PEMサブシステム_統合正本仕様書_v4_0 2章・4章・5章・6章・9章・16章。
 *
 * v1(733959a)からの修正: EvidenceClass→Ledgerの固定1対1対応を廃止した。
 * INFERENCE(AIの推定)をMODEL_FEEDBACK(本人の確認回答)へ暫定対応させていたのは
 * v4.0 2.1節が最も排除しようとした「推定と本人回答の混在」そのものであり、仕様違反だった。
 * 保存先はEvidence Class単体では決まらず、Event/Entity種別ごとにEvent Definition
 * Registry(eventDefinitionRegistry.ts)側で個別に確定する方式へ変更する。
 */

/** Evidence Class(v4.0 2.1節)。Execution Ledgerへ保存できるのはFACTのみ。 */
export const EVIDENCE_CLASSES = [
  "FACT",
  "SELF_REPORT",
  "MEASUREMENT",
  "INFERENCE",
  "INTERVENTION",
  "FEEDBACK",
  "CONFIGURATION",
] as const;
export type EvidenceClass = (typeof EVIDENCE_CLASSES)[number];

/**
 * 保存先の物理的分類(v4.0 3章の論理アーキテクチャを踏まえた具体化)。
 * Evidence Classとは1対1対応させない(INFERENCEはEntity種別により
 * Observation/Hypothesis/TemporaryState/Predictionのいずれかへ分かれるため)。
 * 各Event/Entity定義側が、この集合から個別に保存先を宣言する。
 */
export const EVIDENCE_STORAGE_TARGETS = [
  "EXECUTION_LEDGER",
  "ACTIVITY_EVIDENCE_LEDGER",
  "SELF_REPORT_LEDGER",
  "MODEL_ENTITY", // Observation/Hypothesis/TemporaryState/Prediction本体(INFERENCE)
  "MODEL_FEEDBACK_LEDGER", // 本人の仮説評決・確認回答(FEEDBACK)
  "INTERVENTION_LEDGER",
  "CONSENT_LEDGER",
  "CONFIGURATION_LEDGER",
  "EXPERIMENT_LEDGER",
] as const;
export type EvidenceStorageTarget = (typeof EVIDENCE_STORAGE_TARGETS)[number];

/** actorType(v4.0 4章)。 */
export const ACTOR_TYPES = ["USER", "SYSTEM", "WORKER", "AI", "SERVICE"] as const;
export type ActorType = (typeof ACTOR_TYPES)[number];

/** Event発生源(v4.0 5.3節 source列)。 */
export const EVENT_SOURCES = ["WEB", "MOBILE", "API", "IMPORT"] as const;
export type EventSource = (typeof EVENT_SOURCES)[number];

/** 発生時刻の信頼性区分(v4.0 6.2節)。 */
export const OCCURRED_AT_QUALITIES = [
  "HIGH",
  "MEDIUM",
  "LOW",
  "UNKNOWN",
  "USER_CONFIRMED",
  "USER_APPROXIMATED",
] as const;
export type OccurredAtQuality = (typeof OCCURRED_AT_QUALITIES)[number];

/** 実作業時間の計測品質(v4.0 9章)。時刻の信頼性(occurredAtQuality)とは独立概念。 */
export const MEASUREMENT_QUALITIES = ["HIGH", "MEDIUM", "LOW", "UNKNOWN"] as const;
export type MeasurementQuality = (typeof MEASUREMENT_QUALITIES)[number];

/** Evidence削除mode(v4.0 16.3節)。 */
export const EVIDENCE_DELETION_MODES = [
  "EXCLUDED_FROM_USE",
  "REDACTED",
  "ANONYMIZED",
  "CRYPTOGRAPHICALLY_ERASED",
  "PHYSICALLY_DELETED",
  "LEGALLY_RETAINED",
] as const;
export type EvidenceDeletionMode = (typeof EVIDENCE_DELETION_MODES)[number];

/**
 * 個人情報区分(v3.3.1整合性修正・用語コード定義書 第II部1章 piiClassificationに対応)。
 * Event Definition Registryの各エントリが持ち、ログ・Export・削除方針の判断材料にする。
 */
export const PII_CLASSIFICATIONS = ["NONE", "LOW", "MEDIUM", "HIGH"] as const;
export type PiiClassification = (typeof PII_CLASSIFICATIONS)[number];

/**
 * Execution Ledgerイベント種別(v4.0 5.2節)。FACTのみで構成される。
 * 注記: 状態(from/to)は独自enumを持たず、既存 lib/responsibility.ts の
 * COMMON_STATUS をそのまま参照する(eventDefinitionRegistry.ts参照)。
 * これはPhase 0G-Aの決定事項: 「新しい状態体系を並行定義しない」。
 */
export const EXECUTION_EVENT_TYPES = [
  "START",
  "RESUME",
  "INTERRUPT",
  "DEFER",
  "SWITCH_OUT",
  "COMPLETE",
  "REOPEN",
  "RESPONSIBILITY_ABANDON",
  "AUTO_PAUSE_CONFIRMED",
] as const;
export type ExecutionEventType = (typeof EXECUTION_EVENT_TYPES)[number];

/**
 * Execution Ledgerへの保存を明示的に禁止するイベント種別(v4.0 5.2節)。
 * 「AUTO_PAUSE_PROPOSED、AUTO_PAUSE_REJECTED、SESSION_TIMEOUT_CLOSE、heartbeat、
 *  AI推定はExecution Ledgerへ保存しない」の一覧化。
 */
export const EXCLUDED_FROM_EXECUTION_LEDGER = [
  "AUTO_PAUSE_PROPOSED",
  "AUTO_PAUSE_REJECTED",
  "SESSION_TIMEOUT_CLOSE",
  "HEARTBEAT",
  "SYSTEM_INFERRED_DEFER", // v4.0 6.3節: 「SYSTEM_INFERRED_DEFERは設けない」ため恒久的に禁止
] as const;

/** PEM Consent種別(v4.0 16.1節)。 */
export const PEM_CONSENT_TYPES = [
  "PEM_DATA_COLLECTION",
  "PEM_AI_PROCESSING",
  "PEM_PLANNING_APPLICATION",
  "PEM_EXPERIMENT",
  "SENSITIVE_SELF_REPORT",
] as const;
export type PemConsentType = (typeof PEM_CONSENT_TYPES)[number];

/** Consent Eventのaction(v4.0 16.1節)。 */
export const PEM_CONSENT_ACTIONS = ["GRANTED", "WITHDRAWN"] as const;
export type PemConsentAction = (typeof PEM_CONSENT_ACTIONS)[number];

/**
 * 同意文言・範囲の版(Phase 0S)。改定時はここを上げ、既存GRANTEDを自動的に有効とみなさない運用にする。
 * db.ts(実Prismaクライアント)に依存しないここへ置くことで、tsx実行テストがdb.ts解決
 * (サンドボックスでは`prisma generate`不可のため失敗する)を経由せずに検証できるようにする。
 */
export const PEM_CONSENT_POLICY_VERSION = "v4.0-2026-08-24";

/** Consent未取得エラー(db非依存)。consent.tsのDB関数はこれをimportしてthrowする。 */
export class PemConsentRequiredError extends Error {
  constructor(public readonly consentType: PemConsentType) {
    super(`PEM: 同意(${consentType})が必要です`);
  }
}


/** PriorityClass(v4.0 13.1節)。配列の並び順が優先度順(先頭ほど高優先)。 */
export const PLANNING_PRIORITY_CLASSES = [
  "CRITICAL_OBLIGATION",
  "OVERDUE",
  "IMMINENT_HARD_DEADLINE",
  "UPCOMING_HARD_DEADLINE",
  "NORMAL",
] as const;
export type PlanningPriorityClass = (typeof PLANNING_PRIORITY_CLASSES)[number];

/** Hypothesis状態(v4.0 12.2節)。 */
export const PEM_HYPOTHESIS_STATUSES = [
  "CANDIDATE",
  "ACTIVE",
  "WEAKENED",
  "INVALIDATED",
  "SUPERSEDED",
  "RETIRED",
] as const;
export type PemHypothesisStatus = (typeof PEM_HYPOTHESIS_STATUSES)[number];

/**
 * 本人評決(v4.0 12.2節・15章)。
 * 重要: 既存Prismaの PemHypothesis.userVerdict は現在
 * CONFIRMED/REJECTED/TEMPORARY/PENDING という別語彙で実装されている(不一致)。
 * この不一致はPhase 0G-Dの「PEM衝突台帳」(PHASE_0G_COMPATIBILITY_LEDGER.md)で
 * 正式に記録し、Phase 0C(Model Layer実装)でDBマイグレーションを伴って解消する。
 * 本Phase 0Gでは新語彙をコード上の正本として先に確定するに留める。
 */
export const PEM_USER_VERDICTS = ["UNREVIEWED", "AGREED", "DISAGREED", "PARTIALLY_AGREED"] as const;
export type PemUserVerdict = (typeof PEM_USER_VERDICTS)[number];

/** 週次レビュー項目の実施状況(v4.0 15章)。userVerdictとは独立した軸。 */
export const PEM_REVIEW_STATUSES = ["PENDING", "REVIEWED", "SKIPPED", "STALE"] as const;
export type PemReviewStatus = (typeof PEM_REVIEW_STATUSES)[number];
