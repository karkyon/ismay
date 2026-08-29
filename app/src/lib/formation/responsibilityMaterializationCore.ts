import type { Prisma } from "@/generated/prisma/client";
import { initialStatusFor } from "@/lib/responsibility";

/**
 * V5-M1-B4 共通コア: Responsibility作成 + Tag自動付与 + BLOCKS Relation解決 +
 * EventLog(AI_CANDIDATE_DECIDED) + OutboxEvent(ResponsibilityCreated.v1)。
 * 出典: 監査「Gate M1-B4 次工程指示」B31-05・B31-06是正、
 *       ISMAY_統合正本仕様書_v5_0.md 6.8節(Materialization Transaction)。
 *
 * [設計方針・2026-08-29カルキョンさん承認(案B)]
 * `AiInference`(旧 `/inferences/[id]/decision`)と`FormationCandidateIdentity`
 * (新Formation Materialize)はFKで一切接続されていない別データモデル
 * (schema.prisma実読で確認済み)。そのためこのファイルはどちらのデータモデルへも
 * 変換・同期を行わない。「Responsibility作成後に何を書き込むか」という
 * 中核ロジックだけをここへ1本化し、呼び出し元(旧route/新materialize.ts)は
 * それぞれ自分のデータモデルからこの関数の入力を組み立てて渡す。
 *
 * この関数自身はtransactionを開始・commit・rollbackしない。呼び出し元の
 * `tx`(Prisma.TransactionClient)をそのまま使うため、呼び出し元が
 * 「Decision記録」と「Responsibility作成」を同一`$transaction`で包んでいる限り、
 * 常にatomicになる(B31-05が指摘した非atomicity問題は、呼び出し元がこの関数を
 * 別々のtransactionから呼ばない限り発生しない)。
 */

export interface ResponsibilityCreationInput {
  workspaceId: string;
  domainId: string;
  originCaptureId: string;
  type: string;
  title: string;
  description?: string | null;
  importance?: number | null;
  confidence: Prisma.Decimal | number;
  hardDeadlineAt?: Date | null;
  targetAt?: Date | null;
  startAfterAt?: Date | null;
  actorUserId: string;
  /** AI提案タグ。先頭3件のみ採用(旧routeの既存挙動を踏襲)。 */
  suggestedTags: string[];
  /** 旧API互換field(B31-06)。FormationCandidate起源にはoriginInferenceIdという
   *  概念が存在しないため、その場合は渡さない(schema上optionalなためnullになる)。 */
  originInferenceId?: string;
  /** 相関ID(HTTPリクエストヘッダ由来)。両呼び出し元ともoptionalで渡す。 */
  correlationId?: string;
  /** [B4.1新設・B41-01是正] EventLog(AI_CANDIDATE_DECIDED).afterJson.decisionへ
   *  実際に記録する値。旧routeはACCEPT→"ACCEPTED"・EDIT→"EDITED"の2値を
   *  `AiInference.decision`へ書くが、この共通コアは従来"ACCEPTED"を決め打ちで
   *  記録しており、Flag ON時にEDITしても常にEventLogがACCEPTEDになる不整合が
   *  あった(監査「Gate M1-B4.1」B41-01)。呼び出し元が実際の決定値を明示する。
   */
  decisionValue: "ACCEPTED" | "EDITED";
  /** [B4.1新設・B31-06 embedding同値性] 旧routeがEmbedding生成時に渡している
   *  actor/counterparty(FN-GR-01 embeddingText)。Formation起源の候補にも
   *  同じfieldがproposedFieldsに存在するため、呼び出し元がそのまま渡す。
   *  この共通コア自体はEmbeddingを呼ばない(post-commit best-effort処理は
   *  呼び出し元の責務のまま)が、戻り値へ含めて呼び出し元のembed呼出しで
   *  使えるようにする。 */
  actor?: string | null;
  counterparty?: string | null;
  provenance:
    | { kind: "AI_INFERENCE"; inferenceId: string }
    | { kind: "FORMATION_CANDIDATE"; sessionId: string; candidateIdentityId: string };
  /** この候補が「ブロックする」側として確定済みの相手Responsibility ID一覧
   *  (=このResponsibility自身が先にブロック元となるBLOCKS relationのtoId側)。
   *  相手候補の探索(Capture内/Session内どちらを見るか)は呼び出し元が行う。 */
  blocksResponsibilityIds: string[];
  /** この候補が「ブロックされる」側として確定済みの相手Responsibility ID一覧
   *  (=相手が先にblockedByCandidateIdsへこの候補を含めていた場合のfromId側)。 */
  blockedByResponsibilityIds: string[];
}

export interface CreatedResponsibility {
  id: string;
  domainId: string;
  title: string;
  description: string | null;
  /** [B4.1新設] 呼び出し元がpost-commit embed呼出しでactor/counterpartyを
   *  渡せるよう、入力をそのまま素通しして返す(このファイル自身はEmbeddingを
   *  一切呼ばない設計を維持する)。 */
  actor?: string | null;
  counterparty?: string | null;
}

