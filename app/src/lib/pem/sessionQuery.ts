/**
 * PEM Execution Session Projection の DB連携ラッパー(Phase 0B)。
 * 出典: ISMAY_PEMサブシステム_統合正本仕様書_v4_0 3.2節・5章。
 *
 * sessionProjection.ts(db非依存の純粋ロジック)をResponsibilityExecutionEvent
 * (Phase 0A)から呼び出す薄い層。認可境界(authorizationBoundary.ts)のPemAuthorizationContext
 * を経由し、subjectUserId/workspaceIdをクライアント入力から信用しない(v4.0 4.1節)。
 */
import { db } from "@/lib/db";
import type { PemAuthorizationContext } from "./authorizationBoundary";
import {
  computeExecutionSessions,
  sumActiveDurationMsAsOf,
  sumClosedSessionDurationMs,
  type ExecutionSession,
} from "./sessionProjection";

export async function getExecutionSessionsForResponsibility(
  ctx: PemAuthorizationContext,
  responsibilityId: string,
): Promise<ExecutionSession[]> {
  const events = await db.responsibilityExecutionEvent.findMany({
    where: {
      responsibilityId,
      subjectUserId: ctx.subjectUserId,
      workspaceId: ctx.tenantId,
    },
    orderBy: { responsibilitySequence: "asc" },
    select: {
      id: true,
      eventType: true,
      fromState: true,
      toState: true,
      effectiveOccurredAt: true,
      occurredAtQuality: true,
      responsibilitySequence: true,
    },
  });
  return computeExecutionSessions(responsibilityId, events);
}

/** 指定Responsibilityの、現時点(asOf省略時はnew Date())までの実作業時間合計(ミリ秒)。 */
export async function getActiveDurationMsForResponsibility(
  ctx: PemAuthorizationContext,
  responsibilityId: string,
  asOf: Date = new Date(),
): Promise<number> {
  const sessions = await getExecutionSessionsForResponsibility(ctx, responsibilityId);
  return sumActiveDurationMsAsOf(sessions, asOf);
}

export { sumClosedSessionDurationMs, sumActiveDurationMsAsOf };
