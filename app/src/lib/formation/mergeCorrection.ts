import { createHash } from "node:crypto";
import { db } from "@/lib/db";
import type { Prisma } from "@/generated/prisma/client";
import { debugServer } from "@/lib/debugServer";
import { ResponsibilityCandidateSchema, type ResponsibilityCandidate } from "@/lib/ai/schema";
import { RESPONSIBILITY_TYPES } from "@/lib/responsibility";
import { resolveLegacyProjectionMap } from "@/lib/formation/legacyProjectionResolver";
import { assessAtomicity } from "@/lib/formation/atomicityAssessment";
import { sessionEventTypeForDecision } from "@/lib/formation/materialize";

/**
 * V5-M1-C2B Candidate MERGE Correction service。
 * 出典: 2026-08-30確定指示書 DEC-MERGE-001。
 *
 * 「同一workspace・同一Session内の未Materialize候補を2件以上選び、本人が
 * 統合後のtype/title/description/completionConditionを明示入力・確認する。
 * AIに統合内容を勝手に決めさせない。…Session行をFOR UPDATE、全対象Revisionを
 * CAS固定し、対象重複・越境・既決定・既Materialize・legacy conflictを拒否する。
 * 元候補は削除・上書きせず、各候補へMERGED Correction/Decision Eventを
 * appendし、新しいCandidate Identity/Revisionを同一transactionで作る。新候補は
 * 全親Source Anchorを重複排除して継承し、親candidate/revisionのlineageをDBで
 * 照会可能にする。根拠が無い場合は空/UNKNOWNとして表し、offsetを捏造しない。
 * 新候補のAtomicity Assessmentを同一transaction内で作る。idempotency key +
 * request hash、tenant複合FK、並行実行、部分失敗0を保証する。」
 *
 * [設計方針] `materialize.ts`の`recordCandidateDecision`/`splitCorrection.ts`と
 * 全く同じSession行FOR UPDATE lock・legacy横断guard・revision CASパターンを
 * N個の親candidateへ拡張する。「同時Mergeは一方だけ成功」は、既存の
 * Session行lockが全操作(decide/materialize/split/merge)を完全に直列化する
 * 既存メカニズムに乗る(新しい排他制御を追加で発明しない)。
 *
 * [対象範囲の明記] Candidate段階のMerge(materialize前)のみ実装する。
 * Materialize済みResponsibilityのMerge/Split correction(正本§11.4)は別Gate
 * (M1-C2C以降)で扱う(DEC-MERGE-001の明記どおり)。
 */

export interface MergeCandidatesParentInput {
  candidateId: string;
  expectedRevision: number;
}

export interface MergeCandidatesMergedInput {
  type: string;
  title: string;
  description?: string;
  completionCondition?: string;
}

export interface MergeCandidatesParams {
  sessionId: string;
  workspaceId: string;
  parents: MergeCandidatesParentInput[];
  merged: MergeCandidatesMergedInput;
  reasonCode?: string;
  actorUserId: string;
  /** DEC-MERGE-001「idempotency key」。Answer API(clientEventId)と同じ設計。 */
  clientEventId: string;
}

export interface MergeCandidatesResult0 {
  newCandidateId: string;
  newCandidateKey: string;
  newRevisionId: string;
  parentDecisionEventIds: string[];
}

