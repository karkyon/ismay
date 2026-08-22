import { db } from "@/lib/db";
import { debugServer } from "@/lib/debugServer";
import { isTypeSpecificTerminalStatus } from "@/lib/responsibility";

/**
 * FN-NTF-01 通知(機能別詳細設計書v1.1 15章)の実装(2026-08-22新設)。
 *
 * NotificationPlannerは期限(hardDeadlineAt)・follow_up(WaitingDetail.followUpAt)・
 * risk(RISK種別がOCCURREDへ遷移)の3系統を通知候補へ変換する。dedupeKey(Notification.dedupeKey
 * の一意制約)で冪等生成し、同じ状態への再スキャンでは重複作成されない
 * (＝「同じ危険への再通知は状態変化か設定間隔が無い限り抑制」)。
 *
 * quietHours(本人のUser.notifyQuietHoursStart/End、timeZone基準)中は候補の送達を
 * 静穏時間終了まで遅延させる。bundleWindow(User.notifyBundleWindowMinutes)は
 * scheduledAtをその分単位に切り上げることで、近接して発生した複数候補の送達時刻を
 * 揃え、通知センターUI上でまとまって見えるようにする("まとめ通知")。
 *
 * [設計判断・2026-08-22] 通知チャネルはIN_APPのみ(Web Push/メールは対象外、
 * Notification.channelは既定値のまま)。「送達」はNotification.status=SENTにする
 * ことと同義であり、以後は通知センターUI(GET /api/v1/notifications)がSENT/READのみを
 * 表示する。将来チャネルを追加する場合はdispatchDueNotifications側にのみ手を入れればよい。
 *
 * [2026-08-22追加: 他SaaSの一般的UXパターンを参考にした拡張]
 * - 種別ごとの受信可否(User.notifyDeadlineEnabled等、GitHubのWatching/Participating/
 *   Customに相当する粒度選択)。無効化された種別は候補生成の時点で除外する。
 * - importance(Responsibility.importance)をpayloadに含め、通知センターUIが
 *   重要度の高い通知を視覚的に強調できるようにする(Gmail「重要マーカー」に相当する
 *   軽量なヒューリスティック。機械学習は行わない=FN-PEM-03とは別物)。
 * - DEADLINE通知に当日中の他の期限件数(siblingCountToday)を添える(Googleカレンダー
 *   の「この予定の前に別の予定があります」に相当する文脈情報)。
 * - dispatchDueNotifications: 同一ユーザーに複数件が同時到来した場合、個別に見せず
 *   1件のDIGEST通知へ集約する(Slackの「まとめて1通」・銀行アプリの日次まとめ通知に
 *   相当。元の各通知はSUPPRESSEDへ遷移し、通知センターの一覧(SENT/READのみ表示)には
 *   現れなくなる。dedupeKeyによる冪等性は元候補の生成時点で既に担保されているため、
 *   DIGEST化は表示直前の集約であり、二重通知のリスクは無い)。
 */

const LOOKAHEAD_MS = 24 * 60 * 60 * 1000; // 期限・follow_upの先読み窓(24時間以内に到来する分を対象)
const RISK_LOOKBACK_MS = 2 * 60 * 60 * 1000; // RISK発生イベントの遡り窓(スキャン間隔60秒に対し十分な余裕)

/** 通知payload(いずれもJSON安全な文字列/null限定のフィールドのみで構成する)。
 * [2026-08-22修正] 当初 payload: Record<string, unknown> としていたが、実サーバーで
 * npx prisma generate 実行後の本物のPrisma Client型(InputJsonValue)と構造的に
 * 整合せず、tsc --noEmitでエラーになった(サンドボックスはprisma generateが
 * ネットワーク制約で実行不可のため、この不整合を検出できなかった)。
 * unknownを含まないJSON安全な型に厳密化することで、Prisma.InputJsonValueの
 * import無しでも構造的に代入可能にする。 */
type NotificationPayload = Record<string, string | null>;

type NotificationCandidate = {
  userId: string;
  type: "DEADLINE" | "FOLLOW_UP" | "RISK";
  dedupeKey: string;
  payload: NotificationPayload;
};

/** workspaceIdに現在所属する(leftAt無し)ユーザーID一覧を返す。 */
async function activeMemberUserIds(workspaceId: string): Promise<string[]> {
  const members = await db.workspaceMember.findMany({
    where: { workspaceId, leftAt: null },
    select: { userId: true },
  });
  return members.map((m: { userId: string }) => m.userId);
}

