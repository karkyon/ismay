import type { NextRequest } from "next/server";
import { db } from "@/lib/db";
import { requireAuth } from "@/lib/auth/guard";
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

  return apiOk({
    pattern: {
      id: pattern.id,
      title: pattern.title,
      status: pattern.status,
      confidence: Number(pattern.confidence),
      observedIntervalDays: pattern.observedIntervalDays !== null ? Number(pattern.observedIntervalDays) : null,
      currentRevision: pattern.currentRevision,
      createdAt: pattern.createdAt.toISOString(),
      updatedAt: pattern.updatedAt.toISOString(),
    },
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
