/**
 * Case Pattern Feedback記録サービス(PATTERN-SUGGEST-01C新設・2026-09-05)。
 * 出典: ISMAY_ハンドオフ資料_2026-09-05.md §5-2「PATTERN-SUGGEST-01C
 * (Feedback command・採用処理): CSRF・Idempotency-Key・payload hash・
 * owner認可・optimistic concurrencyを既存規約どおり必須にするmutation API。
 * 01Aで用意したidempotencyKey/requestPayloadHash/supersedesFeedbackEventId
 * を実際に使う層」。
 *
 * [scope訂正・実コード再調査による] ハンドオフ資料5章2項は「採用率計算を
 * case-pattern-adoption-v1としてSuggestion単位の直近N件ベースへ再実装する」
 * とも書いていたが、実際にcasePatternSuggestion.tsのモジュールコメントを
 * 読むと、PATTERN-DETECT-01Eが既に「『直近N件』のような具体的な件数・期間の
 * 定義は正本に記述が無いため、想像でwindowを発明せず、記録済みの全
 * FeedbackEventを対象とする」という検討済みの結論を出していたことが判明した
 * (このコメント自体がPATTERN-SUGGEST-01Bより前、01E時点で書かれている)。
 * これは私自身の前回セッションでの思い込みに基づく誤ったscope認識であり、
 * computeCasePatternAdoptionRate(全履歴ベース)は「暫定」ではなく「正本に
 * windowの定義が無いことを踏まえた意図的な設計」である。従って本Gateでは
 * 採用率計算の再実装は行わない(想像で「直近N件」を発明しない、という
 * このプロジェクト自身の既存原則をここでも守る)。CASE_PATTERN_ADOPTION_
 * POLICY_VERSIONの"-provisional-all-history"という名前は誤解を招くが、
 * 動作に影響は無いため本Gateでは変更しない(名称変更はQ-DOC-03のscope)。
 *
 * このファイルの対象は「Feedback記録処理そのもの」のみ。
 */
import { createHash } from "node:crypto";
import { db } from "@/lib/db";
import type { Prisma } from "@/generated/prisma/client";
import type { CasePatternFeedbackVerdict } from "./coreTypes";

export interface RecordCasePatternFeedbackParams {
  workspaceId: string;
  suggestionId: string;
  actorUserId: string;
  /** [optimistic concurrency] クライアントが読取API経由で得たcurrentRevision。 */
  expectedRevision: number;
  verdict: CasePatternFeedbackVerdict;
  idempotencyKey: string;
  requestPayloadHash: string;
}

export type RecordCasePatternFeedbackResult =
  | { ok: true; feedbackEventId: string; suggestionState: string; replay: boolean }
  | { ok: false; error: "NOT_FOUND" }
  | { ok: false; error: "FORBIDDEN" }
  | { ok: false; error: "REVISION_CONFLICT"; latestRevision: number }
  | { ok: false; error: "SUGGESTION_NOT_MATCHED" }
  | { ok: false; error: "IDEMPOTENCY_KEY_REUSED" };

/**
 * 指定Suggestionへfeedback(ACCEPT/PARTIAL_ACCEPT/REJECT/LATER/NOT_RELEVANT)を
 * 記録する。
 *
 * - owner認可: suggestion.ownerSubjectUserIdとactorUserIdの一致を
 *   application層で検証する(01A schemaコメント「actorがowner本人で
 *   あることをapplication guard」の実装)。
 * - optimistic concurrency: expectedRevisionが現在のcurrentRevisionと
 *   一致しない場合はREVISION_CONFLICT(既存recordCandidateDecisionと
 *   同じ設計)。
 * - AMBIGUOUS(matchedPatternId=null)のSuggestionRevisionにはfeedbackを
 *   記録できない(そもそも「どのPatternへの採否か」が定まっていないため。
 *   CasePatternFeedbackEvent.patternId/patternRevisionIdは必須NOT NULL FKの
 *   ため、DBレベルでも構造的に不可能)。
 * - idempotency: 既存mergeResponsibilities/splitResponsibilityと同じ
 *   「(workspaceId, idempotencyKey)で既存行を検索→同一payloadならreplay
 *   (既存feedbackEventIdをそのまま返す)、異なるpayloadならIDEMPOTENCY_
 *   KEY_REUSED」。
 * - 訂正(supersedesFeedbackEventId): 同一suggestionIdへの既存feedbackが
 *   既にあれば(idempotencyKeyは今回のものと異なる=新規の訂正提出)、
 *   その最新行をsupersedesFeedbackEventIdで指す(01A schemaコメント
 *   「訂正を許すならsupersedesFeedbackEventIdで表現し、過去行UPDATE禁止」の
 *   実装、append-only契約を維持する)。
 */
