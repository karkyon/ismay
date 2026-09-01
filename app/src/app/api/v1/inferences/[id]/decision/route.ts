import type { NextRequest } from "next/server";
import { z } from "zod";
import { db } from "@/lib/db";
import type { Prisma } from "@/generated/prisma/client";
import { debugServer, redactSensitive } from "@/lib/debugServer";
import { requireAuth, requireCsrf } from "@/lib/auth/guard";
import { ensureDefaultWorkspace } from "@/lib/workspace";
import { apiOk, apiError } from "@/lib/auth/response";
import { RESPONSIBILITY_TYPES, initialStatusFor } from "@/lib/responsibility";
import { ResponsibilityCandidateSchema } from "@/lib/ai/schema";
import { embedAndStoreResponsibility, findRelatedResponsibilities } from "@/lib/ai/relatedResponsibilities";
import { createResponsibilityWithLinks } from "@/lib/formation/responsibilityMaterializationCore";
import { resolveLegacyFallbackEligibility } from "@/lib/formation/legacyProjectionResolver";

/**
 * [B4新設・CHG-011 Feature Flag委譲・2026-08-29]
 * 監査「Gate M1-B4 次工程指示」B31-05/B31-06是正(案B・カルキョンさん承認)。
 * `true`の場合のみ、下のResponsibility作成+Tag付与+BLOCKS解決+EventLog+Outboxを
 * `@/lib/formation/responsibilityMaterializationCore`の共通コア関数へ委譲する
 * (新Formation Materialize(`materialize.ts`)と実装を1本化)。`false`または未設定
 * (デフォルト)の場合は、このファイル本来の既存inline実装をそのまま使う
 * (blast radius最小化方針。ロールバックは環境変数変更のみで即時可能、再deploy不要)。
 * 委譲後もこのroute自身が`db.$transaction`でDecision記録とResponsibility作成を
 * 同一transactionに包む点は変わらないため、非atomicity(B31-05)は生じない
 * (共通コア関数自体はtransactionを開始しない設計、同ファイルのコメント参照)。
 */
const CHG011_SHARED_CORE_ENABLED = process.env.FEATURE_CHG011_SHARED_CORE === "true";

