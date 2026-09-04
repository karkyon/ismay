/**
 * Case Pattern 集計・stage projection(PATTERN-DETECT-01C新設・2026-09-03)。
 * 出典: Claude向け_ISMAY_0fcea2b以降_再監査是正・PATTERN-DETECT連続実装指示_2026-09-03.md
 * §6 PATTERN-DETECT-01C、DOC-06(ISMAY_v5_Metric・Granularity・CasePatternCatalog)
 * §5〜§7、§12.5〜§12.7。
 *
 * [scope宣言] このファイルはcasePatternMath.ts(既存・純粋関数)の数式を
 * 一切再実装せず、そのまま呼び出す(指示書「casePatternMath.tsの既存式を
 * 再利用し、重複実装しない」)。このファイルの責務は、DB上の
 * CasePatternSourceLink行を読み、casePatternMath.tsが要求する入力形状
 * (CasePatternOccurrence[])へ変換し、結果をCasePattern/
 * CasePatternEvidenceAggregateへ永続化することのみ。
 *
 * [current revisionのみ集計・想像で先行実装しない] 指示書「current
 * revisionだけを集計し、過去revisionを横断加算しない」に従い、
 * CasePattern.currentRevisionが指すCasePatternRevisionのSourceLinkのみを
 * 対象とする。
 *
 * [independenceWeight正規化] DOC-06 §3/§12.7「同一instance由来の複数
 * Responsibilityは合計重み上限1.0へ正規化する」。CasePatternSourceLink書込み時
 * (sourceLinkService.ts、PATTERN-DETECT-01A)は各occurrenceの生の重みを
 * そのまま保存するだけで正規化しない(1回のwriteでは同じindependenceGroupの
 * 全occurrenceを把握できないため)。正規化は本ファイル(集計時、全occurrenceを
 * 横断できる場所)の責務とする: 同一independenceGroup内の重み合計が1.0を
 * 超える場合のみ、合計が1.0になるよう比例縮小する(1.0以下ならそのまま)。
 *
 * [Metric OFF filterについて] schema.prisma CasePatternEvidenceAggregate.metricKey
 * のコメントが明記する通り、「metricDefinitionRegistry.tsに登録済みのキーのみを
 * 許可する、というapplication層検証は別Gate」として明示的に本Gateのscope外と
 * されている。DOC-06 §2のMetric Catalog(PEM側の11 Metric)とCase Pattern自体の
 * 検出は別概念であり、Case Pattern occurrence自体をON/OFFする「Metric」は
 * 正本上定義されていないため、想像でON/OFF判定を発明しない。
 * `CASE_PATTERN_AGGREGATE_METRIC_KEY`は暫定的な固定値プレースホルダである。
 *
 * [recentAdoptionRateについて] DOC-06 §7の「採用率」はSuggestion単位の
 * ACCEPT/PARTIAL_ACCEPT/REJECT/LATER/NOT_RELEVANT実績から算出される想定だが、
 * 正式なSuggestion entity・提案APIはPATTERN-DETECT-01Eのscopeでまだ存在しない。
 * 「直近」の具体的な件数・期間の定義も正本に記述が無いため、想像でwindowを
 * 発明せず、01E実装まではnull(未計測)を返す。classifyCasePatternStageは
 * recentAdoptionRate=nullの場合STRONG_SUGGESTIONへ昇格しない設計のため、
 * 未計測を0%と偽装することもない。
 */
import { db } from "@/lib/db";
import type { Prisma } from "@/generated/prisma/client";
import {
  computeCasePatternConfidence,
  classifyCasePatternStage,
  displayCasePatternConfidence,
  type CasePatternOccurrence,
  type CasePatternStage,
} from "./casePatternMath";

/** [暫定プレースホルダ] モジュール先頭のコメント「Metric OFF filterについて」参照。 */
export const CASE_PATTERN_AGGREGATE_METRIC_KEY = "CASE_PATTERN_OCCURRENCE";

