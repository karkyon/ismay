/**
 * Case Pattern Catalog(M4) — 可変Window・確度計算(純粋関数)。
 * 出典: DOC-06(ISMAY_v5_Metric_Granularity_CasePatternCatalog) §6「可変Window・確度」、
 * §10「受入条件」の「上記数式のgolden datasetが小数誤差1e-6以内」。
 *
 * [scope宣言・2026-09-03] Case Pattern Catalog(M4)は正本上、CasePattern等6 tableの
 * データ契約(DOC-06 §5)、Pattern検出Worker(CHG-043)、提案API(§7)、embedding
 * 突合(§8)からなる大きなsubsystemであり、Formation Session(M1-B系)が
 * M1-B1〜M1-B6C-6の多数Gateへ分割して段階実装されたのと同じく、単一の
 * patchで一括実装すると「想像で埋める」判断が多数発生するリスクが高い
 * (特に §5の永続化スキーマは、DB設計・API設計・trigger条件の判断を要し、
 * このGateだけでは決定できない)。
 *
 * このGateはDOC-06 §6の数式部分—observedIntervalDaysからconfidenceを導出する
 * 決定論計算—のみを対象とする。この部分は入力(occurrence列)さえあれば
 * DB非依存の純粋関数として完全に定義できる、正本に曖昧さの無い数少ない箇所
 * (§10受入条件が「golden datasetが小数誤差1e-6以内」という具体的な数値検証
 * 基準まで明記している)。Pattern検出Worker・永続化・提案APIは、それぞれ
 * 独立した判断(triggerタイミング、embedding model選定、Formation Candidate
 * 接続方式等)を要するため、このGateのscope外とし、想像で先行実装しない。
 *
 * db.ts を import しないこと(questionPolicy.ts/atomicityAssessment.tsと同じ、
 * db非依存pure test runnerパターン)。
 */

const MS_PER_DAY = 24 * 60 * 60 * 1000;
/** DOC-06 §6「windowCycles = 12」。 */
export const CASE_PATTERN_WINDOW_CYCLES = 12;
/** DOC-06 §6「2 instance未満はNULLで全履歴を候補表示にだけ用い、confidence上限0.25」。 */
export const CASE_PATTERN_NULL_INTERVAL_CONFIDENCE_CAP = 0.25;

export interface CasePatternOccurrence {
  /** DOC-06 §5 CasePatternSourceLink.sourceOccurredAt相当。 */
  occurredAt: Date;
  /** DOC-06 §3「品質」。metricDefinitionRegistry等のqualityWeight(HIGH=1.0/MEDIUM=0.75/LOW=0.4/UNKNOWN=0)と
   * 同じ値域([0,1])を想定するが、この関数はDB上のQuality列挙とは非依存の数値入力として扱う。 */
  qualityWeight: number;
  /** DOC-06 §3「Case Patternの独立単位はProject Context instance。同一instance由来の複数
   * Responsibilityは合計重み上限1.0へ正規化する」。呼び出し元がこの正規化を済ませた後の
   * 重みをここへ渡す(この関数自体は正規化を行わない、想像で正規化アルゴリズムを発明しない)。 */
  independenceWeight: number;
}

/**
 * DOC-06 §6「発生日時の連続差分の中央値をobservedIntervalDaysとする」。
 * occurrencesが2件未満(=差分が1件も取れない)場合はnullを返す。
 * 入力は事前ソート済みでなくてもよい(内部でoccurredAt昇順にソートする)。
 */
export function computeObservedIntervalDays(occurrences: readonly CasePatternOccurrence[]): number | null {
  if (occurrences.length < 2) return null;
  const sorted = [...occurrences].sort((a, b) => a.occurredAt.getTime() - b.occurredAt.getTime());
  const diffsDays: number[] = [];
  for (let i = 1; i < sorted.length; i++) {
    diffsDays.push((sorted[i]!.occurredAt.getTime() - sorted[i - 1]!.occurredAt.getTime()) / MS_PER_DAY);
  }
  diffsDays.sort((a, b) => a - b);
  const mid = Math.floor(diffsDays.length / 2);
  return diffsDays.length % 2 === 0 ? (diffsDays[mid - 1]! + diffsDays[mid]!) / 2 : diffsDays[mid]!;
}

export interface CasePatternConfidenceResult {
  rawSampleSize: number;
  observedIntervalDays: number | null;
  /** observedIntervalDaysがnullの場合はnull(§6数式のhalfLifeDaysが定義できないため、
   * 想像で代替値を発明しない)。 */
  halfLifeDays: number | null;
  /** observedIntervalDaysがnullの場合はnull(windowFromが定義できないため)。 */
  windowFrom: Date | null;
  weightedSupport: number;
  confidence: number;
}

