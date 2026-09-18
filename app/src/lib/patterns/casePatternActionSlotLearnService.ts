/**
 * Case Pattern ActionSlot Learn Service(PATTERN-ACTIONSLOT-LEARN-01新設・
 * 2026-09-17)。
 * 出典: Claude向け_ISMAY_d68e9bf以降_ActionSlot正本準拠・CasePattern実分解
 * 完遂・残工程連続実装指示_2026-09-17.md Gate 5。
 *
 * [学習源・想像で紐付けない] 学習源は本人が確定した`splitFormationCandidate`
 * のSPLIT結果のうち、`FormationCandidateDecisionEvent.attributedCasePatternId`
 * が本Patternを指すもの**のみ**(指示書Gate 5「既存matched suggestionを
 * 起点に適用されたSplit、または本人が明示Pattern選択したSplitだけを最初の
 * 学習対象とする」)。単なる類似titleからの推測でPatternへ紐付けない。
 *
 * [slot grouping・v1決定論的exact match] Gate 3 Decision Record §3.2の
 * とおり、意味クラスタリングの閾値が未確定な間は「決定論的な正規化キー
 * (type+titleのNFKC正規化のSHA-256)によるexact matchのみ」をv1とする。
 * 誤結合よりslot分離を優先する。
 *
 * [generation原子性] 03Cで確立した「DB確定直前にgenerationをlock付きで
 * 再確認する」パターンを、slot単位(1 slotのidentity upsert+revision書込み
 * ごとに1 transaction)で適用する。AI呼出しはこのGateには存在しない
 * (決定論的統計算出のみ)ため、長時間transactionの懸念は無いが、設計の
 * 一貫性のため同じ構造を踏襲する。
 */
import { db } from "@/lib/db";
import type { Prisma } from "@/generated/prisma/client";
import { createHash, randomUUID } from "node:crypto";
import {
  assertCaseActionSlotLearnJobGenerationCurrent,
  type CaseActionSlotLearnJobGenerationContext,
} from "./caseActionSlotLearnQueue";

/** CasePatternActionSlotRevision.schemaVersion/policyVersion(Gate 3 Decision Record §3.5で確定した最初のversion)。 */
const CASE_PATTERN_ACTION_SLOT_SCHEMA_VERSION = "1.0";
const CASE_PATTERN_ACTION_SLOT_POLICY_VERSION = "1.0";
/** Gate 3 Decision Record §3.2「normalizeキー」のpolicyVersion。 */
const CASE_PATTERN_ACTION_SLOT_GROUPING_POLICY_VERSION = "1.0";

/** Gate 3 Decision Record §3.4「predecessorSlotKeys: 最小sample=2、閾値=出現割合0.3以上」。 */
const PREDECESSOR_MIN_SAMPLE = 2;
const PREDECESSOR_THRESHOLD = 0.3;

export type ActionSlotLearnOutcome =
  | { slotKey: string; outcome: "SLOT_CREATED"; slotId: string; revisionId: string }
  | { slotKey: string; outcome: "SLOT_REVISED"; slotId: string; revisionId: string }
  | { slotKey: string; outcome: "SLOT_UNCHANGED"; slotId: string };

/**
 * Gate 3 Decision Record §3.2「normalize(type + "\u0000" + title)のSHA-256
 * hex」。NFKC正規化→trim→連続空白を1個へ(前後の記号除去等の意味的normalizeは
 * 追加しない、想像で汎化アルゴリズムを発明しない)。
 */
export function computeActionSlotGroupingKey(type: string, title: string): string {
  const normalize = (s: string): string => s.normalize("NFKC").trim().replace(/\s+/g, " ");
  const input = `${normalize(type)}\u0000${normalize(title)}`;
  return createHash("sha256").update(input, "utf8").digest("hex");
}

/**
 * splitFormationCandidateが生成するcandidateKey(`${parentKey}-split-${i+1}`)
 * から、そのSplit内での順序(0始まり)を復元する。この命名規則自体は
 * splitCorrection.tsが決定論的に構築したものであり、想像で新しい規則を
 * 発明しているわけではない(唯一の既存の実在パターンを読み取るのみ)。
 */
function orderFromCandidateKey(candidateKey: string): number | null {
  const m = /-split-(\d+)$/.exec(candidateKey);
  if (!m) return null;
  const n = Number.parseInt(m[1]!, 10);
  if (!Number.isFinite(n) || n < 1) return null;
  return n - 1;
}

/** 中央値(偶数個の場合は中央2値の平均)。Gate 3 Decision Record §3.4「typicalOrder: v1統計量=中央値」。 */
function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 0) {
    return (sorted[mid - 1]! + sorted[mid]!) / 2;
  }
  return sorted[mid]!;
}

