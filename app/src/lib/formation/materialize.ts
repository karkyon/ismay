import { createHash } from "node:crypto";
import { db } from "@/lib/db";
import type { Prisma } from "@/generated/prisma/client";
import { debugServer } from "@/lib/debugServer";
import { ResponsibilityCandidateSchema } from "@/lib/ai/schema";
import { initialStatusFor } from "@/lib/responsibility";
import { embedAndStoreResponsibility } from "@/lib/ai/relatedResponsibilities";
import {
  resolveFormationSessionTransition,
  isValidCandidateDecisionEventValue,
  type CandidateDecisionEventValue,
  type FormationEventType,
} from "@/lib/formation/coreTypes";

/**
 * V5-M1-B3 Formation Session Materialize service。
 * 出典: ISMAY-V5-DOC-03(Formation Session仕様書) 6章(Materialization Transaction)・
 *       7章(API-F05 `POST /:id/candidates/:candidateId/decisions`、
 *           API-F06 `POST /:id/materialize`)、10章「B3はMaterialize serviceへsingle-write」。
 *       ISMAY_統合正本仕様書_v5_0.md 6.8節(Materialization Transaction、7 steps)。
 *
 * [設計方針・スコープ] このGate(M1-B3)は、B1(shadowWrite.ts)が書き込んだ
 * FormationSession/CandidateIdentity/Revisionを対象に、新規API経由でのみ
 * CandidateDecisionEvent・MaterializationReceipt・Responsibilityを書き込む。
 *
 * 明示的にやらないこと(B1/B2と同じ「blast radius最小化」方針を踏襲):
 * - 既存`/inferences/[id]/decision`route.tsの変更(CHG-011のFeature Flag委譲は
 *   このGateでは行わない。旧経路は無変更のまま並走させる)。
 * - Atomicity Assessment(DOC-03 5章 ATOMIC/NEEDS_SPLIT等)の実装。AIが
 *   atomicityAssessmentを出力する経路自体がまだ存在しない(ResponsibilityCandidateSchema
 *   に該当fieldが無い)ため、COMMITのguard「atomicity解決」は現状「常に解決済み扱い」
 *   とする(想像でAssessment値を作らない、という既存方針の踏襲)。
 * - Question Policy/CLARIFYING経路との統合(DEC-010を継続。REVIEW_READY到達済みの
 *   Sessionのみを対象とする)。
 * - Context LinkとRelation候補の自動生成(統合正本6.8節 step4後半)。既存
 *   `/inferences/[id]/decision`のblockedByCandidateIds→ResponsibilityRelation自動生成
 *   と同等の機能はこのGateでは移植しない(候補間関係の解決は別Gateで検討する)。
 * - Tag自動付与(既存decision route.tsのsuggestedTags処理)。同様の理由でこのGateでは
 *   移植しない。
 */

// ---------------------------------------------------------------------------
// 型定義
// ---------------------------------------------------------------------------

export interface RecordCandidateDecisionParams {
  sessionId: string;
  workspaceId: string;
  candidateId: string;
  /** 採否対象を固定するため、クライアントが直前に見ていたcurrentRevisionを渡す
   *  (DOC-03 4章「採否対象Revisionを固定」、API-F05「revision必須」)。 */
  expectedRevision: number;
  decision: CandidateDecisionEventValue;
  reasonCode?: string;
  actorUserId: string;
}

export type RecordCandidateDecisionResult =
  | { ok: true; decisionEventId: string; sessionState: string }
  | { ok: false; error: "NOT_FOUND" }
  | { ok: false; error: "REVISION_CONFLICT"; latestRevision: number }
  | { ok: false; error: "ALREADY_DECIDED"; existingDecision: string }
  | { ok: false; error: "INVALID_SESSION_STATE"; sessionState: string }
  | { ok: false; error: "INVALID_DECISION_VALUE" };

export interface MaterializeFormationSessionParams {
  sessionId: string;
  workspaceId: string;
  operationId: string;
  /** 楽観ロック用。クライアントが直前に見ていたFormationSession.versionを渡す。 */
  expectedVersion: number;
  actorUserId: string;
}

export interface MaterializedItem {
  candidateId: string;
  candidateRevisionId: string;
  responsibilityId: string;
}

