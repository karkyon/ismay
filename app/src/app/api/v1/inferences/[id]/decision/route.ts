import type { NextRequest } from "next/server";
import { z } from "zod";
import { db } from "@/lib/db";
import { debugServer, redactSensitive } from "@/lib/debugServer";
import { requireAuth, requireCsrf } from "@/lib/auth/guard";
import { ensureDefaultWorkspace } from "@/lib/workspace";
import { apiOk, apiError } from "@/lib/auth/response";
import { RESPONSIBILITY_TYPES, initialStatusFor } from "@/lib/responsibility";
import { ResponsibilityCandidateSchema } from "@/lib/ai/schema";

/**
 * API-AI-01: POST /inferences/{id}/decision 候補採否(FN-AI-01/UI-04)
 * 出典: API・イベント設計書v1.1 4.2節。
 *
 * [既知のスコープ外・正直に明記]
 * - 「既存統合は対象versionとimpactConfirmation必須」に対応する重複統合フローは、
 *   FN-GR-01/02(意味照合・関係確定)が未実装のため本パッチでは扱わない。
 *   ACCEPT/EDITは常に新規Responsibilityとして作成する。
 * - レスポンスの「取消可能期限」は、取消(Undo)の実処理自体が未実装のため
 *   常にnullを返す(実装するAPI-RESP-06の5分間取消と合わせて別途対応予定)。
 */

const EditedPayloadSchema = z
  .object({
    type: z.enum(RESPONSIBILITY_TYPES).optional(),
    title: z.string().min(1).max(300).optional(),
    description: z.string().max(20000).optional(),
    hardDeadlineAt: z.string().datetime().optional(),
    targetAt: z.string().datetime().optional(),
    startAfterAt: z.string().datetime().optional(),
    importance: z.number().int().min(1).max(5).optional(),
  })
  .partial();

const DecisionSchema = z.object({
  decision: z.enum(["ACCEPT", "EDIT", "REJECT", "HOLD"]),
  editedPayload: EditedPayloadSchema.optional(),
  expectedInferenceVersion: z.number().int().min(0),
});

const DECISION_TO_STORED: Record<string, string> = {
  ACCEPT: "ACCEPTED",
  EDIT: "EDITED",
  REJECT: "REJECTED",
  HOLD: "HELD",
};

