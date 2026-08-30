import type { ResponsibilityCandidate } from "@/lib/ai/schema";
import { type AtomicityAssessment } from "@/lib/formation/coreTypes";

/**
 * V5-M1-C Atomicity Assessment(統合正本§3・§11)。
 * 出典: `ISMAY_統合正本仕様書_v5_0.md` §3.2「Atomicityの必須条件」・
 * §3.4「分解が必要な兆候」・§3.6「例」、§11.1〜11.4「Atomicity Assessmentと
 * 分解提案」、§26.1(Gate M1-C受入基準)「Patternなしの決定論rule」。
 *
 * ============================================================================
 * [最重要] このGate(M1-C)の評価はCase Pattern(§12、M4)に依存しない決定論rule
 * ============================================================================
 * 正本§26.1は「Patternなしの決定論rule」を明記している。これは「Case Pattern
 * (統計的類似案件学習、M4で実装予定)が無くても動く」という意味であり、
 * このファイルはCase Pattern/機械学習/統計モデルを一切参照しない、純粋な
 * if分岐によるrule-based実装である。
 *
 * ============================================================================
 * [正直な限定事項] §11.2「評価入力」のうち、現行schemaから機械的に算出できる
 * ものと、判定材料が無いものを明確に区別する(questionPolicy.tsで確立した
 * 「想像で埋めない」方針をそのまま踏襲する)。
 * ============================================================================
 *
 * §11.2の6項目それぞれについて:
 *
 *   1. 「文中の独立動詞・主体・成果・期限の数」
 *      → 独立動詞・成果の数は自然言語構文解析(NLP)を要し、このリポジトリには
 *        形態素解析・係り受け解析の実装が無い(想像で簡易キーワードマッチを
 *        「独立動詞カウント」と偽称しない)。期限の数のみ`dateMentions`から
 *        機械的に数えられるため、これだけを使う。主体の数(actor複数)は
 *        `ResponsibilityCandidateSchema`が単一`actor: string`しか持たず、
 *        複数主体を表現する構造が無いため判定不能。
 *   2. 「Dependency/Waiting/Decision境界」
 *      → `blockedByCandidateIds`(同一抽出バッチ内の依存)の件数は使える。
 *        Waiting/Decision境界(WAITINGへ分離すべき外部回答待ちを作業本体へ
 *        埋め込んでいないか等)は、対象候補と関連候補の意味的な突合が必要で
 *        現行schemaの範囲では機械的に検出できないため判定不能。
 *   3. 「見積幅と過去実行Session分布」→ PEM実行履歴(過去のResponsibility実行
 *      時間分布)が必要。M1-CはFormation Session Domainのみのscopeで、PEM
 *      実行履歴との突合はこのGateでは配線しない(想像で無い履歴を仮定しない)。
 *      判定材料なし。
 *   4. 「PARTIAL_COMPLETE、INTERRUPT、DEFER、REOPEN率」→ 既存Responsibility
 *      状態遷移履歴の統計が必要。Formation Session段階(候補はまだ
 *      Responsibility化されていない)では対応するResponsibilityが存在しない
 *      ため、判定材料なし。
 *   5. 「本人のMERGE/SPLIT/EDIT判断」→ CandidateDecisionEventの実績。
 *      MERGE/SPLIT語彙自体がこのGate(M1-C)で新設される側であり、既存実績が
 *      存在しない循環参照になるため、初期実装では判定材料なし(実績が蓄積
 *      された後の版で再評価対象とする)。
 *   6. 「同じProject Context・Case Patternの過去分解」→ Case Pattern(M4、
 *      未実装)。判定材料なし(このGateの決定論rule原則そのもの)。
 *
 * 結果として、このv1実装は「1(期限の数のみ)」「2(依存件数のみ)」に加え、
 * 既存の`unknowns`(AI自己申告の未解決点)・`completionCondition`欠落
 * (§3.2条件3「完了条件を一つの文で説明できる」の直接対応)・AI抽出`confidence`
 * を組み合わせた、限定的だが誠実な決定論ruleとする。
 *
 * db.ts を import しないこと(questionPolicy.tsと同じ、db非依存pure test
 * runnerパターン)。
 */

export const ATOMICITY_ALGORITHM_VERSION = "v1";

export interface AtomicityEvidenceItem {
  /** 機械的に識別できる短いcode(UI/ログでの表示・集計用)。 */
  code: string;
  /** 人間可読な詳細説明(§11.3「理由、使用Evidence」)。 */
  detail: string;
}

export interface AtomicityAssessmentResult {
  assessment: AtomicityAssessment;
  /** この判定に至った主理由を示す短いcode(既存reasonCode方式を踏襲)。 */
  reasonCode: string;
  /** §11.3「使用Evidence」。判定根拠となった具体的な観測事実の一覧。 */
  evidence: AtomicityEvidenceItem[];
  /** このアルゴリズム自身の判定に対する確信度(0〜1)。候補のAI抽出confidence
   *  とは別物(§11.3「confidence」は両者を区別せず要求しているが、意味の
   *  混同を避けるため、このファイルではアルゴリズム側の確信度として扱う)。 */
  confidence: number;
  algorithmVersion: string;
}

/** §3.2条件3「完了条件を一つの文で説明できる」の対象型。questionPolicy.tsの
 *  COMPLETION_CONDITION_REQUIRED_TYPESと同じ判断根拠のため同じ集合を用いる
 *  (型は module-privateのため再定義。値のドリフトを避けるため両者を変更する
 *  場合は必ず同時に見直すこと)。 */
const COMPLETION_CONDITION_APPLICABLE_TYPES = new Set(["TASK", "COMMITMENT", "WAITING", "EVENT"]);

