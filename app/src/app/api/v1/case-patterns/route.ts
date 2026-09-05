import type { NextRequest } from "next/server";
import { db } from "@/lib/db";
import { requireAuth } from "@/lib/auth/guard";
import { ensureDefaultWorkspace } from "@/lib/workspace";
import { apiOk, apiError } from "@/lib/auth/response";

/**
 * GET /api/v1/case-patterns(PATTERN-SUGGEST-01B新設・2026-09-05)。
 * 出典: Claude向け_ISMAY_3b695d9以降_再監査是正・CasePattern実機能完遂指示_
 * 2026-09-04.md §6「読取API: ...owner本人のCase Pattern一覧・詳細」。
 *
 * [設計方針] 既存`GET /pem/hypotheses`(id無し一覧)と同じ「本人=auth.user.userIdの
 * データのみ返す、workspaceIdでtenant境界を絞る」設計を踏襲する。他本人の
 * Patternは既存project-contexts/[id]と同じIDOR対策方針により一切返さない
 * (whereで自動的にフィルタされるため、そもそも取得され得ない)。
 *
 * DOC-06 §6「候補表示 raw sample>=2」に満たないstatus=NONEのPatternは
 * このv1では除外しない(想像で追加フィルタを発明しない。「候補表示にすら
 * 値しない」という判定はcasePatternMath.ts側の既存stage計算がstatus自体を
 * NONEのまま据え置くことで既に表現されているため、UI側がstatus!=NONEで
 * 表示要否を判断できる)。
 */
export async function GET(req: NextRequest) {
  const auth = await requireAuth(req);
  if (!auth.authenticated) {
    return apiError("AUTH_REQUIRED", "ログインが必要です");
  }
  const { workspaceId } = await ensureDefaultWorkspace(auth.user.userId, auth.user.email);

  const patterns = await db.casePattern.findMany({
    where: { workspaceId, ownerSubjectUserId: auth.user.userId },
    orderBy: [{ status: "desc" }, { confidence: "desc" }],
    select: {
      id: true,
      title: true,
      status: true,
      confidence: true,
      observedIntervalDays: true,
      currentRevision: true,
      createdAt: true,
      updatedAt: true,
    },
  });

  return apiOk({
    patterns: patterns.map((p: { id: string; title: string; status: string; confidence: unknown; observedIntervalDays: unknown; currentRevision: number; createdAt: Date; updatedAt: Date }) => ({
      id: p.id,
      title: p.title,
      status: p.status,
      confidence: Number(p.confidence),
      observedIntervalDays: p.observedIntervalDays !== null ? Number(p.observedIntervalDays) : null,
      currentRevision: p.currentRevision,
      createdAt: p.createdAt.toISOString(),
      updatedAt: p.updatedAt.toISOString(),
    })),
  });
}