/** "HH:MM"形式の設定値と、timeZone上の現在時刻から、静穏時間帯に該当するかを判定する。
 * 開始>終了の場合は日をまたぐ静穏時間(例: 22:00〜07:00)として扱う。 */
function isWithinQuietHours(
  now: Date,
  timeZone: string,
  quietHoursStart: string | null,
  quietHoursEnd: string | null,
): { inQuietHours: boolean; endsAt: Date | null } {
  if (!quietHoursStart || !quietHoursEnd) return { inQuietHours: false, endsAt: null };

  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(now);
  const hour = Number(parts.find((p) => p.type === "hour")?.value ?? "0");
  const minute = Number(parts.find((p) => p.type === "minute")?.value ?? "0");
  const nowMinutes = hour * 60 + minute;

  const [startH, startM] = quietHoursStart.split(":").map(Number);
  const [endH, endM] = quietHoursEnd.split(":").map(Number);
  if ([startH, startM, endH, endM].some((n) => Number.isNaN(n))) {
    return { inQuietHours: false, endsAt: null };
  }
  const startMinutes = startH * 60 + startM;
  const endMinutes = endH * 60 + endM;

  const overnight = startMinutes > endMinutes;
  const inQuietHours = overnight
    ? nowMinutes >= startMinutes || nowMinutes < endMinutes
    : nowMinutes >= startMinutes && nowMinutes < endMinutes;

  if (!inQuietHours) return { inQuietHours: false, endsAt: null };

  // 静穏時間の終了時刻(直近の未来)をDateとして計算する。
  const minutesUntilEnd = overnight && nowMinutes >= startMinutes
    ? 24 * 60 - nowMinutes + endMinutes // 今日の残り + 明日の終了分
    : endMinutes - nowMinutes;
  const endsAt = new Date(now.getTime() + Math.max(minutesUntilEnd, 0) * 60 * 1000);
  return { inQuietHours: true, endsAt };
}

/** bundleWindow(分)単位でscheduledAtを未来方向に切り上げる(近接通知を束ねる)。 */
function roundUpToBundleWindow(at: Date, bundleWindowMinutes: number): Date {
  if (!bundleWindowMinutes || bundleWindowMinutes <= 1) return at;
  const ms = bundleWindowMinutes * 60 * 1000;
  return new Date(Math.ceil(at.getTime() / ms) * ms);
}

/** DEADLINE候補: hardDeadlineAtがLOOKAHEAD_MS以内に到来する未完了の責任。 */
async function collectDeadlineCandidates(now: Date): Promise<NotificationCandidate[]> {
  const horizon = new Date(now.getTime() + LOOKAHEAD_MS);
  const rows = await db.responsibility.findMany({
    where: {
      deletedAt: null,
      completedAt: null,
      hardDeadlineAt: { not: null, lte: horizon },
    },
    select: {
      id: true,
      workspaceId: true,
      title: true,
      type: true,
      status: true,
      importance: true,
      hardDeadlineAt: true,
    },
  });

  type DeadlineRow = {
    id: string;
    workspaceId: string;
    title: string;
    type: string;
    status: string;
    importance: number | null;
    hardDeadlineAt: Date | null;
  };
  const validRows = (rows as DeadlineRow[]).filter(
    (r: DeadlineRow) => r.hardDeadlineAt && !isTypeSpecificTerminalStatus(r.type, r.status),
  );

  // [2026-08-22追加] Googleカレンダー的な文脈情報: 同じユーザーが本日中(24時間以内)に
  // 他にいくつ期限を抱えているかを事前に集計し、各DEADLINE候補のpayloadへ添える。
  const workspaceMembersCache = new Map<string, string[]>();
  const userDeadlineCounts = new Map<string, number>();
  const rowUserIds = new Map<string, string[]>(); // responsibilityId -> userIds(所属Workspaceの全メンバー)
  for (const r of validRows) {
    let userIds = workspaceMembersCache.get(r.workspaceId);
    if (!userIds) {
      userIds = await activeMemberUserIds(r.workspaceId);
      workspaceMembersCache.set(r.workspaceId, userIds);
    }
    rowUserIds.set(r.id, userIds);
    for (const userId of userIds) {
      userDeadlineCounts.set(userId, (userDeadlineCounts.get(userId) ?? 0) + 1);
    }
  }

  const candidates: NotificationCandidate[] = [];
  for (const r of validRows) {
    if (!r.hardDeadlineAt) continue;
    const userIds = rowUserIds.get(r.id) ?? [];

    for (const userId of userIds) {
      // 自分自身を除いた「他にいくつあるか」を出す(1件しかなければ0=文脈不要)。
      const siblingCount = Math.max((userDeadlineCounts.get(userId) ?? 1) - 1, 0);
      candidates.push({
        userId,
        type: "DEADLINE",
        dedupeKey: `DEADLINE:${r.id}:${r.hardDeadlineAt.toISOString()}:${userId}`,
        payload: {
          responsibilityId: r.id,
          title: r.title,
          hardDeadlineAt: r.hardDeadlineAt.toISOString(),
          importance: r.importance !== null ? String(r.importance) : null,
          siblingCountToday: String(siblingCount),
        },
      });
    }
  }
  return candidates;
}

