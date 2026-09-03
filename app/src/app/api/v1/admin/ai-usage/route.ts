import type { NextRequest } from "next/server";
import { db } from "@/lib/db";
import { requireAuth } from "@/lib/auth/guard";
import { ensureDefaultWorkspace } from "@/lib/workspace";
import { apiOk, apiError } from "@/lib/auth/response";
import { requireAdminConsoleRole } from "@/lib/auth/roleGuard";

/**
 * GET /api/v1/admin/ai-usage: AI運用コスト・利用状況の可視化(2026-08-20新設、同日追補)。
 *
 * [Gate SECURITY-RBAC-01是正・2026-09-03] 運用コスト・APIキー登録状況が間接的に
 * わかる情報のため、../ai-providers/route.tsと同じrequireAdminConsoleRole
 * (OWNER/ADMINのみ)を追加した。詳細な根拠は../ai-providers/route.tsのコメント参照。
 * 「一般的なAI APIツールと同じようなUI/UX、使用量・頻度・効率・効果の視覚的確認」への対応。
 *
 * 市販ツール(OpenAI Usage Dashboard、Anthropic Console、Langfuse等)を参考に、
 * 単純な合計値だけでなく以下を追加する。
 * - 日次トレンド(直近14日、コスト・呼び出し回数の推移)
 * - 成功率・エラー率(AiRun.status)
 * - レイテンシ(平均・p95、AiRun.latencyMs)
 * - AI候補の採用率(AiInference.decision。ISMAY独自の「効果」指標。市販ツールには
 *   無い、この製品固有の価値検証指標)
 * - 直近の呼び出しログ(ドリルダウン用)
 *
 * AiRun.costMicros(schema.prisma既存列。従来は書き込まれておらず常にnullだった)を
 * lib/ai/pricing.tsの料金表で算出して集計する。costMicros=nullの行は件数のみ集計し
 * コストは「不明」として区別し、実際より安く見せない。
 */