/** DOC-06 §3「初期qualityWeightはHIGH=1.0、MEDIUM=0.75、LOW=0.4、UNKNOWN=0」。 */
const QUALITY_BUCKET_BOUNDARIES: { label: string; value: number }[] = [
  { label: "HIGH", value: 1.0 },
  { label: "MEDIUM", value: 0.75 },
  { label: "LOW", value: 0.4 },
  { label: "UNKNOWN", value: 0 },
];

function bucketQualityWeight(qualityWeight: number): string {
  for (const b of QUALITY_BUCKET_BOUNDARIES) {
    if (Math.abs(qualityWeight - b.value) < 1e-9) return b.label;
  }
  return "OTHER";
}

export interface CasePatternAggregateResult {
  patternId: string;
  revisionId: string;
  stage: CasePatternStage;
  rawSampleSize: number;
  distinctContextCount: number;
  observedIntervalDays: number | null;
  windowFrom: Date | null;
  weightedSupport: number;
  /** rawの計算結果(casePatternMath.ts computeCasePatternConfidence参照。表示用に丸めていない)。 */
  confidence: number;
  /** DOC-06 §6「confidence上限0.25」適用後の表示用値。CasePattern.confidenceへ保存する値。 */
  displayConfidence: number;
}

interface EligibleSourceLinkRow {
  id: string;
  contextId: string;
  sourceOccurredAt: Date;
  independenceGroup: string;
  independenceWeight: Prisma.Decimal | number;
  qualityWeight: Prisma.Decimal | number;
}

/**
 * DOC-06 §3/§12.7の正規化: 同一independenceGroup内の重み合計が1.0を超える
 * 場合のみ、合計が1.0になるよう比例縮小する。1.0以下ならそのまま(縮小しない
 * ＝1.0未満の場合に水増しもしない)。
 */
function normalizeIndependenceWeights(links: readonly EligibleSourceLinkRow[]): Map<string, number> {
  const rawWeights = new Map<string, number>();
  const groupSums = new Map<string, number>();
  for (const link of links) {
    const w = Number(link.independenceWeight);
    rawWeights.set(link.id, w);
    groupSums.set(link.independenceGroup, (groupSums.get(link.independenceGroup) ?? 0) + w);
  }
  const normalized = new Map<string, number>();
  for (const link of links) {
    const groupSum = groupSums.get(link.independenceGroup) ?? 0;
    const raw = rawWeights.get(link.id) ?? 0;
    const factor = groupSum > 1.0 ? 1.0 / groupSum : 1.0;
    normalized.set(link.id, raw * factor);
  }
  return normalized;
}

/**
 * この本人の1 Pattern(currentRevision)を再集計し、CasePattern/
 * CasePatternEvidenceAggregateへ永続化する。何度呼んでも同じ入力(DB上の
 * 有効なSourceLink集合)からは同じ結果になる(projectionの再構築可能性、
 * 指示書§3.3「projectionは何度再構築しても同じ値になる」)。
 */
