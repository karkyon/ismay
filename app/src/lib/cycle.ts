import { db } from "@/lib/db";
import { debugServer } from "@/lib/debugServer";
import { isTypeSpecificTerminalStatus } from "@/lib/responsibility";

/**
 * 週次サイクル(Cycle)機能(2026-08-22新設)。
 *
 * カルキョンさんの依頼で参考記事(note.com/bingo10/n/n6ae59c33be8b「個人のタスク管理こそ
 * Linear」)の知見を踏まえて設計した。要点は以下2点:
 *   1. 「1週間で区切り、その間に終わらせるタスクだけに集中する」(Linearの"Cycles"機能)
 *   2. 「未完了タスクは自動で翌週へ持ち越され、罪悪感を感じる間もなくシステムが繋いでくれる」
 * ISMAY設計書には元々「Cycle」に相当する記載が無いため、新規TBDとして扱い、
 * 既存のRecurrenceRule(繰り返し責任そのものの再生成)とは別概念として実装する
 * (RecurrenceRuleは「同じ責任を毎週生成し直す」、Cycleは「複数の責任を週単位の
 * コミット箱に出し入れする」という違いがある)。
 *
 * [設計判断] 週の区切りは月曜0:00〜翌月曜0:00(固定、記事のスクラム由来の慣習に合わせた)。
 * Workspace自体にはtimeZoneが無いため、Workspaceの最初のメンバー(現状は1ユーザー1
 * Workspace前提のため実質本人)のUser.timeZoneを週境界の基準に使う。
 */

const MS_PER_DAY = 24 * 60 * 60 * 1000;

/** WorkspaceのtimeZone基準を代表するユーザーのtimeZoneを返す(先頭メンバー基準)。 */
async function representativeTimeZone(workspaceId: string): Promise<string> {
  const member = await db.workspaceMember.findFirst({
    where: { workspaceId, leftAt: null },
    orderBy: { joinedAt: "asc" },
    select: { user: { select: { timeZone: true } } },
  });
  return member?.user.timeZone ?? "Asia/Tokyo";
}

/** 指定timeZone上での「直近の月曜0:00」を起点に、[startAt, endAt)の週境界を返す。 */
function weekBoundaries(now: Date, timeZone: string): { startAt: Date; endAt: Date } {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    weekday: "short",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  }).formatToParts(now);
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? "";
  const year = Number(get("year"));
  const month = Number(get("month"));
  const day = Number(get("day"));
  const hour = Number(get("hour"));
  const minute = Number(get("minute"));
  const second = Number(get("second"));
  const weekdayStr = get("weekday"); // "Mon".."Sun"
  const WEEKDAY_INDEX: Record<string, number> = { Mon: 0, Tue: 1, Wed: 2, Thu: 3, Fri: 4, Sat: 5, Sun: 6 };
  const daysSinceMonday = WEEKDAY_INDEX[weekdayStr] ?? 0;

  // timeZone上の「現在時刻からdaysSinceMonday日前・0:00」をUTC Dateとして求める。
  // Intl.DateTimeFormatはtimeZone→ローカル時刻の変換しかできないため、
  // 「ローカル時刻の0:00を狙ったUTC値」を二分探索的に求める代わりに、
  // 現在のUTC値からローカル時刻のズレ分だけオフセットする単純な方法を使う。
  const localMs = Date.UTC(year, month - 1, day, hour, minute, second);
  const offsetMs = localMs - now.getTime(); // ローカル時刻 - UTC時刻 = タイムゾーンオフセット(符号込み)
  const localMonday0am = Date.UTC(year, month - 1, day - daysSinceMonday, 0, 0, 0);
  const startAt = new Date(localMonday0am - offsetMs);
  const endAt = new Date(startAt.getTime() + 7 * MS_PER_DAY);
  return { startAt, endAt };
}

export interface CurrentCycle {
  id: string;
  startAt: Date;
  endAt: Date;
  status: string;
}

/** 現在時刻を含むCycleを取得する。無ければ新規作成する(冪等、一意制約で二重作成を防ぐ)。 */
export async function getOrCreateCurrentCycle(workspaceId: string, now: Date = new Date()): Promise<CurrentCycle> {
  const timeZone = await representativeTimeZone(workspaceId);
  const { startAt, endAt } = weekBoundaries(now, timeZone);

  const existing = await db.cycle.findFirst({
    where: { workspaceId, startAt: { lte: now }, endAt: { gt: now } },
  });
  if (existing) return existing;

  try {
    const created = await db.cycle.create({
      data: { workspaceId, startAt, endAt, status: "ACTIVE" },
    });
    debugServer.event("Cycle/getOrCreate", "新規Cycle作成", { workspaceId, startAt, endAt });
    return created;
  } catch (err: unknown) {
    const code = (err as { code?: string } | null)?.code;
    if (code === "P2002") {
      // 並行リクエストで既に作成済み。再取得する。
      const found = await db.cycle.findUniqueOrThrow({ where: { workspaceId_startAt: { workspaceId, startAt } } });
      return found;
    }
    throw err;
  }
}

/**
 * 期限切れ(endAt <= now)のACTIVEサイクルを全workspace分CLOSEDへ遷移させ、
 * 次のサイクルを作成、未完了アイテムを自動持ち越しする(記事の「自動で翌週へ移動」に相当)。
 * dedupeは (cycleId, responsibilityId)の一意制約に委ねる。
 */
export async function rotateCycles(now: Date = new Date()): Promise<{ rotated: number; carriedOver: number }> {
  const expired = await db.cycle.findMany({
    where: { status: "ACTIVE", endAt: { lte: now } },
    select: { id: true, workspaceId: true, endAt: true },
  });
  if (expired.length === 0) return { rotated: 0, carriedOver: 0 };

  let rotated = 0;
  let carriedOver = 0;
  for (const oldCycle of expired) {
    await db.cycle.update({ where: { id: oldCycle.id }, data: { status: "CLOSED" } });

    const newCycle = await getOrCreateCurrentCycle(oldCycle.workspaceId, now);
    if (newCycle.id === oldCycle.id) continue; // 念のため(理論上起きないはず)

    const oldItems = await db.cycleItem.findMany({
      where: { cycleId: oldCycle.id },
      select: {
        responsibilityId: true,
        responsibility: { select: { type: true, status: true, deletedAt: true, completedAt: true } },
      },
    });

    for (const item of oldItems) {
      const r = item.responsibility;
      if (r.deletedAt || r.completedAt) continue;
      if (isTypeSpecificTerminalStatus(r.type, r.status)) continue;
      try {
        await db.cycleItem.create({
          data: {
            cycleId: newCycle.id,
            responsibilityId: item.responsibilityId,
            carriedFromCycleId: oldCycle.id,
          },
        });
        carriedOver++;
      } catch (err: unknown) {
        const code = (err as { code?: string } | null)?.code;
        if (code !== "P2002") throw err; // 既に新サイクルに存在(冪等)以外は再スロー
      }
    }
    rotated++;
    debugServer.event("Cycle/rotate", "サイクル自動繰越", {
      workspaceId: oldCycle.workspaceId,
      closedCycleId: oldCycle.id,
      newCycleId: newCycle.id,
      carried: oldItems.length,
    });
  }

  return { rotated, carriedOver };
}
