import type { NextRequest } from "next/server";
import { db } from "@/lib/db";
import { requireAuth } from "@/lib/auth/guard";
import { ensureDefaultWorkspace } from "@/lib/workspace";
import { apiOk, apiError } from "@/lib/auth/response";

/**
 * GET /api/v1/admin/ai-usage: AI運用コストの可視化(2026-08-20新設)。
 * 「APIの運用コストも明示的に明確に視覚的に随時確認できるように」への対応。
 *
 * AiRun.costMicros(schema.prisma既存列。従来は書き込まれておらず常にnullだった)を
 * lib/ai/pricing.tsの料金表で算出して集計する。costMicros=nullの行(料金表未登録
 * モデルによる呼び出し、または本パッチ適用前の過去データ)は件数のみ集計しコストは
 * 「不明」として区別し、実際より安く見せない。
 */
export async function GET(req: NextRequest) {
  const auth = await requireAuth(req);
  if (!auth.authenticated) {
    return apiError("AUTH_REQUIRED", "ログインが必要です");
  }

  const { workspaceId } = await ensureDefaultWorkspace(auth.user.userId, auth.user.email);

  const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);

  const [byModelAllTime, byModelLast30Days, unknownCostCount] = await Promise.all([
    db.aiRun.groupBy({
      by: ["provider", "model"],
      where: { capture: { workspaceId } },
      _sum: { inputTokens: true, outputTokens: true, costMicros: true },
      _count: { _all: true },
    }),
    db.aiRun.groupBy({
      by: ["provider", "model"],
      where: { capture: { workspaceId }, startedAt: { gte: thirtyDaysAgo } },
      _sum: { inputTokens: true, outputTokens: true, costMicros: true },
      _count: { _all: true },
    }),
    db.aiRun.count({ where: { capture: { workspaceId }, costMicros: null } }),
  ]);

  type GroupRow = {
    provider: string;
    model: string;
    _sum: { inputTokens: number | null; outputTokens: number | null; costMicros: bigint | null };
    _count: { _all: number };
  };

  function serialize(rows: GroupRow[]) {
    return rows.map((r) => ({
      provider: r.provider,
      model: r.model,
      runCount: r._count._all,
      inputTokens: r._sum.inputTokens ?? 0,
      outputTokens: r._sum.outputTokens ?? 0,
      // BigIntはJSON化できないためstring化。表示側でNumber変換して$表記へ整形する。
      costMicros: r._sum.costMicros !== null ? r._sum.costMicros.toString() : null,
    }));
  }

  const allTimeRows = serialize(byModelAllTime as GroupRow[]);
  const last30DaysRows = serialize(byModelLast30Days as GroupRow[]);

  const totalCostMicrosAllTime = allTimeRows.reduce(
    (sum, r) => sum + (r.costMicros !== null ? BigInt(r.costMicros) : BigInt(0)),
    BigInt(0),
  );
  const totalCostMicrosLast30Days = last30DaysRows.reduce(
    (sum, r) => sum + (r.costMicros !== null ? BigInt(r.costMicros) : BigInt(0)),
    BigInt(0),
  );

  return apiOk({
    byModelAllTime: allTimeRows,
    byModelLast30Days: last30DaysRows,
    totalCostMicrosAllTime: totalCostMicrosAllTime.toString(),
    totalCostMicrosLast30Days: totalCostMicrosLast30Days.toString(),
    unknownCostRunCount: unknownCostCount,
    calculatedAt: new Date().toISOString(),
  });
}
