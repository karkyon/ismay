import type { NextRequest } from "next/server";
import { z } from "zod";
import { db } from "@/lib/db";
import { requireAuth, requireCsrf } from "@/lib/auth/guard";
import { ensureDefaultWorkspace } from "@/lib/workspace";
import { apiOk, apiError } from "@/lib/auth/response";
import { buildCasePatternSuggestionDto } from "@/lib/patterns/casePatternSuggestion";

/**
 * GET /api/v1/case-patterns/{id}(PATTERN-SUGGEST-01B新設・2026-09-05)。
 * 出典: Claude向け_ISMAY_3b695d9以降_再監査是正・CasePattern実機能完遂指示_
 * 2026-09-04.md §6「読取API: ...owner本人のCase Pattern一覧・詳細」。
 *
 * tenant境界(workspaceId)・本人境界(ownerSubjectUserId=auth.user.userId)の
 * 両方でfindFirstを絞り、他本人/他workspaceのPattern IDを推測されても
 * 存在有無を漏らさない(既存project-contexts/[id]と同じIDOR対策)。
 *
 * DOC-06 §7「過去N件・M文脈・確度C・採用率A」をbuildCasePatternSuggestionDto
 * (既存casePatternSuggestion.ts、PATTERN-DETECT-01E実装済み)経由でそのまま
 * 返す(このAPIのために別途再計算ロジックを発明しない)。
 */
export async function GET(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const auth = await requireAuth(req);
  if (!auth.authenticated) {
    return apiError("AUTH_REQUIRED", "ログインが必要です");
  }
  const { id: patternId } = await ctx.params;
  const { workspaceId } = await ensureDefaultWorkspace(auth.user.userId, auth.user.email);

  const pattern = await db.casePattern.findFirst({
    where: { id: patternId, workspaceId, ownerSubjectUserId: auth.user.userId },
  });
  if (!pattern) {
    return apiError("RESOURCE_NOT_FOUND", "指定されたCase Patternが見つかりません");
  }

  const revisions = await db.casePatternRevision.findMany({
    where: { patternId: pattern.id, workspaceId },
    orderBy: { revision: "desc" },
    select: { id: true, revision: true, representativeText: true, decompositionTemplate: true, schemaVersion: true, createdAt: true },
  });

  const dto = await buildCasePatternSuggestionDto(workspaceId, pattern.id);

  // [PATTERN-SUGGEST-01B新設・2026-09-05] このPatternへ現在MATCHED/AMBIGUOUSで
  // 紐づいている提案一覧(本人自身の全FormationSession横断)。「AMBIGUOUS候補
  // 確認」(指示書§6)は、matchedPatternIdがこのPatternのAMBIGUOUS結果には
  // 現れない(AMBIGUOUS時はmatchedPatternId自体がnullのため)ことに注意——
  // AMBIGUOUS候補確認は「このPatternが提案候補になったが確定しなかった」
  // ではなく「Suggestion側から見て複数Pattern候補で迷った」という意味であり、
  // Suggestion一覧(formation-sessions/[id]のpatternSuggestion.evidenceSnapshot/
  // decompositionProposal.ambiguousCandidates)側で確認する設計とする
  // (Pattern詳細画面はこのPatternへの確定済みMATCHEDのみ列挙すれば十分)。
  const linkedSuggestions = await db.casePatternSuggestionRevision.findMany({
    where: { workspaceId, matchedPatternId: pattern.id },
    orderBy: { createdAt: "desc" },
    take: 50,
    select: { id: true, suggestionId: true, candidateId: true, similarity: true, createdAt: true },
  });

  // [PATTERN-MANAGEMENT-UI-01新設・2026-09-19] 現行ActionSlot群(Gate 4〜6で
  // 実装済みのCasePatternActionSlot/Revision)を、Pattern管理画面で
  // 「このPatternが何を学習したか」を確認できるよう含める。
  const actionSlots = await db.casePatternActionSlot.findMany({
    where: { workspaceId, patternId: pattern.id, currentRevision: { gt: 0 } },
  });
  const actionSlotRevisions = await db.casePatternActionSlotRevision.findMany({
    where: {
      workspaceId,
      OR: actionSlots.map((s: { id: string; currentRevision: number }) => ({ slotId: s.id, revision: s.currentRevision })),
    },
  });
  const actionSlotRevisionBySlotId = new Map(actionSlotRevisions.map((r: { slotId: string }) => [r.slotId, r]));

  return apiOk({
    pattern: {
      id: pattern.id,
      title: pattern.title,
      status: pattern.status,
      confidence: Number(pattern.confidence),
      observedIntervalDays: pattern.observedIntervalDays !== null ? Number(pattern.observedIntervalDays) : null,
      currentRevision: pattern.currentRevision,
      retiredAt: pattern.retiredAt !== null ? pattern.retiredAt.toISOString() : null,
      createdAt: pattern.createdAt.toISOString(),
      updatedAt: pattern.updatedAt.toISOString(),
    },
    actionSlots: actionSlots.map((s: { id: string; slotKey: string }) => {
      const rev = actionSlotRevisionBySlotId.get(s.id) as
        | { normalizedIntent: string; suggestedType: string; occurrenceProbability: unknown; typicalOrder: unknown; rawSampleSize: number; durationDistribution: unknown; atomicityDistribution: unknown }
        | undefined;
      return {
        slotKey: s.slotKey,
        titleExample: rev?.normalizedIntent ?? null,
        suggestedType: rev?.suggestedType ?? null,
        occurrenceProbability: rev ? Number(rev.occurrenceProbability) : null,
        typicalOrder: rev ? Number(rev.typicalOrder) : null,
        rawSampleSize: rev?.rawSampleSize ?? null,
        durationDistribution: rev?.durationDistribution ?? null,
        atomicityDistribution: rev?.atomicityDistribution ?? null,
      };
    }),
    revisions: revisions.map((r: { id: string; revision: number; representativeText: string; decompositionTemplate: unknown; schemaVersion: string; createdAt: Date }) => ({
      id: r.id,
      revision: r.revision,
      representativeText: r.representativeText,
      decompositionTemplate: r.decompositionTemplate,
      schemaVersion: r.schemaVersion,
      createdAt: r.createdAt.toISOString(),
    })),
    // DOC-06 §7「過去N件・M文脈・確度C・採用率A」。
    suggestionDto: dto,
    linkedSuggestions: linkedSuggestions.map((s: { id: string; suggestionId: string; candidateId: string; similarity: unknown; createdAt: Date }) => ({
      suggestionRevisionId: s.id,
      suggestionId: s.suggestionId,
      candidateId: s.candidateId,
      similarity: Number(s.similarity),
      createdAt: s.createdAt.toISOString(),
    })),
  });
}

