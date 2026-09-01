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

// ---------------------------------------------------------------------------
// [M1-B6C-5新設・2026-09-02指示書§7「Legacy/Realtime/Batch収束」]
// 「shadow欠落時だけ安全に旧経路へfallbackする条件を明文化する」。
//
// [是正の背景] 従来のcutover guard(B4.2、上の`findFormationSessionForCapture`)は
// 「対応するFormationSessionが存在するか」だけを見ていた。しかし
// FormationShadowCheckpoint(M1-B6C-1)がPENDING/RUNNING/RETRY_WAITの間
// (=shadow書込みがまだ進行中で、最終的に成功する可能性がまだ残っている間)は
// FormationSessionがまだ存在しないため、この期間に旧route経由でACCEPTすると、
// 直後にshadow書込みが成功した際、同じ論理candidateに対してlegacy側の
// Responsibilityと(将来Formation側でACCEPTされれば)Formation側の
// Responsibilityが両方作られうる、という是正されていなかったraceが存在した。
//
// 「shadow欠落」とは、shadow書込みが「もう成功する見込みが無い」ことが
// 確定した状態(DEAD_LETTER/CANCELLED)、または最初からshadow書込みが一度も
// 試みられていない状態(checkpoint自体が存在しない、旧データ等)を指す。
// PENDING/RUNNING/RETRY_WAIT(進行中でまだ成功しうる)は「欠落」ではないため、
// この期間は旧経路へのfallbackを許可しない(想像で「たぶん失敗するだろう」と
// 先回りしない。checkpointの状態機械が示す事実だけに従う)。
// ---------------------------------------------------------------------------

export type LegacyFallbackDecision =
  | { allowed: true }
  | { allowed: false; reason: "FORMATION_SESSION_EXISTS"; formationSessionId: string }
  | { allowed: false; reason: "SHADOW_WRITE_IN_PROGRESS"; checkpointStatus: string };

/**
 * 旧`/inferences/[id]/decision`routeが、指定Captureに対する直接生成
 * (legacy fallback)を許可してよいかどうかを判定する。
 *
 * 判定順序:
 *   1. 対応するFormationSessionが既に存在する → 拒否(既存B4.2 guardと同じ)。
 *   2. FormationSessionは無いが、進行中(PENDING/RUNNING/RETRY_WAIT)の
 *      FormationShadowCheckpointが存在する → 拒否(shadow書込みがまだ
 *      「欠落」と確定していない。将来成功しうる)。
 *   3. どちらにも該当しない(Sessionも無く、進行中checkpointも無い。
 *      checkpoint自体が無い、DEAD_LETTER、CANCELLEDのいずれか) → 許可
 *      (shadow経路が確定的に使えない、または最初から試みられていない)。
 */
export async function resolveLegacyFallbackEligibility(
  client: Prisma.TransactionClient,
  params: { captureId: string; workspaceId: string },
): Promise<LegacyFallbackDecision> {
  const session = await findFormationSessionForCapture(client, params);
  if (session) {
    return { allowed: false, reason: "FORMATION_SESSION_EXISTS", formationSessionId: session.id };
  }
  const inProgressCheckpoint = await client.formationShadowCheckpoint.findFirst({
    where: {
      captureId: params.captureId,
      workspaceId: params.workspaceId,
      status: { in: ["PENDING", "RUNNING", "RETRY_WAIT"] },
    },
    select: { status: true },
  });
  if (inProgressCheckpoint) {
    return { allowed: false, reason: "SHADOW_WRITE_IN_PROGRESS", checkpointStatus: inProgressCheckpoint.status };
  }
  return { allowed: true };
}

