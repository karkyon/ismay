import { db } from "@/lib/db";
import { resolveLegacyProjectionMap } from "@/lib/formation/legacyProjectionResolver";

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
 * [B4.1是正・2026-08-29] このファイルに埋め込まれていた「FormationCandidateIdentityと
 * 旧AiInference/Responsibilityの決定論的対応付け」ロジックを
 * `@/lib/formation/legacyProjectionResolver`へ抽出した(監査「Gate M1-B4.1」3.2節)。
 * このファイルは、その共通resolverの結果を既存のdual-read応答形へ整形するだけの
 * 薄いadapterになった。突合方式自体(aiRunId→candidateKey→candidateId照合)は
 * 一切変更していない。
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

  const legacyMap = await resolveLegacyProjectionMap(db, { sessionId, workspaceId });
  if (!legacyMap) return null; // sessionが上のfindFirstで見つかっているため通常到達しない

  const identities = await db.formationCandidateIdentity.findMany({
    where: { sessionId: session.id, workspaceId },
  });

  const candidates: FormationDualReadCandidate[] = [];
  for (const identity of identities) {
    const revision = await db.formationCandidateRevision.findFirst({
      where: { candidateId: identity.id, workspaceId, revision: identity.currentRevision },
    });
    const legacyEntry = legacyMap.byCandidateKey.get(identity.candidateKey) ?? null;

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
      real: legacyEntry
        ? {
            inferenceId: legacyEntry.inferenceId,
            decision: legacyEntry.decision,
            decidedAt: legacyEntry.decidedAt,
            responsibilityId: legacyEntry.responsibilityId,
          }
        : null,
    });
  }

  return {
    sessionId: session.id,
    captureId: session.captureId,
    workspaceId: session.workspaceId,
    aiRunId: legacyMap.aiRunId,
    sessionState: session.state,
    candidates,
    unmatchedInferenceIds: legacyMap.unmatchedInferenceIds,
  };
}
