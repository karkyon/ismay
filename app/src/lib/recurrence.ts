import { createHash } from "node:crypto";
import type { Prisma } from "@/generated/prisma/client";
import { db } from "@/lib/db";
import { debugServer } from "@/lib/debugServer";
import { initialStatusFor, isTypeSpecificTerminalStatus } from "@/lib/responsibility";

/**
 * FN-REC-01 定期責任管理(2026-08-23新設)。TBL-020 recurrence_rules。
 * 出典: 機能別詳細設計書v1.1 11章、Webシステム要件定義書v2.1 FR-WK-08。
 *
 * [設計判断・2026-08-23] schema.prismaのRecurrenceRule.responsibilityIdは
 * `@unique`(1責任につき1ルール)であり、生成された「各回のインスタンス」を
 * 個別のResponsibility行として追跡するための列(occurrenceOfRuleId等)が存在しない。
 * 設計書は「次回インスタンス(Responsibility)を生成する」と書いているが、
 * 具体的なテーブル構造としては「同じResponsibility行を次サイクルへ向けて
 * リセットする」以外の実装がスキーマ上成立しない(想像で新しい列を追加すると
 * 既存スキーマとの整合性が取れなくなるため、既存スキーマの制約に忠実に実装する)。
 * よって本実装は「同一Responsibility行を、次回サイクルの発生タイミングで
 * 初期状態へリセットする」方式を取る。EventLogには"RECURRENCE_GENERATED"として
 * 記録するため、"新しい回が生成された"という意味的な単位はEventLogの履歴で追跡できる。
 *
 * [スコープ外・2026-08-23] 「過去4週間のPEM観察から所要時間見積を補正する」
 * (11章 処理4)は、PEM機能(FN-PEM-02観察更新)自体が未実装のため対象外とする。
 */

export const FREQUENCIES = ["DAILY", "WEEKLY", "MONTHLY"] as const;
export type Frequency = (typeof FREQUENCIES)[number];
export const CARRYOVER_POLICIES = ["CARRY", "DROP", "RENOTIFY"] as const;
export type CarryoverPolicy = (typeof CARRYOVER_POLICIES)[number];

const MS_PER_DAY = 24 * 60 * 60 * 1000;

/** exceptions/weekdaysのJson構造。weekdaysは0=日曜〜6=土曜(JS Date.getDay()と揃える)。 */
interface RecurrenceRuleShape {
  frequency: string;
  interval: number;
  weekdays: number[] | null;
  exceptions: string[] | null; // "YYYY-MM-DD"形式
  pausedUntil: Date | null;
  carryoverPolicy: string;
  lastGeneratedAt: Date | null;
}

