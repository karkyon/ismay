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

// =====================================================================
// FN-PEM-03 助言(AI-07)・週次レビュー(AI-08)
// 出典: AI・PEM設計書v1.0 9〜10章、機能別詳細設計書v1.1 14章、API・イベント設計書v1.1 4.5節
// =====================================================================

import { getActivePemAdviceProvider } from "@/lib/ai/config";
import { estimateCostMicros } from "@/lib/ai/pricing";
import { PemHypothesisDraftSchema, PemWeeklyReviewDraftSchema } from "@/lib/ai/pemAdviceSchema";
import { checkPemSafety } from "@/lib/ai/pemSafety";
import type { PemAdviceProvider, PemAdviceUsage } from "@/lib/ai/pemAdviceProvider";
import { weekBoundaries } from "@/lib/cycle";

const MAX_ADVICE_AI_ATTEMPTS = 2;
/** §9「1件で恒常仮説を作らない」の再提案防止版。却下済み仮説と同じ観察窓の場合は再提案しない。 */
const REJECTION_COOLDOWN_DAYS = AGGREGATE_WINDOW_DAYS;

async function persistAdviceRun(params: {
  workspaceId: string;
  ai: PemAdviceProvider;
  status: "SUCCEEDED" | "FAILED";
  usage: PemAdviceUsage | undefined;
  errorReason?: string;
}): Promise<void> {
  const { workspaceId, ai, status, usage, errorReason } = params;
  await db.aiRun.create({
    data: {
      workspaceId,
      provider: ai.providerName,
      model: ai.modelName,
      promptVersion: ai.promptVersion,
      schemaVersion: ai.schemaVersion,
      inputTokens: usage?.inputTokens,
      outputTokens: usage?.outputTokens,
      costMicros: usage ? estimateCostMicros(ai.modelName, usage.inputTokens, usage.outputTokens) : null,
      latencyMs: usage?.latencyMs,
      status,
      errorCode: errorReason?.slice(0, 200),
      finishedAt: new Date(),
    },
  });
}

/**
 * AI-07 PEM助言。有効なOBSERVATION行のうち、まだ有効な(却下猶予期間内に却下されていない)
 * 仮説が無いものについてのみAI呼び出しを行い、新しい仮説を1件生成する。
 * 既に対応する仮説がある場合はAIを呼ばない(コスト抑制。§「低頻度」の趣旨に合わせる)。
 */
export async function ensureHypothesesUpToDate(userId: string, workspaceId: string): Promise<{ generated: number }> {
  const observations = await db.pemObservation.findMany({
    where: {
      userId,
      observationType: "OBSERVATION",
      deletedAt: null,
      OR: [{ validUntil: null }, { validUntil: { gt: new Date() } }],
    },
  });

  let generated = 0;

  for (const obs of observations as { id: string; payload: unknown; occurredAt: Date }[]) {
    const payload = obs.payload as {
      metric?: string;
      statement?: string;
      sampleSize?: number;
      comparisonSampleSize?: number;
      gapPercentagePoints?: number;
    };
    if (!payload.metric || !payload.statement) continue;

    const cooldownStart = new Date(Date.now() - REJECTION_COOLDOWN_DAYS * 24 * 60 * 60 * 1000);
    const existingActive = await db.pemHypothesis.findFirst({
      where: {
        userId,
        sourceMetric: payload.metric,
        deletedAt: null,
        windowTo: { gte: cooldownStart },
      },
    });
    if (existingActive) continue; // 既に同じ根拠の仮説がある(評決に関わらずAIを再度呼ばない)

    const recentlyRejected = await db.pemHypothesis.findMany({
      where: { userId, sourceMetric: payload.metric, userVerdict: "REJECTED", windowTo: { gte: cooldownStart } },
      select: { statement: true },
      take: 5,
    });

    const ai = await getActivePemAdviceProvider(workspaceId);
    let lastFailureReason = "";
    let lastUsage: PemAdviceUsage | undefined;
    let succeeded = false;

    for (let attempt = 1; attempt <= MAX_ADVICE_AI_ATTEMPTS; attempt++) {
      const outcome = await ai.generateHypothesis({
        observationStatement: payload.statement,
        sampleSize: payload.sampleSize ?? 0,
        comparisonSampleSize: payload.comparisonSampleSize ?? 0,
        gapPercentagePoints: payload.gapPercentagePoints ?? 0,
        recentlyRejectedStatements: (recentlyRejected as { statement: string }[]).map((r) => r.statement),
      });
      if (!outcome.ok) {
        lastFailureReason = outcome.message;
        lastUsage = outcome.usage;
        if (outcome.kind === "FATAL") break;
        continue;
      }
      lastUsage = outcome.usage;
      const parsed = PemHypothesisDraftSchema.safeParse(outcome.rawJson);
      if (!parsed.success) {
        lastFailureReason = `AI_SCHEMA_INVALID: ${parsed.error.issues.map((i) => i.message).join("; ").slice(0, 500)}`;
        continue;
      }

      const safety = checkPemSafety(parsed.data.statement);
      if (!safety.safe) {
        debugServer.error("pem/ensureHypothesesUpToDate", "SafetyValidator違反、この仮説は破棄", {
          userId,
          violations: safety.violations,
        });
        lastFailureReason = "SAFETY_VIOLATION";
        continue; // 安全でない仮説は保存せず次のattemptへ(構造は正しいが内容が不適切なため)
      }

      await persistAdviceRun({ workspaceId, ai, status: "SUCCEEDED", usage: outcome.usage });
      await db.pemHypothesis.create({
        data: {
          userId,
          statement: `${parsed.data.statement}(実験案: ${parsed.data.experimentSuggestion})`,
          sampleSize: payload.sampleSize ?? 0,
          windowFrom: new Date(Date.now() - AGGREGATE_WINDOW_DAYS * 24 * 60 * 60 * 1000),
          windowTo: obs.occurredAt,
          confidence: parsed.data.confidence,
          userVerdict: "PENDING",
          sourceMetric: payload.metric,
        },
      });
      generated++;
      succeeded = true;
      break;
    }

    if (!succeeded) {
      await persistAdviceRun({ workspaceId, ai, status: "FAILED", usage: lastUsage, errorReason: lastFailureReason });
      debugServer.error("pem/ensureHypothesesUpToDate", "仮説生成失敗", { userId, metric: payload.metric, lastFailureReason });
    }
  }

  return { generated };
}

