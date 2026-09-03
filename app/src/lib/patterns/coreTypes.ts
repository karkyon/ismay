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
