import type { NextRequest } from "next/server";
import { z } from "zod";
import { db } from "@/lib/db";
import { debugServer, redactSensitive } from "@/lib/debugServer";
import { requireAuth, requireCsrf } from "@/lib/auth/guard";
import { ensureDefaultWorkspace } from "@/lib/workspace";
import { apiOk, apiError } from "@/lib/auth/response";

/**
 * タグ管理(2026-08-21新設)。カルキョンさんの指摘「タグの管理は？」に対応。
 * Workspace単位でタグ名は一意。色は既定パレットから選ぶ想定(自由入力も許可)。
 */

const CreateSchema = z.object({
  name: z.string().min(1).max(50),
  color: z
    .string()
    .regex(/^#[0-9a-fA-F]{6}$/, "colorは#RRGGBB形式で指定してください")
    .optional(),
});

/** GET /api/v1/tags: このWorkspaceの全タグを返す。 */
export async function GET(req: NextRequest) {
  const auth = await requireAuth(req);
  if (!auth.authenticated) {
    return apiError("AUTH_REQUIRED", "ログインが必要です");
  }
  const { workspaceId } = await ensureDefaultWorkspace(auth.user.userId, auth.user.email);

  const tags = await db.tag.findMany({
    where: { workspaceId, deletedAt: null },
    orderBy: { name: "asc" },
    select: { id: true, name: true, color: true },
  });

  return apiOk({ tags });
}

/** POST /api/v1/tags: 新規タグを作成する(既存の同名タグがあれば流用してそのまま返す)。 */
export async function POST(req: NextRequest) {
  const auth = await requireAuth(req);
  if (!auth.authenticated) {
    return apiError("AUTH_REQUIRED", "ログインが必要です");
  }
  if (!requireCsrf(req)) {
    return apiError("ACCESS_DENIED", "CSRFトークンが不正です");
  }

  const json = await req.json().catch(() => null);
  debugServer.input("POST /tags", "requestBody", redactSensitive(json));
  const parsed = CreateSchema.safeParse(json);
  if (!parsed.success) {
    return apiError("VALIDATION_FAILED", "入力内容を確認してください", {
      fieldErrors: Object.fromEntries(
        Object.entries(parsed.error.flatten().fieldErrors).map(([k, v]) => [k, v?.[0] ?? "不正な値です"]),
      ),
    });
  }
  const { name, color } = parsed.data;
  const { workspaceId } = await ensureDefaultWorkspace(auth.user.userId, auth.user.email);

  const tag = await db.tag.upsert({
    where: { workspaceId_name: { workspaceId, name } },
    create: { workspaceId, name, color: color ?? "#6b7280" },
    update: {},
    select: { id: true, name: true, color: true },
  });
  debugServer.event("POST /tags", "TAG_CREATED_OR_REUSED", { tagId: tag.id, name: tag.name });

  return apiOk({ tag }, { status: 201 });
}
