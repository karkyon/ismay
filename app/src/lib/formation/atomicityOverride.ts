import { db } from "@/lib/db";
import type { Prisma } from "@/generated/prisma/client";
import { ResponsibilityCandidateSchema } from "@/lib/ai/schema";
import { assessAtomicity } from "@/lib/formation/atomicityAssessment";

/**
 * V5-M1-C2A Atomicity Override service。
 * 出典: 2026-08-30確定指示書 Gate M1-C2A「SHOULD_DECOMPOSE/CONTEXT_LIKEは、
 * 本人の明示override EventまたはSplit/Merge/Editで解決したRevisionがない限り
 * 拒否する。overrideは本人操作、対象Revision固定、reason、occurredAt、
 * idempotencyを持つ。無回答や画面離脱をoverride扱いしない。」
 *
 * [設計方針] 本人がSPLIT/MERGEで実際に分解・統合するのではなく、「このまま
 * 単一のResponsibilityとしてMaterializeしてよい」と明示的に判断した場合の
 * 逃げ道。乱用防止のため、既にATOMIC/PROBABLY_ATOMICな候補へは
 * OVERRIDE_NOT_APPLICABLEを返し、無意味なoverride行を作らせない。
 */

export interface RecordAtomicityOverrideParams {
  sessionId: string;
  workspaceId: string;
  candidateId: string;
  expectedRevision: number;
  reasonCode: string;
  actorUserId: string;
}

export type RecordAtomicityOverrideResult =
  | { ok: true; overrideId: string; assessment: string }
  | { ok: false; error: "NOT_FOUND" }
  | { ok: false; error: "REVISION_CONFLICT"; latestRevision: number }
  | { ok: false; error: "OVERRIDE_NOT_APPLICABLE"; assessment: string };

export async function recordAtomicityOverride(
  params: RecordAtomicityOverrideParams,
): Promise<RecordAtomicityOverrideResult> {
  const { sessionId, workspaceId, candidateId, expectedRevision, reasonCode, actorUserId } = params;

  return await db.$transaction(async (tx: Prisma.TransactionClient) => {
    // [既存recordCandidateDecision/splitFormationCandidateと同じB3.1是正パターン]
    const sessionRows = await tx.$queryRaw<{ id: string }[]>`
      SELECT id FROM formation_sessions
      WHERE id = ${sessionId} AND workspace_id = ${workspaceId}
      FOR UPDATE`;
    if (!sessionRows[0]) return { ok: false, error: "NOT_FOUND" } as const;

    const identity = await tx.formationCandidateIdentity.findFirst({
      where: { id: candidateId, sessionId, workspaceId },
    });
    if (!identity) return { ok: false, error: "NOT_FOUND" } as const;

    if (identity.currentRevision !== expectedRevision) {
      return { ok: false, error: "REVISION_CONFLICT", latestRevision: identity.currentRevision } as const;
    }

    const revision = await tx.formationCandidateRevision.findFirst({
      where: { candidateId: identity.id, workspaceId, revision: expectedRevision },
    });
    if (!revision) return { ok: false, error: "NOT_FOUND" } as const;

    let assessmentRow = await tx.formationAtomicityAssessment.findFirst({
      where: { revisionId: revision.id, workspaceId },
    });
    if (!assessmentRow) {
      const parsed = ResponsibilityCandidateSchema.safeParse(revision.proposedFields);
      const computed = parsed.success
        ? assessAtomicity(parsed.data)
        : { assessment: "PROBABLY_ATOMIC" as const, reasonCode: "PARSE_FAILED_FALLBACK", evidence: [], confidence: 0, algorithmVersion: "v1" };
      assessmentRow = await tx.formationAtomicityAssessment.create({
        data: {
          workspaceId,
          revisionId: revision.id,
          assessment: computed.assessment,
          reasonCode: computed.reasonCode,
          evidence: computed.evidence as unknown as object,
          confidence: computed.confidence,
          algorithmVersion: computed.algorithmVersion,
        },
      });
    }

    if (assessmentRow.assessment !== "SHOULD_DECOMPOSE" && assessmentRow.assessment !== "CONTEXT_LIKE") {
      return { ok: false, error: "OVERRIDE_NOT_APPLICABLE", assessment: assessmentRow.assessment } as const;
    }

    // [idempotency] 1 Revisionにつき高々1件(schema.prisma unique制約)。
    // 既存行があれば新規作成せず、その行を返す(再送安全)。
    const existing = await tx.formationAtomicityOverride.findFirst({
      where: { revisionId: revision.id, workspaceId },
    });
    if (existing) {
      return { ok: true, overrideId: existing.id, assessment: assessmentRow.assessment } as const;
    }

    const created = await tx.formationAtomicityOverride.create({
      data: { workspaceId, revisionId: revision.id, reasonCode, actorUserId },
    });

    return { ok: true, overrideId: created.id, assessment: assessmentRow.assessment } as const;
  });
}
