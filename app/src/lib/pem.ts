import { db } from "@/lib/db";
import { debugServer } from "@/lib/debugServer";

/**
 * FN-PEM-02 観察更新(機能別詳細設計書v1.1 13章)。
 *
 * 「PEMObserverはResponsibilityTransitionedを購読し、eventIdで重複排除する。
 *  期間集計は日次Batchで再計算可能にする」に対応し、2段階で実装する:
 *
 * 1. ingestTransitionEvents: EventLog(aggregateType=Responsibility、本人操作のみ)を
 *    ポーリングし、1イベント=1 PemObservation(observationType="TRANSITION")として
 *    生データを取り込む。sourceEventLogId(unique制約)により、同じイベントを
 *    二重に取り込まない(worker/relay.tsのP2002依拠パターンを踏襲)。
 * 2. recomputeAggregates: 直近4週のTRANSITION観察から、AI_PEM設計書v1.0 9章の
 *    「30分を超える曖昧な作業の延期率」に相当する集計をユーザーごとに再計算し、
 *    observationType="OBSERVATION"の行を作る(既存があれば置き換える=「再計算可能」)。
 *    母数(推奨5件以上、§9)に満たない場合は生成しない。
 *
 * AI呼び出しは行わない(観察の「収集・集計」のみがFN-PEM-02の責務。仮説生成(AI-07)は
 * FN-PEM-03のスコープ)。
 */

const TRANSITION_EVENT_TYPES = ["STATUS_CHANGED", "PARTIALLY_COMPLETED", "DEFERRED"] as const;
const INGEST_BATCH_SIZE = 100;
/** 集計対象の遡り期間(§9「直近4週」)。 */
const AGGREGATE_WINDOW_DAYS = 28;
/** §9「初期表示の推奨母数5」。これ未満では観察を生成しない。 */
const MIN_SAMPLE_SIZE = 5;
/** 2群間の延期率の差がこのポイント(pp)以上でなければ「強い要因ではない」として観察化しない。
 * [設計判断・2026-08-23] 設計書に閾値の明記が無いため、母数が少ない個人利用規模でも
 * 意味のある差だけを提示する目的で20ppを暫定値とする(将来EVAL-04相当の評価で調整可能)。 */
const MIN_GAP_PERCENTAGE_POINTS = 20;

interface TransitionPayload {
  responsibilityId: string;
  action: string;
  fromStatus: string;
  toStatus: string;
  type: string;
  /** TaskDetail.estimatedMinutesMaxのスナップショット(集計時点の値ではなく発生当時の値)。 */
  estimatedMinutesMax: number | null;
}

/**
 * 未取り込みのResponsibilityTransitionedイベントをPemObservation(TRANSITION)へ取り込む。
 * 戻り値processedは新規に取り込んだ件数(冪等・重複はカウントしない)。
 */
export async function ingestTransitionEvents(): Promise<{ processed: number }> {
  // occurredAtの新しい方から追う代わりに、まだ取り込んでいない可能性があるものを
  // 広めに取得し、@unique制約(P2002)で重複を弾く方式にする(cursor管理を省略できる
  // 分、実装が単純になる。個人利用規模の件数であれば全件走査コストも許容範囲)。
  const events = await db.eventLog.findMany({
    where: { aggregateType: "Responsibility", eventType: { in: TRANSITION_EVENT_TYPES as unknown as string[] }, actorType: "USER" },
    orderBy: { occurredAt: "asc" },
    take: INGEST_BATCH_SIZE,
  });

  let processed = 0;
  for (const event of events) {
    if (!event.actorId) continue; // 本人操作のみ対象(actorType=USERなら通常ありえないが念のため)

    const responsibility = await db.responsibility.findUnique({
      where: { id: event.aggregateId },
      select: { type: true, taskDetail: { select: { estimatedMinutesMax: true } } },
    });
    if (!responsibility) continue; // 削除済み等

    const after = event.afterJson as { status?: string } | null;
    const before = event.beforeJson as { status?: string } | null;
    const action =
      event.eventType === "PARTIALLY_COMPLETED"
        ? "PARTIAL_COMPLETE"
        : event.eventType === "DEFERRED"
          ? "DEFER"
          : (after?.status ?? "UNKNOWN");

    const payload: TransitionPayload = {
      responsibilityId: event.aggregateId,
      action,
      fromStatus: before?.status ?? "UNKNOWN",
      toStatus: after?.status ?? "UNKNOWN",
      type: responsibility.type,
      estimatedMinutesMax: responsibility.taskDetail?.estimatedMinutesMax ?? null,
    };

    try {
      await db.pemObservation.create({
        data: {
          userId: event.actorId,
          observationType: "TRANSITION",
          payload: payload as unknown as object,
          occurredAt: event.occurredAt,
          sourceEventLogId: event.id,
        },
      });
      processed++;
    } catch (err: unknown) {
      const code = (err as { code?: string } | null)?.code;
      if (code === "P2002") {
        // 既に取り込み済み(eventIdの一意制約違反)。正常系として無視する。
        continue;
      }
      debugServer.error("pem/ingestTransitionEvents", "取り込み失敗", { eventId: event.id, err });
    }
  }

  return { processed };
}