const SUCCESS_TERMINAL_STATUSES = new Set(["COMPLETED", "FULFILLED", "DECIDED", "RESOLVED", "MITIGATED"]);

interface WeeklyStats {
  fulfilledCount: number;
  stalledCount: number;
  estimateErrorPercent: number | null;
}

/** 実測データのみから週次統計を計算する(AIには渡すだけで、ここでは一切AIを呼ばない)。 */
async function computeWeeklyStats(userId: string, weekStart: Date, weekEnd: Date): Promise<WeeklyStats> {
  const rows = await db.pemObservation.findMany({
    where: { userId, observationType: "TRANSITION", occurredAt: { gte: weekStart, lt: weekEnd }, deletedAt: null },
    select: { payload: true, occurredAt: true },
    orderBy: { occurredAt: "asc" },
  });

  type Row = { payload: TransitionPayload; occurredAt: Date };
  // [2026-08-23修正] 実サーバーで発覚したバグ: Prismaの実生成型ではpayloadがJsonValue
  // (JsonObject|JsonArray|string|number|boolean|null)として返るため、TransitionPayloadへ
  // 直接asキャストすると型が「十分に重ならない」としてtsc TS2352エラーになる
  // (サンドボックスのPrismaスタブは[key: string]: anyのため検出できなかった)。
  // 他の箇所(recomputeAggregates等)と同じく、unknownを経由してキャストする。
  const transitions = rows as unknown as Row[];

  const fulfilledIds = new Set<string>();
  const stalledIds = new Set<string>();
  for (const t of transitions) {
    if (SUCCESS_TERMINAL_STATUSES.has(t.payload.toStatus)) fulfilledIds.add(t.payload.responsibilityId);
    if (t.payload.action === "DEFER") stalledIds.add(t.payload.responsibilityId);
  }

  // 予測誤差: 同一responsibilityIdでIN_PROGRESS→COMPLETEDのペアが取れたものだけを対象にする
  // (取れない場合は誤差不明。無理に数値を作らない)。
  const startAtByResponsibility = new Map<string, Date>();
  const errorPercents: number[] = [];
  for (const t of transitions) {
    if (t.payload.toStatus === "IN_PROGRESS") {
      startAtByResponsibility.set(t.payload.responsibilityId, t.occurredAt);
    } else if (t.payload.toStatus === "COMPLETED") {
      const startedAt = startAtByResponsibility.get(t.payload.responsibilityId);
      if (startedAt && t.payload.estimatedMinutesMax) {
        const elapsedMinutes = (t.occurredAt.getTime() - startedAt.getTime()) / 60000;
        const errorPercent = ((elapsedMinutes - t.payload.estimatedMinutesMax) / t.payload.estimatedMinutesMax) * 100;
        errorPercents.push(errorPercent);
      }
    }
  }
  const estimateErrorPercent =
    errorPercents.length > 0 ? Math.round(errorPercents.reduce((a, b) => a + b, 0) / errorPercents.length) : null;

  return { fulfilledCount: fulfilledIds.size, stalledCount: stalledIds.size, estimateErrorPercent };
}

export interface WeeklyReviewResult {
  weekStart: Date;
  weekEnd: Date;
  fulfilledCount: number;
  stalledCount: number;
  estimateErrorPercent: number | null;
  strengthStatement: string | null;
  experimentSuggestion: string | null;
  generatedAt: Date;
  /** データがまだ1週間分たまっていない(アカウント作成直後等)場合はfalse。 */
  available: boolean;
}

