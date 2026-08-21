import type { NextRequest } from "next/server";
import { z } from "zod";
import { db } from "@/lib/db";
import { debugServer, redactSensitive } from "@/lib/debugServer";
import { requireAuth, requireCsrf } from "@/lib/auth/guard";
import { ensureDefaultWorkspace } from "@/lib/workspace";
import { apiOk, apiError } from "@/lib/auth/response";

/**
 * PATCH/DELETE /api/v1/tags/{id}(2026-08-21新設)。
 * カルキョンさんの指摘「カテゴリ、タグの管理はどこでやるんじゃ」に対応。
 * 従来タグは責任の詳細パネルから作成のみ可能で、リネーム・色変更・削除する
 * 専用画面が無かった。/tags管理画面から使う。
 */

const UpdateSchema = z.object({
  name: z.string().min(1).max(50).optional(),
  color: z
    .string()
    .regex(/^#[0-9a-fA-F]{6}$/, "colorは#RRGGBB形式で指定してください")
    .optional(),
});

export async function PATCH(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const auth = await requireAuth(req);
  if (!auth.authenticated) {
    return apiError("AUTH_REQUIRED", "ログインが必要です");
  }
  if (!requireCsrf(req)) {
    return apiError("ACCESS_DENIED", "CSRFトークンが不正です");
  }

  const { id } = await ctx.params;
  const json = await req.json().catch(() => null);
  debugServer.input("PATCH /tags/[id]", "requestBody", redactSensitive(json));
  const parsed = UpdateSchema.safeParse(json);
  if (!parsed.success) {
    return apiError("VALIDATION_FAILED", "入力内容を確認してください");
  }
  const { workspaceId } = await ensureDefaultWorkspace(auth.user.userId, auth.user.email);

  const existing = await db.tag.findFirst({ where: { id, workspaceId, deletedAt: null } });
  if (!existing) {
    return apiError("RESOURCE_NOT_FOUND", "指定されたタグが見つかりません");
  }

  if (parsed.data.name) {
    const dup = await db.tag.findFirst({
      where: { workspaceId, name: parsed.data.name, deletedAt: null, id: { not: id } },
      select: { id: true },
    });
    if (dup) {
      return apiError("VALIDATION_FAILED", "同名のタグが既に存在します", {
        fieldErrors: { name: "このタグ名は既に使われています" },
      });
    }
  }

  const updated = await db.tag.update({
    where: { id },
    data: {
      ...(parsed.data.name ? { name: parsed.data.name } : {}),
      ...(parsed.data.color ? { color: parsed.data.color } : {}),
    },
    select: { id: true, name: true, color: true },
  });
  debugServer.event("PATCH /tags/[id]", "TAG_UPDATED", { id });

  return apiOk({ tag: updated });
}

/** タグ自体を削除する(論理削除)。中間テーブルresponsibility_tagsはCASCADEで自動的に外れる。 */
export async function DELETE(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const auth = await requireAuth(req);
  if (!auth.authenticated) {
    return apiError("AUTH_REQUIRED", "ログインが必要です");
  }
  if (!requireCsrf(req)) {
    return apiError("ACCESS_DENIED", "CSRFトークンが不正です");
  }

  const { id } = await ctx.params;
  const { workspaceId } = await ensureDefaultWorkspace(auth.user.userId, auth.user.email);

  const existing = await db.tag.findFirst({ where: { id, workspaceId, deletedAt: null } });
  if (!existing) {
    return apiError("RESOURCE_NOT_FOUND", "指定されたタグが見つかりません");
  }

  await db.$transaction([
    db.responsibilityTag.deleteMany({ where: { tagId: id } }),
    db.tag.update({ where: { id }, data: { deletedAt: new Date() } }),
  ]);
  debugServer.event("DELETE /tags/[id]", "TAG_DELETED", { id });

  return apiOk({ deleted: true });
}