interface DeferRateBucket {
  deferred: number;
  total: number;
}

/**
 * 直近4週のTRANSITION観察から「所要時間見積が長い/未設定のTASKほど延期されやすいか」を
 * 集計し、母数・差が十分な場合のみOBSERVATION行を作る(無ければ何もしない)。
 * 「再計算可能」の要件通り、既存のOBSERVATION行はupsertで置き換える
 * (userIdごとに1行、observationType="OBSERVATION"かつpayload.metric="DEFER_RATE_BY_ESTIMATE"を
 *  一意に保つため、まず既存行を検索して更新/作成する)。
 */
export async function recomputeAggregates(): Promise<{ usersProcessed: number; observationsWritten: number }> {
  const windowStart = new Date(Date.now() - AGGREGATE_WINDOW_DAYS * 24 * 60 * 60 * 1000);

  const userRows = await db.pemObservation.findMany({
    where: { observationType: "TRANSITION", occurredAt: { gte: windowStart }, deletedAt: null },
    select: { userId: true },
    distinct: ["userId"],
  });

  let observationsWritten = 0;

  for (const { userId } of userRows as { userId: string }[]) {
    const transitions = await db.pemObservation.findMany({
      where: { userId, observationType: "TRANSITION", occurredAt: { gte: windowStart }, deletedAt: null },
      select: { payload: true },
    });

    const long: DeferRateBucket = { deferred: 0, total: 0 };
    const short: DeferRateBucket = { deferred: 0, total: 0 };

    for (const row of transitions as { payload: unknown }[]) {
      const p = row.payload as TransitionPayload;
      if (p.type !== "TASK") continue;
      if (p.action !== "DEFER" && p.action !== "COMPLETED" && p.toStatus !== "COMPLETED") continue;
      // 30分以上、または見積未設定(=曖昧)を「長い/曖昧な作業」とみなす(ワイヤーフレームUI-09の
      // 「30分を超える曖昧な作業」の例に対応)。
      const isLongOrAmbiguous = p.estimatedMinutesMax === null || p.estimatedMinutesMax >= 30;
      const bucket = isLongOrAmbiguous ? long : short;
      bucket.total++;
      if (p.action === "DEFER") bucket.deferred++;
    }

    const existing = await db.pemObservation.findFirst({
      where: { userId, observationType: "OBSERVATION", deletedAt: null },
      orderBy: { createdAt: "desc" },
    });

    if (long.total < MIN_SAMPLE_SIZE) {
      // 母数不足(§9「1件で恒常仮説を作らない」の観察版)。既存の集計行があれば、
      // データが古くなった可能性があるため有効期限切れとして扱う(削除はしない=観察は消さない、
      // AI_PEM設計書v1.0 9章「本人訂正は観察を消さず」の精神を、母数不足化にも適用する)。
      if (existing && (!existing.validUntil || existing.validUntil > new Date())) {
        await db.pemObservation.update({ where: { id: existing.id }, data: { validUntil: new Date() } });
      }
      continue;
    }

    const longRate = long.deferred / long.total;
    const shortRate = short.total > 0 ? short.deferred / short.total : null;
    const gapPoints = shortRate === null ? null : Math.round((longRate - shortRate) * 100);

    if (gapPoints === null || Math.abs(gapPoints) < MIN_GAP_PERCENTAGE_POINTS) {
      // 差が弱い、または比較対象(短い作業)の母数が無い場合は「強い要因ではありません」相当。
      if (existing && (!existing.validUntil || existing.validUntil > new Date())) {
        await db.pemObservation.update({ where: { id: existing.id }, data: { validUntil: new Date() } });
      }
      continue;
    }

    const statement = `所要時間の見積が30分以上、または未設定のタスク: 直近${AGGREGATE_WINDOW_DAYS / 7}週間で${long.total}件中${long.deferred}件が延期されています`;
    const payload = {
      metric: "DEFER_RATE_BY_ESTIMATE",
      statement,
      sampleSize: long.total,
      deferred: long.deferred,
      comparisonSampleSize: short.total,
      comparisonDeferred: short.deferred,
      gapPercentagePoints: gapPoints,
      windowDays: AGGREGATE_WINDOW_DAYS,
    };

    if (existing) {
      await db.pemObservation.update({
        where: { id: existing.id },
        data: { payload: payload as unknown as object, occurredAt: new Date(), validUntil: null },
      });
    } else {
      await db.pemObservation.create({
        data: { userId, observationType: "OBSERVATION", payload: payload as unknown as object },
      });
    }
    observationsWritten++;
  }

  return { usersProcessed: userRows.length, observationsWritten };
}