export type MaterializeFormationSessionResult =
  | { ok: true; receiptId: string; operationId: string; items: MaterializedItem[]; replay: boolean }
  | { ok: false; error: "NOT_FOUND" }
  | { ok: false; error: "VERSION_CONFLICT" }
  | { ok: false; error: "INVALID_SESSION_STATE"; sessionState: string }
  | { ok: false; error: "NO_ACCEPTED_CANDIDATES" }
  | { ok: false; error: "IDEMPOTENCY_KEY_REUSED" }
  | { ok: false; error: "CORRUPTED_CANDIDATE_DATA"; candidateId: string };

// ---------------------------------------------------------------------------
// 純粋関数(db非依存、__tests__/coreInvariants.test.tsから直接検証できるようにする)
// ---------------------------------------------------------------------------

/**
 * Materializeのidempotency用request hash。DOC-03 6章「operationIdとrequestHashの
 * 冪等性を検証。同一key異payloadは409」。operationId自体はkeyであり、hash対象には
 * 含めない(sessionIdとworkspaceIdが変われば別operationとして扱われるべきため含める)。
 */
export function computeMaterializeRequestHash(input: { sessionId: string; workspaceId: string }): string {
  return createHash("sha256")
    .update(JSON.stringify({ sessionId: input.sessionId, workspaceId: input.workspaceId }))
    .digest("hex");
}

/**
 * CandidateDecisionEventValueから、対応するFormationSessionEvent(timeline)のeventTypeを
 * 決める。Event Catalog(DOC-02 7.3節)にはCANDIDATE_ACCEPTED/CANDIDATE_REJECTED/
 * CANDIDATE_DEFERREDの3種のみ存在し、DO_NOT_MATERIALIZE専用のcatalog値は無い
 * (想像で新しいEvent Codeを発明しない、という既存方針)。DO_NOT_MATERIALIZEは
 * 「延期ではなく明確な非対象化」だが、既存3値のうち意味的に最も近いCANDIDATE_DEFERREDへ
 * 記録する。実際の決定値そのものはCandidateDecisionEvent.decisionに正確に残るため、
 * この対応は診断用timelineの表示上の丸めであり、正本データを失わない。
 */
export function sessionEventTypeForDecision(decision: CandidateDecisionEventValue): FormationEventType {
  switch (decision) {
    case "ACCEPTED":
      return "CANDIDATE_ACCEPTED";
    case "REJECTED":
      return "CANDIDATE_REJECTED";
    case "DEFERRED":
    case "DO_NOT_MATERIALIZE":
      return "CANDIDATE_DEFERRED";
  }
}

// ---------------------------------------------------------------------------
// API-F05: POST /:id/candidates/:candidateId/decisions
// ---------------------------------------------------------------------------

