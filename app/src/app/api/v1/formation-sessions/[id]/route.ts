import type { NextRequest } from "next/server";
import { db } from "@/lib/db";
import { requireAuth } from "@/lib/auth/guard";
import { ensureDefaultWorkspace } from "@/lib/workspace";
import { apiOk, apiError } from "@/lib/auth/response";
import { resolveLegacyProjectionMap, computeCandidateConflict } from "@/lib/formation/legacyProjectionResolver";

/**
 * V5-M1-B4.1: GET /formation-sessions/{id} 正式Projection API。
 * 出典: 監査「Gate M1-B4.1」3.5節「正式Formation Projection API」。
 *
 * `dual-read`(診断用GET、B2で追加)とは別のpathで、Session Review UI(B4.2)が
 * 直接使える形の集約viewを返す。tenant境界はworkspaceIdで必ず絞り、他workspaceの
 * IDは404として存在を漏らさない(既存project-contexts/[id]と同じIDOR対策)。
 *
 * このAPI自体は読み取り専用。書込みは既存の
 * `POST /:id/candidates/:cid/decisions`・`POST /:id/candidates/bulk-decisions`・
 * `POST /:id/materialize`・[2026-08-30追加]`POST /:id/answers`が担う。
 *
 * [2026-08-30追加・M1-B5a §4.4] CLARIFYING画面(次Gateで実装予定)が使えるよう、
 * `FormationQuestion`一覧と各Questionの最新回答summaryをレスポンスへ追加した。
 * 訂正チェーン(revisionOfIdを辿った全履歴)は、このAPIでは最新回答のみを返し
 * (一覧表示には最新のみで十分なため)、履歴全体が必要な場合は将来
 * 専用endpointを設ける。
 *
 * [B4.3是正] `legacyProjection.conflictCode`の算出を、このfile内のinline三項演算子
 * (「legacy ACCEPTED/EDITEDなのにResponsibilityが無い」の1パターンのみ検出)から、
 * `computeCandidateConflict`(legacyProjectionResolver.ts)へ委譲するよう変更した。
 * 同関数は上記に加え「legacyとFormationの決定が食い違うDECISION_MISMATCH」も
 * 検出する(HANDOFF_2026-08-29_B4.1_B4.2.md §4-3「legacy/Formation競合表示」)。
 * 併せて`legacyProjection.decidedAt`をレスポンスへ追加し、UI側が競合の詳細
 * (いつ・どちらの決定と食い違っているか)を表示できるようにした。
 */