interface SplitInstance {
  decisionEventId: string;
  childRevisionId: string;
  type: string;
  title: string;
  order: number;
  groupingKey: string;
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((v) => stableStringify(v)).join(",")}]`;
  const keys = Object.keys(value as Record<string, unknown>).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify((value as Record<string, unknown>)[k])}`).join(",")}}`;
}

/**
 * この本Pattern(patternId)向けに、attributedCasePatternIdが本Patternを
 * 指す全SPLIT実例を集約し、ActionSlotのidentity/revisionへ反映する。
 * 呼び出し元(caseActionSlotLearnQueueJob.ts)はjobContextを渡すことで、
 * 各slotのDB確定transactionへgeneration lockを適用させる。jobContext
 * 未指定時(verify script等の単独呼び出し)はlockを行わない。
 */
export async function runActionSlotLearningForPattern(
  workspaceId: string,
  patternId: string,
  jobContext?: CaseActionSlotLearnJobGenerationContext,
): Promise<ActionSlotLearnOutcome[]> {
  const results: ActionSlotLearnOutcome[] = [];

  const pattern = await db.casePattern.findFirst({
    where: { id: patternId, workspaceId },
    select: { id: true, currentRevision: true },
  });
  if (!pattern || pattern.currentRevision < 1) return results;

  const patternRevision = await db.casePatternRevision.findFirst({
    where: { workspaceId, patternId, revision: pattern.currentRevision },
    select: { id: true },
  });
  if (!patternRevision) return results;

  // [学習源・想像で紐付けない] このPatternへattributedなSPLIT decision eventのみ。
  const decisionEvents = await db.formationCandidateDecisionEvent.findMany({
    where: { workspaceId, decision: "SPLIT", attributedCasePatternId: patternId },
    select: { id: true, candidateId: true, revisionId: true },
  });
  if (decisionEvents.length === 0) return results;

  const decisionEventByCandidateId = new Map(decisionEvents.map((d) => [d.candidateId, d]));

  const lineageRows = await db.formationCandidateLineage.findMany({
    where: {
      workspaceId,
      correctionKind: "SPLIT",
      parentIdentityId: { in: decisionEvents.map((d) => d.candidateId) },
    },
    select: { parentIdentityId: true, parentRevisionId: true, childRevisionId: true },
  });

  const childRevisionIds = lineageRows
    .filter((r) => decisionEventByCandidateId.get(r.parentIdentityId)?.revisionId === r.parentRevisionId)
    .map((r) => r.childRevisionId);
  if (childRevisionIds.length === 0) return results;

  const childRevisions = await db.formationCandidateRevision.findMany({
    where: { workspaceId, id: { in: childRevisionIds } },
    select: { id: true, type: true, title: true, candidate: { select: { candidateKey: true } } },
  });
  const childRevisionById = new Map(childRevisions.map((r) => [r.id, r]));

  // parentIdentityId(=decisionEvent.candidateId) → このSplitのinstance群
  const instancesByDecisionEvent = new Map<string, SplitInstance[]>();
  for (const lineage of lineageRows) {
    const decisionEvent = decisionEventByCandidateId.get(lineage.parentIdentityId);
    if (!decisionEvent || decisionEvent.revisionId !== lineage.parentRevisionId) continue;
    const child = childRevisionById.get(lineage.childRevisionId);
    if (!child) continue;
    const order = orderFromCandidateKey(child.candidate.candidateKey);
    if (order === null) continue;
    const groupingKey = computeActionSlotGroupingKey(child.type, child.title);
    const list = instancesByDecisionEvent.get(decisionEvent.id) ?? [];
    list.push({ decisionEventId: decisionEvent.id, childRevisionId: child.id, type: child.type, title: child.title, order, groupingKey });
    instancesByDecisionEvent.set(decisionEvent.id, list);
  }

  const totalEligibleInstances = instancesByDecisionEvent.size;
  if (totalEligibleInstances === 0) return results;

  // groupingKey → このgroupに属する全instance(decisionEvent横断)
  const instancesByGroupingKey = new Map<string, SplitInstance[]>();
  for (const list of instancesByDecisionEvent.values()) {
    for (const inst of list) {
      const arr = instancesByGroupingKey.get(inst.groupingKey) ?? [];
      arr.push(inst);
      instancesByGroupingKey.set(inst.groupingKey, arr);
    }
  }

  // ------------------------------------------------------------------
  // Phase 1: 各groupingKeyに対応するslot identityをupsertし、
  // groupingKey→slotKeyの解決表を作る(predecessorSlotKeys算出に必要)。
  // ------------------------------------------------------------------
  const slotKeyByGroupingKey = new Map<string, string>();
  const slotIdByGroupingKey = new Map<string, string>();
  for (const groupingKey of instancesByGroupingKey.keys()) {
    const existingSlot = await db.casePatternActionSlot.findFirst({
      where: { workspaceId, patternId, groupingKey },
      select: { id: true, slotKey: true },
    });
    if (existingSlot) {
      slotKeyByGroupingKey.set(groupingKey, existingSlot.slotKey);
      slotIdByGroupingKey.set(groupingKey, existingSlot.id);
      continue;
    }
    // [Gate 3 Decision Record §3.2] 初回生成時のみcrypto.randomUUID()を採番する。
    const created = await db.casePatternActionSlot.create({
      data: {
        workspaceId,
        patternId,
        slotKey: randomUUID(),
        groupingKey,
        groupingPolicyVersion: CASE_PATTERN_ACTION_SLOT_GROUPING_POLICY_VERSION,
        currentRevision: 0,
      },
      select: { id: true, slotKey: true },
    });
    slotKeyByGroupingKey.set(groupingKey, created.slotKey);
    slotIdByGroupingKey.set(groupingKey, created.id);
  }

  // ------------------------------------------------------------------
  // Phase 2: 各slotの統計を算出し、内容が変化した場合のみ新revisionを
  // 追記する(generation lock付きtransaction、1 slotにつき1 transaction)。
  // ------------------------------------------------------------------
  for (const [groupingKey, groupInstances] of instancesByGroupingKey) {
    const slotId = slotIdByGroupingKey.get(groupingKey)!;
    const slotKey = slotKeyByGroupingKey.get(groupingKey)!;

    const decisionEventIdsInGroup = new Set(groupInstances.map((i) => i.decisionEventId));
    const rawSampleSize = decisionEventIdsInGroup.size;
    const occurrenceProbability = rawSampleSize / totalEligibleInstances;

    // 中央値算出は各decisionEventにつき1回(同一split内の重複を避ける)。
    const orderPerDecisionEvent = new Map<string, number>();
    for (const inst of groupInstances) {
      if (!orderPerDecisionEvent.has(inst.decisionEventId)) orderPerDecisionEvent.set(inst.decisionEventId, inst.order);
    }
    const typicalOrder = median([...orderPerDecisionEvent.values()]);

    // predecessorSlotKeys: 各instanceについて、同一split内でorder-1に
    // あたるinstanceのgroupingKey→slotKeyを集計する。
    const predecessorCounts = new Map<string, number>();
    for (const decisionEventId of decisionEventIdsInGroup) {
      const siblings = instancesByDecisionEvent.get(decisionEventId) ?? [];
      const orderInThisGroup = orderPerDecisionEvent.get(decisionEventId)!;
      const predecessor = siblings.find((s) => s.order === orderInThisGroup - 1);
      if (!predecessor) continue;
      const predSlotKey = slotKeyByGroupingKey.get(predecessor.groupingKey);
      if (!predSlotKey) continue;
      predecessorCounts.set(predSlotKey, (predecessorCounts.get(predSlotKey) ?? 0) + 1);
    }
    let predecessorSlotKeys: string[] = [];
    if (rawSampleSize >= PREDECESSOR_MIN_SAMPLE) {
      predecessorSlotKeys = [...predecessorCounts.entries()]
        .filter(([, count]) => count / rawSampleSize >= PREDECESSOR_THRESHOLD)
        .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
        .map(([key]) => key);
    }

    // atomicityDistribution: 保存済みFormationAtomicityAssessmentのみから算出する
    // (Gate 3 Decision Record §3.4「child Revisionの保存済みFormationAtomicity
    // Assessmentのみから算出し、想像で推定しない」)。
    const childRevisionIdsInGroup = [...new Set(groupInstances.map((i) => i.childRevisionId))];
    const assessments = await db.formationAtomicityAssessment.findMany({
      where: { workspaceId, revisionId: { in: childRevisionIdsInGroup } },
      select: { assessment: true, algorithmVersion: true },
    });
    const byAssessment: Record<string, number> = {};
    const algorithmVersionsSet = new Set<string>();
    for (const a of assessments) {
      byAssessment[a.assessment] = (byAssessment[a.assessment] ?? 0) + 1;
      algorithmVersionsSet.add(a.algorithmVersion);
    }
    // [注記] Prisma.InputJsonValueは配列/オブジェクトを厳密な構造で要求するため、
    // 明示的なinterface型注釈を付けず、オブジェクトリテラルの構造的推論に
    // 委ねる(durationDistributionと同じ扱い。named interfaceへ明示annotateすると
    // index signatureの分散(variance)issueでInputJsonValueへ代入できなくなる)。
    const atomicityDistribution = {
      sampleSize: assessments.length,
      byAssessment,
      algorithmVersions: [...algorithmVersionsSet].sort(),
    };

    // durationDistribution: v1は明示的な未計測状態(空{}は禁止、Gate 3
    // Decision Record §3.4)。ExecutionSession接続は別Gate(PATTERN-DURATION-01)。
    const durationDistribution = {
      status: "NOT_ENOUGH_DATA" as const,
      sampleSize: 0,
      policyVersion: CASE_PATTERN_ACTION_SLOT_POLICY_VERSION,
    };

    // 代表titleは直近instance(最新のchildRevisionId、createdAt降順は
    // 明示的に取得していないためlineage取得順=DB返却順の最後を採用する。
    // 要約・汎化はしない(Gate 6の前段方針)。
    const representativeInstance = groupInstances[groupInstances.length - 1]!;

    const commit = async (tx: Prisma.TransactionClient): Promise<ActionSlotLearnOutcome> => {
      if (jobContext) {
        await assertCaseActionSlotLearnJobGenerationCurrent(tx, jobContext.jobId, jobContext.generation);
      }

      const currentSlot = await tx.casePatternActionSlot.findUniqueOrThrow({
        where: { id: slotId },
        select: { currentRevision: true },
      });

      const latestRevision = currentSlot.currentRevision > 0
        ? await tx.casePatternActionSlotRevision.findFirst({
            where: { workspaceId, slotId, revision: currentSlot.currentRevision },
          })
        : null;

      const nextContent = {
        normalizedIntent: representativeInstance.title,
        suggestedType: representativeInstance.type,
        occurrenceProbability: occurrenceProbability.toFixed(4),
        typicalOrder: typicalOrder.toFixed(2),
        predecessorSlotKeys,
        durationDistribution,
        atomicityDistribution,
        rawSampleSize,
      };
      const nextDigest = stableStringify(nextContent);

      let unchanged = false;
      if (latestRevision) {
        const prevContent = {
          normalizedIntent: latestRevision.normalizedIntent,
          suggestedType: latestRevision.suggestedType,
          occurrenceProbability: latestRevision.occurrenceProbability.toString(),
          typicalOrder: latestRevision.typicalOrder.toString(),
          predecessorSlotKeys: latestRevision.predecessorSlotKeys,
          durationDistribution: latestRevision.durationDistribution,
          atomicityDistribution: latestRevision.atomicityDistribution,
          rawSampleSize: latestRevision.rawSampleSize,
        };
        unchanged = stableStringify(prevContent) === nextDigest;
      }

      // provenance(SourceInstance)は内容の変化有無に関わらず、未記録の
      // childRevisionIdがあれば都度追記する(append-only、冪等)。
      // [実DB検証で発見・是正] 個別create()をtry/catchでP2002だけ無視する
      // 実装は、Postgresでは1文でも失敗するとtransaction全体が
      // "current transaction is aborted"状態になり、以降の同一transaction内
      // 文がすべて25P02で失敗する(SAVEPOINTなしでは継続できない)。
      // createMany({ skipDuplicates: true })は単一のINSERT ... ON CONFLICT
      // DO NOTHING文としてtransaction安全に実行されるため、この問題を起こさない。
      if (childRevisionIdsInGroup.length > 0) {
        await tx.casePatternActionSlotSourceInstance.createMany({
          data: childRevisionIdsInGroup.map((childRevisionId) => {
            const inst = groupInstances.find((i) => i.childRevisionId === childRevisionId)!;
            return {
              workspaceId,
              slotId,
              childRevisionId,
              order: inst.order,
              independenceGroup: inst.decisionEventId,
            };
          }),
          skipDuplicates: true,
        });
      }

      if (unchanged) {
        return { slotKey, outcome: "SLOT_UNCHANGED", slotId };
      }

      const nextRevisionNumber = currentSlot.currentRevision + 1;
      const revision = await tx.casePatternActionSlotRevision.create({
        data: {
          workspaceId,
          slotId,
          revision: nextRevisionNumber,
          patternId,
          patternRevisionId: patternRevision.id,
          normalizedIntent: representativeInstance.title,
          suggestedType: representativeInstance.type,
          occurrenceProbability: occurrenceProbability.toFixed(4),
          typicalOrder: typicalOrder.toFixed(2),
          predecessorSlotKeys,
          durationDistribution,
          atomicityDistribution,
          rawSampleSize,
          schemaVersion: CASE_PATTERN_ACTION_SLOT_SCHEMA_VERSION,
          policyVersion: CASE_PATTERN_ACTION_SLOT_POLICY_VERSION,
        },
      });
      await tx.casePatternActionSlot.update({
        where: { id: slotId },
        data: { currentRevision: nextRevisionNumber },
      });

      return {
        slotKey,
        outcome: currentSlot.currentRevision === 0 ? "SLOT_CREATED" : "SLOT_REVISED",
        slotId,
        revisionId: revision.id,
      };
    };

    const outcome = await db.$transaction((tx: Prisma.TransactionClient) => commit(tx));
    results.push(outcome);
  }

  return results;
}