// ---------------------------------------------------------------------------
// [B4.3新設] legacy/Formation 競合検出(read-only、pure関数)。
// 出典: HANDOFF_2026-08-29_B4.1_B4.2.md §4-3
//       「legacy/Formation競合表示(項目6)。FormationSessionPanel.tsxは
//       legacyProjection.conflictCodeがあれば警告バッジを出す最低限の実装のみ。
//       詳細な競合内容の表示は未実装」。
//
// [経緯・既存実装との差分] 従来`formation-sessions/[id]/route.ts`はinline実装で
// 「legacy ACCEPTED/EDITEDなのにResponsibilityが見つからない」(データ破損)の
// 1パターンのみをLEGACY_PROJECTION_CONFLICTとして検出していた。この関数は
// それに加え、「legacyとFormationの両方に決定が存在し、かつ採否の意味が
// 食い違っている」パターンをDECISION_MISMATCHとして新たに検出する
// (旧経路はB4.2のcutover guardにより通常は塞がれるが、guard導入前の残存データ、
// またはFlag OFF期間中に生じたデータについて、想像で無視せず明示的に検知する)。
// ---------------------------------------------------------------------------

export type CandidateConflictCode = "LEGACY_PROJECTION_CONFLICT" | "DECISION_MISMATCH";

export interface ConflictLegacyEntryInput {
  /** PENDING/ACCEPTED/EDITED/REJECTED/HELD */
  decision: string;
  responsibilityId: string | null;
}

export interface ConflictFormationDecisionInput {
  /** ACCEPTED/REJECTED/DEFERRED/DO_NOT_MATERIALIZE */
  decision: string;
}

/**
 * candidate 1件分の legacyEntry・formationDecision(あれば)から conflictCode を
 * 決定論的に計算する。DB非依存の純粋関数(`formation-sessions/[id]/route.ts`と
 * `scripts/verify_gate_m1b43_bulk_and_conflict.ts`の両方から直接呼べる)。
 *
 * 判定順序:
 *   1. legacyEntryが無ければconflictは無い(旧経路自体に対応データが無いため)。
 *   2. legacy側がACCEPTED/EDITEDなのにResponsibilityが見つからない場合は
 *      データ破損そのものであり、Formation側の決定有無に関わらず最優先で
 *      LEGACY_PROJECTION_CONFLICTを返す(既存実装のスコープをそのまま継承)。
 *   3. 上記に該当せず、かつFormation側にも決定が存在する場合のみ、
 *      「legacyが実質ACCEPTED相当なのにFormationがREJECTED相当」または
 *      「legacyが実質REJECTED相当なのにFormationがACCEPTED」を
 *      DECISION_MISMATCHとして検出する。
 *   4. どちらにも該当しなければnull(legacy PENDING、または両者が同じ意味の
 *      決定である場合。DEFERRED/DO_NOT_MATERIALIZEはlegacy側に対応語彙が
 *      無いため、REJECTED相当として扱う=想像で新しい対応関係を発明しない)。
 */
export function computeCandidateConflict(input: {
  legacyEntry: ConflictLegacyEntryInput | null;
  formationDecision: ConflictFormationDecisionInput | null;
}): CandidateConflictCode | null {
  const { legacyEntry, formationDecision } = input;
  if (!legacyEntry) return null;

  const legacyAcceptedLike = legacyEntry.decision === "ACCEPTED" || legacyEntry.decision === "EDITED";
  const legacyRejectedLike = legacyEntry.decision === "REJECTED" || legacyEntry.decision === "HELD";

  if (legacyAcceptedLike && !legacyEntry.responsibilityId) {
    return "LEGACY_PROJECTION_CONFLICT";
  }

  if (formationDecision) {
    const formationAccepted = formationDecision.decision === "ACCEPTED";
    const formationRejectedLike =
      formationDecision.decision === "REJECTED" ||
      formationDecision.decision === "DEFERRED" ||
      formationDecision.decision === "DO_NOT_MATERIALIZE";

    if ((legacyAcceptedLike && formationRejectedLike) || (legacyRejectedLike && formationAccepted)) {
      return "DECISION_MISMATCH";
    }
  }

  return null;
}
