/**
 * Case Pattern Suggestion接続準備(PATTERN-DETECT-01E新設・2026-09-04)。
 * 出典: Claude向け_ISMAY_0fcea2b以降_再監査是正・PATTERN-DETECT連続実装指示_2026-09-03.md
 * §6 PATTERN-DETECT-01E、DOC-06 §7「提案契約」
 * 「Pattern提案は「過去N件・M文脈・確度C・採用率A」を表示し、
 * ACCEPT/PARTIAL_ACCEPT/REJECT/LATER/NOT_RELEVANTを記録する」。
 *
 * [scope宣言・想像で先行実装しない・指示書の明示的分離許可に基づく] このGateの
 * 対象は以下の2点のみ:
 *   (a) 提案表示用DTO(buildCasePatternSuggestionDto)の実装。
 *   (b) 採用率(adoptionRate)の実計算を、CasePatternFeedbackEventから
 *       casePatternAggregation.ts(PATTERN-DETECT-01C)へ接続する
 *       (01C実装時は「Suggestion entity未実装のため常にnull」だった箇所を、
 *       feedback dataの意味が明確になったこのGateで実データへ差し替える)。
 *
 * 指示書§6 01E「実際の提案API/UIとCHG-044が大きい場合は次のPATTERN-SUGGEST-01
 * へ分離し、未実装を完了扱いしない」という明示的な分離許可に従い、以下は
 * このGateのscope外としPATTERN-SUGGEST-01(別Gate)へ委ねる(想像で
 * 先行実装しない):
 *   - 正式なSuggestion identity/revision entity(CasePatternFeedbackEvent.
 *     suggestionIdへのFK追加は、そのentityが存在して初めて可能になる)。
 *   - 提案の作成・表示・ACCEPT/REJECT等を行う実際のAPI route・UI。
 *   - ACCEPT時にFormation Candidateを作る接続(CHG-044)。
 * これらは「実際にSuggestionをどう識別し、どのAPI形状で提示するか」という
 * 独立した設計判断を要する、指示書が言う意味での「大きい」作業であり、
 * このGate 1つに詰め込むと想像で埋める箇所が増えるリスクが高い。
 */
import { db } from "@/lib/db";

/**
 * この本人のこのPatternについて、これまでに記録された全FeedbackEventから
 * 採用率を計算する。「直近N件」のような具体的な件数・期間の定義は正本に
 * 記述が無いため(casePatternAggregation.tsのモジュールコメント参照)、
 * 想像でwindowを発明せず、記録済みの全FeedbackEventを対象とする
 * (将来「直近」の定義が正本で確定した時点で、このwindow付けだけを
 * 差し替えられるよう、この関数1箇所に計算ロジックを閉じ込めてある)。
 *
 * 分子: ACCEPT + PARTIAL_ACCEPT(部分的にでも採用された)。
 * 分母: 分子 + REJECT + NOT_RELEVANT(明確に決着した件数)。
 * LATER(保留)は分母に含めない(まだ決着していない=採用率の計算対象外。
 * 「未計測を0%と偽装しない」という既存方針を踏襲)。
 * 決着した記録が1件も無い場合はnull(未計測)を返す。
 */
export async function computeCasePatternAdoptionRate(workspaceId: string, patternId: string): Promise<number | null> {
  const counts = await db.casePatternFeedbackEvent.groupBy({
    by: ["verdict"],
    where: { workspaceId, patternId },
    _count: { _all: true },
  });

  let accepted = 0;
  let decided = 0;
  for (const row of counts as { verdict: string; _count: { _all: number } }[]) {
    if (row.verdict === "ACCEPT" || row.verdict === "PARTIAL_ACCEPT") {
      accepted += row._count._all;
      decided += row._count._all;
    } else if (row.verdict === "REJECT" || row.verdict === "NOT_RELEVANT") {
      decided += row._count._all;
    }
    // LATERは分母に含めない(上記コメント参照)。
  }

  if (decided === 0) return null;
  return accepted / decided;
}

export interface CasePatternSuggestionDto {
  patternId: string;
  revisionId: string;
  title: string;
  stage: string;
  /** DOC-06 §7「過去N件」。 */
  rawSampleSize: number;
  /** DOC-06 §7「M文脈」。 */
  distinctContextCount: number;
  /** DOC-06 §7「確度C」。CasePattern.confidence(表示用に丸め済み)。 */
  confidence: number;
  /** DOC-06 §7「採用率A」。決着した記録が無ければnull(未計測)。 */
  adoptionRate: number | null;
  observedIntervalDays: number | null;
}

/**
 * Pattern提案の表示用DTOを組み立てる(DOC-06 §7の4値: 過去N件・M文脈・
 * 確度C・採用率A)。CasePattern.currentRevisionに対応するEvidence
 * Aggregate(PATTERN-DETECT-01C成果物)が無い場合はnullを返す
 * (まだ一度も集計されていないPatternは提案として提示できる状態にない)。
 */
export async function buildCasePatternSuggestionDto(
  workspaceId: string,
  patternId: string,
): Promise<CasePatternSuggestionDto | null> {
  const pattern = await db.casePattern.findFirst({
    where: { id: patternId, workspaceId },
    select: { id: true, title: true, status: true, confidence: true, observedIntervalDays: true, currentRevision: true },
  });
  if (!pattern || pattern.currentRevision < 1) return null;

  const revision = await db.casePatternRevision.findFirst({
    where: { workspaceId, patternId, revision: pattern.currentRevision },
    select: { id: true },
  });
  if (!revision) return null;

  const aggregate = await db.casePatternEvidenceAggregate.findFirst({
    where: { workspaceId, revisionId: revision.id },
    select: { rawSampleSize: true, distinctContextCount: true },
    orderBy: { computedAt: "desc" },
  });
  if (!aggregate) return null;

  const adoptionRate = await computeCasePatternAdoptionRate(workspaceId, patternId);

  return {
    patternId: pattern.id,
    revisionId: revision.id,
    title: pattern.title,
    stage: pattern.status,
    rawSampleSize: aggregate.rawSampleSize,
    distinctContextCount: aggregate.distinctContextCount,
    confidence: Number(pattern.confidence),
    adoptionRate,
    observedIntervalDays: pattern.observedIntervalDays !== null ? Number(pattern.observedIntervalDays) : null,
  };
}
