import { createHash } from "node:crypto";
import { db } from "@/lib/db";
import type { Prisma } from "@/generated/prisma/client";
import { debugServer } from "@/lib/debugServer";
import { ResponsibilityCandidateSchema } from "@/lib/ai/schema";
import {
  resolveFormationSessionTransition,
  isValidFormationAnswerKind,
  type FormationAnswerKind,
} from "@/lib/formation/coreTypes";
import { applyAnswerToCandidate, isValidQuestionCode, type QuestionCode } from "@/lib/formation/questionPolicy";
import { applyQuestionPolicyAndTransition, type CandidateForQuestionPolicy } from "@/lib/formation/formationQuestionService";
import { assessAtomicity } from "@/lib/formation/atomicityAssessment";

/**
 * V5-M1-B5a: POST /formation-sessions/{id}/answers service。
 * 出典: 2026-08-30指示書§4.3、統合正本v5.0 §6.4「回答には
 * SELECTED/FREE_TEXT/UNKNOWN/DEFERRED/DO_NOT_MATERIALIZEを許可する」、
 * DOC-03 §7「POST /:id/answers | 回答Event追加 | clientEventId unique」。
 *
 * [設計方針] `materialize.ts`の`recordCandidateDecision`と同じ不変条件パターンを踏襲する:
 * Session行を`FOR UPDATE`でlockして同一Sessionへの並行回答を直列化し、
 * `(workspaceId, actorUserId, clientEventId)`の冪等性をDB一意制約(is層)+
 * tx内事前チェック(P2002多層防御)で保証する。
 *
 * [このPatchでのscope外] `revisionOfId`による訂正(append-only補正)はDB schema・
 * 型としては用意されているが、このPatchでは新規回答のみを実装対象とし、訂正時の
 * 詳細な差分表示ロジックはUI実装(§4.4)と合わせて次のGateで扱う。訂正リクエスト
 * (revisionOfId指定)自体はここで受理し、append-onlyで記録する(Answer Event自体は
 * 訂正チェーンをたどれる形で保存されるため、データが失われることはない)。
 */

export interface RecordFormationAnswerParams {
  sessionId: string;
  workspaceId: string;
  questionId: string;
  clientEventId: string;
  answerKind: string;
  value: unknown;
  /** 訂正の場合、訂正対象の既存FormationAnswerEvent.id。新規回答ではundefined。 */
  revisionOfId?: string;
  actorUserId: string;
}

export interface AnsweredCandidateRevision {
  candidateId: string;
  previousRevision: number;
  newRevision: number;
}

export type RecordFormationAnswerResult =
  | {
      ok: true;
      answerEventId: string;
      sessionState: string;
      replay: boolean;
      candidateRevision: AnsweredCandidateRevision | null;
      questionsAskedCount: number;
    }
  | { ok: false; error: "NOT_FOUND" }
  | { ok: false; error: "INVALID_SESSION_STATE"; sessionState: string }
  | { ok: false; error: "INVALID_ANSWER_KIND" }
  | { ok: false; error: "INVALID_QUESTION_CODE" }
  /** revisionOfId無しで、この質問に既に回答済み(訂正するにはrevisionOfId必須)。 */
  | { ok: false; error: "ALREADY_ANSWERED"; latestAnswerEventId: string }
  /** revisionOfIdが、この質問の最新回答を指していない(想像で「たぶんこれだろう」と
   *  推測せず、明示的にconflictとして停止する)。 */
  | { ok: false; error: "REVISION_OF_NOT_LATEST"; latestAnswerEventId: string }
  | { ok: false; error: "IDEMPOTENCY_KEY_REUSED" }
  | { ok: false; error: "CORRUPTED_CANDIDATE_DATA"; candidateId: string };

/** clientEventId冪等性のための論理payload hash(materialize.tsのrequestHashと同じ考え方)。 */
function computeAnswerRequestHash(input: {
  questionId: string;
  answerKind: string;
  value: unknown;
  revisionOfId?: string;
}): string {
  return createHash("sha256")
    .update(
      JSON.stringify({
        questionId: input.questionId,
        answerKind: input.answerKind,
        value: input.value ?? null,
        revisionOfId: input.revisionOfId ?? null,
      }),
    )
    .digest("hex");
}

