import type { NextRequest } from "next/server";
import { z } from "zod";
import { db } from "@/lib/db";
import { debugServer, redactSensitive } from "@/lib/debugServer";
import { requireAuth, requireCsrf } from "@/lib/auth/guard";
import { ensureDefaultWorkspace } from "@/lib/workspace";
import { apiOk, apiError } from "@/lib/auth/response";
import { getOrCreateCurrentCycle } from "@/lib/cycle";
import { isTypeSpecificTerminalStatus } from "@/lib/responsibility";

/**
 * API-CYCLE-01: GET /cycles/current(2026-08-22新設)。
 * 参考記事(note.com/bingo10/n/n6ae59c33be8b)のLinear「Cycles」に相当する、
 * 現在の週次サイクルとコミット済みアイテム一覧を返す。無ければ自動生成する。
 */
export async function GET(req: NextRequest) {
  const auth = await requireAuth(req);
  if (!auth.authenticated) {
    return apiError("AUTH_REQUIRED", "ログインが必要です");
  }
  const { workspaceId } = await ensureDefaultWorkspace(auth.user.userId, auth.user.email);
  const cycle = await getOrCreateCurrentCycle(workspaceId);

  const items = await db.cycleItem.findMany({
    where: { cycleId: cycle.id },
    orderBy: { addedAt: "asc" },
    select: {
      id: true,
      responsibilityId: true,
      carriedFromCycleId: true,
      addedAt: true,
      responsibility: {
        select: {
          id: true,
          type: true,
          title: true,
          status: true,
          importance: true,
          hardDeadlineAt: true,
          targetAt: true,
          completedAt: true,
          deletedAt: true,
        },
      },
    },
  });

  type ItemRow = (typeof items)[number];
  // [2026-08-23バグ修正・全ソース総点検で発見] completedAtのみでフィルタしており、
  // 責任がsoft-delete(deletedAt設定、例: 一括削除機能で削除)された場合に、
  // 削除済みのアイテムが「未完了」としてサイクル一覧に残り続けてしまっていた。
  // また、削除済みを「完了」扱いで進捗バーの分子に加算してしまうのも意味的に誤り
  // なので、削除済みはtotal/doneどちらの分母・分子からも除外する。
  const nonDeleted = (items as ItemRow[]).filter((i) => !i.responsibility.deletedAt);
  const visible = nonDeleted.filter((i) => !i.responsibility.completedAt);
  const done = nonDeleted.length - visible.length;

  return apiOk({
    cycle: { id: cycle.id, startAt: cycle.startAt, endAt: cycle.endAt, status: cycle.status },
    items: visible.map((i) => ({
      id: i.id,
      responsibilityId: i.responsibilityId,
      carriedOver: !!i.carriedFromCycleId,
      addedAt: i.addedAt,
      type: i.responsibility.type,
      title: i.responsibility.title,
      status: i.responsibility.status,
      importance: i.responsibility.importance,
      hardDeadlineAt: i.responsibility.hardDeadlineAt,
      targetAt: i.responsibility.targetAt,
    })),
    doneCount: done,
    totalCount: nonDeleted.length,
  });
}

const AddItemSchema = z.object({
  responsibilityId: z.string().uuid(),
});

/**
 * API-CYCLE-02: POST /cycles/current/items(2026-08-22新設)。
 * バックログから今週のサイクルへコミットする("週末の一人作戦会議"のPlanningステップに相当)。
 */
export async function POST(req: NextRequest) {
  const auth = await requireAuth(req);
  if (!auth.authenticated) {
    return apiError("AUTH_REQUIRED", "ログインが必要です");
  }
  if (!requireCsrf(req)) {
    return apiError("ACCESS_DENIED", "CSRFトークンが不正です");
  }

  const json = await req.json().catch(() => null);
  debugServer.input("POST /cycles/current/items", "requestBody", redactSensitive(json));
  const parsed = AddItemSchema.safeParse(json);
  if (!parsed.success) {
    return apiError("VALIDATION_FAILED", "入力内容を確認してください", {
      fieldErrors: Object.fromEntries(
        Object.entries(parsed.error.flatten().fieldErrors).map(([k, v]) => [k, v?.[0] ?? "不正な値です"]),
      ),
    });
  }

  const { workspaceId } = await ensureDefaultWorkspace(auth.user.userId, auth.user.email);
  const { responsibilityId } = parsed.data;

  const resp = await db.responsibility.findFirst({
    where: { id: responsibilityId, workspaceId, deletedAt: null },
    select: { id: true, type: true, status: true, completedAt: true },
  });
  if (!resp) {
    return apiError("RESOURCE_NOT_FOUND", "指定された責任が見つかりません");
  }
  if (resp.completedAt || isTypeSpecificTerminalStatus(resp.type, resp.status)) {
    return apiError("VALIDATION_FAILED", "既に完了・終端状態の責任はサイクルに追加できません");
  }

  const cycle = await getOrCreateCurrentCycle(workspaceId);

  try {
    const item = await db.cycleItem.create({
      data: { cycleId: cycle.id, responsibilityId },
    });
    debugServer.event("POST /cycles/current/items", "CycleItem追加", { cycleId: cycle.id, responsibilityId });
    return apiOk({ id: item.id, cycleId: cycle.id, responsibilityId });
  } catch (err: unknown) {
    const code = (err as { code?: string } | null)?.code;
    if (code === "P2002") {
      return apiOk({ cycleId: cycle.id, responsibilityId, alreadyAdded: true });
    }
    throw err;
  }
}
