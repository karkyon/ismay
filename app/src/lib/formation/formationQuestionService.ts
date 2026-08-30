import type { Prisma } from "@/generated/prisma/client";
import type { ResponsibilityCandidate } from "@/lib/ai/schema";
import { debugServer } from "@/lib/debugServer";
import { resolveFormationSessionTransition, FORMATION_MAX_QUESTIONS } from "@/lib/formation/coreTypes";
import { QUESTION_POLICY_VERSION, selectSessionQuestions, type SessionCandidateInput } from "@/lib/formation/questionPolicy";

/**
 * V5-M1-B5a Formation作成service(共通部分)。
 * 出典: 2026-08-30指示書§4.2「現行shadowWrite.tsの巨大transactionを分離し、
 * REALTIME/BATCHの双方が使う冪等Formation作成serviceへする」。
 *
 * [このPatchでのscope] 指示書§4.2が要求する完全なservice一本化(Session作成・
 * replay・Candidate Identity/Revision/Source Anchor生成まで含めた1関数化、
 * BATCH経路への配線)は、既存`shadowWrite.ts`(REALTIME専用、B1/B2で確立済み)と
 * BATCH側抽出経路(`aiExtractJob.ts`等、未調査)の両方を1度に書き換える広範囲
 * 変更になり、blast radiusが大きすぎる。このPatchでは「Question Policy評価から
 * 状態遷移まで」の部分だけをここへ切り出し、まず`shadowWrite.ts`(REALTIME)からの
 * 呼び出しを、次に`answerService.ts`(回答後の再評価、状態遷移そのものは同じロジック)
 * からの呼び出しを共通化する。BATCH配線・Session作成部分の統合は次のGateで行う
 * (放棄ではなく明示的な段階分割、既存B1→B2→B3→B3.1の細分方針を踏襲)。
 *
 * db.ts を import しないこと(呼び出し元がtxを渡す設計にし、このファイル自体は
 * db非依存に保つ。ただし`Prisma.TransactionClient`型のためprisma clientの型だけは
 * importする。既存materialize.ts/shadowWrite.tsと同じ)。
 */

export interface CandidateForQuestionPolicy {
  /** FormationCandidateIdentity.id。 */
  identityId: string;
  /** tie-break用の作成順。 */
  createdOrder: number;
  /** 現在のCandidate Revisionから復元したAI候補(ResponsibilityCandidateSchema互換)。 */
  candidate: ResponsibilityCandidate;
}

export interface ApplyQuestionPolicyParams {
  tx: Prisma.TransactionClient;
  workspaceId: string;
  sessionId: string;
  /** 呼び出し時点のFormationSession.questionCount(このtx内でSELECT済みの値を渡す)。 */
  questionCountBefore: number;
  candidates: CandidateForQuestionPolicy[];
  actorType?: "SYSTEM" | "USER";
  actorUserId?: string | null;
}

export interface ApplyQuestionPolicyResult {
  newState: "CLARIFYING" | "REVIEW_READY";
  questionsAskedCount: number;
  newQuestionCount: number;
}

/**
 * ANALYZING状態のSessionに対し、Question Policyを評価してCLARIFYING(質問あり)
 * またはREVIEW_READY(質問なし)へ遷移させる。呼び出し元は既にSession行をFOR UPDATEで
 * lockしたtx内からこの関数を呼ぶこと(このファイル自体はlockを取得しない)。
 *
 * [指示書§3.4] 生涯合計`FORMATION_MAX_QUESTIONS`(=3)を超えて質問しない。
 * `alreadyAsked`はこのSessionの`formation_questions`全件(candidateId,questionCode)から
 * 機械的に算出するため、呼び出し元が別途管理する必要はない。
 */