/**
 * API-AI-01: POST /inferences/{id}/decision 候補採否(FN-AI-01/UI-04)
 * 出典: API・イベント設計書v1.1 4.2節。
 *
 * [既知のスコープ外・正直に明記]
 * - 「既存統合は対象versionとimpactConfirmation必須」に対応する重複統合フローは、
 *   FN-GR-01/02(意味照合・関係確定)が未実装のため本パッチでは扱わない。
 *   ACCEPT/EDITは常に新規Responsibilityとして作成する。
 * - レスポンスの「取消可能期限」(undoDeadlineAt)は常にnullを返す。
 *   [2026-08-23訂正] このコメントは元々「API-RESP-06の5分間取消と合わせて対応予定」と
 *   記載していたが古い情報だった。実際に実装した一括操作の取消(FN-WK-04)は5分間の
 *   期限付きUndoではなく無期限のステートレスUndo(操作前の状態を都度APIから再取得して
 *   復元する方式)であり、この個別採否APIのundoDeadlineAtフィールドとは無関係。
 *   フィールド自体は現状フロントで未使用のためnullのまま残すが、将来この個別採否の
 *   取消(期限付き)を実装する場合はここを置き換える。
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

  // [B4.2新設・2026-08-29、M1-B6C-5是正・2026-09-02指示書§7]
  // cutover flag(FEATURE_CHG011_SHARED_CORE)がON、かつこのCaptureに対応する
  // FormationSessionが既に存在する場合、旧routeでの直接生成をserver側で拒否する
  // (監査「Gate M1-B4.1即時完了・B4.2連続実装指示」B4.2受入項目7・8)。
  // [M1-B6C-5是正] 「shadow欠落時だけ安全に旧経路へfallbackする」という条件を
  // 厳密化した: FormationSessionが無くても、shadow書込みがまだ進行中
  // (PENDING/RUNNING/RETRY_WAIT)の間はfallbackを許可しない(詳細は
  // legacyProjectionResolver.ts `resolveLegacyFallbackEligibility`のコメント参照)。
  // Flag OFF時は既存Inbox挙動を完全維持する(項目10、この判定自体を呼ばない)。
  if (CHG011_SHARED_CORE_ENABLED) {
    const fallbackDecision = await resolveLegacyFallbackEligibility(db, {
      captureId: inference.captureId,
      workspaceId,
    });
    if (!fallbackDecision.allowed) {
      if (fallbackDecision.reason === "FORMATION_SESSION_EXISTS") {
        return apiError(
          "STATE_TRANSITION_INVALID",
          "このCaptureはFormation経路(Session Review)へ移行済みです。旧採否APIは使用できません",
          { retryable: false, extra: { formationSessionId: fallbackDecision.formationSessionId } },
        );
      }
      // SHADOW_WRITE_IN_PROGRESS: まだ「欠落」と確定していないため、確定
      // (成功→Formation経路/DEAD_LETTER→fallback許可)するまで少し待ってから
      // 再試行するようクライアントへ伝える。
      return apiError(
        "STATE_TRANSITION_INVALID",
        "このCaptureはFormation経路への移行処理が進行中です。少し時間をおいて再度お試しください",
        { retryable: true, extra: { checkpointStatus: fallbackDecision.checkpointStatus } },
      );
    }
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

  const created = await db.$transaction(async (tx: Prisma.TransactionClient) => {
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

    let responsibility: { id: string; domainId: string; title: string; description: string | null };

    if (CHG011_SHARED_CORE_ENABLED) {
      // [B4新設・CHG-011有効時] Responsibility作成+Tag付与+BLOCKS解決+EventLog+Outboxを
      // 共通コア関数へ委譲する。BLOCKS解決の相手探索(同一Capture内のACCEPTED/EDITED
      // 候補)自体はこのroute固有のデータモデル(AiInference)に依存するため、
      // ここで解決してから共通コアへ「解決済みの相手Responsibility ID一覧」だけを渡す
      // (共通コア側はAiInferenceを一切知らない、というB31-05/06是正時の設計方針)。
      const siblingInferences = await tx.aiInference.findMany({
        where: { captureId: inference.captureId, decision: { in: ["ACCEPTED", "EDITED"] }, id: { not: inference.id } },
        select: { id: true, payload: true },
      });
      const blockedByResponsibilityIds: string[] = [];
      for (const sibling of siblingInferences) {
        const siblingCandidate = ResponsibilityCandidateSchema.safeParse(sibling.payload);
        if (!siblingCandidate.success) continue;
        if (!candidate.blockedByCandidateIds.includes(siblingCandidate.data.candidateId)) continue;
        const blockingResponsibility = await tx.responsibility.findFirst({
          where: { originInferenceId: sibling.id },
          select: { id: true },
        });
        if (blockingResponsibility) blockedByResponsibilityIds.push(blockingResponsibility.id);
      }
      const blocksResponsibilityIds: string[] = [];
      for (const sibling of siblingInferences) {
        const siblingCandidate = ResponsibilityCandidateSchema.safeParse(sibling.payload);
        if (!siblingCandidate.success) continue;
        if (!siblingCandidate.data.blockedByCandidateIds.includes(candidate.candidateId)) continue;
        const dependentResponsibility = await tx.responsibility.findFirst({
          where: { originInferenceId: sibling.id },
          select: { id: true },
        });
        if (dependentResponsibility) blocksResponsibilityIds.push(dependentResponsibility.id);
      }

      responsibility = await createResponsibilityWithLinks(tx, {
        workspaceId,
        domainId: inference.capture.domainId ?? defaultDomainId,
        originCaptureId: inference.captureId,
        originInferenceId: inference.id,
        type: finalType,
        title: finalTitle,
        description: finalDescription ?? null,
        importance: finalImportance ?? null,
        confidence: candidate.confidence,
        hardDeadlineAt: finalHardDeadlineAt ? new Date(finalHardDeadlineAt) : null,
        targetAt: finalTargetAt ? new Date(finalTargetAt) : null,
        startAfterAt: finalStartAfterAt ? new Date(finalStartAfterAt) : null,
        actorUserId: auth.user.userId,
        suggestedTags: candidate.suggestedTags,
        correlationId: req.headers.get("x-correlation-id") ?? undefined,
        // [B4.1是正・B41-01] storedDecisionは"ACCEPTED"|"EDITED"のいずれか
        // (decisionは"ACCEPT"|"EDIT"のみこの分岐へ来るためDECISION_TO_STOREDの
        // 値もこの2つに限られる)。EventLog.afterJson.decisionをAiInference.decision
        // と一致させる。
        decisionValue: storedDecision as "ACCEPTED" | "EDITED",
        actor: candidate.actor ?? null,
        counterparty: candidate.counterparty ?? null,
        provenance: { kind: "AI_INFERENCE", inferenceId: inference.id },
        blockedByResponsibilityIds,
        blocksResponsibilityIds,
      });
      debugServer.event("POST /inferences/[id]/decision", "CHG011_SHARED_CORE_DELEGATED", {
        responsibilityId: responsibility.id,
      });
    } else {
      // [既存inline実装・変更なし] CHG-011未有効時は本来の実装をそのまま使う。
      const created = await tx.responsibility.create({
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
      responsibility = created;
      debugServer.state("POST /inferences/[id]/decision", "AiInference.decision", {
        inferenceId: inference.id,
        decision: storedDecision,
      });

      if (candidate.suggestedTags.length > 0) {
        for (const tagName of candidate.suggestedTags.slice(0, 3)) {
          const trimmed = tagName.trim();
          if (!trimmed) continue;
          const tag = await tx.tag.upsert({
            where: { workspaceId_name: { workspaceId, name: trimmed } },
            create: { workspaceId, name: trimmed },
            update: {},
            select: { id: true },
          });
          await tx.responsibilityTag.create({
            data: { responsibilityId: created.id, tagId: tag.id },
          });
        }
        debugServer.event("POST /inferences/[id]/decision", "AI提案タグを自動付与", {
          responsibilityId: created.id,
          tags: candidate.suggestedTags,
        });
      }

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
              toId: created.id,
              relationType: "BLOCKS",
              status: "CONFIRMED",
              sourceKind: "AI",
              confirmedById: auth.user.userId,
              confirmedAt: new Date(),
            },
          });
          debugServer.event("POST /inferences/[id]/decision", "RESPONSIBILITY_RELATION_CREATED(採用時解決)", {
            fromId: blockingResponsibility.id,
            toId: created.id,
          });
        }
      }

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
        const alreadyExists = await tx.responsibilityRelation.findFirst({
          where: { fromId: created.id, toId: dependentResponsibility.id, relationType: "BLOCKS" },
          select: { id: true },
        });
        if (alreadyExists) continue;
        await tx.responsibilityRelation.create({
          data: {
            fromId: created.id,
            toId: dependentResponsibility.id,
            relationType: "BLOCKS",
            status: "CONFIRMED",
            sourceKind: "AI",
            confirmedById: auth.user.userId,
            confirmedAt: new Date(),
          },
        });
        debugServer.event("POST /inferences/[id]/decision", "RESPONSIBILITY_RELATION_CREATED(逆方向解決)", {
          fromId: created.id,
          toId: dependentResponsibility.id,
        });
      }

      await tx.eventLog.create({
        data: {
          aggregateType: "Responsibility",
          aggregateId: created.id,
          eventType: "AI_CANDIDATE_DECIDED",
          beforeJson: { inferenceId: inference.id, decision: "PENDING" },
          afterJson: { inferenceId: inference.id, decision: storedDecision, responsibilityId: created.id },
          actorType: "USER",
          actorId: auth.user.userId,
          correlationId: req.headers.get("x-correlation-id") ?? undefined,
        },
      });
      debugServer.event("POST /inferences/[id]/decision", "AI_CANDIDATE_DECIDED", { aggregateId: created.id });

      await tx.outboxEvent.create({
        data: {
          eventName: "ResponsibilityCreated.v1",
          eventVersion: "1",
          aggregateId: created.id,
          aggregateVersion: created.version,
          correlationId: req.headers.get("x-correlation-id") ?? undefined,
          payload: {
            responsibilityId: created.id,
            workspaceId,
            domainId: created.domainId,
            type: created.type,
            fromInferenceId: inference.id,
          },
        },
      });
      debugServer.event("POST /inferences/[id]/decision", "ResponsibilityCreated.v1", { aggregateId: created.id });
    }

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

  // FN-GR-01: 意味照合用の埋め込みを生成・保存する(トランザクション外。Embedding API呼び出しは
  // レイテンシがあり、かつ失敗してもResponsibility本体の作成自体は成立済みのため、
  // ここで失敗しても responsibility 作成自体はロールバックしない)。
  const embedResult = await embedAndStoreResponsibility({
    responsibilityId: created.id,
    workspaceId,
    domainId: created.domainId,
    title: created.title,
    description: created.description,
    actor: candidate.actor,
    counterparty: candidate.counterparty,
  }).catch((err: unknown) => {
    debugServer.error("POST /inferences/[id]/decision", "embedAndStoreResponsibility例外", err);
    return { ok: false as const, reason: String(err) };
  });

  const relatedResponsibilities = embedResult.ok
    ? await findRelatedResponsibilities({ responsibilityId: created.id, workspaceId }).catch((err: unknown) => {
        debugServer.error("POST /inferences/[id]/decision", "findRelatedResponsibilities例外", err);
        return [];
      })
    : [];

  return apiOk(
    {
      inferenceId: inference.id,
      decision: storedDecision,
      responsibilityId: created.id,
      undoDeadlineAt: null,
      relatedResponsibilities,
    },
    { status: 201 },
  );
}