export async function computeAndPersistCasePatternAggregate(
  workspaceId: string,
  patternId: string,
): Promise<CasePatternAggregateResult> {
  const pattern = await db.casePattern.findFirst({
    where: { id: patternId, workspaceId },
    select: { id: true, currentRevision: true },
  });
  if (!pattern) {
    throw new Error(`CasePattern(id=${patternId})がworkspace内に見つかりません`);
  }
  if (pattern.currentRevision < 1) {
    throw new Error(`CasePattern(id=${patternId})にrevisionがまだありません(currentRevision=${pattern.currentRevision})`);
  }

  const revision = await db.casePatternRevision.findFirst({
    where: { workspaceId, patternId, revision: pattern.currentRevision },
    select: { id: true },
  });
  if (!revision) {
    throw new Error(
      `CasePattern(id=${patternId})のcurrentRevision(${pattern.currentRevision})に対応するrevision行が見つかりません`,
    );
  }

  // [PS-07踏襲] excludedAt:nullのみが集計対象(Evidence削除は物理削除せず
  // excludedAt/excludedReasonで除外する、既存CasePatternSourceLinkの契約)。
  const links: EligibleSourceLinkRow[] = await db.casePatternSourceLink.findMany({
    where: { workspaceId, patternRevisionId: revision.id, excludedAt: null },
    select: { id: true, contextId: true, sourceOccurredAt: true, independenceGroup: true, independenceWeight: true, qualityWeight: true },
  });

  const normalizedWeights = normalizeIndependenceWeights(links);
  const qualitySummary: Record<string, number> = { HIGH: 0, MEDIUM: 0, LOW: 0, UNKNOWN: 0, OTHER: 0 };
  const occurrences: CasePatternOccurrence[] = links.map((link) => {
    const qualityWeight = Number(link.qualityWeight);
    qualitySummary[bucketQualityWeight(qualityWeight)]! += 1;
    return {
      occurredAt: link.sourceOccurredAt,
      qualityWeight,
      independenceWeight: normalizedWeights.get(link.id) ?? 0,
    };
  });

  const now = new Date();
  const confResult = computeCasePatternConfidence(occurrences, now);
  const distinctContextCount = new Set(links.map((l) => l.contextId)).size;
  // [01E待ち・モジュール先頭コメント参照] Suggestion実装までは未計測。
  const recentAdoptionRate: number | null = null;

  const stage = classifyCasePatternStage({
    rawSampleSize: confResult.rawSampleSize,
    observedIntervalDays: confResult.observedIntervalDays,
    distinctContextCount,
    confidence: confResult.confidence,
    recentAdoptionRate,
  });
  const displayConfidence = displayCasePatternConfidence(confResult);

  await db.$transaction(async (tx: Prisma.TransactionClient) => {
    await tx.casePatternEvidenceAggregate.upsert({
      where: { revisionId_metricKey: { revisionId: revision.id, metricKey: CASE_PATTERN_AGGREGATE_METRIC_KEY } },
      create: {
        workspaceId,
        revisionId: revision.id,
        metricKey: CASE_PATTERN_AGGREGATE_METRIC_KEY,
        rawSampleSize: confResult.rawSampleSize,
        distinctContextCount,
        weightedSupport: confResult.weightedSupport,
        qualitySummary,
        computedAt: now,
      },
      update: {
        rawSampleSize: confResult.rawSampleSize,
        distinctContextCount,
        weightedSupport: confResult.weightedSupport,
        qualitySummary,
        computedAt: now,
      },
    });

    await tx.casePattern.update({
      where: { id: patternId },
      data: {
        status: stage,
        observedIntervalDays: confResult.observedIntervalDays,
        windowFrom: confResult.windowFrom,
        confidence: displayConfidence,
      },
    });
  });

  return {
    patternId,
    revisionId: revision.id,
    stage,
    rawSampleSize: confResult.rawSampleSize,
    distinctContextCount,
    observedIntervalDays: confResult.observedIntervalDays,
    windowFrom: confResult.windowFrom,
    weightedSupport: confResult.weightedSupport,
    confidence: confResult.confidence,
    displayConfidence,
  };
}

/**
 * この本人(ownerSubjectUserId)が持つ全CasePatternを再集計する。
 * caseDetectQueueJob.tsのno-opプレースホルダから、このGateで実処理へ
 * 差し込む差し込み点。
 */
export async function computeAndPersistCasePatternAggregatesForOwner(
  workspaceId: string,
  ownerSubjectUserId: string,
): Promise<CasePatternAggregateResult[]> {
  const patterns = await db.casePattern.findMany({
    where: { workspaceId, ownerSubjectUserId, currentRevision: { gt: 0 } },
    select: { id: true },
  });
  const results: CasePatternAggregateResult[] = [];
  for (const p of patterns) {
    results.push(await computeAndPersistCasePatternAggregate(workspaceId, p.id));
  }
  return results;
}
