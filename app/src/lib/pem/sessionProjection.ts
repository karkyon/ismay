/**
 * PEM Execution Session Projection(Phase 0B)。
 * 出典: ISMAY_PEMサブシステム_統合正本仕様書_v4_0 3.2節・5章。
 *
 * 設計方針:
 *  - 新規テーブルを作らず、Consent state(Phase 0S getConsentState)と同じ「insert-only
 *    Ledgerからの都度投影」方式を踏襲する。ExecutionSessionは Phase 0A の
 *    ResponsibilityExecutionEvent から純粋関数として導出する。
 *  - セッションは「toState=IN_PROGRESSへ遷移したイベント」から「同じResponsibility上で
 *    次にfromState=IN_PROGRESSから離脱したイベント」までの区間として定義する。
 *    eventType名を個別列挙せず、Event Definition Registry(eventDefinitionRegistry.ts)の
 *    fromStates/toStateだけを実質的な根拠にしているため、将来イベント種別が追加・変更
 *    されてもこのロジックは無修正で追従する。
 *  - 09:00開始→09:30中断→13:00再開→14:00完了、を「5時間」ではなく
 *    「30分+60分=90分」の実作業時間として計測する(v4.0 3.2節の要求)。
 *  - db.ts(実Prismaクライアント)に依存しない。tsx実行テスト(consent.ts・
 *    executionLedgerMapping.tsと同じ理由)からdb.ts解決を経由せず検証できるようにする。
 */
import type { MeasurementQuality } from "./coreTypes";

const SESSION_OPEN_TO_STATE = "IN_PROGRESS";
const SESSION_CLOSE_FROM_STATE = "IN_PROGRESS";

export interface ExecutionSessionSourceEvent {
  id: string;
  eventType: string;
  fromState: string;
  toState: string;
  effectiveOccurredAt: Date;
  /** ResponsibilityExecutionEvent.occurredAtQuality(OccurredAtQuality値、Prisma上はstring)。 */
  occurredAtQuality: string;
  responsibilitySequence: number;
}

export interface ExecutionSession {
  responsibilityId: string;
  startEventId: string;
  startedAt: Date;
  endEventId: string | null;
  endedAt: Date | null;
  /** このセッションを終了させたイベント種別(進行中セッションはnull)。 */
  closedByEventType: string | null;
  isOpen: boolean;
  /** 進行中セッション(isOpen=true)はnull。実作業時間はsumActiveDurationMsAsOfで計算する。 */
  durationMs: number | null;
  measurementQuality: MeasurementQuality;
}

/**
 * occurredAtQuality(v4.0 6.2節・6区分)を、実作業時間の測定品質(v4.0 9章・4区分)へ
 * 変換する。USER_CONFIRMED/USER_APPROXIMATEDは「クロック上はズレていても本人確認済み」
 * のためMEDIUM、HIGH/MEDIUMはそのまま、LOW/UNKNOWNはLOWへ丸める(不明な品質を
 * 楽観的にHIGH扱いしない)。
 */
function toMeasurementQuality(occurredAtQuality: string): MeasurementQuality {
  switch (occurredAtQuality) {
    case "HIGH":
      return "HIGH";
    case "MEDIUM":
    case "USER_CONFIRMED":
    case "USER_APPROXIMATED":
      return "MEDIUM";
    case "LOW":
      return "LOW";
    default:
      return "UNKNOWN";
  }
}

const QUALITY_RANK: Record<MeasurementQuality, number> = { HIGH: 3, MEDIUM: 2, LOW: 1, UNKNOWN: 0 };

/** セッションを構成する2端点のうち、より低い方の品質を採用する(楽観側に倒さない)。 */
function derivePairQuality(
  startQuality: string,
  endQuality: string | null,
): MeasurementQuality {
  const start = toMeasurementQuality(startQuality);
  if (endQuality === null) return start;
  const end = toMeasurementQuality(endQuality);
  return QUALITY_RANK[start] <= QUALITY_RANK[end] ? start : end;
}

/**
 * 単一Responsibilityの、responsibilitySequence昇順のイベント列からExecutionSession列を導出する。
 * 呼び出し側で昇順ソート済みでなくても内部でソートする(冪等)。
 */
export function computeExecutionSessions(
  responsibilityId: string,
  events: readonly ExecutionSessionSourceEvent[],
): ExecutionSession[] {
  const sorted = [...events].sort((a, b) => a.responsibilitySequence - b.responsibilitySequence);
  const sessions: ExecutionSession[] = [];
  let openStart: ExecutionSessionSourceEvent | null = null;

  for (const event of sorted) {
    if (openStart === null) {
      if (event.toState === SESSION_OPEN_TO_STATE) {
        openStart = event;
      }
      continue;
    }
    if (event.fromState === SESSION_CLOSE_FROM_STATE) {
      const durationMs = Math.max(
        0,
        event.effectiveOccurredAt.getTime() - openStart.effectiveOccurredAt.getTime(),
      );
      sessions.push({
        responsibilityId,
        startEventId: openStart.id,
        startedAt: openStart.effectiveOccurredAt,
        endEventId: event.id,
        endedAt: event.effectiveOccurredAt,
        closedByEventType: event.eventType,
        isOpen: false,
        durationMs,
        measurementQuality: derivePairQuality(openStart.occurredAtQuality, event.occurredAtQuality),
      });
      openStart = event.toState === SESSION_OPEN_TO_STATE ? event : null;
    }
    // openStart有りで event.fromState !== IN_PROGRESS のイベント(理論上REOPEN等)は無視。
  }

  if (openStart !== null) {
    sessions.push({
      responsibilityId,
      startEventId: openStart.id,
      startedAt: openStart.effectiveOccurredAt,
      endEventId: null,
      endedAt: null,
      closedByEventType: null,
      isOpen: true,
      durationMs: null,
      measurementQuality: derivePairQuality(openStart.occurredAtQuality, null),
    });
  }

  return sessions;
}

/** 完了済みセッションのみを対象に、実作業時間の合計(ミリ秒)を求める。 */
export function sumClosedSessionDurationMs(sessions: readonly ExecutionSession[]): number {
  return sessions.reduce((total, s) => total + (s.durationMs ?? 0), 0);
}

/**
 * 進行中セッション(isOpen)を含めた、asOf時点までの実作業時間合計(ミリ秒)。
 * asOfがセッション開始より前の場合はそのセッション分を0として扱う(負値にしない)。
 */
export function sumActiveDurationMsAsOf(
  sessions: readonly ExecutionSession[],
  asOf: Date,
): number {
  return sessions.reduce((total, s) => {
    if (!s.isOpen) return total + (s.durationMs ?? 0);
    const openMs = Math.max(0, asOf.getTime() - s.startedAt.getTime());
    return total + openMs;
  }, 0);
}