export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const auth = await requireAuth(req);
  if (!auth.authenticated) {
    return apiError("AUTH_REQUIRED", "ログインが必要です");
  }
  if (!requireCsrf(req)) {
    return apiError("ACCESS_DENIED", "CSRFトークンが不正です");
  }

  const json = await req.json().catch(() => null);
  debugServer.input("POST /inferences/[id]/decision", "requestBody", redactSensitive(json));
  const parsed = DecisionSchema.safeParse(json);
  if (!parsed.success) {
    return apiError("VALIDATION_FAILED", "入力内容を確認してください", {
      fieldErrors: Object.fromEntries(
        Object.entries(parsed.error.flatten().fieldErrors).map(([k, v]) => [k, v?.[0] ?? "不正な値です"]),
      ),
    });
  }
  const { decision, editedPayload, expectedInferenceVersion } = parsed.data;

  const { id } = await ctx.params;
  const { workspaceId, domainId: defaultDomainId } = await ensureDefaultWorkspace(
    auth.user.userId,
    auth.user.email,
  );

  const inference = await db.aiInference.findUnique({
    where: { id },
    include: { capture: true },
  });
  if (!inference || inference.capture.workspaceId !== workspaceId || inference.capture.deletedAt) {
    return apiError("RESOURCE_NOT_FOUND", "指定された候補が見つかりません");
  }
  if (inference.decision !== "PENDING") {
    return apiError("STATE_TRANSITION_INVALID", `この候補は既に${inference.decision}として処理済みです`);
  }
  if (inference.version !== expectedInferenceVersion) {
    return apiError("VERSION_CONFLICT", "他の操作と競合しました。最新の状態を取得してください", {
      retryable: true,
      extra: { latestVersion: inference.version },
    });
  }

  const storedDecision = DECISION_TO_STORED[decision];

  if (decision === "REJECT" || decision === "HOLD") {
    const updated = await db.aiInference.updateMany({
      where: { id: inference.id, version: expectedInferenceVersion },
      data: {
        decision: storedDecision,
        decidedById: auth.user.userId,
        decidedAt: new Date(),
        version: { increment: 1 },
      },
    });
    if (updated.count === 0) {
      return apiError("VERSION_CONFLICT", "他の操作と競合しました。最新の状態を取得してください", { retryable: true });
    }
    return apiOk({ inferenceId: inference.id, decision: storedDecision, responsibilityId: null, undoDeadlineAt: null });
  }

  // ACCEPT/EDIT: candidateペイロードを検証し、Responsibilityを新規作成する
  const candidateParsed = ResponsibilityCandidateSchema.safeParse(inference.payload);
  if (!candidateParsed.success) {
    return apiError(
      "VALIDATION_FAILED",
      "保存済みのAI候補データが不正です(AI_SCHEMA_INVALID)。この候補は採用できません",
    );
  }
  const candidate = candidateParsed.data;

  const edit = decision === "EDIT" ? (editedPayload ?? {}) : {};
  const finalType = edit.type ?? candidate.type;
  const finalTitle = edit.title ?? candidate.title;
  const finalDescription = edit.description ?? candidate.description;
  // [2026-08-20修正] 従来はedit.importanceのみを見ており、AIが推定したimportance
  // (candidate.importance)を採用時に一切反映していなかった(手動編集しない限り
  // 常にnullになる不備)。AI推定値をフォールバックとして使うよう修正。
  const finalImportance = edit.importance ?? candidate.importance;

  // UNKNOWNをHard deadlineへ昇格しない(AI・PEM設計書v1.0 3章)。編集で明示指定された場合のみ例外的に許可する。
  const hardDeadlineFromCandidate = candidate.dateMentions.find((d) => d.meaning === "HARD_DEADLINE")?.normalizedAt;
  const targetFromCandidate = candidate.dateMentions.find((d) => d.meaning === "SOFT_TARGET")?.normalizedAt;
  const finalHardDeadlineAt = edit.hardDeadlineAt ?? hardDeadlineFromCandidate;
  const finalTargetAt = edit.targetAt ?? targetFromCandidate;
  const finalStartAfterAt = edit.startAfterAt;

  const created = await db.$transaction(async (tx) => {
    const updatedInference = await tx.aiInference.updateMany({
      where: { id: inference.id, version: expectedInferenceVersion },
      data: {
        decision: storedDecision,
        decidedById: auth.user.userId,
        decidedAt: new Date(),
        version: { increment: 1 },
      },
    });
    if (updatedInference.count === 0) {
      throw new Error("ISMAY_VERSION_CONFLICT");
    }

    const responsibility = await tx.responsibility.create({
      data: {
        workspaceId,
        domainId: inference.capture.domainId ?? defaultDomainId,
        originCaptureId: inference.captureId,
        originInferenceId: inference.id,
        type: finalType,
        title: finalTitle,
        description: finalDescription ?? null,
        status: initialStatusFor(finalType),
        importance: finalImportance ?? null,
        confidence: candidate.confidence,
        sourceKind: "AI",
        hardDeadlineAt: finalHardDeadlineAt ? new Date(finalHardDeadlineAt) : null,
        targetAt: finalTargetAt ? new Date(finalTargetAt) : null,
        startAfterAt: finalStartAfterAt ? new Date(finalStartAfterAt) : null,
        createdById: auth.user.userId,
        updatedById: auth.user.userId,
      },
    });
    debugServer.state("POST /inferences/[id]/decision", "AiInference.decision", {
      inferenceId: inference.id,
      decision: storedDecision,
    });

    // [2026-08-20追加] カルキョンさんの指示「候補間の親子・依存関係を自動検出しろ」に対応。
    // 同一Capture内の他候補で、AIがblockedByCandidateIdsとして関連付けたものが
    // 既に採用済み(Responsibility化済み)であれば、ここでResponsibilityRelationを
    // 自動生成する。他Captureをまたぐ意味的関連付け(FN-GR-01)はスコープ外。
    if (candidate.blockedByCandidateIds.length > 0) {
      const siblingInferences = await tx.aiInference.findMany({
        where: {
          captureId: inference.captureId,
          decision: { in: ["ACCEPTED", "EDITED"] },
          id: { not: inference.id },
        },
        select: { id: true, payload: true },
      });
      for (const sibling of siblingInferences) {
        const siblingCandidate = ResponsibilityCandidateSchema.safeParse(sibling.payload);
        if (!siblingCandidate.success) continue;
        if (!candidate.blockedByCandidateIds.includes(siblingCandidate.data.candidateId)) continue;
        const blockingResponsibility = await tx.responsibility.findFirst({
          where: { originInferenceId: sibling.id },
          select: { id: true },
        });
        if (!blockingResponsibility) continue;
        await tx.responsibilityRelation.create({
          data: {
            fromId: blockingResponsibility.id,
            toId: responsibility.id,
            relationType: "BLOCKS",
            status: "CONFIRMED",
            sourceKind: "AI",
            confirmedById: auth.user.userId,
            confirmedAt: new Date(),
          },
        });
        debugServer.event("POST /inferences/[id]/decision", "RESPONSIBILITY_RELATION_CREATED(採用時解決)", {
          fromId: blockingResponsibility.id,
          toId: responsibility.id,
        });
      }
    }

    // 逆方向: 既に採用済みの他候補が、この候補(今作成したResponsibility)を
    // blockedByCandidateIdsに含めていた場合(=先にブロック元でない方が採用されていた場合)、
    // 今このタイミングで関係を解決する。
    const dependentSiblingInferences = await tx.aiInference.findMany({
      where: {
        captureId: inference.captureId,
        decision: { in: ["ACCEPTED", "EDITED"] },
        id: { not: inference.id },
      },
      select: { id: true, payload: true },
    });
    for (const sibling of dependentSiblingInferences) {
      const siblingCandidate = ResponsibilityCandidateSchema.safeParse(sibling.payload);
      if (!siblingCandidate.success) continue;
      if (!siblingCandidate.data.blockedByCandidateIds.includes(candidate.candidateId)) continue;
      const dependentResponsibility = await tx.responsibility.findFirst({
        where: { originInferenceId: sibling.id },
        select: { id: true },
      });
      if (!dependentResponsibility) continue;
      // 既に(採用順序次第で)上のループで作成済みの場合はスキップする
      const alreadyExists = await tx.responsibilityRelation.findFirst({
        where: { fromId: responsibility.id, toId: dependentResponsibility.id, relationType: "BLOCKS" },
        select: { id: true },
      });
      if (alreadyExists) continue;
      await tx.responsibilityRelation.create({
        data: {
          fromId: responsibility.id,
          toId: dependentResponsibility.id,
          relationType: "BLOCKS",
          status: "CONFIRMED",
          sourceKind: "AI",
          confirmedById: auth.user.userId,
          confirmedAt: new Date(),
        },
      });
      debugServer.event("POST /inferences/[id]/decision", "RESPONSIBILITY_RELATION_CREATED(逆方向解決)", {
        fromId: responsibility.id,
        toId: dependentResponsibility.id,
      });
    }

    await tx.eventLog.create({
      data: {
        aggregateType: "Responsibility",
        aggregateId: responsibility.id,
        eventType: "AI_CANDIDATE_DECIDED",
        beforeJson: { inferenceId: inference.id, decision: "PENDING" },
        afterJson: { inferenceId: inference.id, decision: storedDecision, responsibilityId: responsibility.id },
        actorType: "USER",
        actorId: auth.user.userId,
        correlationId: req.headers.get("x-correlation-id") ?? undefined,
      },
    });
    debugServer.event("POST /inferences/[id]/decision", "AI_CANDIDATE_DECIDED", { aggregateId: responsibility.id });

    await tx.outboxEvent.create({
      data: {
        eventName: "ResponsibilityCreated.v1",
        eventVersion: "1",
        aggregateId: responsibility.id,
        aggregateVersion: responsibility.version,
        correlationId: req.headers.get("x-correlation-id") ?? undefined,
        payload: {
          responsibilityId: responsibility.id,
          workspaceId,
          domainId: responsibility.domainId,
          type: responsibility.type,
          fromInferenceId: inference.id,
        },
      },
    });
    debugServer.event("POST /inferences/[id]/decision", "ResponsibilityCreated.v1", {
      aggregateId: responsibility.id,
    });

    return responsibility;
  }).catch((e: unknown) => {
    if (e instanceof Error && e.message === "ISMAY_VERSION_CONFLICT") {
      return null;
    }
    throw e;
  });

  if (!created) {
    return apiError("VERSION_CONFLICT", "他の操作と競合しました。最新の状態を取得してください", { retryable: true });
  }

  return apiOk(
    {
      inferenceId: inference.id,
      decision: storedDecision,
      responsibilityId: created.id,
      undoDeadlineAt: null,
    },
    { status: 201 },
  );
}
