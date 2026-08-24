/**
 * PEM Execution Ledger の純粋ロジック(db非依存部分)。
 * 出典: ISMAY_PEMサブシステム_統合正本仕様書_v4_0 5.3節、
 *       v3.3.1整合性修正 3章「occurredAtの検証・補正規則」。
 *
 * executionLedger.ts(db.tsを経由し実Prismaクライアントに依存する)から分離し、
 * tsx実行テストがdb.ts解決(サンドボックスでは`prisma generate`不可のため失敗する)を
 * 経由せずにこのロジックを検証できるようにする(Phase 0S consent.tsと同じ設計原則)。
 */
import type { ExecutionEventType } from "./coreTypes";

/**
 * 既存API-RESP-03のaction値からv4.0 Execution Event種別への対応表。
 * PARTIAL_COMPLETEは状態不変(v4.0に対応イベント無し)のため意図的に含まない。
 * MARK_NOT_NEEDEDはv4.0のRESPONSIBILITY_ABANDONへ対応する(Phase 0G-A決定)。
 */
export const TRANSITION_ACTION_TO_EVENT_TYPE: Partial<Record<string, ExecutionEventType>> = {
  START: "START",
  RESUME: "RESUME",
  INTERRUPT: "INTERRUPT",
  DEFER: "DEFER",
  COMPLETE: "COMPLETE",
  REOPEN: "REOPEN",
  MARK_NOT_NEEDED: "RESPONSIBILITY_ABANDON",
};

export function computeEffectiveOccurredAt(
  clientOccurredAt: Date,
  serverRecordedAt: Date,
): { effectiveOccurredAt: Date; occurredAtQuality: "HIGH" | "LOW" } {
  const diffMs = Math.abs(serverRecordedAt.getTime() - clientOccurredAt.getTime());
  const fiveMinutesMs = 5 * 60 * 1000;
  if (diffMs <= fiveMinutesMs) {
    return { effectiveOccurredAt: clientOccurredAt, occurredAtQuality: "HIGH" };
  }
  return { effectiveOccurredAt: serverRecordedAt, occurredAtQuality: "LOW" };
}

/**
 * Reason Capture(Phase 0C-1、v4.0 8.2節・8.3節)。
 * 中断・延期・再開・放棄等での任意の理由入力を、Execution Event の metadata 列へ
 * 格納する形へ変換する。reason未指定・空文字・空白のみの場合はmetadataを作らない
 * (undefinedを返し、Prisma create時にmetadata列をnullのままにする)。
 */
export function buildExecutionEventMetadata(
  reason: string | undefined | null,
): { reason: string } | undefined {
  const trimmed = reason?.trim();
  if (!trimmed) return undefined;
  return { reason: trimmed };
}