export async function applyQuestionPolicyAndTransition(
  params: ApplyQuestionPolicyParams,
): Promise<ApplyQuestionPolicyResult> {
  const { tx, workspaceId, sessionId, questionCountBefore, candidates } = params;
  const actorType = params.actorType ?? "SYSTEM";
  const actorUserId = params.actorUserId ?? null;

  const remainingSlots = FORMATION_MAX_QUESTIONS - questionCountBefore;

  const priorQuestions = await tx.formationQuestion.findMany({
    where: { sessionId, workspaceId },
    select: { id: true, candidateId: true, questionCode: true },
  });
  const alreadyAsked = new Set<string>(
    priorQuestions
      .filter((q: { candidateId: string | null }) => q.candidateId !== null)
      .map((q: { candidateId: string | null; questionCode: string }) => `${q.candidateId}::${q.questionCode}`),
  );

  // [2026-08-30新設・実装不備の是正] 指示書§4.3「再評価後、残QuestionがあればCLARIFYING、
  // なければREVIEW_READY」の「残Question」は、既に質問済みだがまだ回答されていない
  // Questionを指す。当初の実装は「新規に生成すべき質問があるか」だけを見ており、
  // 既存の未回答Question(例: 2問同時提示のうち1問だけ回答された場合の残り1問)を
  // 見落としてREVIEW_READYへ誤って進んでしまうbugがあった(Answer API実装時の
  // シナリオ検討で発覚)。既存Question全件のうち、FormationAnswerEventが
  // 1件も無いものが残っていればCLARIFYINGを維持する。
  const priorQuestionIds = priorQuestions.map((q: { id: string }) => q.id);
  let hasUnansweredPriorQuestion = false;
  if (priorQuestionIds.length > 0) {
    const answeredRows = await tx.formationAnswerEvent.findMany({
      where: { workspaceId, questionId: { in: priorQuestionIds } },
      select: { questionId: true },
      distinct: ["questionId"],
    });
    const answeredQuestionIds = new Set(answeredRows.map((a: { questionId: string }) => a.questionId));
    hasUnansweredPriorQuestion = priorQuestionIds.some((id: string) => !answeredQuestionIds.has(id));
  }

  const sessionCandidateInputs: SessionCandidateInput[] = candidates.map((c) => ({
    candidateRef: c.identityId,
    createdOrder: c.createdOrder,
    candidate: c.candidate,
  }));

  const selected = remainingSlots > 0 ? selectSessionQuestions(sessionCandidateInputs, remainingSlots, alreadyAsked) : [];

  const lastSessionEvent = await tx.formationSessionEvent.findFirst({
    where: { sessionId, workspaceId },
    orderBy: { sequence: "desc" },
  });
  let nextSequence = (lastSessionEvent?.sequence ?? 0) + 1;

  if (selected.length === 0 && !hasUnansweredPriorQuestion) {
    const toReviewReady = resolveFormationSessionTransition("ANALYZING", "NO_QUESTIONS_NEEDED");
    if (!toReviewReady) {
      throw new Error("coreTypes不整合: ANALYZING--NO_QUESTIONS_NEEDED-->の遷移が定義されていません");
    }
    await tx.formationSession.update({
      where: { id: sessionId },
      data: { state: toReviewReady, version: { increment: 1 } },
    });
    debugServer.event("formation/questionPolicy", "NO_QUESTIONS_NEEDED", { sessionId, questionCountBefore });
    return { newState: "REVIEW_READY", questionsAskedCount: 0, newQuestionCount: questionCountBefore };
  }

  // [設計判断・2026-08-30] coreTypes.tsの遷移guard文言は「Question Policyが質問を生成」
  // だが、ここは「新規質問生成」と「既存未回答質問の維持」の両方でCLARIFYINGへ
  // 遷移させる(統合正本§6.3の状態自体はCLARIFYING/REVIEW_READYの2値のみで、
  // 「未回答質問が残っているか」という粒度の別状態は無いため、同じ操作名
  // QUESTIONS_READYを再利用する。新しい操作名を追加するとFORMATION_SESSION_
  // OPERATIONS/既存pure testへの変更が必要になり、この是正の本質的なscopeを
  // 超えるため、既存語彙の範囲内で対応する)。
  const toClarifying = resolveFormationSessionTransition("ANALYZING", "QUESTIONS_READY");
  if (!toClarifying) {
    throw new Error("coreTypes不整合: ANALYZING--QUESTIONS_READY-->の遷移が定義されていません");
  }

  let ordinal = questionCountBefore;
  for (const q of selected) {
    ordinal += 1;
    const askedEvent = await tx.formationSessionEvent.create({
      data: {
        workspaceId,
        sessionId,
        sequence: nextSequence++,
        eventType: "QUESTION_ASKED",
        actorType,
        actorUserId,
        // [実機tsc是正] Prisma Json fieldはInputJsonObject(index signature必須)を
        // 要求するが、`ScoreComponents`はexplicitなfield名を持つinterfaceのため
        // 構造的に不適合と判定される。既存shadowWrite.tsの`payload as object`パターンと
        // 同じ形でキャストする(想像で型定義を変えず、既存の型消去パターンを踏襲)。
        payload: {
          candidateId: q.candidateRef,
          questionCode: q.questionCode,
          priority: q.priority,
          policyVersion: QUESTION_POLICY_VERSION,
          scoreComponents: q.scoreComponents,
          score: q.score,
        } as object,
      },
    });
    await tx.formationQuestion.create({
      data: {
        workspaceId,
        sessionId,
        candidateId: q.candidateRef,
        ordinal,
        questionCode: q.questionCode,
        promptVersion: QUESTION_POLICY_VERSION,
        promptText: q.promptText,
        priority: q.priority,
        reasonCode: q.reasonCode,
        scoreValue: q.score,
        askedEventId: askedEvent.id,
      },
    });
  }

  await tx.formationSession.update({
    where: { id: sessionId },
    data: { state: toClarifying, version: { increment: 1 }, questionCount: ordinal },
  });

  debugServer.event("formation/questionPolicy", "QUESTIONS_READY", {
    sessionId,
    questionsAskedCount: selected.length,
    newQuestionCount: ordinal,
  });

  return { newState: "CLARIFYING", questionsAskedCount: selected.length, newQuestionCount: ordinal };
}
