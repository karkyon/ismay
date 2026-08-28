import { db } from "@/lib/db";
import { ResponsibilityCandidateSchema } from "@/lib/ai/schema";

/**
 * V5-M1-B2 Formation Session dual-read。
 * 出典: ISMAY-V5-DOC-03(Formation Session仕様書) 10章「B2は既存Inference decisionと
 *       dual-read」。
 *
 * [設計方針・スコープ] このGate(M1-B2)は、B1(shadowWrite.ts)が書き込んだ
 * FormationSession/CandidateIdentity/Revisionと、既存の`/api/v1/inferences/[id]/decision`
 * が書き込むAiInference.decisionを、**読み取り専用**で突合するだけである。
 *
 * 明示的にやらないこと:
 * - FormationCandidateDecisionEventへの書込み(これはB3「Materialize serviceへ
 *   single-write」の役割)。
 * - FormationSession.state遷移(REVIEW_READY→PARTIALLY_CONFIRMED/CONFIRMED等)。
 * - 既存`/inferences/[id]/decision`route.tsの変更。
 *
 * B1のshadowWriteはANALYSIS_REQUESTED Eventのpayloadに`aiRunId`を保存しているため、
 * これを鍵にAiInference(captureId, aiRunId)を引き、FormationCandidateIdentity.candidateKey
 * とAiInference.payload.candidateIdで1:1突合する(shadowWriteと同じ突合方式、
 * scripts/verify_gate_m1b1_shadow_acceptance.tsが検証したのと同じ対応関係を再利用する)。
 */

export interface FormationDualReadCandidate {
  /** FormationCandidateIdentity.id */
  candidateId: string;
  /** Session内安定キー(AiInference.payload.candidateIdと同じ値のはず) */
  candidateKey: string;
  /** shadow側(B1書込み)の現在地。FormationCandidateIdentityが存在すれば必ず取れる。 */
  shadow: {
    currentRevision: number;
    type: string;
    title: string;
    confidence: number;
  } | null;
  /** 正本側(既存/inferences/[id]/decision経由の実決定)。対応するAiInferenceが
   *  見つからない場合はnull(shadow書込みの対象外だった、または未実装経路)。 */
  real: {
    inferenceId: string;
    decision: string;
    decidedAt: string | null;
    responsibilityId: string | null;
  } | null;
}

export interface FormationDualReadProjection {
  sessionId: string;
  captureId: string;
  workspaceId: string;
  /** ANALYSIS_REQUESTED Eventから復元したaiRunId。取得できない場合はnull
   *  (B1書込みが何らかの理由で失敗しEventが無いケース)。 */
  aiRunId: string | null;
  sessionState: string;
  candidates: FormationDualReadCandidate[];
  /** 正本(AiInference)には存在するが、対応するshadow候補が見つからなかったもの
   *  (shadow書込みの取りこぼしを検知するための診断フィールド)。 */
  unmatchedInferenceIds: string[];
}

/**
 * sessionId(tenant境界: workspaceId一致)から dual-read projection を組み立てる。
 * 純粋な読み取りのみ行い、いかなるテーブルへも書込みしない。
 */
export async function buildFormationDualReadProjection(
  sessionId: string,
  workspaceId: string,
): Promise<FormationDualReadProjection | null> {
  const session = await db.formationSession.findFirst({
    where: { id: sessionId, workspaceId },
  });
  if (!session) return null;

  const analysisRequestedEvent = await db.formationSessionEvent.findFirst({
    where: { sessionId: session.id, workspaceId, eventType: "ANALYSIS_REQUESTED" },
    orderBy: { sequence: "asc" },
  });
  const aiRunId =
    analysisRequestedEvent && typeof (analysisRequestedEvent.payload as { aiRunId?: unknown })?.aiRunId === "string"
      ? ((analysisRequestedEvent.payload as { aiRunId: string }).aiRunId)
      : null;

  const identities = await db.formationCandidateIdentity.findMany({
    where: { sessionId: session.id, workspaceId },
  });

  const aiInferences = aiRunId
    ? await db.aiInference.findMany({
        where: { captureId: session.captureId, aiRunId },
      })
    : [];

  // AiInference.payload.candidateId -> AiInference行 のmap(不正payloadはスキップ)
  const inferenceByCandidateKey = new Map<string, (typeof aiInferences)[number]>();
  for (const inference of aiInferences) {
    const parsed = ResponsibilityCandidateSchema.safeParse(inference.payload);
    if (!parsed.success) continue;
    inferenceByCandidateKey.set(parsed.data.candidateId, inference);
  }

  const candidates: FormationDualReadCandidate[] = [];
  const matchedCandidateKeys = new Set<string>();

  for (const identity of identities) {
    matchedCandidateKeys.add(identity.candidateKey);

    const revision = await db.formationCandidateRevision.findFirst({
      where: { candidateId: identity.id, workspaceId, revision: identity.currentRevision },
    });

    const matchedInference = inferenceByCandidateKey.get(identity.candidateKey) ?? null;
    let responsibilityId: string | null = null;
    if (matchedInference && (matchedInference.decision === "ACCEPTED" || matchedInference.decision === "EDITED")) {
      const responsibility = await db.responsibility.findFirst({
        where: { originInferenceId: matchedInference.id, workspaceId },
        select: { id: true },
      });
      responsibilityId = responsibility?.id ?? null;
    }

    candidates.push({
      candidateId: identity.id,
      candidateKey: identity.candidateKey,
      shadow: revision
        ? {
            currentRevision: revision.revision,
            type: revision.type,
            title: revision.title,
            confidence: Number(revision.confidence),
          }
        : null,
      real: matchedInference
        ? {
            inferenceId: matchedInference.id,
            decision: matchedInference.decision,
            decidedAt: matchedInference.decidedAt ? matchedInference.decidedAt.toISOString() : null,
            responsibilityId,
          }
        : null,
    });
  }

  const unmatchedInferenceIds = aiInferences
    .filter((inference: (typeof aiInferences)[number]) => {
      const parsed = ResponsibilityCandidateSchema.safeParse(inference.payload);
      return !parsed.success || !matchedCandidateKeys.has(parsed.data.candidateId);
    })
    .map((inference: (typeof aiInferences)[number]) => inference.id);

  return {
    sessionId: session.id,
    captureId: session.captureId,
    workspaceId: session.workspaceId,
    aiRunId,
    sessionState: session.state,
    candidates,
    unmatchedInferenceIds,
  };
}
