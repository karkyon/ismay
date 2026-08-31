import { createHash } from "node:crypto";
import { db } from "@/lib/db";
import type { Prisma } from "@/generated/prisma/client";
import { ResponsibilityCandidateSchema } from "@/lib/ai/schema";
import { assessAtomicity } from "@/lib/formation/atomicityAssessment";
import { resolveLegacyProjectionMap } from "@/lib/formation/legacyProjectionResolver";

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
 *
 * [R1-02是正・監査是正指示書2026-08-31] 実コード監査(69b5a87時点)で次の欠陥が
 * 判明したため是正した。
 * - proposedFieldsのparse失敗を`PROBABLY_ATOMIC/PARSE_FAILED_FALLBACK`という
 *   安全側でない評価へ倒し、その行をDBへ確定保存していた(materialize.ts自体は
 *   独立にparseし直しCORRUPTED_CANDIDATE_DATAで別途弾くため実害は限定的だが、
 *   誤った評価が監査証跡として残り、override要求者には「適用不可
 *   (=既にATOMIC)」という誤った理由が返っていた)。→ parse失敗はここで
 *   materialize.ts/splitCorrection.ts/mergeCorrection.tsと同じ
 *   CORRUPTED_CANDIDATE_DATAとして即座に拒否し、フォールバック評価行を
 *   一切作らない。
 * - Session状態・既決定・legacy conflictの確認が無く、DRAFT/CONFIRMED等の
 *   Sessionや既にACCEPT/REJECT等が記録された候補に対してもoverride行を
 *   作成できてしまっていた。→ recordCandidateDecision/mergeFormationCandidates
 *   と同じ「Session行FOR UPDATE配下でstate・legacy射影・既存Decisionを確認」
 *   パターンへ揃えた。
 * - clientEventId/requestHashが無く、「同一Revisionなら理由が違っても
 *   既存行を返す」だけの弱いidempotencyだった。→ Answer/Merge APIと同じ
 *   clientEventId+requestHash契約を追加した(同一key・同一内容の再送は
 *   同じ結果、内容が違えば試行を拒否)。Revision単位の一意制約
 *   (`formation_atomicity_overrides_revision_uq`)は「1 Revisionにつき
 *   override高々1件」という業務不変条件の最終防衛線として維持する。
 */

export interface RecordAtomicityOverrideParams {
  sessionId: string;
  workspaceId: string;
  candidateId: string;
  expectedRevision: number;
  reasonCode: string;
  actorUserId: string;
  /** [R1-02新設] Answer/Merge APIと同じ設計のidempotency key。 */
  clientEventId: string;
}

export type RecordAtomicityOverrideResult =
  | { ok: true; overrideId: string; assessment: string; replay: boolean }
  | { ok: false; error: "NOT_FOUND" }
  | { ok: false; error: "INVALID_REASON_CODE" }
  | { ok: false; error: "INVALID_SESSION_STATE"; sessionState: string }
  | { ok: false; error: "REVISION_CONFLICT"; latestRevision: number }
  | { ok: false; error: "ALREADY_DECIDED"; existingDecision: string }
  | { ok: false; error: "ALREADY_MATERIALIZED_BY_LEGACY"; legacyInferenceId: string; legacyDecision: string }
  | { ok: false; error: "ALREADY_DECIDED_BY_LEGACY"; legacyInferenceId: string; legacyDecision: string }
  | { ok: false; error: "LEGACY_PROJECTION_CONFLICT"; legacyInferenceId: string; legacyDecision: string }
  // [R1-02新設] proposedFieldsのparse失敗を安全側でなく許可側へ倒さないための拒否。
  | { ok: false; error: "CORRUPTED_CANDIDATE_DATA" }
  | { ok: false; error: "OVERRIDE_NOT_APPLICABLE"; assessment: string }
  | { ok: false; error: "IDEMPOTENCY_KEY_REUSED" };