function isPrismaUniqueConstraintError(e: unknown): boolean {
  if (typeof e !== "object" || e === null) return false;
  return (e as { code?: unknown }).code === "P2002";
}

export async function recordFormationAnswer(params: RecordFormationAnswerParams): Promise<RecordFormationAnswerResult> {
  const { sessionId, workspaceId, questionId, clientEventId, answerKind, value, revisionOfId, actorUserId } = params;

  if (!isValidFormationAnswerKind(answerKind)) {
    return { ok: false, error: "INVALID_ANSWER_KIND" };
  }
  const validatedAnswerKind: FormationAnswerKind = answerKind;
  const requestHash = computeAnswerRequestHash({ questionId, answerKind, value, revisionOfId });

  try {
    return await db.$transaction(async (tx: Prisma.TransactionClient) => {
      // [materialize.tsのrecordCandidateDecisionと同じパターン] Session行を
      // FOR UPDATEでlockし、同一Sessionへの並行回答・他の書込み(materialize等)と
      // 直列化する。
      const sessionRows = await tx.$queryRaw<{ id: string; version: number; state: string; question_count: number }[]>`
        SELECT id, version, state, question_count FROM formation_sessions
        WHERE id = ${sessionId} AND workspace_id = ${workspaceId}
        FOR UPDATE`;
      const session = sessionRows[0];
      if (!session) return { ok: false, error: "NOT_FOUND" } as const;

      // [冪等性] Session行lock配下のため、以後のSELECTはrace無く信頼できる。
      const existingAnswer = await tx.formationAnswerEvent.findFirst({
        where: { workspaceId, actorUserId, clientEventId },
      });
      if (existingAnswer) {
        const existingHash = computeAnswerRequestHash({
          questionId: existingAnswer.questionId,
          answerKind: existingAnswer.answerKind,
          value: existingAnswer.valueJson,
          revisionOfId: existingAnswer.revisionOfId ?? undefined,
        });
        if (existingHash !== requestHash) {
          return { ok: false, error: "IDEMPOTENCY_KEY_REUSED" } as const;
        }
        // 同一key・同一payloadの再送。現在のSession状態をそのまま返す
        // (既にこの回答による副作用は初回リクエストで確定済みのため、再実行しない)。
        return {
          ok: true,
          answerEventId: existingAnswer.id,
          sessionState: session.state,
          replay: true,
          candidateRevision: null,
          questionsAskedCount: 0,
        } as const;
      }

      if (session.state !== "CLARIFYING") {
        return { ok: false, error: "INVALID_SESSION_STATE", sessionState: session.state } as const;
      }

      const question = await tx.formationQuestion.findFirst({
        where: { id: questionId, sessionId, workspaceId },
      });
      if (!question) return { ok: false, error: "NOT_FOUND" } as const;
      if (!isValidQuestionCode(question.questionCode)) {
        return { ok: false, error: "INVALID_QUESTION_CODE" } as const;
      }
      const questionCode = question.questionCode as QuestionCode;

      const latestAnswerForQuestion = await tx.formationAnswerEvent.findFirst({
        where: { workspaceId, questionId },
        orderBy: { occurredAt: "desc" },
      });
      if (latestAnswerForQuestion) {
        if (!revisionOfId) {
          return { ok: false, error: "ALREADY_ANSWERED", latestAnswerEventId: latestAnswerForQuestion.id } as const;
        }
        if (revisionOfId !== latestAnswerForQuestion.id) {
          return { ok: false, error: "REVISION_OF_NOT_LATEST", latestAnswerEventId: latestAnswerForQuestion.id } as const;
        }
      }

      const answerEvent = await tx.formationAnswerEvent.create({
        data: {
          workspaceId,
          questionId,
          answerKind: validatedAnswerKind,
          // valueJsonはnullable Json field。null/undefinedの場合はkey自体を省略し、
          // DBのNULLへ委ねる(PrismaのJson?フィールドへ明示nullを渡すとJsonNull/DbNull
          // の区別が必要になり、既存コードベースにこの区別を扱う前例が無いため、
          // 想像で挙動を決めず「省略」という最も曖昧さの無い経路を選ぶ)。
          ...(value === undefined || value === null ? {} : { valueJson: value as unknown as object }),
          actorUserId,
          revisionOfId: revisionOfId ?? null,
          clientEventId,
        },
      });

      const lastSessionEvent = await tx.formationSessionEvent.findFirst({
        where: { sessionId, workspaceId },
        orderBy: { sequence: "desc" },
      });
      let nextSequence = (lastSessionEvent?.sequence ?? 0) + 1;

      await tx.formationSessionEvent.create({
        data: {
          workspaceId,
          sessionId,
          sequence: nextSequence++,
          eventType: "ANSWER_RECORDED",
          actorType: "USER",
          actorUserId,
          // [Json field型消去] 既存emit()ヘルパー(shadowWrite.ts)・
          // formationQuestionService.tsと同じ`as object`パターンで統一する。
          payload: { questionId, questionCode, answerKind: validatedAnswerKind, clientEventId, revisionOfId: revisionOfId ?? null } as object,
        },
      });

      // ---- Answer → Candidate Revision反映(questionPolicy.tsのpure reducer) ----
      let candidateRevisionResult: AnsweredCandidateRevision | null = null;
      if (question.candidateId) {
        const identity = await tx.formationCandidateIdentity.findFirst({
          where: { id: question.candidateId, sessionId, workspaceId },
        });
        if (identity) {
          const currentRevisionRow = await tx.formationCandidateRevision.findFirst({
            where: { candidateId: identity.id, workspaceId, revision: identity.currentRevision },
          });
          if (!currentRevisionRow) {
            return { ok: false, error: "CORRUPTED_CANDIDATE_DATA", candidateId: identity.id } as const;
          }
          const parsed = ResponsibilityCandidateSchema.safeParse(currentRevisionRow.proposedFields);
          if (!parsed.success) {
            return { ok: false, error: "CORRUPTED_CANDIDATE_DATA", candidateId: identity.id } as const;
          }
          const updatedCandidate = applyAnswerToCandidate(parsed.data, questionCode, validatedAnswerKind, value);
          if (updatedCandidate !== parsed.data) {
            const newRevisionNumber = currentRevisionRow.revision + 1;
            const newRevisionRow = await tx.formationCandidateRevision.create({
              data: {
                workspaceId,
                candidateId: identity.id,
                revision: newRevisionNumber,
                type: updatedCandidate.type,
                title: updatedCandidate.title,
                description: updatedCandidate.description ?? null,
                proposedFields: updatedCandidate as unknown as object,
                confidence: updatedCandidate.confidence,
                schemaVersion: currentRevisionRow.schemaVersion,
              },
            });
            await tx.formationCandidateIdentity.update({
              where: { id: identity.id },
              data: { currentRevision: newRevisionNumber },
            });
            // [2026-08-30新設・M1-C] 回答で新Revisionが作られた際も、
            // 新しい内容に対してAtomicity Assessmentを再算出する
            // (shadowWrite.tsの初回Revisionと同じパターン。回答で
            // completionCondition等が埋まったことで判定が変わりうるため)。
            const revisedAssessment = assessAtomicity(updatedCandidate);
            await tx.formationAtomicityAssessment.create({
              data: {
                workspaceId,
                revisionId: newRevisionRow.id,
                assessment: revisedAssessment.assessment,
                reasonCode: revisedAssessment.reasonCode,
                evidence: revisedAssessment.evidence as unknown as object,
                confidence: revisedAssessment.confidence,
                algorithmVersion: revisedAssessment.algorithmVersion,
              },
            });
            await tx.formationSessionEvent.create({
              data: {
                workspaceId,
                sessionId,
                sequence: nextSequence++,
                eventType: "CANDIDATE_REVISED",
                actorType: "USER",
                actorUserId,
                payload: {
                  candidateId: identity.id,
                  previousRevisionId: currentRevisionRow.id,
                  newRevisionId: newRevisionRow.id,
                  previousRevision: currentRevisionRow.revision,
                  newRevision: newRevisionNumber,
                  questionCode,
                } as object,
              },
            });
            candidateRevisionResult = {
              candidateId: identity.id,
              previousRevision: currentRevisionRow.revision,
              newRevision: newRevisionNumber,
            };
          }
        }
      }

      // ---- CLARIFYING --ANSWER_SUBMITTED--> ANALYZING (統合正本§6.3) ----
      const toAnalyzing = resolveFormationSessionTransition("CLARIFYING", "ANSWER_SUBMITTED");
      if (!toAnalyzing) {
        throw new Error("coreTypes不整合: CLARIFYING--ANSWER_SUBMITTED-->の遷移が定義されていません");
      }
      await tx.formationSession.update({
        where: { id: sessionId },
        data: { state: toAnalyzing, version: { increment: 1 } },
      });

      // ---- 再評価: 残Question有無でCLARIFYING/REVIEW_READYへ ----
      // Question Policy再評価には、Session内の全候補の「最新」Revisionが要る
      // (今回更新した候補は上で作った新Revision、それ以外は既存のcurrentRevision)。
      const allIdentities = await tx.formationCandidateIdentity.findMany({
        where: { sessionId, workspaceId },
        orderBy: { createdAt: "asc" },
      });
      const candidatesForPolicy: CandidateForQuestionPolicy[] = [];
      for (let i = 0; i < allIdentities.length; i++) {
        const identity = allIdentities[i];
        const revisionRow = await tx.formationCandidateRevision.findFirst({
          where: { candidateId: identity.id, workspaceId, revision: identity.currentRevision },
        });
        if (!revisionRow) {
          return { ok: false, error: "CORRUPTED_CANDIDATE_DATA", candidateId: identity.id } as const;
        }
        const parsed = ResponsibilityCandidateSchema.safeParse(revisionRow.proposedFields);
        if (!parsed.success) {
          return { ok: false, error: "CORRUPTED_CANDIDATE_DATA", candidateId: identity.id } as const;
        }
        candidatesForPolicy.push({ identityId: identity.id, createdOrder: i, candidate: parsed.data });
      }

      const policyResult = await applyQuestionPolicyAndTransition({
        tx,
        workspaceId,
        sessionId,
        questionCountBefore: session.question_count,
        candidates: candidatesForPolicy,
        actorType: "SYSTEM",
        actorUserId: null,
      });

      debugServer.event("formation/answerService", "ANSWER_RECORDED", {
        sessionId,
        questionId,
        answerKind: validatedAnswerKind,
        newSessionState: policyResult.newState,
      });

      return {
        ok: true,
        answerEventId: answerEvent.id,
        sessionState: policyResult.newState,
        replay: false,
        candidateRevision: candidateRevisionResult,
        questionsAskedCount: policyResult.questionsAskedCount,
      } as const;
    });
  } catch (e: unknown) {
    if (isPrismaUniqueConstraintError(e)) {
      // [多層防御] (workspaceId, actorUserId, clientEventId)一意制約への並行衝突。
      // 勝者を再取得してreplay/IDEMPOTENCY_KEY_REUSEDへ決定論的に変換する
      // (materialize.tsのB32-03と同じ考え方)。
      const winner = await db.formationAnswerEvent.findFirst({
        where: { workspaceId, actorUserId, clientEventId },
      });
      if (winner) {
        const winnerHash = computeAnswerRequestHash({
          questionId: winner.questionId,
          answerKind: winner.answerKind,
          value: winner.valueJson,
          revisionOfId: winner.revisionOfId ?? undefined,
        });
        if (winnerHash === requestHash) {
          const winnerSession = await db.formationSession.findFirst({ where: { id: sessionId, workspaceId } });
          return {
            ok: true,
            answerEventId: winner.id,
            sessionState: winnerSession?.state ?? "UNKNOWN",
            replay: true,
            candidateRevision: null,
            questionsAskedCount: 0,
          };
        }
        return { ok: false, error: "IDEMPOTENCY_KEY_REUSED" };
      }
    }
    throw e;
  }
}