export async function createResponsibilityWithLinks(
  tx: Prisma.TransactionClient,
  input: ResponsibilityCreationInput,
): Promise<CreatedResponsibility> {
  const responsibility = await tx.responsibility.create({
    data: {
      workspaceId: input.workspaceId,
      domainId: input.domainId,
      originCaptureId: input.originCaptureId,
      originInferenceId: input.originInferenceId ?? null,
      type: input.type,
      title: input.title,
      description: input.description ?? null,
      status: initialStatusFor(input.type),
      importance: input.importance ?? null,
      confidence: input.confidence,
      sourceKind: "AI",
      hardDeadlineAt: input.hardDeadlineAt ?? null,
      targetAt: input.targetAt ?? null,
      startAfterAt: input.startAfterAt ?? null,
      createdById: input.actorUserId,
      updatedById: input.actorUserId,
    },
  });

  // AI提案タグの自動付与(既存タグ再利用・未登録タグは自動作成)。旧routeの
  // 既存挙動(2026-08-21追加分)をそのまま踏襲。
  if (input.suggestedTags.length > 0) {
    for (const tagName of input.suggestedTags.slice(0, 3)) {
      const trimmed = tagName.trim();
      if (!trimmed) continue;
      const tag = await tx.tag.upsert({
        where: { workspaceId_name: { workspaceId: input.workspaceId, name: trimmed } },
        create: { workspaceId: input.workspaceId, name: trimmed },
        update: {},
        select: { id: true },
      });
      await tx.responsibilityTag.create({
        data: { responsibilityId: responsibility.id, tagId: tag.id },
      });
    }
  }

  // 順方向: 相手が既に確定済み(=blockingResponsibilityとして解決済み)であれば
  // 「相手 BLOCKS 自分」のrelationを張る(旧route既存挙動)。
  for (const blockingId of input.blockedByResponsibilityIds) {
    await tx.responsibilityRelation.create({
      data: {
        fromId: blockingId,
        toId: responsibility.id,
        relationType: "BLOCKS",
        status: "CONFIRMED",
        sourceKind: "AI",
        confirmedById: input.actorUserId,
        confirmedAt: new Date(),
      },
    });
  }

  // 逆方向: 既に確定済みの他候補が、この候補(今作成したResponsibility)を
  // blockedByとして指定していた場合、「自分 BLOCKS 相手」のrelationを張る
  // (旧route既存挙動。二重生成防止のため既存relationの有無を確認する)。
  for (const dependentId of input.blocksResponsibilityIds) {
    const alreadyExists = await tx.responsibilityRelation.findFirst({
      where: { fromId: responsibility.id, toId: dependentId, relationType: "BLOCKS" },
      select: { id: true },
    });
    if (alreadyExists) continue;
    await tx.responsibilityRelation.create({
      data: {
        fromId: responsibility.id,
        toId: dependentId,
        relationType: "BLOCKS",
        status: "CONFIRMED",
        sourceKind: "AI",
        confirmedById: input.actorUserId,
        confirmedAt: new Date(),
      },
    });
  }

  const provenanceRef =
    input.provenance.kind === "AI_INFERENCE"
      ? { inferenceId: input.provenance.inferenceId }
      : { candidateId: input.provenance.candidateIdentityId };

  await tx.eventLog.create({
    data: {
      aggregateType: "Responsibility",
      aggregateId: responsibility.id,
      eventType: "AI_CANDIDATE_DECIDED",
      beforeJson: { ...provenanceRef, decision: "PENDING" },
      afterJson: { ...provenanceRef, decision: input.decisionValue, responsibilityId: responsibility.id },
      actorType: "USER",
      actorId: input.actorUserId,
      correlationId: input.correlationId,
    },
  });

  await tx.outboxEvent.create({
    data: {
      eventName: "ResponsibilityCreated.v1",
      eventVersion: "1",
      aggregateId: responsibility.id,
      aggregateVersion: responsibility.version,
      correlationId: input.correlationId,
      payload:
        input.provenance.kind === "AI_INFERENCE"
          ? {
              responsibilityId: responsibility.id,
              workspaceId: input.workspaceId,
              domainId: responsibility.domainId,
              type: responsibility.type,
              fromInferenceId: input.provenance.inferenceId,
            }
          : {
              responsibilityId: responsibility.id,
              workspaceId: input.workspaceId,
              domainId: responsibility.domainId,
              type: responsibility.type,
              fromFormationSessionId: input.provenance.sessionId,
              fromCandidateId: input.provenance.candidateIdentityId,
            },
    },
  });

  return {
    id: responsibility.id,
    domainId: responsibility.domainId,
    title: responsibility.title,
    description: responsibility.description,
    actor: input.actor ?? null,
    counterparty: input.counterparty ?? null,
  };
}