export async function GET(req: NextRequest) {
  const auth = await requireAuth(req);
  if (!auth.authenticated) {
    return apiError("AUTH_REQUIRED", "ログインが必要です");
  }

  const { workspaceId } = await ensureDefaultWorkspace(auth.user.userId, auth.user.email);

  const roleOk = await requireAdminConsoleRole({
    userId: auth.user.userId,
    workspaceId,
    action: "ADMIN_AI_USAGE_VIEW",
  });
  if (!roleOk) {
    return apiError("ACCESS_DENIED", "この操作には管理者権限(OWNER/ADMIN)が必要です");
  }

  const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
  const fourteenDaysAgo = new Date(Date.now() - 14 * 24 * 60 * 60 * 1000);

  const [
    byModelAllTime,
    byModelLast30Days,
    unknownCostCount,
    statusCounts,
    latencyRows,
    recentRuns,
    dailyRows,
    decisionCounts,
  ] = await Promise.all([
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
    // 成功率・エラー率(直近30日)
    db.aiRun.groupBy({
      by: ["status"],
      where: { capture: { workspaceId }, startedAt: { gte: thirtyDaysAgo } },
      _count: { _all: true },
    }),
    // レイテンシ(平均・p95算出用に生値を取得。件数が多い場合はDB側集約が望ましいが、
    // 個人利用規模のMVPではアプリ側計算で十分と判断)
    db.aiRun.findMany({
      where: { capture: { workspaceId }, startedAt: { gte: thirtyDaysAgo }, latencyMs: { not: null } },
      select: { latencyMs: true },
    }),
    // 直近の呼び出しログ(ドリルダウン用)
    db.aiRun.findMany({
      where: { capture: { workspaceId } },
      orderBy: { startedAt: "desc" },
      take: 20,
      select: {
        id: true,
        provider: true,
        model: true,
        status: true,
        inputTokens: true,
        outputTokens: true,
        costMicros: true,
        latencyMs: true,
        errorCode: true,
        startedAt: true,
      },
    }),
    // 日次トレンド(直近14日)
    db.aiRun.findMany({
      where: { capture: { workspaceId }, startedAt: { gte: fourteenDaysAgo } },
      select: { startedAt: true, costMicros: true, status: true },
    }),
    // AI候補の採用率(FR-AI-06相当の効果指標。ISMAY独自)
    db.aiInference.groupBy({
      by: ["decision"],
      where: { capture: { workspaceId } },
      _count: { _all: true },
    }),
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

  // 成功率・エラー率
  type StatusGroup = { status: string; _count: { _all: number } };
  const statusBreakdown = (statusCounts as StatusGroup[]).map((s) => ({ status: s.status, count: s._count._all }));
  const totalRuns30d = statusBreakdown.reduce((sum, s) => sum + s.count, 0);
  const succeeded30d = statusBreakdown.find((s) => s.status === "SUCCEEDED")?.count ?? 0;
  const successRate = totalRuns30d > 0 ? succeeded30d / totalRuns30d : null;

  // レイテンシ(平均・p95)
  const latencies = (latencyRows as { latencyMs: number | null }[])
    .map((r) => r.latencyMs)
    .filter((v): v is number => v !== null)
    .sort((a, b) => a - b);
  const avgLatencyMs = latencies.length > 0 ? Math.round(latencies.reduce((a, b) => a + b, 0) / latencies.length) : null;
  const p95LatencyMs =
    latencies.length > 0 ? latencies[Math.min(latencies.length - 1, Math.floor(latencies.length * 0.95))] : null;

  // 直近呼び出しログ
  type RecentRun = {
    id: string;
    provider: string;
    model: string;
    status: string;
    inputTokens: number | null;
    outputTokens: number | null;
    costMicros: bigint | null;
    latencyMs: number | null;
    errorCode: string | null;
    startedAt: Date;
  };
  const recentRunsSerialized = (recentRuns as RecentRun[]).map((r) => ({
    id: r.id,
    provider: r.provider,
    model: r.model,
    status: r.status,
    inputTokens: r.inputTokens,
    outputTokens: r.outputTokens,
    costMicros: r.costMicros !== null ? r.costMicros.toString() : null,
    latencyMs: r.latencyMs,
    errorCode: r.errorCode,
    startedAt: r.startedAt.toISOString(),
  }));

  // 日次トレンド(直近14日、日付ごとにコスト・件数を集計)
  type DailyRow = { startedAt: Date; costMicros: bigint | null; status: string };
  const dailyMap = new Map<string, { date: string; costMicros: bigint; runCount: number; failedCount: number }>();
  for (const r of dailyRows as DailyRow[]) {
    const dateKey = r.startedAt.toISOString().slice(0, 10);
    const entry = dailyMap.get(dateKey) ?? { date: dateKey, costMicros: BigInt(0), runCount: 0, failedCount: 0 };
    entry.costMicros += r.costMicros ?? BigInt(0);
    entry.runCount += 1;
    if (r.status === "FAILED") entry.failedCount += 1;
    dailyMap.set(dateKey, entry);
  }
  const dailyTrend = Array.from(dailyMap.values())
    .sort((a, b) => a.date.localeCompare(b.date))
    .map((d) => ({ ...d, costMicros: d.costMicros.toString() }));

  // AI候補採用率(ISMAY独自の効果指標。FR-AI-06「候補採用率」に対応)
  type DecisionGroup = { decision: string; _count: { _all: number } };
  const decisionBreakdown = (decisionCounts as DecisionGroup[]).map((d) => ({
    decision: d.decision,
    count: d._count._all,
  }));
  const totalDecided = decisionBreakdown
    .filter((d) => d.decision !== "PENDING")
    .reduce((sum, d) => sum + d.count, 0);
  const accepted = decisionBreakdown
    .filter((d) => d.decision === "ACCEPTED" || d.decision === "EDITED")
    .reduce((sum, d) => sum + d.count, 0);
  const acceptanceRate = totalDecided > 0 ? accepted / totalDecided : null;

  return apiOk({
    byModelAllTime: allTimeRows,
    byModelLast30Days: last30DaysRows,
    totalCostMicrosAllTime: totalCostMicrosAllTime.toString(),
    totalCostMicrosLast30Days: totalCostMicrosLast30Days.toString(),
    unknownCostRunCount: unknownCostCount,
    statusBreakdown,
    successRate,
    avgLatencyMs,
    p95LatencyMs,
    recentRuns: recentRunsSerialized,
    dailyTrend,
    decisionBreakdown,
    acceptanceRate,
    calculatedAt: new Date().toISOString(),
  });
}
