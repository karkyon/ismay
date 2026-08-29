import type { Prisma } from "@/generated/prisma/client";
import { ResponsibilityCandidateSchema } from "@/lib/ai/schema";

/**
 * V5-M1-B4.1 legacy projection resolver。
 * 出典: 監査「Gate M1-B4.1」3.2節「既存dual-read mappingを共通resolverへ抽出」。
 *
 * [経緯] `dualRead.ts`(B2)に埋め込まれていた「FormationCandidateIdentityと
 * 旧AiInference/Responsibilityの決定論的対応付け」ロジックを、read-onlyの
 * 共通関数へ抽出した。`dualRead.ts`(診断API)と`materialize.ts`の
 * `recordCandidateDecision`(旧新横断guard、B4.1 3.3節)の両方がこの関数を呼ぶ。
 *
 * 対応付けの鍵(想像・推測は一切含まない、既存B1/B2実装がそのまま使っていたもの):
 *   1. FormationSessionの`ANALYSIS_REQUESTED` Eventのpayloadから`aiRunId`を得る。
 *   2. `(captureId, aiRunId)`でAiInference群を得る。
 *   3. `FormationCandidateIdentity.candidateKey`と
 *      `ResponsibilityCandidateSchema(AiInference.payload).candidateId`を照合する。
 *   4. 対応する既存Responsibilityを`originInferenceId`で得る。
 * candidateIdの推測・title一致・配列順一致は一切行わない。
 *
 * この関数はいかなるテーブルへも書込みを行わない(read-only)。
 */

export interface LegacyProjectionEntry {
  /** AiInference.id */
  inferenceId: string;
  /** PENDING/ACCEPTED/EDITED/REJECTED/HELD */
  decision: string;
  decidedAt: string | null;
  /** decision=ACCEPTED/EDITEDの場合のみ、対応するResponsibility.id。
   *  データ破損(ACCEPTED/EDITEDなのにResponsibilityが無い)の場合はnullのまま返し、
   *  呼び出し元がその破損自体を検知できるようにする(想像で補完しない)。 */
  responsibilityId: string | null;
}

export interface LegacyProjectionMap {
  /** ANALYSIS_REQUESTED Eventから復元したaiRunId。取得できない場合はnull。 */
  aiRunId: string | null;
  /** FormationCandidateIdentity.candidateKey -> legacy projection。
   *  対応するAiInferenceが無い候補(shadow書込みの取りこぼし、または
   *  そもそもAiInference経由で採否されたことが無い候補)はmapに存在しない。 */
  byCandidateKey: Map<string, LegacyProjectionEntry>;
  /** 正本(AiInference)には存在するが対応するFormation候補が見つからなかったもの
   *  (shadow書込みの取りこぼしを検知するための診断フィールド、dualRead.ts用)。 */
  unmatchedInferenceIds: string[];
}

/**
 * `db`(PrismaClient)・`tx`(Prisma.TransactionClient)のどちらからでも呼べる
 * (recordCandidateDecisionはSession行lock配下のtx内から呼ぶ必要があるため)。
 */
export async function resolveLegacyProjectionMap(
  client: Prisma.TransactionClient,
  params: { sessionId: string; workspaceId: string },
): Promise<LegacyProjectionMap | null> {
  const session = await client.formationSession.findFirst({
    where: { id: params.sessionId, workspaceId: params.workspaceId },
    select: { id: true, captureId: true },
  });
  if (!session) return null;

  const analysisRequestedEvent = await client.formationSessionEvent.findFirst({
    where: { sessionId: session.id, workspaceId: params.workspaceId, eventType: "ANALYSIS_REQUESTED" },
    orderBy: { sequence: "asc" },
  });
  const aiRunId =
    analysisRequestedEvent && typeof (analysisRequestedEvent.payload as { aiRunId?: unknown })?.aiRunId === "string"
      ? ((analysisRequestedEvent.payload as { aiRunId: string }).aiRunId)
      : null;

  const identities = await client.formationCandidateIdentity.findMany({
    where: { sessionId: session.id, workspaceId: params.workspaceId },
    select: { candidateKey: true },
  });

  const aiInferences = aiRunId
    ? await client.aiInference.findMany({
        where: { captureId: session.captureId, aiRunId },
      })
    : [];

  const inferenceByCandidateKey = new Map<string, (typeof aiInferences)[number]>();
  for (const inference of aiInferences) {
    const parsed = ResponsibilityCandidateSchema.safeParse(inference.payload);
    if (!parsed.success) continue;
    inferenceByCandidateKey.set(parsed.data.candidateId, inference);
  }

  const byCandidateKey = new Map<string, LegacyProjectionEntry>();
  const matchedCandidateKeys = new Set<string>();

  for (const identity of identities) {
    matchedCandidateKeys.add(identity.candidateKey);
    const matchedInference = inferenceByCandidateKey.get(identity.candidateKey);
    if (!matchedInference) continue;

    let responsibilityId: string | null = null;
    if (matchedInference.decision === "ACCEPTED" || matchedInference.decision === "EDITED") {
      const responsibility = await client.responsibility.findFirst({
        where: { originInferenceId: matchedInference.id, workspaceId: params.workspaceId },
        select: { id: true },
      });
      responsibilityId = responsibility?.id ?? null;
    }

    byCandidateKey.set(identity.candidateKey, {
      inferenceId: matchedInference.id,
      decision: matchedInference.decision,
      decidedAt: matchedInference.decidedAt ? matchedInference.decidedAt.toISOString() : null,
      responsibilityId,
    });
  }

  const unmatchedInferenceIds = aiInferences
    .filter((inference: (typeof aiInferences)[number]) => {
      const parsed = ResponsibilityCandidateSchema.safeParse(inference.payload);
      return !parsed.success || !matchedCandidateKeys.has(parsed.data.candidateId);
    })
    .map((inference: (typeof aiInferences)[number]) => inference.id);

  return { aiRunId, byCandidateKey, unmatchedInferenceIds };
}

/**
 * [B4.2新設・2026-08-29] 指定Capture(workspaceIdスコープ)に対応する
 * FormationSessionが存在するかどうかだけを返す。旧`/inferences/[id]/decision`
 * routeのcutover guard(B4.2受入項目7・8)が使う。scripts/配下のDB受入testが
 * next/serverに依存せず検証できるよう、route本体から独立した関数として切り出す
 * (Gate M1-B4.1で`next/server`をscripts/からimportできないことが判明した教訓を
 * 踏まえた設計)。
 */
export async function findFormationSessionForCapture(
  client: Prisma.TransactionClient,
  params: { captureId: string; workspaceId: string },
): Promise<{ id: string } | null> {
  return client.formationSession.findFirst({
    where: { captureId: params.captureId, workspaceId: params.workspaceId },
    select: { id: true },
  });
}