export type MergeCandidatesResult =
  | ({ ok: true; replay: boolean } & MergeCandidatesResult0)
  | { ok: false; error: "NOT_FOUND" }
  | { ok: false; error: "INVALID_SESSION_STATE"; sessionState: string }
  | { ok: false; error: "INVALID_MERGE_PARTS"; reason: string }
  | { ok: false; error: "DUPLICATE_PARENT_CANDIDATE" }
  | { ok: false; error: "REVISION_CONFLICT"; candidateId: string; latestRevision: number }
  | { ok: false; error: "ALREADY_DECIDED"; candidateId: string; existingDecision: string }
  | { ok: false; error: "ALREADY_MATERIALIZED_BY_LEGACY"; candidateId: string; legacyInferenceId: string; legacyDecision: string }
  | { ok: false; error: "ALREADY_DECIDED_BY_LEGACY"; candidateId: string; legacyInferenceId: string; legacyDecision: string }
  | { ok: false; error: "LEGACY_PROJECTION_CONFLICT"; candidateId: string; legacyInferenceId: string; legacyDecision: string }
  | { ok: false; error: "IDEMPOTENCY_KEY_REUSED" }
  // [R1-02監査是正指示書2026-08-31 R1-01] 親Revisionのproposed Fieldsがparse不能。
  // materialize.ts/splitCorrection.ts/answerService.tsと同じ語彙。架空Evidence
  // [{start:0,end:1}]を生成する代わりに、書込み前に拒否する。
  | { ok: false; error: "CORRUPTED_CANDIDATE_DATA"; candidateId: string }
  // [R1-01] 全親のparseは成功したが、代表Evidenceを1件も確保できない
  // (通常はResponsibilityCandidateSchemaのevidenceSpans min(1)により発生しない
  // 防御的分岐。DBの参照整合性が崩れRevision行が想定数取得できない場合等)。
  | { ok: false; error: "SOURCE_EVIDENCE_UNAVAILABLE" }
  // [R1-03新設・監査是正指示書2026-08-31] idempotency replay時、FormationCandidateMergeEvent
  // 行は見つかったのに、それが指すはずのnewCandidateId/新Revisionが実在しない
  // (データ不整合)。空文字を返して成功扱いにする代わりに、明示的に拒否する。
  | { ok: false; error: "REPLAY_INTEGRITY_ERROR"; mergeEventId: string };

const RESPONSIBILITY_TYPE_SET = new Set<string>(RESPONSIBILITY_TYPES);

function computeMergeRequestHash(input: {
  sessionId: string;
  workspaceId: string;
  parents: MergeCandidatesParentInput[];
  merged: MergeCandidatesMergedInput;
}): string {
  const sortedParents = [...input.parents].sort((a, b) => a.candidateId.localeCompare(b.candidateId));
  const payload = JSON.stringify({
    sessionId: input.sessionId,
    workspaceId: input.workspaceId,
    parents: sortedParents,
    merged: input.merged,
  });
  return createHash("sha256").update(payload).digest("hex");
}

function validateMergeInput(parents: MergeCandidatesParentInput[], merged: MergeCandidatesMergedInput): string | null {
  if (parents.length < 2) {
    return "統合には2件以上の親候補が必要です";
  }
  const ids = new Set<string>();
  for (const p of parents) {
    if (ids.has(p.candidateId)) return "DUPLICATE";
    ids.add(p.candidateId);
  }
  if (!RESPONSIBILITY_TYPE_SET.has(merged.type)) {
    return `merged.typeが不正です: ${merged.type}`;
  }
  if (!merged.title || merged.title.trim().length === 0) {
    return "merged.titleが空です";
  }
  return null;
}

