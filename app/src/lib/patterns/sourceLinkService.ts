import { db } from "@/lib/db";
import { Prisma } from "@/generated/prisma/client";
import type { CasePatternSourceEventKind } from "./coreTypes";

type PatternDbClient = typeof db | Prisma.TransactionClient;

/**
 * Case Pattern Catalog(M4) — SourceLink唯一のwrite service(PATTERN-DETECT-01A)。
 * 出典: Claude向け_ISMAY_0fcea2b以降_再監査是正・PATTERN-DETECT連続実装指示_2026-09-03.md
 * §3.2「raw Prisma createをAPI/workerから直接呼ばず、唯一のSourceLink write service
 * を作る」、§6 PATTERN-DETECT-01A「Eligibility・SourceLink service」。
 *
 * このモジュールが提供する唯一の入口 `linkPatternSourceEvent` は、
 * CasePatternSourceLinkへのINSERTを行う唯一の経路として設計されている。
 * 呼び出し元(将来のDetector/worker、PATTERN-DETECT-01B以降)は
 * `db.casePatternSourceLink.create(...)` を直接呼んではならない。
 *
 * 保証する内容(指示書§3.2・§4 DR-A・受入条件PD-01/PD-02/PD-05):
 *   1. [Eligibility, DR-A] sourceEventKind=MATERIALIZATION_RECEIPT_ITEMの場合、
 *      対象ResponsibilityがこのContextへactiveなPRIMARY Linkを持つ場合のみ
 *      許可する(SUPPORTING/REFERENCEのみ、または他Contextへのlinkは拒否)。
 *   2. [Provenance] sourceEventKindに応じてMaterializationReceiptItemまたは
 *      FormationCandidateRevisionを実際に読み、workspaceId・
 *      responsibilityId/formationSessionIdの対応を検証する(kind違い・
 *      他workspace・無関係provenanceは拒否)。
 *   3. [Idempotency] (patternRevisionId, sourceEventKind, sourceEventId)の
 *      組が既存なら例外を投げず、既存行を指す成功応答を返す(PD-01: 同じ
 *      source Eventの再処理100回でSourceLink/sampleSize増加0)。
 *
 * scope注記(想像で先行実装しない):
 * sourceEventKind=FORMATION_CANDIDATE_REVISION(materialize前段階)は、この
 * 段階ではまだResponsibility/ProjectContextLinkが存在しないため、DR-Aの
 * PRIMARY Link Eligibility判定を適用できない。正本(DOC-06)にもこの段階での
 * Context紐付け方法の記述が無いため、想像でEligibility規則を発明せず、
 * provenance検証(FormationCandidateRevisionの実在・workspace一致・
 * formationSessionId対応)のみを行う。この段階のEligibility規則が必要に
 * なった場合は、正本を確認のうえ別途DECISION_REQUIRED。
 *
 * Metric OFF filter(CHG-042踏襲、指示書「Metric OFFならObservation/
 * Aggregate/Adviceを新規作成しない」)は、raw evidenceであるSourceLink自体
 * ではなくCasePatternEvidenceAggregate書込み時(PATTERN-DETECT-01C)に適用
 * する。SourceLinkはmetricに紐付かない生証跡(「いつ・どのContextで発生
 * したか」の記録)であり、SourceLink自体をmetric単位で間引くとPS-07
 * (Evidence削除→再計算)のような後からの是正パスを失うため。
 */

export interface LinkPatternSourceEventInput {
  workspaceId: string;
  patternRevisionId: string;
  contextId: string;
  sourceEventKind: CasePatternSourceEventKind;
  sourceEventId: string;
  /** 呼び出し元が既に把握しているresponsibilityId(あれば、provenanceとの一致を検証)。 */
  responsibilityId?: string | null;
  /** 呼び出し元が既に把握しているformationSessionId(あれば、provenanceとの一致を検証)。 */
  formationSessionId?: string | null;
  /** DOC-06 §3「同一instance由来の複数Responsibilityは合計重み上限1.0」の正規化グループキー。 */
  independenceGroup: string;
  independenceWeight?: number;
  qualityWeight?: number;
}

export interface LinkPatternSourceEventResult {
  sourceLinkId: string;
  /** false の場合、既存行を指す冪等応答(新規INSERTは発生していない)。 */
  created: boolean;
}

/** provenance(sourceEventKind/sourceEventIdの実在・workspace一致・kind対応)検証に失敗。 */
export class PatternSourceProvenanceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PatternSourceProvenanceError";
  }
}

/** DR-A: 対象ResponsibilityがこのContextへのactive PRIMARY Linkを持たない。 */
export class PatternSourceEligibilityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PatternSourceEligibilityError";
  }
}

