/**
 * Case Pattern ActionSlot Duration Distribution(PATTERN-DURATION-01新設・
 * 2026-09-19)。
 * 出典: Claude向け_ISMAY_d68e9bf以降_ActionSlot正本準拠・CasePattern実分解
 * 完遂・残工程連続実装指示_2026-09-17.md P1「11. Pattern管理UI・duration・
 * docs」のduration部分。casePatternActionSlotLearnService.tsのGate 5実装
 * コメント「ExecutionSession接続は別Gate(PATTERN-DURATION-01)」を実装する。
 *
 * [実在する接続経路のみを辿る・想像で推定しない] このGateで使う接続経路は、
 * 既存の実在テーブルのみを辿る(新しいFKや非正規化列を追加しない):
 *   FormationCandidateRevision.candidateId
 *     → MaterializationReceiptItem(workspaceId, candidateId一意)
 *       → responsibilityId
 *         → ExecutionSessionIdentity(workspaceId, responsibilityId)
 *           → ExecutionSessionRevision(現行版、status='CLOSED_CONFIRMED'のみ)
 *             → rawElapsedSeconds
 * まだmaterialize(ACCEPT/SPLIT確定)されていないchildRevisionは
 * MaterializationReceiptItemが存在しないため自然に除外される(想像で
 * 未確定candidateの見積り時間を捏造しない)。correctedActiveSecondsは
 * Activity Segment未実装のため常にnull(schema.prismaコメント参照)であり、
 * v1はrawElapsedSecondsのみを使う。
 *
 * [1 Responsibilityに複数Session] 同一Responsibilityへ複数回着手した場合、
 * ExecutionSessionIdentityは複数行になりうる(INTERRUPT/DEFER後の再開等)。
 * このGateでは、そのResponsibilityに対するCLOSED_CONFIRMED済み全Sessionの
 * rawElapsedSecondsを合算した値を「そのSplit実例1件の所要時間」として扱う
 * (作業が中断・再開されても実質作業時間の合計であるべき、という最も単純で
 * 説明可能な定義を採用し、想像で複雑な重み付けを発明しない)。
 *
 * [統計量] typicalOrderと同じくv1は中央値(median)のみを使う(policyVersionで
 * 明記、無断で意味を変更しない)。
 */
import { db } from "@/lib/db";

export const CASE_PATTERN_ACTION_SLOT_DURATION_POLICY_VERSION = "1.0";

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 0) {
    return (sorted[mid - 1]! + sorted[mid]!) / 2;
  }
  return sorted[mid]!;
}

/**
 * この一群のchildRevisionId(1 ActionSlotのgroup)について、実際に
 * materialize済みかつCLOSED_CONFIRMED Sessionを持つResponsibility群から
 * duration distributionを算出する。該当データが1件も無ければ
 * NOT_ENOUGH_DATAを返す(v1既定と同一形状、空{}は返さない)。
 */
export async function computeDurationDistributionForChildRevisions(
  workspaceId: string,
  childRevisionIds: string[],
): Promise<{ status: "COMPUTED"; sampleSize: number; medianSeconds: number; policyVersion: string } | { status: "NOT_ENOUGH_DATA"; sampleSize: number; policyVersion: string }> {
  const notEnoughData = { status: "NOT_ENOUGH_DATA" as const, sampleSize: 0, policyVersion: CASE_PATTERN_ACTION_SLOT_DURATION_POLICY_VERSION };
  if (childRevisionIds.length === 0) return notEnoughData;

  const revisions = await db.formationCandidateRevision.findMany({
    where: { workspaceId, id: { in: childRevisionIds } },
    select: { candidateId: true },
  });
  const candidateIds = [...new Set(revisions.map((r: { candidateId: string }) => r.candidateId))];
  if (candidateIds.length === 0) return notEnoughData;

  const receiptItems = await db.materializationReceiptItem.findMany({
    where: { workspaceId, candidateId: { in: candidateIds } },
    select: { responsibilityId: true },
  });
  const responsibilityIds = [...new Set(receiptItems.map((r: { responsibilityId: string }) => r.responsibilityId))];
  if (responsibilityIds.length === 0) return notEnoughData;

  const sessionIdentities = await db.executionSessionIdentity.findMany({
    where: { workspaceId, responsibilityId: { in: responsibilityIds } },
    select: { id: true, responsibilityId: true },
  });
  if (sessionIdentities.length === 0) return notEnoughData;

  const identityIds = sessionIdentities.map((s: { id: string; responsibilityId: string }) => s.id);
  // [現行revisionのみ] insert-only履歴のため、identityIdごとに最大revisionの
  // 行のみが「現在の状態」を表す(sessionPersistence.tsと同じ
  // `orderBy: { revision: "desc" }`慣行)。1クエリで全件取得し、以後は
  // メモリ上でidentityId単位に絞り込む(N+1回避)。
  const allRevisions = await db.executionSessionRevision.findMany({
    where: { sessionIdentityId: { in: identityIds }, status: "CLOSED_CONFIRMED" },
    orderBy: { revision: "desc" },
    select: { sessionIdentityId: true, revision: true, rawElapsedSeconds: true },
  });
  const currentRevisionByIdentityId = new Map<string, { revision: number; rawElapsedSeconds: number }>();
  for (const rev of allRevisions) {
    const existing = currentRevisionByIdentityId.get(rev.sessionIdentityId);
    if (!existing || rev.revision > existing.revision) {
      currentRevisionByIdentityId.set(rev.sessionIdentityId, { revision: rev.revision, rawElapsedSeconds: rev.rawElapsedSeconds });
    }
  }

  const secondsByResponsibilityId = new Map<string, number>();
  for (const identity of sessionIdentities) {
    const current = currentRevisionByIdentityId.get(identity.id);
    if (!current) continue; // このidentityの現行revisionはCLOSED_CONFIRMEDではない。
    secondsByResponsibilityId.set(
      identity.responsibilityId,
      (secondsByResponsibilityId.get(identity.responsibilityId) ?? 0) + current.rawElapsedSeconds,
    );
  }

  const totalsSeconds = [...secondsByResponsibilityId.values()];
  if (totalsSeconds.length === 0) return notEnoughData;

  return {
    status: "COMPUTED",
    sampleSize: totalsSeconds.length,
    medianSeconds: median(totalsSeconds),
    policyVersion: CASE_PATTERN_ACTION_SLOT_DURATION_POLICY_VERSION,
  };
}