export async function mergeFormationCandidates(params: MergeCandidatesParams): Promise<MergeCandidatesResult> {
  const { sessionId, workspaceId, parents, merged, reasonCode, actorUserId, clientEventId } = params;

  const validationError = validateMergeInput(parents, merged);
  if (validationError === "DUPLICATE") {
    return { ok: false, error: "DUPLICATE_PARENT_CANDIDATE" };
  }
  if (validationError) {
    return { ok: false, error: "INVALID_MERGE_PARTS", reason: validationError };
  }

  const requestHash = computeMergeRequestHash({ sessionId, workspaceId, parents, merged });

  // [DEC-MERGE-001「同一idempotency再送は同じ結果」] tx外の高速path事前確認
  // (materializeFormationSessionと同じ二段構え。真の排他性はDB unique制約と
  // tx内の再確認で保証する)。
  const existingMergeEvent = await db.formationCandidateMergeEvent.findFirst({
    where: { workspaceId, clientEventId },
  });
  if (existingMergeEvent) {
    if (existingMergeEvent.requestHash !== requestHash) {
      return { ok: false, error: "IDEMPOTENCY_KEY_REUSED" };
    }
    const newIdentity = await db.formationCandidateIdentity.findFirst({
      where: { id: existingMergeEvent.newCandidateId, workspaceId },
    });
    const newRevision = newIdentity
      ? await db.formationCandidateRevision.findFirst({ where: { candidateId: newIdentity.id, workspaceId, revision: 1 } })
      : null;
    // [R1-03是正・監査是正指示書2026-08-31] MergeEvent行が実在するのに、それが
    // 指すはずのCandidateIdentity/Revisionが見つからないのはデータ不整合
    // (通常発生しない)。空文字で「成功」を返す代わりに明示的に拒否する。
    if (!newIdentity || !newRevision) {
      return { ok: false, error: "REPLAY_INTEGRITY_ERROR", mergeEventId: existingMergeEvent.id };
    }
    const parentDecisionEvents = await db.formationCandidateDecisionEvent.findMany({
      where: { workspaceId, candidateId: { in: parents.map((p) => p.candidateId) }, decision: "MERGED" },
    });
    return {
      ok: true,
      replay: true,
      newCandidateId: existingMergeEvent.newCandidateId,
      newCandidateKey: newIdentity.candidateKey,
      newRevisionId: newRevision.id,
      parentDecisionEventIds: parentDecisionEvents.map((e) => e.id),
    };
  }

  return await db.$transaction(async (tx: Prisma.TransactionClient) => {
    const sessionRows = await tx.$queryRaw<{ id: string; state: string }[]>`
      SELECT id, state FROM formation_sessions
      WHERE id = ${sessionId} AND workspace_id = ${workspaceId}
      FOR UPDATE`;
    const session = sessionRows[0];
    if (!session) return { ok: false, error: "NOT_FOUND" } as const;

    // [B3.1と同じraceガード] lock獲得後、再度idempotency確認する。
    const existingInTx = await tx.formationCandidateMergeEvent.findFirst({ where: { workspaceId, clientEventId } });
    if (existingInTx) {
      if (existingInTx.requestHash !== requestHash) {
        return { ok: false, error: "IDEMPOTENCY_KEY_REUSED" } as const;
      }
      const newIdentity = await tx.formationCandidateIdentity.findFirst({ where: { id: existingInTx.newCandidateId, workspaceId } });
      const newRevision = newIdentity
        ? await tx.formationCandidateRevision.findFirst({ where: { candidateId: newIdentity.id, workspaceId, revision: 1 } })
        : null;
      if (!newIdentity || !newRevision) {
        return { ok: false, error: "REPLAY_INTEGRITY_ERROR", mergeEventId: existingInTx.id } as const;
      }
      const parentDecisionEvents = await tx.formationCandidateDecisionEvent.findMany({
        where: { workspaceId, candidateId: { in: parents.map((p) => p.candidateId) }, decision: "MERGED" },
      });
      return {
        ok: true,
        replay: true,
        newCandidateId: existingInTx.newCandidateId,
        newCandidateKey: newIdentity.candidateKey,
        newRevisionId: newRevision.id,
        parentDecisionEventIds: parentDecisionEvents.map((e) => e.id),
      } as const;
    }

    if (session.state !== "REVIEW_READY" && session.state !== "PARTIALLY_CONFIRMED") {
      return { ok: false, error: "INVALID_SESSION_STATE", sessionState: session.state } as const;
    }

    // [DEC-MERGE-001「対象重複・越境・既決定・既Materialize・legacy conflictを拒否」]
    const legacyMap = await resolveLegacyProjectionMap(tx, { sessionId, workspaceId });

    const parentIdentities: { id: string; candidateKey: string; revisionId: string }[] = [];
    for (const parentInput of parents) {
      // where句にsessionId/workspaceIdを含めることで「越境」(別Session/別workspace)
      // の候補は自動的にNOT_FOUNDになる(想像で個別の越境checkを足さない、
      // 既存recordCandidateDecision/splitFormationCandidateと同じ設計)。
      const identity = await tx.formationCandidateIdentity.findFirst({
        where: { id: parentInput.candidateId, sessionId, workspaceId },
      });
      if (!identity) return { ok: false, error: "NOT_FOUND" } as const;

      if (identity.currentRevision !== parentInput.expectedRevision) {
        return {
          ok: false,
          error: "REVISION_CONFLICT",
          candidateId: identity.id,
          latestRevision: identity.currentRevision,
        } as const;
      }

      const legacyEntry = legacyMap?.byCandidateKey.get(identity.candidateKey) ?? null;
      if (legacyEntry) {
        if (legacyEntry.decision === "ACCEPTED" || legacyEntry.decision === "EDITED") {
          if (legacyEntry.responsibilityId) {
            return {
              ok: false,
              error: "ALREADY_MATERIALIZED_BY_LEGACY",
              candidateId: identity.id,
              legacyInferenceId: legacyEntry.inferenceId,
              legacyDecision: legacyEntry.decision,
            } as const;
          }
          return {
            ok: false,
            error: "LEGACY_PROJECTION_CONFLICT",
            candidateId: identity.id,
            legacyInferenceId: legacyEntry.inferenceId,
            legacyDecision: legacyEntry.decision,
          } as const;
        }
        if (legacyEntry.decision === "REJECTED" || legacyEntry.decision === "HELD") {
          return {
            ok: false,
            error: "ALREADY_DECIDED_BY_LEGACY",
            candidateId: identity.id,
            legacyInferenceId: legacyEntry.inferenceId,
            legacyDecision: legacyEntry.decision,
          } as const;
        }
      }

      const existingDecision = await tx.formationCandidateDecisionEvent.findFirst({
        where: { candidateId: identity.id, workspaceId },
        orderBy: { occurredAt: "desc" },
      });
      if (existingDecision) {
        return {
          ok: false,
          error: "ALREADY_DECIDED",
          candidateId: identity.id,
          existingDecision: existingDecision.decision,
        } as const;
      }

      const revision = await tx.formationCandidateRevision.findFirst({
        where: { candidateId: identity.id, workspaceId, revision: parentInput.expectedRevision },
      });
      if (!revision) return { ok: false, error: "NOT_FOUND" } as const;

      parentIdentities.push({ id: identity.id, candidateKey: identity.candidateKey, revisionId: revision.id });
    }

    // [R1-01是正・監査是正指示書2026-08-31] 全親Revisionのproposed Fieldsを、
    // どのDecisionEvent/lineage/MergeEvent書込みよりも前にparseする。parse不能な
    // 親が1件でもあれば、ここで何も書き込まずCORRUPTED_CANDIDATE_DATAで拒否する
    // (以前はこのparseがDecisionEvent/SessionEvent作成の後段(旧336行目付近)で
    // 行われており、parse失敗時に架空Evidence[{start:0,end:1}]を生成していた)。
    const parentRevisionRows = await tx.formationCandidateRevision.findMany({
      where: { id: { in: parentIdentities.map((p) => p.revisionId) }, workspaceId },
    });
    const parentRevisionById = new Map(parentRevisionRows.map((r) => [r.id, r]));
    const representativeEvidenceSpans: { start: number; end: number }[] = [];
    for (const parent of parentIdentities) {
      const rev = parentRevisionById.get(parent.revisionId);
      if (!rev) {
        return { ok: false, error: "CORRUPTED_CANDIDATE_DATA", candidateId: parent.id } as const;
      }
      const parsed = ResponsibilityCandidateSchema.safeParse(rev.proposedFields);
      if (!parsed.success) {
        return { ok: false, error: "CORRUPTED_CANDIDATE_DATA", candidateId: parent.id } as const;
      }
      // ResponsibilityCandidateSchemaはevidenceSpans min(1)必須のため、parseが
      // 成功した時点で必ず1件以上存在する(架空値を補う必要が無い)。
      representativeEvidenceSpans.push(parsed.data.evidenceSpans[0]);
    }
    if (representativeEvidenceSpans.length === 0) {
      // [R1-01「実Anchorと実Evidenceの双方が無い場合は拒否」]
      // 全親parse成功時は上のpushにより通常到達しない防御的分岐。捏造せず拒否する。
      return { ok: false, error: "SOURCE_EVIDENCE_UNAVAILABLE" } as const;
    }

    // [DEC-MERGE-001「各候補へMERGED Correction/Decision Eventをappend」]
    const parentDecisionEventIds: string[] = [];
    for (const parent of parentIdentities) {
      const decisionEvent = await tx.formationCandidateDecisionEvent.create({
        data: {
          workspaceId,
          candidateId: parent.id,
          revisionId: parent.revisionId,
          decision: "MERGED",
          reasonCode: reasonCode ?? null,
          actorUserId,
        },
      });
      parentDecisionEventIds.push(decisionEvent.id);
    }

    const lastSessionEvent = await tx.formationSessionEvent.findFirst({
      where: { sessionId, workspaceId },
      orderBy: { sequence: "desc" },
    });
    let nextSequence = (lastSessionEvent?.sequence ?? 0) + 1;

    for (const parent of parentIdentities) {
      await tx.formationSessionEvent.create({
        data: {
          workspaceId,
          sessionId,
          sequence: nextSequence++,
          eventType: sessionEventTypeForDecision("MERGED"),
          actorType: "USER",
          actorUserId,
          payload: { candidateId: parent.id, candidateKey: parent.candidateKey, decision: "MERGED", revisionId: parent.revisionId },
        },
      });
    }

    // [DEC-MERGE-001「新しいCandidate Identity/Revisionを同一transactionで作る」]
    // [R1-03是正・監査是正指示書2026-08-31] 以前は先頭3候補名の連結
    // (`merged-${key1}+${key2}+${key3}`)だったため、同一Session内で構成要素が
    // 異なる別のMerge操作が同じ先頭3候補名を持つ場合に衝突し得た
    // (`formation_candidate_identities_session_key_uq`違反)。requestHashは
    // parents/merged内容から決定論的に算出済み(=このMerge要求そのものを
    // 一意に表す)であり、これに由来する値を使うことでSession内衝突を防ぐ。
    const newCandidateKey = `merged-${requestHash.slice(0, 16)}`;
    const newIdentity = await tx.formationCandidateIdentity.create({
      data: { workspaceId, sessionId, candidateKey: newCandidateKey },
    });

    // [R1-01是正・DEC-MERGE-001「根拠が無い場合は空/UNKNOWNとして表し、offsetを
    // 捏造しない」] 統合後の候補は本人が明示入力した新しい内容であり、原文中の
    // 新しい単一の根拠位置は存在しない。evidenceSpansはResponsibilityCandidateSchema
    // 上必須(min 1)のため、上でtx冒頭にて全親から実在するevidenceを確認・収集
    // 済みのrepresentativeEvidenceSpansをそのまま使う(捏造ではなく、実在する
    // 親のevidenceを引き継ぐ選択。SourceAnchor自体は全親から重複排除して継承
    // するため、Anchor側の記録は正確に保たれる)。
    const mergedCandidate: ResponsibilityCandidate = {
      candidateId: newCandidateKey,
      type: merged.type as ResponsibilityCandidate["type"],
      title: merged.title,
      description: merged.description,
      completionCondition: merged.completionCondition,
      evidenceSpans: representativeEvidenceSpans,
      // [設計判断・splitCorrection.tsと同じ] 本人が明示確認した内容のため1(最大)。
      confidence: 1,
      dateMentions: [],
      unknowns: [],
      blockedByCandidateIds: [],
      suggestedTags: [],
      // [M1-B6B追加] 本人が統合を明示確定させた候補のため、質問すべき曖昧性は
      // 無い(clarificationSignalsは空)。
      clarificationSignals: [],
    };

    const newRevision = await tx.formationCandidateRevision.create({
      data: {
        workspaceId,
        candidateId: newIdentity.id,
        revision: 1,
        type: merged.type,
        title: merged.title,
        description: merged.description ?? null,
        proposedFields: mergedCandidate as unknown as object,
        confidence: 1,
        schemaVersion: parentRevisionRows[0]?.schemaVersion ?? "1.0",
      },
    });

    await tx.formationCandidateIdentity.update({
      where: { id: newIdentity.id },
      data: { currentRevision: 1 },
    });

    // [DEC-MERGE-001「親candidate/revisionのlineageをDBで照会可能にする」]
    for (const parent of parentIdentities) {
      await tx.formationCandidateLineage.create({
        data: {
          workspaceId,
          childRevisionId: newRevision.id,
          parentIdentityId: parent.id,
          parentRevisionId: parent.revisionId,
          correctionKind: "MERGE",
        },
      });
    }

    // [DEC-MERGE-001「全親Source Anchorを重複排除して継承する」]
    const parentAnchors = await tx.formationSourceAnchor.findMany({
      where: { revisionId: { in: parentIdentities.map((p) => p.revisionId) }, workspaceId },
    });
    const seenAnchorKeys = new Set<string>();
    for (const anchor of parentAnchors) {
      // [R1-03是正・監査是正指示書2026-08-31] 以前はsourceKind/startOffset/
      // endOffset/excerptHashのみで、captureId・imageRegionを含んでいなかった。
      // 異なるCaptureの同じoffset範囲(偶然一致)や、IMAGE_BBOXのregion違いを
      // 誤って同一視し得たため、captureIdとimageRegionの正規化文字列を加える。
      // [M1-B6A追加・2026-08-31指示書§3.2.1「異なる根拠を誤って同一視し得る」]
      // audio timecode/speaker/pageも同様の理由で追加する。
      const dedupeKey = [
        anchor.sourceKind,
        anchor.captureId,
        anchor.startOffset ?? "null",
        anchor.endOffset ?? "null",
        JSON.stringify(anchor.imageRegion ?? null),
        anchor.audioStartMs ?? "null",
        anchor.audioEndMs ?? "null",
        anchor.speakerLabel ?? "null",
        anchor.pageIndex ?? "null",
        anchor.excerptHash,
      ].join(":");
      if (seenAnchorKeys.has(dedupeKey)) continue;
      seenAnchorKeys.add(dedupeKey);
      await tx.formationSourceAnchor.create({
        data: {
          workspaceId,
          revisionId: newRevision.id,
          sourceKind: anchor.sourceKind,
          captureId: anchor.captureId,
          startOffset: anchor.startOffset,
          endOffset: anchor.endOffset,
          imageRegion: anchor.imageRegion ?? undefined,
          excerptHash: anchor.excerptHash,
          piiClassification: anchor.piiClassification,
          // [M1-B6A追加・2026-08-31指示書§3.2.3「Split/Mergeは全kind固有field
          // を正確に継承し、dedupeしても根拠を失わない」]
          audioStartMs: anchor.audioStartMs,
          audioEndMs: anchor.audioEndMs,
          segmentIndex: anchor.segmentIndex,
          speakerLabel: anchor.speakerLabel,
          speakerConfirmed: anchor.speakerConfirmed,
          pageIndex: anchor.pageIndex,
          ocrConfidence: anchor.ocrConfidence ?? undefined,
          quality: anchor.quality,
          unavailableReason: anchor.unavailableReason,
          anchorSchemaVersion: anchor.anchorSchemaVersion,
        },
      });
    }

    // [DEC-MERGE-001「新候補のAtomicity Assessmentを同一transaction内で作る」]
    const mergedAssessment = assessAtomicity(mergedCandidate);
    await tx.formationAtomicityAssessment.create({
      data: {
        workspaceId,
        revisionId: newRevision.id,
        assessment: mergedAssessment.assessment,
        reasonCode: mergedAssessment.reasonCode,
        evidence: mergedAssessment.evidence as unknown as object,
        confidence: mergedAssessment.confidence,
        algorithmVersion: mergedAssessment.algorithmVersion,
      },
    });

    await tx.formationSessionEvent.create({
      data: {
        workspaceId,
        sessionId,
        sequence: nextSequence++,
        eventType: "CANDIDATE_CREATED",
        actorType: "USER",
        actorUserId,
        payload: {
          candidateKey: newCandidateKey,
          revisionId: newRevision.id,
          type: merged.type,
          mergedFromCandidateIds: parentIdentities.map((p) => p.id),
          mergedFromCandidateKeys: parentIdentities.map((p) => p.candidateKey),
        },
      },
    });

    // [DEC-MERGE-001「idempotency key + request hash」の記録本体]
    await tx.formationCandidateMergeEvent.create({
      data: {
        workspaceId,
        sessionId,
        clientEventId,
        requestHash,
        newCandidateId: newIdentity.id,
        actorUserId,
      },
    });

    debugServer.event("formation/mergeCorrection", "CANDIDATES_MERGED", {
      sessionId,
      parentCandidateIds: parentIdentities.map((p) => p.id),
      newCandidateId: newIdentity.id,
    });

    return {
      ok: true,
      replay: false,
      newCandidateId: newIdentity.id,
      newCandidateKey,
      newRevisionId: newRevision.id,
      parentDecisionEventIds,
    } as const;
  });
}
