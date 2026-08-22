import type { NextRequest } from "next/server";
import { db } from "@/lib/db";
import { requireAuth } from "@/lib/auth/guard";
import { ensureDefaultWorkspace } from "@/lib/workspace";
import { apiOk, apiError } from "@/lib/auth/response";
import { isTypeSpecificTerminalStatus } from "@/lib/responsibility";

/**
 * API-WK-06: GET /today-summary(2026-08-22新設)。
 *
 * Todoist「今日/近日中/今後」・Things 3「今日」画面のセクション分けに相当する、
 * 期限の近さによる階層バケット表示。lib/planning.tsの閾値(24時間/72時間)と
 * 同じ考え方を踏襲し、「今日」を24時間以内、「3日以内」を72時間以内、「今週」を
 * 168時間(7日)以内として分類する。バケットは排他的(ある責任は最も近いバケット
 * 1つにのみ属する)。
 *
 * pinnedはFN-WK-03「今日の最低ライン」。バケットと独立して常に別枠で返す
 * (Notion「今週のタスク」の手動ピン留め+自動集計の併用に相当)。
 *
 * 判定に使う日時は hardDeadlineAt を優先し、無ければ targetAt を使う
 * (lib/planning.tsのスコアリングと同じ優先順位)。
 */

type BucketRow = {
  id: string;
  type: string;
  title: string;
  status: string;
  importance: number | null;
  hardDeadlineAt: Date | null;
  targetAt: Date | null;
  pinned: boolean;
};

function toItem(r: BucketRow, effectiveAt: Date) {
  return {
    id: r.id,
    type: r.type,
    title: r.title,
    status: r.status,
    importance: r.importance,
    effectiveAt: effectiveAt.toISOString(),
    isHardDeadline: !!r.hardDeadlineAt,
    pinned: r.pinned,
  };
}

export async function GET(req: NextRequest) {
  const auth = await requireAuth(req);
  if (!auth.authenticated) {
    return apiError("AUTH_REQUIRED", "ログインが必要です");
  }

  const now = new Date();
  const nowMs = now.getTime();
  const horizon7d = new Date(nowMs + 7 * 24 * 60 * 60 * 1000);

  const { workspaceId } = await ensureDefaultWorkspace(auth.user.userId, auth.user.email);

  const rows = await db.responsibility.findMany({
    where: {
      workspaceId,
      deletedAt: null,
      completedAt: null,
      OR: [
        { hardDeadlineAt: { not: null, lte: horizon7d } },
        { targetAt: { not: null, lte: horizon7d } },
      ],
    },
    select: {
      id: true,
      type: true,
      title: true,
      status: true,
      importance: true,
      hardDeadlineAt: true,
      targetAt: true,
      pinned: true,
    },
    orderBy: [{ hardDeadlineAt: "asc" }, { targetAt: "asc" }],
  });

  const pinnedRows = await db.responsibility.findMany({
    where: { workspaceId, deletedAt: null, completedAt: null, pinned: true },
    select: {
      id: true,
      type: true,
      title: true,
      status: true,
      importance: true,
      hardDeadlineAt: true,
      targetAt: true,
      pinned: true,
    },
    orderBy: { pinnedAt: "asc" },
  });

  const today: ReturnType<typeof toItem>[] = [];
  const next3Days: ReturnType<typeof toItem>[] = [];
  const thisWeek: ReturnType<typeof toItem>[] = [];

  for (const r of rows as BucketRow[]) {
    if (isTypeSpecificTerminalStatus(r.type, r.status)) continue;
    const effectiveAt = r.hardDeadlineAt ?? r.targetAt;
    if (!effectiveAt) continue;
    const hours = (effectiveAt.getTime() - nowMs) / (1000 * 60 * 60);
    const item = toItem(r, effectiveAt);
    if (hours <= 24) {
      today.push(item);
    } else if (hours <= 72) {
      next3Days.push(item);
    } else {
      thisWeek.push(item);
    }
  }

  const pinned = (pinnedRows as BucketRow[])
    .filter((r) => !isTypeSpecificTerminalStatus(r.type, r.status))
    .map((r) => toItem(r, r.hardDeadlineAt ?? r.targetAt ?? now));

  return apiOk({
    pinned,
    today,
    next3Days,
    thisWeek,
    generatedAt: now.toISOString(),
  });
}
