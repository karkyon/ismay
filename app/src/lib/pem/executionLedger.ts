/**
 * PEM Execution Event Ledger 記録処理(Phase 0A)。
 * 出典: ISMAY_PEMサブシステム_統合正本仕様書_v4_0 5章・6章、Phase 0G eventDefinitionRegistry.ts。
 *
 * 設計方針:
 *  - 既存 transitions/route.ts のトランザクション内から呼び出される。
 *    楽観ロック(Responsibility.version)・EventLog・OutboxEventは既存実装をそのまま使い、
 *    本モジュールは「PEM専用の詳細な実行イベント」を追加で記録するに留める。
 *  - PEM_DATA_COLLECTION同意が無い場合は例外を投げず静かに記録をスキップする
 *    (v4.0 16.2節の「PEM全体OFF: 新規収集停止」に対応。かつ、コア機能である
 *     責任管理自体をPEM同意の有無で止めてはならないという製品判断)。
 *  - 対象はEXECUTION_LEDGER対象型(TASK/EVENT/CONCERN/HABIT/IDEA)のみ。
 *  - action->eventTypeマッピング、occurredAt補正ロジックはexecutionLedgerMapping.tsを参照
 *    (db非依存にしてある。tsx実行テストからそちらのみをimportする)。
 */
import type { Prisma } from "@/generated/prisma/client";
import {
  assertExecutionLedgerWriteAllowed,
  isExecutionLedgerApplicableType,
  type ExecutionLedgerState,
} from "./eventDefinitionRegistry";
import type { ActorType, EventSource } from "./coreTypes";
import type { PemAuthorizationContext } from "./authorizationBoundary";
import { isConsentGranted } from "./consent";
// ResponsibilityType(狭いUnion)は使わない。既存 lib/responsibility.ts の
// transitionsForType/isCommonStatusTypeと同様、type: stringとして扱う
// (Responsibility.typeはPrisma上プレーンなString列のため)。
import { TRANSITION_ACTION_TO_EVENT_TYPE, computeEffectiveOccurredAt } from "./executionLedgerMapping";

export { TRANSITION_ACTION_TO_EVENT_TYPE, computeEffectiveOccurredAt };

export interface RecordExecutionLedgerEventParams {
  tx: Prisma.TransactionClient;
  ctx: PemAuthorizationContext;
  responsibilityId: string;
  responsibilityType: string;
  action: string;
  fromState: string;
  toState: string;
  versionBefore: number;
  versionAfter: number;
  clientOccurredAt: Date;
  actorType: ActorType;
  source: EventSource;
  correlationId?: string;
}

/**
 * Execution Ledgerへ1件記録する。次のいずれかの場合は例外を投げず`null`を返す
 * (コアの責任管理機能を止めないため):
 *  - 対象Responsibility型がExecution Ledger対象外(COMMITMENT等)
 *  - actionにv4.0 Event種別の対応が無い(PARTIAL_COMPLETE等)
 *  - PEM_DATA_COLLECTION同意が未取得
 */
export async function recordExecutionLedgerEvent(
  params: RecordExecutionLedgerEventParams,
): Promise<{ id: string } | null> {
  if (!isExecutionLedgerApplicableType(params.responsibilityType)) {
    return null;
  }
  const eventType = TRANSITION_ACTION_TO_EVENT_TYPE[params.action];
  if (!eventType) {
    return null;
  }
  if (!(await isConsentGranted(params.ctx, "PEM_DATA_COLLECTION"))) {
    return null;
  }

  const serverRecordedAt = new Date();
  const { effectiveOccurredAt, occurredAtQuality } = computeEffectiveOccurredAt(
    params.clientOccurredAt,
    serverRecordedAt,
  );

  const counterResult = await params.tx.responsibility.update({
    where: { id: params.responsibilityId },
    data: { eventSequenceCounter: { increment: 1 } },
    select: { eventSequenceCounter: true },
  });

  const { definition } = assertExecutionLedgerWriteAllowed({
    eventType,
    evidenceClass: "FACT",
    actorType: params.actorType,
    source: params.source,
    fromState: params.fromState,
    responsibilityType: params.responsibilityType,
    consentGranted: () => true,
  });
  void definition;

  const created = await params.tx.responsibilityExecutionEvent.create({
    data: {
      workspaceId: params.ctx.tenantId,
      subjectUserId: params.ctx.subjectUserId,
      actorType: params.actorType,
      actorUserId: params.ctx.actorUserId,
      responsibilityId: params.responsibilityId,
      eventType,
      fromState: params.fromState as ExecutionLedgerState,
      toState: params.toState as ExecutionLedgerState,
      responsibilityVersionBefore: params.versionBefore,
      responsibilityVersionAfter: params.versionAfter,
      responsibilitySequence: counterResult.eventSequenceCounter,
      source: params.source,
      clientOccurredAt: params.clientOccurredAt,
      serverRecordedAt,
      effectiveOccurredAt,
      occurredAtQuality,
      schemaVersion: "v4.0",
      correlationId: params.correlationId,
      idempotencyKey: `${params.responsibilityId}:${params.action}:${params.versionBefore}`,
    },
    select: { id: true },
  });

  return created;
}