/** FOLLOW_UP候補: WaitingDetail.followUpAtがLOOKAHEAD_MS以内に到来し、
 * まだそのfollowUpAtに対するリマインダーを送っていないもの。 */
async function collectFollowUpCandidates(now: Date): Promise<NotificationCandidate[]> {
  const horizon = new Date(now.getTime() + LOOKAHEAD_MS);
  const rows = await db.waitingDetail.findMany({
    where: {
      followUpAt: { not: null, lte: horizon },
      responsibility: { deletedAt: null, completedAt: null },
    },
    select: {
      responsibilityId: true,
      followUpAt: true,
      reminderSentAt: true,
      waitingOn: true,
      responsibility: { select: { workspaceId: true, title: true, type: true, status: true } },
    },
  });

  const candidates: NotificationCandidate[] = [];
  const workspaceMembersCache = new Map<string, string[]>();
  const reminderUpdates: { responsibilityId: string; followUpAt: Date }[] = [];

  for (const w of rows) {
    if (!w.followUpAt) continue;
    if (isTypeSpecificTerminalStatus(w.responsibility.type, w.responsibility.status)) continue;
    // 既にこのfollowUpAt時点に対してリマインダー済みならスキップ(followUpAtが更新されれば再度対象になる)。
    if (w.reminderSentAt && w.reminderSentAt.getTime() >= w.followUpAt.getTime()) continue;

    let userIds = workspaceMembersCache.get(w.responsibility.workspaceId);
    if (!userIds) {
      userIds = await activeMemberUserIds(w.responsibility.workspaceId);
      workspaceMembersCache.set(w.responsibility.workspaceId, userIds);
    }

    for (const userId of userIds) {
      candidates.push({
        userId,
        type: "FOLLOW_UP",
        dedupeKey: `FOLLOW_UP:${w.responsibilityId}:${w.followUpAt.toISOString()}:${userId}`,
        payload: {
          responsibilityId: w.responsibilityId,
          title: w.responsibility.title,
          followUpAt: w.followUpAt.toISOString(),
          waitingOn: w.waitingOn,
        },
      });
    }
    reminderUpdates.push({ responsibilityId: w.responsibilityId, followUpAt: w.followUpAt });
  }

  // dedupeKeyでの冪等性はNotification側の一意制約に委ねつつ、無駄な再スキャンを避けるため
  // reminderSentAtも進めておく(WaitingDetail.reminderSentAt自体は既存の未使用列を活用)。
  for (const u of reminderUpdates) {
    await db.waitingDetail.update({
      where: { responsibilityId: u.responsibilityId },
      data: { reminderSentAt: u.followUpAt },
    });
  }

  return candidates;
}

/** RISK候補: EventLogでRISK種別がOCCURREDへ遷移した記録をRISK_LOOKBACK_MS以内で走査する。
 * dedupeKeyにEventLog.idを使うことで、同一イベントに対しては確実に1回だけ生成される。 */