/**
 * §3.6の例「○○製作所Webシステム開発 → Project Context。WBS本体ではない」に
 * 対応するキーワード群。[設計判断・2026-08-30] 真の構文解析ではなく表層一致の
 * ヒューリスティックであることを明記する。誤検出を避けるため、他の強いsignal
 * (期限複数・依存複数・完了条件欠落等)が無く、かつcompletionCondition/
 * dateMentionsが両方とも空である場合のみ発火させる(弱い根拠だけで
 * CONTEXT_LIKEを乱発しない)。
 */
const CONTEXT_LIKE_TITLE_KEYWORDS = ["プロジェクト", "システム開発", "リニューアル", "導入", "移行", "案件"];

function countHardDeadlines(candidate: ResponsibilityCandidate): number {
  return candidate.dateMentions.filter((d) => d.meaning === "HARD_DEADLINE").length;
}

/**
 * 候補1件のAtomicity Assessmentを算出する(決定論rule、Case Pattern非依存)。
 * 判定優先順位(§3.4「分解が必要な兆候」の強い順から評価):
 *   1. 複数の独立した期限・依存 → SHOULD_DECOMPOSE
 *   2. 曖昧性(unknowns複数・完了条件欠落) → NEEDS_CLARIFICATION
 *   3. 大規模案件を示唆するtitleキーワード(他に強いsignal無し) → CONTEXT_LIKE
 *   4. AI抽出confidenceが高く他signal無し → ATOMIC
 *   5. それ以外(弱いsignalも無いが確信も持てない、既定・保守的) → PROBABLY_ATOMIC
 */
export function assessAtomicity(candidate: ResponsibilityCandidate): AtomicityAssessmentResult {
  const evidence: AtomicityEvidenceItem[] = [];
  const hardDeadlineCount = countHardDeadlines(candidate);
  const dependencyCount = candidate.blockedByCandidateIds.length;

  // --- 1. 複数の独立した期限・依存(§3.4「期限、主体、完了条件が複数ある」) ---
  if (hardDeadlineCount >= 2) {
    evidence.push({ code: "MULTIPLE_HARD_DEADLINES", detail: `独立した締切が${hardDeadlineCount}件検出されました` });
  }
  if (dependencyCount >= 2) {
    evidence.push({ code: "MULTIPLE_DEPENDENCIES", detail: `前提となる依存候補が${dependencyCount}件あります` });
  }
  if (hardDeadlineCount >= 2 || dependencyCount >= 2) {
    return {
      assessment: "SHOULD_DECOMPOSE",
      reasonCode: "MULTIPLE_INDEPENDENT_CONSTRAINTS",
      evidence,
      confidence: 0.6,
      algorithmVersion: ATOMICITY_ALGORITHM_VERSION,
    };
  }

  // --- 2. 曖昧性(§3.2条件3「完了条件を一つの文で説明できる」・AI自己申告の未解決点) ---
  if (candidate.unknowns.length >= 2) {
    evidence.push({ code: "MULTIPLE_UNKNOWNS", detail: `AIが自信を持てなかった点が${candidate.unknowns.length}件あります` });
  }
  const completionApplicable = COMPLETION_CONDITION_APPLICABLE_TYPES.has(candidate.type);
  if (completionApplicable && !candidate.completionCondition) {
    evidence.push({ code: "COMPLETION_CONDITION_MISSING", detail: "完了条件を一文で説明できていません" });
  }
  if (evidence.length > 0) {
    return {
      assessment: "NEEDS_CLARIFICATION",
      reasonCode: "AMBIGUOUS_BOUNDARY",
      evidence,
      confidence: 0.55,
      algorithmVersion: ATOMICITY_ALGORITHM_VERSION,
    };
  }

  // --- 3. 大規模案件らしきtitle(他に強いsignal無い場合のみ、誤検出抑制) ---
  const hasContextKeyword = CONTEXT_LIKE_TITLE_KEYWORDS.some((k) => candidate.title.includes(k));
  if (hasContextKeyword && !candidate.completionCondition && hardDeadlineCount === 0) {
    evidence.push({
      code: "CONTEXT_LIKE_TITLE_KEYWORD",
      detail: "titleが大規模案件を示唆するキーワードを含み、完了条件・締切とも未確定です",
    });
    return {
      assessment: "CONTEXT_LIKE",
      reasonCode: "LOOKS_LIKE_PROJECT_CONTEXT",
      evidence,
      confidence: 0.5,
      algorithmVersion: ATOMICITY_ALGORITHM_VERSION,
    };
  }

  // --- 4. 強いnegative signalが無く、AI抽出confidenceも高い ---
  if (candidate.confidence >= 0.85) {
    evidence.push({ code: "HIGH_EXTRACTION_CONFIDENCE", detail: "分解を示唆する兆候が無く、AI抽出confidenceも高い値でした" });
    return {
      assessment: "ATOMIC",
      reasonCode: "NO_DECOMPOSITION_SIGNAL",
      evidence,
      confidence: 0.5,
      algorithmVersion: ATOMICITY_ALGORITHM_VERSION,
    };
  }

  // --- 5. 既定(保守的): 強い分解signalは無いが、確信も持てない ---
  evidence.push({ code: "NO_STRONG_SIGNAL", detail: "分解が必要と判定する明確な兆候はありませんが、機械的な確信度も高くありません" });
  return {
    assessment: "PROBABLY_ATOMIC",
    reasonCode: "DEFAULT_CONSERVATIVE",
    evidence,
    confidence: 0.4,
    algorithmVersion: ATOMICITY_ALGORITHM_VERSION,
  };
}