function toDateKey(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/**
 * lastGeneratedAt(無ければ"今"を基点)から、ルールに従って次の発生日時を計算する。
 * 休止解除後に過去分をまとめて生成しない(11章「例外」)ため、計算結果が現在時刻より
 * 過去になった場合は現在時刻を基点に取り直す(遡って複数回分を生成しない)。
 */
export function computeNextOccurrence(rule: RecurrenceRuleShape, now: Date): Date {
  const base = rule.lastGeneratedAt && rule.lastGeneratedAt.getTime() > now.getTime() - 365 * MS_PER_DAY
    ? rule.lastGeneratedAt
    : now;

  let candidate: Date;
  if (rule.frequency === "DAILY") {
    candidate = new Date(base.getTime() + rule.interval * MS_PER_DAY);
  } else if (rule.frequency === "WEEKLY") {
    if (rule.weekdays && rule.weekdays.length > 0) {
      // 指定曜日のうち、baseより後で最も近い日を探す(最大2週間先まで探索すれば必ず見つかる)。
      candidate = new Date(base.getTime() + MS_PER_DAY);
      for (let i = 0; i < 14; i++) {
        if (rule.weekdays.includes(candidate.getDay())) break;
        candidate = new Date(candidate.getTime() + MS_PER_DAY);
      }
    } else {
      candidate = new Date(base.getTime() + rule.interval * 7 * MS_PER_DAY);
    }
  } else {
    // MONTHLY: baseのN(=interval)ヶ月後、同じ日付(UTC基準の簡易実装)。
    const d = new Date(base);
    d.setUTCMonth(d.getUTCMonth() + rule.interval);
    candidate = d;
  }

  // 遡って複数回分を生成しない: 計算結果が既に過去なら、nowを基点に1回だけ取り直す。
  if (candidate.getTime() <= now.getTime() && base.getTime() !== now.getTime()) {
    return computeNextOccurrence({ ...rule, lastGeneratedAt: now }, now);
  }
  return candidate;
}

/** 例外日リストと重複する場合は例外日を優先し、その回はスキップする(11章「例外」)。 */
function isExceptionDay(rule: RecurrenceRuleShape, occurrence: Date): boolean {
  if (!rule.exceptions || rule.exceptions.length === 0) return false;
  return rule.exceptions.includes(toDateKey(occurrence));
}

interface RuleRow {
  id: string;
  responsibilityId: string;
  frequency: string;
  interval: number;
  weekdays: unknown;
  exceptions: unknown;
  pausedUntil: Date | null;
  carryoverPolicy: string;
  lastGeneratedAt: Date | null;
  version: number;
}

/**
 * 日次(実際はworker/recurrenceGenerationJob.tsのスロットリングに従う)で全ルールを走査し、
 * 発生予定日を過ぎているものについて、carryoverPolicyに従って責任行を扱う。
 */
export async function generateRecurrences(now: Date = new Date()): Promise<{
  processed: number;
  reset: number;
  carried: number;
  dropped: number;
  renotified: number;
  skippedException: number;
  skippedPaused: number;
}> {
  const rules = await db.recurrenceRule.findMany({
    select: {
      id: true,
      responsibilityId: true,
      frequency: true,
      interval: true,
      weekdays: true,
      exceptions: true,
      pausedUntil: true,
      carryoverPolicy: true,
      lastGeneratedAt: true,
      version: true,
    },
  });

  let processed = 0;
  let reset = 0;
  let carried = 0;
  let dropped = 0;
  let renotified = 0;
  let skippedException = 0;
  let skippedPaused = 0;

  for (const r of rules as RuleRow[]) {
    // 休止期間中(paused_untilが未来)はスキップする(11章「処理3」)。
    if (r.pausedUntil && r.pausedUntil.getTime() > now.getTime()) {
      skippedPaused++;
      continue;
    }

    const shape: RecurrenceRuleShape = {
      frequency: r.frequency,
      interval: r.interval,
      weekdays: (r.weekdays as number[] | null) ?? null,
      exceptions: (r.exceptions as string[] | null) ?? null,
      pausedUntil: r.pausedUntil,
      carryoverPolicy: r.carryoverPolicy,
      lastGeneratedAt: r.lastGeneratedAt,
    };
    const nextOccurrence = computeNextOccurrence(shape, now);
    if (nextOccurrence.getTime() > now.getTime()) continue; // まだ発生予定日に達していない

    if (isExceptionDay(shape, nextOccurrence)) {
      // 例外日は生成をスキップしつつ、次回計算の基点だけ進めておく(無限に同じ日を再評価しない)。
      await db.recurrenceRule.update({ where: { id: r.id }, data: { lastGeneratedAt: nextOccurrence } });
      skippedException++;
      continue;
    }

    const responsibility = await db.responsibility.findFirst({
      where: { id: r.responsibilityId, deletedAt: null },
      select: {
        id: true,
        type: true,
        status: true,
        completedAt: true,
        version: true,
        workspaceId: true,
        title: true,
        createdById: true,
      },
    });
    if (!responsibility) continue; // 責任自体が削除済み(想定外だがスキップして継続)

    const isOpen =
      !responsibility.completedAt && !isTypeSpecificTerminalStatus(responsibility.type, responsibility.status);

    processed++;

    if (!isOpen) {
      // 前回インスタンスは完了済み → 通常どおり次サイクルへリセットする。
      await resetForNextCycle(
        responsibility.id,
        responsibility.workspaceId,
        responsibility.createdById,
        responsibility.type,
        responsibility.status,
        nextOccurrence,
      );
      await db.recurrenceRule.update({ where: { id: r.id }, data: { lastGeneratedAt: nextOccurrence } });
      await logGenerated(responsibility.id, responsibility.workspaceId, "RESET");
      reset++;
      continue;
    }

    // 前回インスタンスが未完了 → carryoverPolicyに従う(11章「処理2」)。
    if (r.carryoverPolicy === "CARRY") {
      // そのまま繰越: 責任本体には触れず、次回判定の基点だけ進める。
      await db.recurrenceRule.update({ where: { id: r.id }, data: { lastGeneratedAt: nextOccurrence } });
      carried++;
    } else if (r.carryoverPolicy === "DROP") {
      // 破棄: 未完了だった分を打ち切り、次サイクルへリセットする。
      await resetForNextCycle(
        responsibility.id,
        responsibility.workspaceId,
        responsibility.createdById,
        responsibility.type,
        responsibility.status,
        nextOccurrence,
      );
      await db.recurrenceRule.update({ where: { id: r.id }, data: { lastGeneratedAt: nextOccurrence } });
      await logGenerated(responsibility.id, responsibility.workspaceId, "DROP_AND_RESET");
      dropped++;
    } else {
      // RENOTIFY: 責任本体は変更せず、既存の通知基盤(FN-NTF-01)へ乗せて再通知のみ行う。
      await db.recurrenceRule.update({ where: { id: r.id }, data: { lastGeneratedAt: nextOccurrence } });
      await createRenotifyNotification(responsibility.id, responsibility.workspaceId, responsibility.title, nextOccurrence);
      renotified++;
    }
  }

  if (processed > 0) {
    debugServer.event("Recurrence/generate", "定期責任サイクル処理", {
      processed,
      reset,
      carried,
      dropped,
      renotified,
      skippedException,
      skippedPaused,
    });
  }
  return { processed, reset, carried, dropped, renotified, skippedException, skippedPaused };
}

/**
 * [既知の制限・2026-08-23全ソース総点検で発見] targetAtのみを次回発生日へ進め、
 * hardDeadlineAtは更新しない。元の責任にhardDeadlineAtが設定されていた場合
 * (例: 「毎週月曜に着手、火曜が締切」のような定期責任)、次サイクルでも古い
 * hardDeadlineAtが残ってしまう。「次回のhardDeadlineAtをどう計算すべきか」は
 * targetAtとの差分維持など設計判断が必要で、想像で複雑な自動計算を組み込むと
 * 誤った期限を設定しかねないため、今回はtargetAtのみの更新に留める。
 * hardDeadlineAt付きの定期責任を使う場合は、都度手動で更新することを推奨する。
 */
// [2026-08-25追加・Completion Gate 2] このリセットはWorker(SYSTEM)による定期
// サイクルの自動処理であり、Execution Event RegistryのREOPENはallowedActors=
// ["USER"]のみを許可する(本人操作限定)。「定期サイクルのリセットは本人操作としての
// REOPENと同じ意味を持つか」は設計判断が必要なため、想像で許可actorを拡張せず、
// Execution Ledger(ResponsibilityExecutionEvent)には接続しないままとする。
// [2026-08-25是正・Completion Gate 2.1] ただし「状態が変わった事実そのものが
// どこにも記録されない」ことは別問題であり是正が必要(v4.0のinsert-only原則)。
// Execution Ledgerとは別の ResponsibilityLifecycleEvent(kind=RECURRENCE_RESET)へ、
// SYSTEM actorとして記録する。
async function resetForNextCycle(
  responsibilityId: string,
  workspaceId: string,
  subjectUserId: string,
  type: string,
  fromStatus: string,
  nextOccurrence: Date,
): Promise<void> {
  const toStatus = initialStatusFor(type);
  const requestPayloadHash = createHash("sha256")
    .update(JSON.stringify({ action: "RECURRENCE_RESET", responsibilityId, nextOccurrence: nextOccurrence.toISOString() }))
    .digest("hex");
  const idempotencyKey = `${responsibilityId}:RECURRENCE_RESET:${nextOccurrence.toISOString()}`;

  await db.$transaction(async (tx: Prisma.TransactionClient) => {
    const existing = await tx.responsibilityLifecycleEvent.findFirst({
      where: { workspaceId, subjectUserId, idempotencyKey },
      select: { id: true },
    });
    if (existing) return;

    await tx.responsibility.update({
      where: { id: responsibilityId },
      data: {
        status: toStatus,
        completedAt: null,
        targetAt: nextOccurrence,
        version: { increment: 1 },
      },
    });
    await tx.responsibilityLifecycleEvent.create({
      data: {
        workspaceId,
        subjectUserId,
        responsibilityId,
        kind: "RECURRENCE_RESET",
        correctionType: null,
        correctionOfEventId: null,
        resultingEventId: null,
        fromState: fromStatus,
        toState: toStatus,
        reason: "定期責任サイクルの自動リセット",
        actorType: "SYSTEM",
        actorUserId: null,
        idempotencyKey,
        requestPayloadHash,
      },
    });
  });
}

async function logGenerated(responsibilityId: string, workspaceId: string, mode: string): Promise<void> {
  await db.eventLog.create({
    data: {
      aggregateType: "Responsibility",
      aggregateId: responsibilityId,
      eventType: "RECURRENCE_GENERATED",
      afterJson: { mode },
      actorType: "SYSTEM",
    },
  });
  await db.outboxEvent.create({
    data: {
      eventName: "RecurrenceGenerated.v1",
      eventVersion: "1",
      aggregateId: responsibilityId,
      aggregateVersion: 0,
      payload: { responsibilityId, workspaceId, mode },
    },
  });
}

/** RENOTIFY用: 既存Notificationテーブルへ直接1件作成する(通知種別トグル・quietHoursは
 * 対象外の単発通知として扱う。dedupeKeyでその日1回だけに冪等化する)。 */
async function createRenotifyNotification(
  responsibilityId: string,
  workspaceId: string,
  title: string,
  occurrence: Date,
): Promise<void> {
  const members = await db.workspaceMember.findMany({
    where: { workspaceId, leftAt: null },
    select: { userId: true },
  });
  const now = new Date();
  for (const m of members as { userId: string }[]) {
    try {
      await db.notification.create({
        data: {
          userId: m.userId,
          type: "RECURRENCE_RENOTIFY",
          dedupeKey: `RECURRENCE_RENOTIFY:${responsibilityId}:${toDateKey(occurrence)}`,
          payload: { responsibilityId, title },
          channel: "IN_APP",
          status: "SENT",
          scheduledAt: now,
          sentAt: now,
        },
      });
    } catch (err: unknown) {
      const code = (err as { code?: string } | null)?.code;
      if (code !== "P2002") throw err;
    }
  }
}