export async function GET(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const auth = await requireAuth(req);
  if (!auth.authenticated) {
    return apiError("AUTH_REQUIRED", "ログインが必要です");
  }
  const { id: sessionId } = await ctx.params;
  const { workspaceId } = await ensureDefaultWorkspace(auth.user.userId, auth.user.email);

  const session = await db.formationSession.findFirst({
    where: { id: sessionId, workspaceId },
  });
  if (!session) {
    // 他Workspaceのsession IDを推測されても存在有無を漏らさない。
    return apiError("RESOURCE_NOT_FOUND", "指定されたFormation Sessionが見つかりません");
  }

  const identities = await db.formationCandidateIdentity.findMany({
    where: { sessionId: session.id, workspaceId },
    orderBy: { createdAt: "asc" },
  });

  const legacyMap = await resolveLegacyProjectionMap(db, { sessionId: session.id, workspaceId });

  const receiptItems = await db.materializationReceiptItem.findMany({
    where: { workspaceId, candidateId: { in: identities.map((c) => c.id) } },
    select: { candidateId: true, receiptId: true, responsibilityId: true, receipt: { select: { committedAt: true } } },
  });
  const receiptItemByCandidateId = new Map(receiptItems.map((r) => [r.candidateId, r]));

  const candidates = [];
  let pendingCount = 0;
  let acceptedUnmaterializedCount = 0;

  for (const identity of identities) {
    const currentRevision = await db.formationCandidateRevision.findFirst({
      where: { candidateId: identity.id, workspaceId, revision: identity.currentRevision },
    });
    const sourceAnchors = currentRevision
      ? await db.formationSourceAnchor.findMany({
          where: { revisionId: currentRevision.id, workspaceId },
          select: {
            id: true,
            sourceKind: true,
            startOffset: true,
            endOffset: true,
            imageRegion: true,
            excerptHash: true,
            piiClassification: true,
          },
        })
      : [];

    const decisionEvent = await db.formationCandidateDecisionEvent.findFirst({
      where: { candidateId: identity.id, workspaceId },
      orderBy: { occurredAt: "desc" },
    });

    const receiptItem = receiptItemByCandidateId.get(identity.id) ?? null;
    const legacyEntry = legacyMap?.byCandidateKey.get(identity.candidateKey) ?? null;

    if (!decisionEvent) {
      pendingCount++;
    } else if (decisionEvent.decision === "ACCEPTED" && !receiptItem) {
      acceptedUnmaterializedCount++;
    }

    candidates.push({
      identityId: identity.id,
      candidateKey: identity.candidateKey,
      currentRevision: currentRevision
        ? {
            revision: currentRevision.revision,
            type: currentRevision.type,
            title: currentRevision.title,
            description: currentRevision.description,
            proposedFields: currentRevision.proposedFields,
            confidence: Number(currentRevision.confidence),
          }
        : null,
      sourceAnchors,
      formationDecision: decisionEvent
        ? { decision: decisionEvent.decision, revisionId: decisionEvent.revisionId, occurredAt: decisionEvent.occurredAt.toISOString() }
        : null,
      materialization: receiptItem
        ? {
            receiptId: receiptItem.receiptId,
            responsibilityId: receiptItem.responsibilityId,
            committedAt: receiptItem.receipt.committedAt.toISOString(),
          }
        : null,
      legacyProjection: legacyEntry
        ? {
            inferenceId: legacyEntry.inferenceId,
            decision: legacyEntry.decision,
            decidedAt: legacyEntry.decidedAt,
            responsibilityId: legacyEntry.responsibilityId,
            // [B4.3是正] 破損検出(ACCEPTED/EDITEDなのにResponsibility無し)に加え、
            // legacyとFormationの決定が食い違うDECISION_MISMATCHも検出する
            // (想像で補完せず、明示的にconflictとして提示する)。
            conflictCode: computeCandidateConflict({
              legacyEntry: { decision: legacyEntry.decision, responsibilityId: legacyEntry.responsibilityId },
              formationDecision: decisionEvent ? { decision: decisionEvent.decision } : null,
            }),
          }
        : null,
    });
  }

  const sessionActive = session.state === "REVIEW_READY" || session.state === "PARTIALLY_CONFIRMED";
  const acceptedMaterializedCount = candidates.filter((c) => c.materialization !== null).length;

  // [2026-08-30追加・M1-B5a §4.4] Question一覧+各Questionの最新回答summary。
  const questionRows = await db.formationQuestion.findMany({
    where: { sessionId: session.id, workspaceId },
    orderBy: { ordinal: "asc" },
  });
  const answerRows = questionRows.length
    ? await db.formationAnswerEvent.findMany({
        where: { workspaceId, questionId: { in: questionRows.map((q) => q.id) } },
        orderBy: { occurredAt: "desc" },
      })
    : [];
  const latestAnswerByQuestionId = new Map<string, (typeof answerRows)[number]>();
  for (const a of answerRows) {
    // occurredAt降順で最初に出た行=最新(Mapは既存keyを上書きしないためsetは1回のみ)。
    if (!latestAnswerByQuestionId.has(a.questionId)) {
      latestAnswerByQuestionId.set(a.questionId, a);
    }
  }
  const questions = questionRows.map((q) => {
    const latestAnswer = latestAnswerByQuestionId.get(q.id) ?? null;
    return {
      id: q.id,
      ordinal: q.ordinal,
      candidateId: q.candidateId,
      questionCode: q.questionCode,
      priority: q.priority,
      reasonCode: q.reasonCode,
      promptText: q.promptText,
      promptVersion: q.promptVersion,
      scoreValue: Number(q.scoreValue),
      latestAnswer: latestAnswer
        ? {
            id: latestAnswer.id,
            answerKind: latestAnswer.answerKind,
            value: latestAnswer.valueJson,
            occurredAt: latestAnswer.occurredAt.toISOString(),
            revisionOfId: latestAnswer.revisionOfId,
          }
        : null,
    };
  });
  const unansweredQuestionCount = questions.filter((q) => q.latestAnswer === null).length;

  const allowedActions = {
    decide: sessionActive && pendingCount > 0,
    materialize: sessionActive && acceptedUnmaterializedCount > 0,
    // [B4.1新設・3.4節] 0 item finalize: pending=0かつ過去materialized>0かつ
    // 今回新規にmaterializeすべき候補が無い状態でのみ、明示finalizeを許可する
    // (materialize.tsのisExplicitZeroItemFinalize判定と同じ条件)。
    finalize: sessionActive && pendingCount === 0 && acceptedUnmaterializedCount === 0 && acceptedMaterializedCount > 0,
    // [2026-08-30追加・M1-B5a §4.4] CLARIFYING状態かつ未回答Questionが残っている場合のみ回答可能。
    answer: session.state === "CLARIFYING" && unansweredQuestionCount > 0,
  };

  const body = {
    session: {
      id: session.id,
      captureId: session.captureId,
      state: session.state,
      version: session.version,
      questionCount: session.questionCount,
    },
    candidates,
    questions,
    allowedActions,
  };

  // [3.5節] ETag = Session.versionを含む弱いETag。apiOk自体はheader
  // optionを持たない共通utilityのため変更せず、戻り値のNextResponseへ
  // 直接設定する(他APIへの影響を避けるため)。
  const response = apiOk(body);
  response.headers.set("ETag", `W/"${session.version}"`);
  return response;
}
