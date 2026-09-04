/**
 * Case Pattern Catalog(M4) — 語彙定義(PATTERN-SCHEMA-01)。
 * 出典: DOC-06(ISMAY_v5_Metric_Granularity_CasePatternCatalog) §5「Case Patternデータ
 * 契約」、§7「提案契約」。
 *
 * この語彙のうち CASE_PATTERN_STAGES は既に casePatternMath.ts (M4-PATTERN-FOUNDATION、
 * commit 390c380) で定義済みのため、ここでは再定義しない(想像で重複定義しない)。
 * import して使うこと: `import { CASE_PATTERN_STAGES } from "./casePatternMath"`。
 */

/**
 * CasePatternSourceLink.sourceEventKind の正式語彙(DR-2設計決定・2026-09-03)。
 * 既存コードベースの targetType/targetId 多態パターン(AuditLog.targetType/targetId、
 * PemEvidenceDeletionEvent.targetType/targetId)を再利用した設計。
 *
 * - MATERIALIZATION_RECEIPT_ITEM: Responsibility確定(materialize)後のoccurrence。
 *   MaterializationReceiptItem.idを指す(workspaceId+candidateIdでglobal一意、
 *   immutable)。この場合responsibilityIdが必須(migration.sqlのCHECK制約で保証)。
 * - FORMATION_CANDIDATE_REVISION: materialize前のFormation Candidate段階での
 *   occurrence。FormationCandidateRevision.idを指す(immutable・一意)。
 *   この場合formationSessionIdが必須(migration.sqlのCHECK制約で保証)。
 */
export const CASE_PATTERN_SOURCE_EVENT_KINDS = ["MATERIALIZATION_RECEIPT_ITEM", "FORMATION_CANDIDATE_REVISION"] as const;
export type CasePatternSourceEventKind = (typeof CASE_PATTERN_SOURCE_EVENT_KINDS)[number];

/**
 * DOC-06 §7「ACCEPT / PARTIAL_ACCEPT / REJECT / LATER / NOT_RELEVANTを記録する」。
 */
export const CASE_PATTERN_FEEDBACK_VERDICTS = ["ACCEPT", "PARTIAL_ACCEPT", "REJECT", "LATER", "NOT_RELEVANT"] as const;
export type CasePatternFeedbackVerdict = (typeof CASE_PATTERN_FEEDBACK_VERDICTS)[number];

export function isValidCasePatternSourceEventKind(value: string): value is CasePatternSourceEventKind {
  return (CASE_PATTERN_SOURCE_EVENT_KINDS as readonly string[]).includes(value);
}

export function isValidCasePatternFeedbackVerdict(value: string): value is CasePatternFeedbackVerdict {
  return (CASE_PATTERN_FEEDBACK_VERDICTS as readonly string[]).includes(value);
}

/**
 * DR-2設計決定: sourceEventKindごとに必須となるprovenance参照列
 * (migration.sqlのCHECK制約と同一の契約をTS側でも表現する。DBが真の防御線、
 * これはapplication層での早期検証・ドキュメントとしての役割)。
 */
export function requiredProvenanceFieldFor(kind: CasePatternSourceEventKind): "responsibilityId" | "formationSessionId" {
  switch (kind) {
    case "MATERIALIZATION_RECEIPT_ITEM":
      return "responsibilityId";
    case "FORMATION_CANDIDATE_REVISION":
      return "formationSessionId";
  }
}

/**
 * CasePatternDetectionReceipt.outcomeの正式語彙(PATTERN-DETECT-02A新設・
 * 2026-09-04)。出典: Claude向け_ISMAY_3b695d9以降_再監査是正・CasePattern
 * 実機能完遂指示_2026-09-04.md §2 P1-4「CasePatternDetectionReceipt」
 * 契約、§3.2 worker処理手順。
 *
 * - MATCHED: 既存Patternのcurrent revisionへexact cosineで一致し、SourceLinkを
 *   冪等作成した。
 * - NEW_PATTERN_CREATED: 一致なし(NO_MATCH)のため、新規CasePattern
 *   identity + revision 1 + embedding + SourceLinkを同一transactionで作成した。
 * - AMBIGUOUS: best/second類似度差がambiguity margin未満のため自動統合せず、
 *   候補をReceiptへ保存するに留めた(本人確認は別Gate)。
 * - SKIPPED: eligibility/provenance/consentのいずれかを満たさないため処理を
 *   見送った(reasonCode必須)。
 * - FAILED: embedding provider失敗・次元検証失敗等(reasonCode必須)。
 */
export const CASE_PATTERN_DETECTION_OUTCOMES = [
  "MATCHED",
  "NEW_PATTERN_CREATED",
  "AMBIGUOUS",
  "SKIPPED",
  "FAILED",
] as const;
export type CasePatternDetectionOutcome = (typeof CASE_PATTERN_DETECTION_OUTCOMES)[number];

/**
 * SKIPPED/FAILED時のreasonCode語彙。秘密情報(APIキー等)を含まない、原因の
 * 大分類のみ(詳細メッセージはdebugServerログのみに出す)。
 */
export const CASE_PATTERN_DETECTION_REASON_CODES = [
  "NOT_ELIGIBLE_NO_PRIMARY_LINK",
  "CONSENT_NOT_GRANTED",
  "EMBEDDING_TRANSIENT_FAILURE",
  "EMBEDDING_FATAL_FAILURE",
  "GENERATION_STALE",
] as const;
export type CasePatternDetectionReasonCode = (typeof CASE_PATTERN_DETECTION_REASON_CODES)[number];

/**
 * CasePatternSuggestionIdentity.stateの正式語彙(PATTERN-SUGGEST-01A新設・
 * 2026-09-04)。出典: Claude向け_ISMAY_3b695d9以降_再監査是正・CasePattern
 * 実機能完遂指示_2026-09-04.md §5。
 *
 * PENDINGはfeedback未記録(初期状態)。それ以外はCASE_PATTERN_FEEDBACK_VERDICTS
 * をそのまま再利用する(想像で別語彙を発明しない)。currentRevisionに対する
 * 最新の有効feedbackのverdictをそのまま複製した投影値であり、この投影の
 * 更新自体はPATTERN-SUGGEST-01C(Feedback command)のscope。
 */
export const CASE_PATTERN_SUGGESTION_STATES = ["PENDING", ...CASE_PATTERN_FEEDBACK_VERDICTS] as const;
export type CasePatternSuggestionState = (typeof CASE_PATTERN_SUGGESTION_STATES)[number];
