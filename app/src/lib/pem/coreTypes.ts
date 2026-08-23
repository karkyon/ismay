/**
 * PEMサブシステム Phase 0G: 共通enum・識別子定義。
 * 出典: ISMAY_PEMサブシステム_統合正本仕様書_v4_0 2章・4章・5章・6章・9章・16章。
 *
 * 本ファイルはPhase 0Gの成果物であり、DBスキーマ変更を一切伴わない
 * (v4.0仕様書の実装ゲート原則により、Phase 0D以降のMetric Catalog等が
 *  未確定のため、まずコード上の型・定義registryのみを確定する)。
 * 実際のDB書き込み・状態遷移適用は、本Registryを参照する形でPhase 0A以降に実装する。
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

/** Ledgerの保存先分類(v4.0 3章 論理アーキテクチャ)。 */
export const LEDGER_KINDS = [
  "EXECUTION",
  "ACTIVITY_EVIDENCE",
  "ONBOARDING_SELF_REPORT",
  "CONSENT_CONFIGURATION",
  "MODEL_FEEDBACK",
  "INTERVENTION",
  "EXPERIMENT",
] as const;
export type LedgerKind = (typeof LEDGER_KINDS)[number];

/** Evidence ClassとLedgerの対応(v4.0 2.1節の表をコード化)。 */
export const EVIDENCE_CLASS_TO_LEDGER: Readonly<Record<EvidenceClass, LedgerKind>> = {
  FACT: "EXECUTION",
  SELF_REPORT: "ONBOARDING_SELF_REPORT",
  MEASUREMENT: "ACTIVITY_EVIDENCE",
  INFERENCE: "MODEL_FEEDBACK", // Hypothesis/Observation等はModel Layer由来だが、
  // Feedbackとの接続点としてMODEL_FEEDBACKを暫定割当(Phase 0Dで正式なModel Layer
  // 用Ledger区分を再検討する。INFERENCE自体は「Model Layer」に保存され、単一の
  // Ledger種別には収まらないため、この対応表はEXECUTION/INTERVENTION等、
  // Ledgerが一意に決まる区分のみを機械的ガードに用いる想定。
  INTERVENTION: "INTERVENTION",
  FEEDBACK: "MODEL_FEEDBACK",
  CONFIGURATION: "CONSENT_CONFIGURATION",
};

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
 * Responsibility実行状態(v4.0 5.1節)。
 * 既存 lib/responsibility.ts の COMMON_STATUS(INBOX/PLANNED/IN_PROGRESS/DEFERRED/
 * COMPLETED/NOT_NEEDED/CANCELLED)より狭い、Execution Ledgerが直接扱う範囲。
 * INBOX・NOT_NEEDED・CANCELLEDとの対応関係はPhase 0A(Execution Ledger実装)で
 * 既存状態遷移表(COMMON_TRANSITIONS等)と突合の上、正式に確定する
 * (現時点では未確定事項として残す。v4.0 24.2節の方針と同様、値の選択が
 *  製品方針へ影響するため、根拠なく断定しない)。
 */
export const EXECUTION_RESPONSIBILITY_STATES = [
  "PLANNED",
  "IN_PROGRESS",
  "DEFERRED",
  "COMPLETED",
  "ABANDONED",
] as const;
export type ExecutionResponsibilityState = (typeof EXECUTION_RESPONSIBILITY_STATES)[number];

/** Execution Ledgerイベント種別(v4.0 5.2節)。FACTのみで構成される。 */
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
 * これらは将来Intervention Ledger / Model Feedback Ledger / Activity Evidence Ledger
 * 側の型として別途定義する(Phase 0A以降)。
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

/** PriorityClass(v4.0 13.1節)。数値が小さいほど優先度が高い。 */
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

/** 本人評決(v4.0 12.2節・15章)。仮説評決とレビュー実施状況(reviewStatus)は別軸。 */
export const PEM_USER_VERDICTS = ["UNREVIEWED", "AGREED", "DISAGREED", "PARTIALLY_AGREED"] as const;
export type PemUserVerdict = (typeof PEM_USER_VERDICTS)[number];

/** 週次レビュー項目の実施状況(v4.0 15章)。userVerdictとは独立した軸。 */
export const PEM_REVIEW_STATUSES = ["PENDING", "REVIEWED", "SKIPPED", "STALE"] as const;
export type PemReviewStatus = (typeof PEM_REVIEW_STATUSES)[number];