const PatchRequestSchema = z.object({
  action: z.enum(["RETIRE", "REACTIVATE"]),
});

/**
 * PATCH /api/v1/case-patterns/{id}(PATTERN-MANAGEMENT-UI-01新設・
 * 2026-09-19)。
 * 出典: Claude向け_ISMAY_d68e9bf以降_ActionSlot正本準拠・CasePattern実分解
 * 完遂・残工程連続実装指示_2026-09-17.md P1「11. Pattern管理UI」。
 *
 * [statusとは別列] retiredAtはaggregation(casePatternAggregation.ts)が
 * 無条件で上書きするstatus列とは独立させている(schema.prismaコメント参照)。
 * 退避中もSourceLink・ActionSlot学習自体は止めない(既存の破壊的巻き戻し
 * 禁止方針を踏襲)。matching(casePatternMatching.ts)からのみ除外する。
 */
export async function PATCH(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const auth = await requireAuth(req);
  if (!auth.authenticated) {
    return apiError("AUTH_REQUIRED", "ログインが必要です");
  }
  if (!requireCsrf(req)) {
    return apiError("ACCESS_DENIED", "CSRFトークンが不正です");
  }

  const json = await req.json().catch(() => null);
  const parsed = PatchRequestSchema.safeParse(json);
  if (!parsed.success) {
    return apiError("VALIDATION_FAILED", "actionはRETIREまたはREACTIVATEを指定してください");
  }

  const { id: patternId } = await ctx.params;
  const { workspaceId } = await ensureDefaultWorkspace(auth.user.userId, auth.user.email);

  // [IDOR対策] GETと同じくtenant境界・本人境界の両方でfindFirstを絞る。
  const pattern = await db.casePattern.findFirst({
    where: { id: patternId, workspaceId, ownerSubjectUserId: auth.user.userId },
    select: { id: true, retiredAt: true },
  });
  if (!pattern) {
    return apiError("RESOURCE_NOT_FOUND", "指定されたCase Patternが見つかりません");
  }

  if (parsed.data.action === "RETIRE") {
    if (pattern.retiredAt !== null) {
      return apiOk({ retiredAt: pattern.retiredAt.toISOString() });
    }
    const updated = await db.casePattern.update({
      where: { id: pattern.id },
      data: { retiredAt: new Date(), retiredById: auth.user.userId },
      select: { retiredAt: true },
    });
    return apiOk({ retiredAt: updated.retiredAt!.toISOString() });
  }

  // REACTIVATE
  if (pattern.retiredAt === null) {
    return apiOk({ retiredAt: null });
  }
  await db.casePattern.update({
    where: { id: pattern.id },
    data: { retiredAt: null, retiredById: null },
  });
  return apiOk({ retiredAt: null });
}
