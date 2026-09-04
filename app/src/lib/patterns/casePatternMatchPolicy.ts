/**
 * Case Pattern Embedding matching — db非依存の純粋な判定方式定義
 * (PATTERN-DETECT-01D新設・2026-09-04)。
 * 出典: Claude向け_ISMAY_0fcea2b以降_再監査是正・PATTERN-DETECT連続実装指示_2026-09-03.md
 * §5 DR-Bの決定「同一Pattern判定はversioned embedding exact cosine」、
 * v1判定契約テーブル。
 *
 * [db.ts を import しないこと] casePatternMath.tsと同じ理由(db非依存pure
 * test runnerパターン)。src/lib/db.tsはモジュール読み込み時点で
 * DATABASE_URL未設定なら即例外を投げるため、この判定ロジック自体がdb.tsに
 * 依存すると、pure test(npx tsx直接実行、DATABASE_URL不要)が実行できなく
 * なってしまう。similarity計算(pgvector経由、DB依存)はcasePatternMatching.ts
 * (このファイルを呼び出す側)の責務とし、このファイルは「計算済みの
 * similarity値をどう分類するか」という決定論的ロジックのみを持つ。
 */

/** DOC-06 §5 DR-Bで確定した判定方式のversion識別子。判定証跡へ保存する。 */
export const CASE_PATTERN_MATCH_POLICY_VERSION = "case-pattern-match-v1";

/**
 * Embedding入力テキストの構築手順自体のversion(CHG-045「model/dimensions/
 * sourceVersionを必須化」の三つ目)。model名・dimensionsが同じでも、この
 * テキスト構築手順(casePatternEmbeddingText.ts)を変更した場合はベクトルの
 * 意味が変わるため、比較対象から除外する必要がある。そのための版番号。
 * casePatternEmbeddingText.tsの構築手順を変更した場合のみ増やす。
 */
export const CASE_PATTERN_EMBEDDING_SOURCE_VERSION = 1;

/** DOC-06 §5 DR-B v1判定契約テーブルの値(推測を隠さないversioned初期運用値)。 */
export const CASE_PATTERN_MATCH_CANDIDATE_THRESHOLD = 0.88;
export const CASE_PATTERN_MATCH_AMBIGUITY_MARGIN = 0.03;

export type CasePatternMatchResult =
  | { kind: "MATCHED"; patternId: string; revisionId: string; similarity: number; policyVersion: string }
  | { kind: "AMBIGUOUS"; candidates: { patternId: string; revisionId: string; similarity: number }[]; policyVersion: string }
  | { kind: "NO_MATCH"; policyVersion: string }
  /** provider失敗時。文字列一致へのsilent fallbackはしない(指示書§6 01D)。 */
  | { kind: "EMBEDDING_FAILED"; errorKind: "TRANSIENT" | "FATAL"; reason: string };

export interface CasePatternMatchCandidate {
  patternId: string;
  revisionId: string;
  similarity: number;
}

/**
 * v1判定契約の分類ロジックそのもの(candidate threshold・ambiguity margin)。
 * similarity計算(pgvector経由、float4丸め誤差あり)とこの分類判定を分離した
 * ことで、0.879999は不一致・0.88は一致(PD-09)のような厳密な境界値を、
 * DB/pgvectorのfloat4丸め誤差の心配なくテストできる(casePatternMath.tsの
 * computeCasePatternConfidence/classifyCasePatternStageの分離と同じ設計思想)。
 * candidatesは類似度降順で渡すこと(呼び出し元のSQL ORDER BYが保証する)。
 */
export function classifyCasePatternMatchCandidates(
  candidates: readonly CasePatternMatchCandidate[],
): Exclude<CasePatternMatchResult, { kind: "EMBEDDING_FAILED" }> {
  if (candidates.length === 0) {
    return { kind: "NO_MATCH", policyVersion: CASE_PATTERN_MATCH_POLICY_VERSION };
  }

  const best = candidates[0]!;
  if (best.similarity < CASE_PATTERN_MATCH_CANDIDATE_THRESHOLD) {
    return { kind: "NO_MATCH", policyVersion: CASE_PATTERN_MATCH_POLICY_VERSION };
  }

  if (candidates.length >= 2) {
    const second = candidates[1]!;
    if (best.similarity - second.similarity < CASE_PATTERN_MATCH_AMBIGUITY_MARGIN) {
      return {
        kind: "AMBIGUOUS",
        candidates: candidates.map((c) => ({ patternId: c.patternId, revisionId: c.revisionId, similarity: c.similarity })),
        policyVersion: CASE_PATTERN_MATCH_POLICY_VERSION,
      };
    }
  }

  return {
    kind: "MATCHED",
    patternId: best.patternId,
    revisionId: best.revisionId,
    similarity: best.similarity,
    policyVersion: CASE_PATTERN_MATCH_POLICY_VERSION,
  };
}