async function resolveProvenance(
  tx: Prisma.TransactionClient,
  input: LinkPatternSourceEventInput,
): Promise<{ responsibilityId: string | null; formationSessionId: string | null; sourceOccurredAt: Date }> {
  if (input.sourceEventKind === "MATERIALIZATION_RECEIPT_ITEM") {
    const item = await tx.materializationReceiptItem.findFirst({
      where: { id: input.sourceEventId, workspaceId: input.workspaceId },
      select: { responsibilityId: true, receipt: { select: { committedAt: true } } },
    });
    if (!item) {
      throw new PatternSourceProvenanceError(
        `sourceEventKind=MATERIALIZATION_RECEIPT_ITEM(id=${input.sourceEventId})が` +
          `このworkspace内に見つかりません(他workspaceのid、または実在しないidの可能性)`,
      );
    }
    if (input.responsibilityId != null && input.responsibilityId !== item.responsibilityId) {
      throw new PatternSourceProvenanceError(
        "指定されたresponsibilityIdが、sourceEventIdの指すMaterializationReceiptItemの" +
          "responsibilityIdと一致しません",
      );
    }
    return { responsibilityId: item.responsibilityId, formationSessionId: null, sourceOccurredAt: item.receipt.committedAt };
  }

  if (input.sourceEventKind === "FORMATION_CANDIDATE_REVISION") {
    const revision = await tx.formationCandidateRevision.findFirst({
      where: { id: input.sourceEventId, workspaceId: input.workspaceId },
      select: { createdAt: true, candidate: { select: { sessionId: true } } },
    });
    if (!revision) {
      throw new PatternSourceProvenanceError(
        `sourceEventKind=FORMATION_CANDIDATE_REVISION(id=${input.sourceEventId})が` +
          `このworkspace内に見つかりません(他workspaceのid、または実在しないidの可能性)`,
      );
    }
    if (input.formationSessionId != null && input.formationSessionId !== revision.candidate.sessionId) {
      throw new PatternSourceProvenanceError(
        "指定されたformationSessionIdが、sourceEventIdの指すFormationCandidateRevisionの" +
          "所属Session(candidate.sessionId)と一致しません",
      );
    }
    return { responsibilityId: null, formationSessionId: revision.candidate.sessionId, sourceOccurredAt: revision.createdAt };
  }

  // CasePatternSourceEventKindは網羅的なunion(coreTypes.ts)のため、到達しない防御的分岐。
  throw new PatternSourceProvenanceError(`未知のsourceEventKind: ${String(input.sourceEventKind)}`);
}

async function assertEligible(
  tx: Prisma.TransactionClient,
  input: LinkPatternSourceEventInput,
  responsibilityId: string | null,
): Promise<void> {
  // [DR-A] MATERIALIZATION_RECEIPT_ITEM段階(Responsibility確定後)のみ、
  // PRIMARY Link Eligibilityを判定できる。FORMATION_CANDIDATE_REVISION段階は
  // モジュールコメントのscope注記の通り対象外。
  if (responsibilityId == null) return;

  const primaryLink = await tx.projectContextLink.findFirst({
    where: {
      workspaceId: input.workspaceId,
      contextId: input.contextId,
      responsibilityId,
      role: "PRIMARY",
      unlinkedAt: null,
    },
    select: { id: true },
  });
  if (!primaryLink) {
    throw new PatternSourceEligibilityError(
      "このResponsibilityは指定Contextへのactiveな PRIMARY Linkを持たないため、" +
        "Case Pattern occurrenceとして計上できません(DR-A: SUPPORTING/REFERENCEのみ、" +
        "unlink済み、または他Contextへのlinkはoccurrenceとして数えない)",
    );
  }
}

/**
 * Case Pattern occurrenceのSourceLinkを冪等に作成する唯一の入口。
 *
 * 呼び出し前提: `input.contextId`・`input.patternRevisionId`は呼び出し元が
 * 別途この関数の外でworkspace所属を検証済みであること(この関数内でも
 * 再検証するが、呼び出し元での早期エラーメッセージのために推奨)。
 */