async function collectRiskCandidates(now: Date): Promise<NotificationCandidate[]> {
  const since = new Date(now.getTime() - RISK_LOOKBACK_MS);
  const events = await db.eventLog.findMany({
    where: {
      aggregateType: "Responsibility",
      eventType: "STATUS_CHANGED",
      occurredAt: { gte: since },
    },
    select: { id: true, aggregateId: true, afterJson: true, occurredAt: true },
    orderBy: { occurredAt: "asc" },
  });

  type OccurredEvent = { id: string; aggregateId: string; afterJson: unknown; occurredAt: Date };
  const occurredEvents = (events as OccurredEvent[]).filter((e: OccurredEvent) => {
    const after = e.afterJson as { status?: string } | null;
    return after?.status === "OCCURRED";
  });
  if (occurredEvents.length === 0) return [];

  const responsibilityIds = [...new Set<string>(occurredEvents.map((e: OccurredEvent) => e.aggregateId))];
  const responsibilities = await db.responsibility.findMany({
    where: { id: { in: responsibilityIds }, type: "RISK", deletedAt: null },
    select: { id: true, workspaceId: true, title: true, importance: true },
  });
  type RiskResponsibility = { id: string; workspaceId: string; title: string; importance: number | null };
  const respById = new Map(
    (responsibilities as RiskResponsibility[]).map((r: RiskResponsibility) => [r.id, r]),
  );

  const candidates: NotificationCandidate[] = [];
  const workspaceMembersCache = new Map<string, string[]>();
  for (const e of occurredEvents) {
    const resp = respById.get(e.aggregateId);
    if (!resp) continue; // RISK以外の種別、または削除済みは対象外

    let userIds = workspaceMembersCache.get(resp.workspaceId);
    if (!userIds) {
      userIds = await activeMemberUserIds(resp.workspaceId);
      workspaceMembersCache.set(resp.workspaceId, userIds);
    }

    for (const userId of userIds) {
      candidates.push({
        userId,
        type: "RISK",
        dedupeKey: `RISK:${e.id}:${userId}`,
        payload: {
          responsibilityId: resp.id,
          title: resp.title,
          occurredAt: e.occurredAt.toISOString(),
          importance: resp.importance !== null ? String(resp.importance) : null,
        },
      });
    }
  }
  return candidates;
}

/**
 * 候補をNotificationとして冪等生成する(dedupeKeyの一意制約により、既存分はP2002で
 * スキップされる)。quietHours/bundleWindowを反映したscheduledAtを算出し、
 * 到来済みならstatus=SENTで即座に作成、未来ならSCHEDULEDで作成する
 * (SCHEDULED分はdispatchDueNotificationsが後続tickで拾う)。
 */
export async function planNotifications(): Promise<{ created: number; skipped: number }> {
  const now = new Date();
  const [deadline, followUp, risk] = await Promise.all([
    collectDeadlineCandidates(now),
    collectFollowUpCandidates(now),
    collectRiskCandidates(now),
  ]);
  const candidates = [...deadline, ...followUp, ...risk];
  if (candidates.length === 0) return { created: 0, skipped: 0 };

  const userIds = [...new Set(candidates.map((c) => c.userId))];
  const users = await db.user.findMany({
    where: { id: { in: userIds } },
    select: {
      id: true,
      timeZone: true,
      notifyQuietHoursStart: true,
      notifyQuietHoursEnd: true,
      notifyBundleWindowMinutes: true,
      notifyDeadlineEnabled: true,
      notifyFollowUpEnabled: true,
      notifyRiskEnabled: true,
    },
  });
  type NotifyUser = {
    id: string;
    timeZone: string;
    notifyQuietHoursStart: string | null;
    notifyQuietHoursEnd: string | null;
    notifyBundleWindowMinutes: number;
    notifyDeadlineEnabled: boolean;
    notifyFollowUpEnabled: boolean;
    notifyRiskEnabled: boolean;
  };
  const userById = new Map((users as NotifyUser[]).map((u: NotifyUser) => [u.id, u]));

  const TYPE_ENABLED_KEY: Record<NotificationCandidate["type"], keyof NotifyUser> = {
    DEADLINE: "notifyDeadlineEnabled",
    FOLLOW_UP: "notifyFollowUpEnabled",
    RISK: "notifyRiskEnabled",
  };

  let created = 0;
  let skipped = 0;
  for (const c of candidates) {
    const user = userById.get(c.userId);
    if (!user) continue;
    // [2026-08-22追加] GitHub「Watching/Participating/Custom」に相当する種別粒度設定。
    // 無効化されている種別はこの時点でスキップする(dedupeKeyの消費すら発生させない)。
    if (!user[TYPE_ENABLED_KEY[c.type]]) {
      skipped++;
      continue;
    }

    const { inQuietHours, endsAt } = isWithinQuietHours(
      now,
      user.timeZone,
      user.notifyQuietHoursStart,
      user.notifyQuietHoursEnd,
    );
    let scheduledAt: Date;
    if (inQuietHours && endsAt) {
      scheduledAt = endsAt;
    } else {
      scheduledAt = roundUpToBundleWindow(now, user.notifyBundleWindowMinutes);
    }
    const willSendNow = scheduledAt.getTime() <= now.getTime();

    try {
      await db.notification.create({
        data: {
          userId: c.userId,
          type: c.type,
          dedupeKey: c.dedupeKey,
          payload: c.payload,
          channel: "IN_APP",
          status: willSendNow ? "SENT" : "SCHEDULED",
          scheduledAt,
          sentAt: willSendNow ? now : null,
        },
      });
      created++;
      debugServer.event("Notifications/plan", "Notification作成", {
        type: c.type,
        dedupeKey: c.dedupeKey,
        status: willSendNow ? "SENT" : "SCHEDULED",
      });
    } catch (err: unknown) {
      const code = (err as { code?: string } | null)?.code;
      if (code === "P2002") {
        skipped++; // 既に同じdedupeKeyで生成済み(冪等)
        continue;
      }
      debugServer.error("Notifications/plan", "Notification作成失敗", { dedupeKey: c.dedupeKey, err });
    }
  }

  return { created, skipped };
}