/**
 * DOC-06 §6の数式をそのまま実装する:
 *   windowFrom = now - observedIntervalDays * windowCycles days
 *   halfLifeDays = observedIntervalDays * 6
 *   recencyWeight_i = 0.5 ^ (ageDays_i / halfLifeDays)
 *   weightedSupport = Σ(recencyWeight_i * qualityWeight_i * independenceWeight_i)
 *   confidence = min(1.0, weightedSupport / 6)
 *
 * [observedIntervalDays=nullの扱い] §6「2 instance未満はNULLで全履歴を候補表示にだけ
 * 用い、confidence上限0.25、ACTIVE化禁止」。この場合halfLifeDays/windowFromは数式上
 * 定義不能なため(0除算・NaN化を避ける)、weightedSupport/confidenceは計算せず
 * confidence=0とし、呼び出し元(classifyCasePatternStage)側でCANDIDATE_DISPLAY
 * より上のstageへ進めない・confidenceの表示上限を0.25にする、という形で
 * ガードを効かせる(この関数自体はconfidence上限のclampを行わない — 上限を
 * 適用するのは表示・stage判定の責務であり、rawの計算結果を偽装しない)。
 */
export function computeCasePatternConfidence(
  occurrences: readonly CasePatternOccurrence[],
  now: Date,
): CasePatternConfidenceResult {
  const rawSampleSize = occurrences.length;
  const observedIntervalDays = computeObservedIntervalDays(occurrences);

  if (observedIntervalDays === null) {
    return {
      rawSampleSize,
      observedIntervalDays: null,
      halfLifeDays: null,
      windowFrom: null,
      weightedSupport: 0,
      confidence: 0,
    };
  }

  const halfLifeDays = observedIntervalDays * 6;
  const windowFrom = new Date(now.getTime() - observedIntervalDays * CASE_PATTERN_WINDOW_CYCLES * MS_PER_DAY);

  let weightedSupport = 0;
  if (halfLifeDays > 0) {
    for (const occ of occurrences) {
      const ageDays = (now.getTime() - occ.occurredAt.getTime()) / MS_PER_DAY;
      const recencyWeight = Math.pow(0.5, ageDays / halfLifeDays);
      weightedSupport += recencyWeight * occ.qualityWeight * occ.independenceWeight;
    }
  }
  // halfLifeDays<=0(observedIntervalDays<=0、通常は起こらないはずの異常値)の場合、
  // 0除算・Infinity化を避けるためweightedSupport=0のまま(fail-closed、楽観側に倒さない)。

  const confidence = Math.min(1.0, weightedSupport / 6);

  return { rawSampleSize, observedIntervalDays, halfLifeDays, windowFrom, weightedSupport, confidence };
}

export const CASE_PATTERN_STAGES = ["NONE", "CANDIDATE_DISPLAY", "ACTIVE", "STRONG_SUGGESTION"] as const;
export type CasePatternStage = (typeof CASE_PATTERN_STAGES)[number];

export interface ClassifyCasePatternStageInput {
  rawSampleSize: number;
  observedIntervalDays: number | null;
  distinctContextCount: number;
  confidence: number;
  /** DOC-06 §7「直近採用率」。「強い分解提案」判定にのみ使う。未計測ならnull
   * (未計測をACCEPT率0%と偽装せず、STRONG_SUGGESTIONを単に許可しない)。 */
  recentAdoptionRate: number | null;
}

/**
 * DOC-06 §6の段階表:
 *   候補表示: raw sample>=2
 *   ACTIVE: raw sample>=5, distinct Context>=3, confidence>=0.50
 *   強い分解提案: raw sample>=10, distinct Context>=5, confidence>=0.67, 直近採用率>=0.60
 * 「2 instance未満はNULLで全履歴を候補表示にだけ用い、confidence上限0.25、ACTIVE化禁止」
 * を、observedIntervalDays===nullならCANDIDATE_DISPLAYを上限とするガードとして実装する。
 */
export function classifyCasePatternStage(input: ClassifyCasePatternStageInput): CasePatternStage {
  const { rawSampleSize, observedIntervalDays, distinctContextCount, confidence, recentAdoptionRate } = input;

  if (rawSampleSize < 2) return "NONE";
  if (observedIntervalDays === null) return "CANDIDATE_DISPLAY"; // ACTIVE化禁止(§6明記)

  const meetsActive = rawSampleSize >= 5 && distinctContextCount >= 3 && confidence >= 0.5;
  if (!meetsActive) return "CANDIDATE_DISPLAY";

  const meetsStrong =
    rawSampleSize >= 10 &&
    distinctContextCount >= 5 &&
    confidence >= 0.67 &&
    recentAdoptionRate !== null &&
    recentAdoptionRate >= 0.6;
  return meetsStrong ? "STRONG_SUGGESTION" : "ACTIVE";
}

/**
 * 表示用confidence(§6「confidence上限0.25」の適用)。rawの計算結果(computeCasePatternConfidence)
 * を偽装しないよう、「表示用に丸めた値」は別関数として分離する。
 */
export function displayCasePatternConfidence(result: Pick<CasePatternConfidenceResult, "observedIntervalDays" | "confidence">): number {
  if (result.observedIntervalDays === null) {
    return Math.min(result.confidence, CASE_PATTERN_NULL_INTERVAL_CONFIDENCE_CAP);
  }
  return result.confidence;
}