export async function recordCasePatternFeedback(
  params: RecordCasePatternFeedbackParams,
): Promise<RecordCasePatternFeedbackResult> {
  const { workspaceId, suggestionId, actorUserId, expectedRevision, verdict, idempotencyKey, requestPayloadHash } = params;

  // [既存merge/split契約と同じ順序] 書き込みより前に、idempotencyKeyの
  // 既存行を確認する。
  const existingEvent = await db.casePatternFeedbackEvent.findFirst({
    where: { workspaceId, idempotencyKey },
    select: { id: true, requestPayloadHash: true, suggestionId: true },
  });
  if (existingEvent) {
    if (existingEvent.requestPayloadHash !== requestPayloadHash) {
      return { ok: false, error: "IDEMPOTENCY_KEY_REUSED" };
    }
    const suggestion = await db.casePatternSuggestionIdentity.findFirst({
      where: { id: existingEvent.suggestionId, workspaceId },
      select: { state: true },
    });
    return { ok: true, feedbackEventId: existingEvent.id, suggestionState: suggestion?.state ?? "PENDING", replay: true };
  }

  const suggestion = await db.casePatternSuggestionIdentity.findFirst({
    where: { id: suggestionId, workspaceId },
    select: { id: true, ownerSubjectUserId: true, currentRevision: true },
  });
  if (!suggestion) {
    return { ok: false, error: "NOT_FOUND" };
  }
  if (suggestion.ownerSubjectUserId !== actorUserId) {
    return { ok: false, error: "FORBIDDEN" };
  }
  if (suggestion.currentRevision !== expectedRevision) {
    return { ok: false, error: "REVISION_CONFLICT", latestRevision: suggestion.currentRevision };
  }

  const suggestionRevision = await db.casePatternSuggestionRevision.findFirst({
    where: { workspaceId, suggestionId: suggestion.id, revision: expectedRevision },
    select: { id: true, matchedPatternId: true, matchedPatternRevisionId: true },
  });
  if (!suggestionRevision || !suggestionRevision.matchedPatternId || !suggestionRevision.matchedPatternRevisionId) {
    return { ok: false, error: "SUGGESTION_NOT_MATCHED" };
  }

  const priorEvent = await db.casePatternFeedbackEvent.findFirst({
    where: { workspaceId, suggestionId: suggestion.id },
    orderBy: { occurredAt: "desc" },
    select: { id: true },
  });

  const result = await db.$transaction(async (tx: Prisma.TransactionClient) => {
    const feedbackEvent = await tx.casePatternFeedbackEvent.create({
      data: {
        workspaceId,
        patternId: suggestionRevision.matchedPatternId!,
        patternRevisionId: suggestionRevision.matchedPatternRevisionId!,
        suggestionId: suggestion.id,
        suggestionRevisionId: suggestionRevision.id,
        verdict,
        actorUserId,
        idempotencyKey,
        requestPayloadHash,
        supersedesFeedbackEventId: priorEvent?.id ?? null,
      },
    });
    await tx.casePatternSuggestionIdentity.update({
      where: { id: suggestion.id },
      data: { state: verdict },
    });
    return feedbackEvent;
  });

  return { ok: true, feedbackEventId: result.id, suggestionState: verdict, replay: false };
}

/** APIハンドラでrequestPayloadHash算出に使う共通ヘルパー(既存mergeResponsibilities等と同じ算出方法)。 */
export function computeCasePatternFeedbackPayloadHash(payload: unknown): string {
  return createHash("sha256").update(JSON.stringify(payload)).digest("hex");
}