/**
 * API-PEM-03(GET /reviews/weekly)。直近の完了済み週(現在の週の1つ前)のレビューを返す。
 * 既に生成済みならキャッシュ(PemWeeklyReview)を返し、無ければその場でAI-08を呼び出して
 * 生成・保存する(週1回程度の低頻度呼び出しのため、Workerでの事前生成はしない設計。
 * 2026-08-23セッションでカルキョンさんへ説明・合意済みの方針)。
 */
export async function getOrGenerateWeeklyReview(
  userId: string,
  workspaceId: string,
  timeZone: string,
  now: Date = new Date(),
): Promise<WeeklyReviewResult> {
  const { startAt: currentWeekStart } = weekBoundaries(now, timeZone);
  const weekStart = new Date(currentWeekStart.getTime() - 7 * 24 * 60 * 60 * 1000);
  const weekEnd = currentWeekStart;

  // アカウント作成が今週の場合、直近の完了済み週が存在しない可能性がある。
  const firstActivity = await db.pemObservation.findFirst({
    where: { userId },
    orderBy: { occurredAt: "asc" },
    select: { occurredAt: true },
  });
  if (!firstActivity || firstActivity.occurredAt >= weekEnd) {
    return {
      weekStart,
      weekEnd,
      fulfilledCount: 0,
      stalledCount: 0,
      estimateErrorPercent: null,
      strengthStatement: null,
      experimentSuggestion: null,
      generatedAt: now,
      available: false,
    };
  }

  const cached = await db.pemWeeklyReview.findUnique({ where: { userId_weekStart: { userId, weekStart } } });
  if (cached) {
    const summary = cached.summaryJson as {
      fulfilledCount: number;
      stalledCount: number;
      estimateErrorPercent: number | null;
      strengthStatement: string | null;
      experimentSuggestion: string | null;
    };
    return { weekStart, weekEnd, ...summary, generatedAt: cached.generatedAt, available: true };
  }

  const stats = await computeWeeklyStats(userId, weekStart, weekEnd);

  const activeHypothesis = await db.pemHypothesis.findFirst({
    where: {
      userId,
      deletedAt: null,
      userVerdict: { in: ["CONFIRMED", "PENDING"] },
      OR: [{ validUntil: null }, { validUntil: { gt: now } }],
    },
    orderBy: { createdAt: "desc" },
    select: { statement: true },
  });

  const weekLabel = `${weekStart.toISOString().slice(0, 10)} 〜 ${new Date(weekEnd.getTime() - 1).toISOString().slice(0, 10)}`;

  let strengthStatement: string | null = null;
  let experimentSuggestion: string | null = null;

  if (stats.fulfilledCount > 0 || stats.stalledCount > 0) {
    const ai = await getActivePemAdviceProvider(workspaceId);
    let lastUsage: PemAdviceUsage | undefined;
    let lastFailureReason = "";

    for (let attempt = 1; attempt <= MAX_ADVICE_AI_ATTEMPTS; attempt++) {
      const outcome = await ai.generateWeeklyReview({
        weekLabel,
        fulfilledCount: stats.fulfilledCount,
        stalledCount: stats.stalledCount,
        estimateErrorPercent: stats.estimateErrorPercent,
        activeHypothesisStatement: activeHypothesis?.statement ?? null,
      });
      if (!outcome.ok) {
        lastFailureReason = outcome.message;
        lastUsage = outcome.usage;
        if (outcome.kind === "FATAL") break;
        continue;
      }
      lastUsage = outcome.usage;
      const parsed = PemWeeklyReviewDraftSchema.safeParse(outcome.rawJson);
      if (!parsed.success) {
        lastFailureReason = `AI_SCHEMA_INVALID: ${parsed.error.issues.map((i) => i.message).join("; ").slice(0, 500)}`;
        continue;
      }
      const safeStrength =
        parsed.data.strengthStatement && checkPemSafety(parsed.data.strengthStatement).safe
          ? parsed.data.strengthStatement
          : null;
      const safeExperiment =
        parsed.data.experimentSuggestion && checkPemSafety(parsed.data.experimentSuggestion).safe
          ? parsed.data.experimentSuggestion
          : null;
      strengthStatement = safeStrength;
      experimentSuggestion = safeExperiment;
      await persistAdviceRun({ workspaceId, ai, status: "SUCCEEDED", usage: outcome.usage });
      break;
    }
    if (strengthStatement === null && experimentSuggestion === null && lastFailureReason) {
      await persistAdviceRun({ workspaceId, ai, status: "FAILED", usage: lastUsage, errorReason: lastFailureReason });
      debugServer.error("pem/getOrGenerateWeeklyReview", "週次レビューAI生成失敗(実績数値のみで保存)", {
        userId,
        lastFailureReason,
      });
    }
  }

  const summary = { ...stats, strengthStatement, experimentSuggestion };
  await db.pemWeeklyReview.create({
    data: { userId, weekStart, weekEnd, summaryJson: summary as unknown as object },
  });

  return { weekStart, weekEnd, ...summary, generatedAt: now, available: true };
}