export async function recordCandidateDecision(
  params: RecordCandidateDecisionParams,
): Promise<RecordCandidateDecisionResult> {
  const { sessionId, workspaceId, candidateId, expectedRevision, decision, reasonCode, actorUserId } = params;

  if (!isValidCandidateDecisionEventValue(decision)) {
    return { ok: false, error: "INVALID_DECISION_VALUE" };
  }

  return db.$transaction(async (tx: Prisma.TransactionClient) => {
    const session = await tx.formationSession.findFirst({
      where: { id: sessionId, workspaceId },
    });
    if (!session) return { ok: false, error: "NOT_FOUND" } as const;

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

    const existingDecision = await tx.formationCandidateDecisionEvent.findFirst({
      where: { candidateId: identity.id, workspaceId },
      orderBy: { occurredAt: "desc" },
    });
    if (existingDecision) {
      return { ok: false, error: "ALREADY_DECIDED", existingDecision: existingDecision.decision } as const;
    }

    const revision = await tx.formationCandidateRevision.findFirst({
      where: { candidateId: identity.id, workspaceId, revision: expectedRevision },
    });
    if (!revision) return { ok: false, error: "NOT_FOUND" } as const;

    const decisionEvent = await tx.formationCandidateDecisionEvent.create({
      data: {
        workspaceId,
        candidateId: identity.id,
        revisionId: revision.id,
        decision,
        reasonCode: reasonCode ?? null,
        actorUserId,
      },
    });

    const lastSessionEvent = await tx.formationSessionEvent.findFirst({
      where: { sessionId, workspaceId },
      orderBy: { sequence: "desc" },
    });
    const nextSequence = (lastSessionEvent?.sequence ?? 0) + 1;
    await tx.formationSessionEvent.create({
      data: {
        workspaceId,
        sessionId,
        sequence: nextSequence,
        eventType: sessionEventTypeForDecision(decision),
        actorType: "USER",
        actorUserId,
        payload: { candidateId: identity.id, candidateKey: identity.candidateKey, decision, revisionId: revision.id },
      },
    });

    // REVIEW_READY --partial decisions--> PARTIALLY_CONFIRMED(DOC-03 3章
    // 「acceptedとpending混在」)。acceptedが1件以上あり、かつ未決定の候補が
    // まだ残っている場合にのみ遷移する。全候補決定済みでも自動COMMITはしない
    // (COMMITは別APIの明示操作、DOC-03 3章「REVIEW_READY/PARTIALLY_CONFIRMED --commit--> CONFIRMED」)。
    let sessionState: string = session.state;
    if (session.state === "REVIEW_READY") {
      const allIdentities = await tx.formationCandidateIdentity.findMany({
        where: { sessionId, workspaceId },
        select: { id: true },
      });
      const decidedRows = await tx.formationCandidateDecisionEvent.findMany({
        where: { workspaceId, candidateId: { in: allIdentities.map((c: { id: string }) => c.id) } },
        select: { candidateId: true },
        distinct: ["candidateId"],
      });
      const decidedCandidateIds = new Set(decidedRows.map((d: { candidateId: string }) => d.candidateId));
      const hasAccepted = decision === "ACCEPTED";
      const hasPending = allIdentities.some((c: { id: string }) => !decidedCandidateIds.has(c.id));
      if (hasAccepted && hasPending) {
        const toPartial = resolveFormationSessionTransition("REVIEW_READY", "PARTIAL_DECISIONS");
        if (toPartial) {
          await tx.formationSession.update({
            where: { id: sessionId },
            data: { state: toPartial, version: { increment: 1 } },
          });
          sessionState = toPartial;
        }
      }
    }

    debugServer.event("formation/materialize", "CANDIDATE_DECISION_RECORDED", {
      sessionId,
      candidateId: identity.id,
      decision,
    });

    return { ok: true, decisionEventId: decisionEvent.id, sessionState } as const;
  });
}

// ---------------------------------------------------------------------------
// API-F06: POST /:id/materialize
// ---------------------------------------------------------------------------

/** transaction内から即座に中断してエラー結果を返すための内部signal。 */
class MaterializeAbort extends Error {
  result: MaterializeFormationSessionResult;
  constructor(result: MaterializeFormationSessionResult) {
    super("MATERIALIZE_ABORT");
    this.result = result;
  }
}