export async function linkPatternSourceEvent(
  input: LinkPatternSourceEventInput,
): Promise<LinkPatternSourceEventResult> {
  try {
    return await db.$transaction(async (tx: Prisma.TransactionClient) => {
      const existing = await tx.casePatternSourceLink.findFirst({
        where: {
          patternRevisionId: input.patternRevisionId,
          sourceEventKind: input.sourceEventKind,
          sourceEventId: input.sourceEventId,
        },
        select: { id: true },
      });
      if (existing) {
        return { sourceLinkId: existing.id, created: false };
      }

      const revision = await tx.casePatternRevision.findFirst({
        where: { id: input.patternRevisionId, workspaceId: input.workspaceId },
        select: { id: true },
      });
      if (!revision) {
        throw new PatternSourceProvenanceError(
          `patternRevisionId(${input.patternRevisionId})がこのworkspace内に見つかりません`,
        );
      }
      const context = await tx.projectContext.findFirst({
        where: { id: input.contextId, workspaceId: input.workspaceId, deletedAt: null },
        select: { id: true },
      });
      if (!context) {
        throw new PatternSourceProvenanceError(`contextId(${input.contextId})がこのworkspace内に見つかりません`);
      }

      const { responsibilityId, formationSessionId, sourceOccurredAt } = await resolveProvenance(tx, input);
      await assertEligible(tx, input, responsibilityId);

      const created = await tx.casePatternSourceLink.create({
        data: {
          workspaceId: input.workspaceId,
          patternRevisionId: input.patternRevisionId,
          contextId: input.contextId,
          sourceEventKind: input.sourceEventKind,
          sourceEventId: input.sourceEventId,
          responsibilityId,
          formationSessionId,
          sourceOccurredAt,
          independenceGroup: input.independenceGroup,
          independenceWeight: input.independenceWeight ?? 1,
          qualityWeight: input.qualityWeight ?? 1,
        },
      });
      return { sourceLinkId: created.id, created: true };
    });
  } catch (err) {
    // 並行呼び出しによる競合(2つのtransactionが同時に「まだ存在しない」と
    // 判定してどちらもcreateを試みた場合)は、一意制約違反として一方が失敗する。
    // これもPD-01の「再処理」の一種として冪等成功応答へ変換する。
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") {
      const existing = await db.casePatternSourceLink.findFirst({
        where: {
          patternRevisionId: input.patternRevisionId,
          sourceEventKind: input.sourceEventKind,
          sourceEventId: input.sourceEventId,
        },
        select: { id: true },
      });
      if (existing) {
        return { sourceLinkId: existing.id, created: false };
      }
    }
    throw err;
  }
}

export interface ExcludeCasePatternSourceLinksResult {
  /** excludedAt: nullだった行のうち、今回excludedAtをセットした件数。 */
  excludedCount: number;
  /** 影響を受けたCasePattern.ownerSubjectUserIdの重複排除済み一覧
   *  (呼び出し元がこの本人向けにenqueueCaseDetect(reasonCode=EVIDENCE_EXCLUDED)する)。 */
  affectedOwnerIds: string[];
}

/**
 * [PATTERN-DETECT-02B新設・2026-09-04] 指定Responsibilityに紐づく、まだ除外
 * されていないCasePatternSourceLink全件を除外する(excludedAt/excludedReason
 * をセット。物理削除しない、PS-07踏襲)。CasePatternSourceLinkへの唯一の
 * write入口という本モジュールの契約上、除外もこの関数を経由させる
 * (呼び出し元がtx.casePatternSourceLink.updateManyを直接呼ばない)。
 *
 * 出典: Claude向け_ISMAY_3b695d9以降_再監査是正・CasePattern実機能完遂指示_
 * 2026-09-04.md §4「Evidence deletionでは対応SourceLinkをprojection上
 * excludedにし、raw/weighted/confidenceを減算する」。
 *
 * revision横断(current revisionでない過去revisionのSourceLinkも含む)で
 * 除外する。casePatternAggregation.tsはcurrent revisionのみ集計するため
 * 過去revision分の除外は集計結果へ影響しないが、「この本人が実際に削除した
 * Responsibility由来のoccurrenceである」という事実の記録としては、
 * revisionを問わず一貫して除外しておくべきと判断した(想像で過去revisionを
 * 対象外にする理由が正本に無いため、全revisionを対象とする)。
 */
export async function excludeCasePatternSourceLinksForResponsibility(
  txOrDb: PatternDbClient,
  params: { workspaceId: string; responsibilityId: string; reason: string },
): Promise<ExcludeCasePatternSourceLinksResult> {
  const targets: { id: string; patternRevisionId: string }[] = await txOrDb.casePatternSourceLink.findMany({
    where: { workspaceId: params.workspaceId, responsibilityId: params.responsibilityId, excludedAt: null },
    select: { id: true, patternRevisionId: true },
  });
  if (targets.length === 0) {
    return { excludedCount: 0, affectedOwnerIds: [] };
  }

  const now = new Date();
  const updateResult = await txOrDb.casePatternSourceLink.updateMany({
    where: { id: { in: targets.map((t: { id: string }) => t.id) } },
    data: { excludedAt: now, excludedReason: params.reason },
  });

  const revisionIds = [...new Set(targets.map((t: { patternRevisionId: string }) => t.patternRevisionId))];
  const revisions: { patternId: string }[] = await txOrDb.casePatternRevision.findMany({
    where: { id: { in: revisionIds }, workspaceId: params.workspaceId },
    select: { patternId: true },
  });
  const patternIds = [...new Set(revisions.map((r: { patternId: string }) => r.patternId))];
  const patterns: { ownerSubjectUserId: string }[] = await txOrDb.casePattern.findMany({
    where: { id: { in: patternIds }, workspaceId: params.workspaceId },
    select: { ownerSubjectUserId: true },
  });
  const affectedOwnerIds = [...new Set(patterns.map((p: { ownerSubjectUserId: string }) => p.ownerSubjectUserId))];

  return { excludedCount: updateResult.count, affectedOwnerIds };
}