/** DIGEST payload: 集約された個々の通知の要約リスト(JSON安全な文字列配列)。 */
type DigestItem = { type: string; title: string; responsibilityId: string };

/**
 * quietHours中に据え置かれたSCHEDULED通知のうち、scheduledAtが到来したものを送達する。
 * [2026-08-22追加] 同一ユーザーに2件以上が同時到来した場合は、個別に見せず1件の
 * DIGEST通知へ集約する(Slack「まとめて1通」・銀行アプリの日次まとめ通知に相当)。
 * 集約元の各通知はSUPPRESSED(schema.prismaのコメントで元々想定されていた状態値)へ
 * 遷移させ、通知センターの一覧(SENT/READのみ表示)からは隠す。1件のみの場合は
 * 従来通りその1件だけをSENTにする(digestのオーバーヘッドを掛けない)。
 */
export async function dispatchDueNotifications(): Promise<{ dispatched: number }> {
  const now = new Date();
  const due = await db.notification.findMany({
    where: { status: "SCHEDULED", scheduledAt: { lte: now } },
    select: { id: true, userId: true, type: true, payload: true },
  });
  if (due.length === 0) return { dispatched: 0 };

  type DueNotification = { id: string; userId: string; type: string; payload: unknown };
  const byUser = new Map<string, DueNotification[]>();
  for (const n of due as DueNotification[]) {
    const list = byUser.get(n.userId) ?? [];
    list.push(n);
    byUser.set(n.userId, list);
  }

  let dispatched = 0;
  for (const [userId, items] of byUser) {
    if (items.length === 1) {
      await db.notification.update({
        where: { id: items[0].id },
        data: { status: "SENT", sentAt: now },
      });
      dispatched++;
      continue;
    }

    // 2件以上 -> DIGESTへ集約。
    const digestItems: DigestItem[] = items.map((n) => {
      const p = n.payload as { responsibilityId?: string; title?: string } | null;
      return { type: n.type, title: p?.title ?? "(タイトル不明)", responsibilityId: p?.responsibilityId ?? "" };
    });
    const digestPayload: NotificationPayload = {
      count: String(digestItems.length),
      itemsJson: JSON.stringify(digestItems),
    };
    try {
      await db.notification.create({
        data: {
          userId,
          type: "DIGEST",
          dedupeKey: `DIGEST:${userId}:${now.toISOString()}`,
          payload: digestPayload,
          channel: "IN_APP",
          status: "SENT",
          scheduledAt: now,
          sentAt: now,
        },
      });
      await db.notification.updateMany({
        where: { id: { in: items.map((n) => n.id) } },
        data: { status: "SUPPRESSED" },
      });
      dispatched += items.length;
      debugServer.event("Notifications/dispatch", "DIGESTへ集約", { userId, count: items.length });
    } catch (err: unknown) {
      const code = (err as { code?: string } | null)?.code;
      if (code !== "P2002") {
        debugServer.error("Notifications/dispatch", "DIGEST作成失敗", { userId, err });
      }
    }
  }

  if (dispatched > 0) {
    debugServer.event("Notifications/dispatch", "SCHEDULED→SENT/DIGEST", { count: dispatched });
  }
  return { dispatched };
}