function computeOverrideRequestHash(input: {
  sessionId: string;
  workspaceId: string;
  candidateId: string;
  expectedRevision: number;
  reasonCode: string;
}): string {
  const payload = JSON.stringify({
    sessionId: input.sessionId,
    workspaceId: input.workspaceId,
    candidateId: input.candidateId,
    expectedRevision: input.expectedRevision,
    reasonCode: input.reasonCode,
  });
  return createHash("sha256").update(payload).digest("hex");
}

export async function recordAtomicityOverride(
  params: RecordAtomicityOverrideParams,
): Promise<RecordAtomicityOverrideResult> {
  const { sessionId, workspaceId, candidateId, expectedRevision, reasonCode, actorUserId, clientEventId } = params;

  // [R1-02「reasonCode空白禁止」] API route側でもz.string().min(1)を課しているが、
  // service層は単体でも呼ばれ得る前提のため二重に守る(mergeCorrection.tsの
  // validateMergeInputと同じ考え方)。
  if (!reasonCode || reasonCode.trim().length === 0) {
    return { ok: false, error: "INVALID_REASON_CODE" };
  }

  const requestHash = computeOverrideRequestHash({ sessionId, workspaceId, candidateId, expectedRevision, reasonCode });

  return await db.$transaction(async (tx: Prisma.TransactionClient) => {
    // [既存recordCandidateDecision/mergeFormationCandidatesと同じB3.1是正パターン]
    const sessionRows = await tx.$queryRaw<{ id: string; state: string }[]>`
      SELECT id, state FROM formation_sessions
      WHERE id = ${sessionId} AND workspace_id = ${workspaceId}
      FOR UPDATE`;
    const session = sessionRows[0];
    if (!session) return { ok: false, error: "NOT_FOUND" } as const;

    // [R1-02「clientEventId/requestHash」] Session行lock配下のため、この時点の
    // 確認はrace無く信頼できる(mergeFormationCandidatesと同じ設計)。
    const existingByClientEventId = await tx.formationAtomicityOverride.findFirst({
      where: { workspaceId, clientEventId },
    });
    if (existingByClientEventId) {
      if (existingByClientEventId.requestHash !== requestHash) {
        return { ok: false, error: "IDEMPOTENCY_KEY_REUSED" } as const;
      }
      const assessmentForReplay = await tx.formationAtomicityAssessment.findFirst({
        where: { revisionId: existingByClientEventId.revisionId, workspaceId },
      });
      return {
        ok: true,
        replay: true,
        overrideId: existingByClientEventId.id,
        assessment: assessmentForReplay?.assessment ?? "UNKNOWN",
      } as const;
    }

    // [R1-02新設「Session stateをREVIEW_READY/PARTIALLY_CONFIRMEDへ限定」]
    if (session.state !== "REVIEW_READY" && session.state !== "PARTIALLY_CONFIRMED") {
      return { ok: false, error: "INVALID_SESSION_STATE", sessionState: session.state } as const;
    }

    const identity = await tx.formationCandidateIdentity.findFirst({
      where: { id: candidateId, sessionId, workspaceId },
    });
    if (!identity) return { ok: false, error: "NOT_FOUND" } as const;

    if (identity.currentRevision !== expectedRevision) {
      return { ok: false, error: "REVISION_CONFLICT", latestRevision: identity.currentRevision } as const;
    }

    // [R1-02新設「既決定・既Materialize・legacy conflictを拒否」]
    // recordCandidateDecision/mergeFormationCandidatesと同じ旧新横断guard。
    const legacyMap = await resolveLegacyProjectionMap(tx, { sessionId, workspaceId });
    const legacyEntry = legacyMap?.byCandidateKey.get(identity.candidateKey) ?? null;
    if (legacyEntry) {
      if (legacyEntry.decision === "ACCEPTED" || legacyEntry.decision === "EDITED") {
        if (legacyEntry.responsibilityId) {
          return {
            ok: false,
            error: "ALREADY_MATERIALIZED_BY_LEGACY",
            legacyInferenceId: legacyEntry.inferenceId,
            legacyDecision: legacyEntry.decision,
          } as const;
        }
        return {
          ok: false,
          error: "LEGACY_PROJECTION_CONFLICT",
          legacyInferenceId: legacyEntry.inferenceId,
          legacyDecision: legacyEntry.decision,
        } as const;
      }
      if (legacyEntry.decision === "REJECTED" || legacyEntry.decision === "HELD") {
        return {
          ok: false,
          error: "ALREADY_DECIDED_BY_LEGACY",
          legacyInferenceId: legacyEntry.inferenceId,
          legacyDecision: legacyEntry.decision,
        } as const;
      }
    }

    // [是正・実機検証で発覚(2026-08-31)] recordCandidateDecision/mergeFormationCandidates
    // と異なり、overrideは「まだ決定されていない候補」に対する操作ではない。
    // 正規のflowは「ACCEPTED決定 → (SHOULD_DECOMPOSE/CONTEXT_LIKEなら)override
    // → materialize」であり、ACCEPTED決定の存在はoverrideの前提条件であって
    // 拒否理由ではない(verify_gate_m1c2a M1C2A.11「SHOULD_DECOMPOSE候補もACCEPT
    // 自体は成功する(Guardはmaterialize時のみ)」と整合)。ACCEPTED以外
    // (REJECTED/DEFERRED/DO_NOT_MATERIALIZE/SPLIT/MERGED)の確定的な決定が既に
    // 記録されている場合のみ、override対象として不適切なためALREADY_DECIDEDで
    // 拒否する。
    const existingDecision = await tx.formationCandidateDecisionEvent.findFirst({
      where: { candidateId: identity.id, workspaceId },
      orderBy: { occurredAt: "desc" },
    });
    if (existingDecision && existingDecision.decision !== "ACCEPTED") {
      return { ok: false, error: "ALREADY_DECIDED", existingDecision: existingDecision.decision } as const;
    }

    const revision = await tx.formationCandidateRevision.findFirst({
      where: { candidateId: identity.id, workspaceId, revision: expectedRevision },
    });
    if (!revision) return { ok: false, error: "NOT_FOUND" } as const;

    let assessmentRow = await tx.formationAtomicityAssessment.findFirst({
      where: { revisionId: revision.id, workspaceId },
    });
    if (!assessmentRow) {
      // [R1-02是正・fail-closed] parse失敗を`PROBABLY_ATOMIC`へ倒さない。
      // parseできない=候補の中身を評価できない、という事実そのものを
      // CORRUPTED_CANDIDATE_DATAとして即座に返し、誤った評価行を作らない。
      const parsed = ResponsibilityCandidateSchema.safeParse(revision.proposedFields);
      if (!parsed.success) {
        return { ok: false, error: "CORRUPTED_CANDIDATE_DATA" } as const;
      }
      const computed = assessAtomicity(parsed.data);
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

    // [既存revisionId一意制約(業務不変条件の最終防衛線)] 何らかの理由で
    // clientEventIdが一致しないまま既にこのRevisionへoverrideが記録済みの
    // 場合(例: 別クライアントからの再試行で異なるclientEventIdが使われた)、
    // overrideという操作自体は単調(一度許可されたら再度許可し直しても
    // 安全)なため、新規行を作らず既存行を返す(以前と同じ安全側の再利用)。
    const existingByRevision = await tx.formationAtomicityOverride.findFirst({
      where: { revisionId: revision.id, workspaceId },
    });
    if (existingByRevision) {
      return { ok: true, replay: true, overrideId: existingByRevision.id, assessment: assessmentRow.assessment } as const;
    }

    const created = await tx.formationAtomicityOverride.create({
      data: { workspaceId, revisionId: revision.id, reasonCode, actorUserId, clientEventId, requestHash },
    });

    return { ok: true, replay: false, overrideId: created.id, assessment: assessmentRow.assessment } as const;
  });
}
