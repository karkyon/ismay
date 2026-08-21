import type { NextRequest } from "next/server";
import { z } from "zod";
import { db } from "@/lib/db";
import { debugServer, redactSensitive } from "@/lib/debugServer";
import { requireAuth, requireCsrf } from "@/lib/auth/guard";
import { ensureDefaultWorkspace } from "@/lib/workspace";
import { apiOk, apiError } from "@/lib/auth/response";

/**
 * POST /api/v1/responsibility-relations(2026-08-21新設)。
 * カルキョンさんの指摘「相関位置関係の編集もグラフィカルに行えるように」に対応。
 * PERT図上でノードからノードへドラッグして前提関係(BLOCKS)を作成するためのAPI。
 * fromId(前提側)がtoId(後続側)をブロックする、という向きは既存のAI自動生成分と統一する。
 */

const CreateSchema = z.object({
  fromId: z.string().uuid(),
  toId: z.string().uuid(),
});

export async function POST(req: NextRequest) {
  const auth = await requireAuth(req);
  if (!auth.authenticated) {
    return apiError("AUTH_REQUIRED", "ログインが必要です");
  }
  if (!requireCsrf(req)) {
    return apiError("ACCESS_DENIED", "CSRFトークンが不正です");
  }

  const json = await req.json().catch(() => null);
  debugServer.input("POST /responsibility-relations", "requestBody", redactSensitive(json));
  const parsed = CreateSchema.safeParse(json);
  if (!parsed.success) {
    return apiError("VALIDATION_FAILED", "入力内容を確認してください");
  }
  const { fromId, toId } = parsed.data;
  if (fromId === toId) {
    return apiError("VALIDATION_FAILED", "同じ責任同士は関連付けできません");
  }

  const { workspaceId } = await ensureDefaultWorkspace(auth.user.userId, auth.user.email);

  const [from, to] = await Promise.all([
    db.responsibility.findFirst({ where: { id: fromId, workspaceId, deletedAt: null }, select: { id: true } }),
    db.responsibility.findFirst({ where: { id: toId, workspaceId, deletedAt: null }, select: { id: true } }),
  ]);
  if (!from || !to) {
    return apiError("RESOURCE_NOT_FOUND", "指定された責任が見つかりません");
  }

  // [簡易な循環検出] toIdの祖先(何がtoIdをブロックしているか遡る)にfromIdが既に含まれる場合、
  // fromId→toIdを追加すると循環するため拒否する(PERT図が矛盾した状態になるのを防ぐ)。
  const wouldCycle = await createsCycle(fromId, toId, workspaceId);
  if (wouldCycle) {
    return apiError("VALIDATION_FAILED", "この関係を追加すると循環参照になります", {
      fieldErrors: { toId: "既に(間接的に)前提となっている責任には設定できません" },
    });
  }

  const existing = await db.responsibilityRelation.findFirst({
    where: { fromId, toId, relationType: "BLOCKS", deletedAt: null },
    select: { id: true },
  });
  if (existing) {
    return apiOk({ relation: existing, alreadyExisted: true });
  }

  const relation = await db.responsibilityRelation.create({
    data: {
      fromId,
      toId,
      relationType: "BLOCKS",
      status: "CONFIRMED",
      sourceKind: "USER",
      confirmedById: auth.user.userId,
      confirmedAt: new Date(),
    },
  });
  debugServer.event("POST /responsibility-relations", "RESPONSIBILITY_RELATION_CREATED(手動)", {
    fromId,
    toId,
    relationId: relation.id,
  });

  return apiOk({ relation, alreadyExisted: false }, { status: 201 });
}

async function createsCycle(fromId: string, toId: string, workspaceId: string): Promise<boolean> {
  // toIdから前提を遡ってfromIdに到達できるなら、fromId→toIdの追加は循環になる。
  const visited = new Set<string>();
  let frontier = [toId];
  let guard = 0;
  while (frontier.length > 0 && guard < 500) {
    guard++;
    const rows = await db.responsibilityRelation.findMany({
      where: {
        toId: { in: frontier },
        relationType: "BLOCKS",
        status: "CONFIRMED",
        deletedAt: null,
        from: { workspaceId },
      },
      select: { fromId: true },
    });
    const nextFrontier: string[] = [];
    for (const r of rows) {
      if (r.fromId === fromId) return true;
      if (!visited.has(r.fromId)) {
        visited.add(r.fromId);
        nextFrontier.push(r.fromId);
      }
    }
    frontier = nextFrontier;
  }
  return false;
}
