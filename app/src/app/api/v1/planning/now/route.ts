import type { NextRequest } from "next/server";
import { db } from "@/lib/db";
import { requireAuth } from "@/lib/auth/guard";
import { ensureDefaultWorkspace } from "@/lib/workspace";
import { apiOk, apiError } from "@/lib/auth/response";
import {
  computeNow,
  PLANNING_ASSUMPTIONS,
  PLANNING_CALC_VERSION,
  type PlanningCandidateInput,
} from "@/lib/planning";

/**
 * API-PLAN-01: GET /planning/now 「今やる一つ」(UI-03)。
 * 出典: ISMAY_API・イベント設計書v1.1 4.4節、機能別詳細設計書v1.1 8章(FN-WK-02)。
 * 依存関係(FN-GR-02)・PEM補正(MOD-05)なしの決定論版。設計判断はlib/planning.tsを参照。
 * 未成熟な状態(候補ゼロ等)でも決定論ルールで応答する(4.4節「PEM未成熟時も決定論ルールで応答」)。
 */
export async function GET(req: NextRequest) {
  const auth = await requireAuth(req);
  if (!auth.authenticated) {
    return apiError("AUTH_REQUIRED", "ログインが必要です");
  }

  const { workspaceId } = await ensureDefaultWorkspace(auth.user.userId, auth.user.email);

  const url = new URL(req.url);
  const atParam = url.searchParams.get("at");
  const now = atParam && !Number.isNaN(Date.parse(atParam)) ? new Date(atParam) : new Date();

  const [candidateRows, decisions, waitings, risks] = await Promise.all([
    db.responsibility.findMany({
      where: {
        workspaceId,
        deletedAt: null,
        type: { in: ["TASK", "EVENT", "HABIT", "COMMITMENT", "WAITING"] },
      },
      select: {
        id: true,
        type: true,
        title: true,
        status: true,
        importance: true,
        hardDeadlineAt: true,
        targetAt: true,
        startAfterAt: true,
        waitingDetail: { select: { followUpAt: true } },
      },
    }),
    db.responsibility.findMany({
      where: {
        workspaceId,
        deletedAt: null,
        type: "DECISION",
        status: { in: ["OPEN", "EVIDENCE_GATHERING", "REOPENED"] },
      },
      select: { id: true, title: true, status: true, hardDeadlineAt: true },
      orderBy: { updatedAt: "desc" },
      take: 20,
    }),
    db.responsibility.findMany({
      where: {
        workspaceId,
        deletedAt: null,
        type: "WAITING",
        status: { in: ["WAITING", "FOLLOW_UP_DUE"] },
      },
      select: {
        id: true,
        title: true,
        status: true,
        waitingDetail: { select: { followUpAt: true, expectedReplyBy: true } },
      },
      orderBy: { updatedAt: "desc" },
      take: 20,
    }),
    db.responsibility.findMany({
      where: { workspaceId, deletedAt: null, type: "RISK", status: { in: ["OPEN", "MONITORING"] } },
      select: { id: true, title: true, status: true },
      orderBy: { updatedAt: "desc" },
      take: 20,
    }),
  ]);

  type CandidateRow = {
    id: string;
    type: string;
    title: string;
    status: string;
    importance: number | null;
    hardDeadlineAt: Date | null;
    targetAt: Date | null;
    startAfterAt: Date | null;
    waitingDetail: { followUpAt: Date | null } | null;
  };
  type DecisionRow = { id: string; title: string; status: string; hardDeadlineAt: Date | null };
  type WaitingRow = {
    id: string;
    title: string;
    status: string;
    waitingDetail: { followUpAt: Date | null; expectedReplyBy: Date | null } | null;
  };
  type RiskRow = { id: string; title: string; status: string };

  const candidates: PlanningCandidateInput[] = (candidateRows as CandidateRow[]).map((r) => ({
    id: r.id,
    type: r.type,
    title: r.title,
    status: r.status,
    importance: r.importance,
    hardDeadlineAt: r.hardDeadlineAt,
    targetAt: r.targetAt,
    startAfterAt: r.startAfterAt,
    waitingFollowUpAt: r.waitingDetail?.followUpAt ?? null,
  }));

  const { primary, alternatives } = computeNow(candidates, now);

  return apiOk({
    primary,
    alternatives,
    // FN-WK-03(BaselineService)未実装のため常にnull。実装後に置き換える。
    minimumLine: null,
    decisions: (decisions as DecisionRow[]).map((d) => ({
      id: d.id,
      title: d.title,
      status: d.status,
      hardDeadlineAt: d.hardDeadlineAt,
    })),
    waitings: (waitings as WaitingRow[]).map((w) => ({
      id: w.id,
      title: w.title,
      status: w.status,
      followUpAt: w.waitingDetail?.followUpAt ?? null,
      expectedReplyBy: w.waitingDetail?.expectedReplyBy ?? null,
    })),
    risks: (risks as RiskRow[]).map((r) => ({ id: r.id, title: r.title, status: r.status })),
    assumptions: PLANNING_ASSUMPTIONS,
    calcVersion: PLANNING_CALC_VERSION,
    calculatedAt: now.toISOString(),
  });
}