export async function materializeFormationSession(
  params: MaterializeFormationSessionParams,
): Promise<MaterializeFormationSessionResult> {
  const { sessionId, workspaceId, operationId, expectedVersion, actorUserId } = params;
  const requestHash = computeMaterializeRequestHash({ sessionId, workspaceId });

  // 冪等性チェック(DOC-03 6章2「operationIdとrequestHashの冪等性を検証。
  // 同一key異payloadは409」)。tx外で先に見て、既にcommit済みなら書込みを一切
  // 行わずreplay結果を返す(統合正本6.8節 step7「idempotency response保存」)。
  const existingReceipt = await db.materializationReceipt.findFirst({
    where: { workspaceId, operationId },
    include: { items: true },
  });
  if (existingReceipt) {
    if (existingReceipt.requestHash !== requestHash) {
      return { ok: false, error: "IDEMPOTENCY_KEY_REUSED" };
    }
    return {
      ok: true,
      receiptId: existingReceipt.id,
      operationId,
      replay: true,
      items: existingReceipt.items.map((i: { candidateId: string; candidateRevisionId: string; responsibilityId: string }) => ({
        candidateId: i.candidateId,
        candidateRevisionId: i.candidateRevisionId,
        responsibilityId: i.responsibilityId,
      })),
    };
  }

  const txResult: MaterializeFormationSessionResult = await db
    .$transaction(async (tx: Prisma.TransactionClient) => {
      const session = await tx.formationSession.findFirst({ where: { id: sessionId, workspaceId } });
      if (!session) return { ok: false, error: "NOT_FOUND" } as const;

      if (session.state !== "REVIEW_READY" && session.state !== "PARTIALLY_CONFIRMED") {
        return { ok: false, error: "INVALID_SESSION_STATE", sessionState: session.state } as const;
      }

      // Session取得しversion/state検証(DOC-03 6章1「SELECT ... FOR UPDATE相当」)。
      // Prismaはrow lock構文を持たないため、CAS(updateMany + count確認)で
      // 同等の排他性を得る(既存/inferences/[id]/decision route.tsと同じ設計)。
      const casResult = await tx.formationSession.updateMany({
        where: { id: sessionId, workspaceId, version: expectedVersion },
        data: { version: { increment: 1 } },
      });
      if (casResult.count === 0) {
        return { ok: false, error: "VERSION_CONFLICT" } as const;
      }

      const identities = await tx.formationCandidateIdentity.findMany({
        where: { sessionId, workspaceId },
      });

      const alreadyMaterializedRows = await tx.materializationReceiptItem.findMany({
        where: { workspaceId, candidateId: { in: identities.map((c: { id: string }) => c.id) } },
        select: { candidateId: true },
      });
      const alreadyMaterializedCandidateIds = new Set(alreadyMaterializedRows.map((i: { candidateId: string }) => i.candidateId));

      const acceptedTargets: { identityId: string; candidateKey: string; decisionRevisionId: string }[] = [];
      for (const identity of identities) {
        if (alreadyMaterializedCandidateIds.has(identity.id)) continue;
        const latestDecision = await tx.formationCandidateDecisionEvent.findFirst({
          where: { candidateId: identity.id, workspaceId },
          orderBy: { occurredAt: "desc" },
        });
        if (latestDecision?.decision === "ACCEPTED") {
          acceptedTargets.push({
            identityId: identity.id,
            candidateKey: identity.candidateKey,
            decisionRevisionId: latestDecision.revisionId,
          });
        }
      }

      if (acceptedTargets.length === 0) {
        return { ok: false, error: "NO_ACCEPTED_CANDIDATES" } as const;
      }

      const items: MaterializedItem[] = [];
      for (const target of acceptedTargets) {
        // 採否対象Revisionを固定(決定時点のrevisionId、currentRevisionではない。
        // DOC-03 4章「採否対象Revisionを固定」、EV-F-003)。
        const revision = await tx.formationCandidateRevision.findFirst({
          where: { id: target.decisionRevisionId, workspaceId },
        });
        if (!revision) {
          throw new MaterializeAbort({ ok: false, error: "CORRUPTED_CANDIDATE_DATA", candidateId: target.identityId });
        }
        const candidateParsed = ResponsibilityCandidateSchema.safeParse(revision.proposedFields);
        if (!candidateParsed.success) {
          throw new MaterializeAbort({ ok: false, error: "CORRUPTED_CANDIDATE_DATA", candidateId: target.identityId });
        }
        const candidate = candidateParsed.data;

        const hardDeadlineAt = candidate.dateMentions.find((d) => d.meaning === "HARD_DEADLINE")?.normalizedAt;
        const targetAt = candidate.dateMentions.find((d) => d.meaning === "SOFT_TARGET")?.normalizedAt;

        const responsibility = await tx.responsibility.create({
          data: {
            workspaceId,
            domainId: session.domainId,
            originCaptureId: session.captureId,
            type: revision.type,
            title: revision.title,
            description: revision.description ?? null,
            status: initialStatusFor(revision.type),
            importance: candidate.importance ?? null,
            confidence: revision.confidence,
            sourceKind: "AI",
            hardDeadlineAt: hardDeadlineAt ? new Date(hardDeadlineAt) : null,
            targetAt: targetAt ? new Date(targetAt) : null,
            createdById: actorUserId,
            updatedById: actorUserId,
          },
        });

        await tx.eventLog.create({
          data: {
            aggregateType: "Responsibility",
            aggregateId: responsibility.id,
            eventType: "AI_CANDIDATE_DECIDED",
            beforeJson: { candidateId: target.identityId, decision: "PENDING" },
            afterJson: { candidateId: target.identityId, decision: "ACCEPTED", responsibilityId: responsibility.id },
            actorType: "USER",
            actorId: actorUserId,
          },
        });

        await tx.outboxEvent.create({
          data: {
            eventName: "ResponsibilityCreated.v1",
            eventVersion: "1",
            aggregateId: responsibility.id,
            aggregateVersion: responsibility.version,
            payload: {
              responsibilityId: responsibility.id,
              workspaceId,
              domainId: responsibility.domainId,
              type: responsibility.type,
              fromFormationSessionId: sessionId,
              fromCandidateId: target.identityId,
            },
          },
        });

        items.push({
          candidateId: target.identityId,
          candidateRevisionId: revision.id,
          responsibilityId: responsibility.id,
        });
      }

      const receipt = await tx.materializationReceipt.create({
        data: { workspaceId, sessionId, operationId, requestHash },
      });
      for (const item of items) {
        await tx.materializationReceiptItem.create({
          data: {
            workspaceId,
            receiptId: receipt.id,
            candidateId: item.candidateId,
            candidateRevisionId: item.candidateRevisionId,
            responsibilityId: item.responsibilityId,
          },
        });
      }

      const lastSessionEvent = await tx.formationSessionEvent.findFirst({
        where: { sessionId, workspaceId },
        orderBy: { sequence: "desc" },
      });
      const nextSequence = (lastSessionEvent?.sequence ?? 0) + 1;
      await tx.formationSessionEvent.create({
        data: {
          workspaceId,
          sessionId,
          sequence: nextSequence,
          eventType: "MATERIALIZATION_COMMITTED",
          actorType: "USER",
          actorUserId,
          payload: { operationId, receiptId: receipt.id, responsibilityIds: items.map((i) => i.responsibilityId) },
        },
      });

      // REVIEW_READY/PARTIALLY_CONFIRMED --commit--> CONFIRMED(DOC-03 3章)。
      // atomicity Assessmentは未実装のため常に「解決済み」として扱う
      // (このファイル冒頭コメントのスコープ注記を参照)。
      const toConfirmed = resolveFormationSessionTransition(session.state, "COMMIT");
      if (!toConfirmed) {
        throw new Error("coreTypes不整合: " + session.state + "--commit-->の遷移が定義されていません");
      }
      await tx.formationSession.update({
        where: { id: sessionId },
        data: { state: toConfirmed },
      });
      await tx.formationSessionEvent.create({
        data: {
          workspaceId,
          sessionId,
          sequence: nextSequence + 1,
          eventType: "SESSION_CONFIRMED",
          actorType: "USER",
          actorUserId,
          payload: { operationId, receiptId: receipt.id },
        },
      });

      debugServer.event("formation/materialize", "MATERIALIZATION_COMMITTED", {
        sessionId,
        operationId,
        receiptId: receipt.id,
        itemCount: items.length,
      });

      return { ok: true, receiptId: receipt.id, operationId, items, replay: false } as const;
    })
    .catch((e: unknown) => {
      if (e instanceof MaterializeAbort) return e.result;
      throw e;
    });

  if (txResult.ok) {
    // 統合正本6.8節 step7 / DOC-03 6章7「commit後にAI/Embedding Jobを配送。
    // 失敗してもResponsibilityを巻き戻さない」(既存/inferences/[id]/decision
    // route.tsと同じtransaction外best-effort呼出パターン)。
    for (const item of txResult.items) {
      const responsibility = await db.responsibility.findUnique({
        where: { id: item.responsibilityId },
        select: { id: true, workspaceId: true, domainId: true, title: true, description: true },
      });
      if (!responsibility) continue;
      await embedAndStoreResponsibility({
        responsibilityId: responsibility.id,
        workspaceId: responsibility.workspaceId,
        domainId: responsibility.domainId,
        title: responsibility.title,
        description: responsibility.description,
      }).catch((err: unknown) => {
        debugServer.error("formation/materialize", "embedAndStoreResponsibility例外", err);
      });
    }
  }

  return txResult;
}
