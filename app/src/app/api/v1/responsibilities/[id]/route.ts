import type { NextRequest } from "next/server";
import { z } from "zod";
import { db } from "@/lib/db";
import { debugServer, redactSensitive } from "@/lib/debugServer";
import { requireAuth, requireCsrf } from "@/lib/auth/guard";
import { ensureDefaultWorkspace } from "@/lib/workspace";
import { apiOk, apiError } from "@/lib/auth/response";

/** API-RESP-02: GET /responsibilities/{id} 詳細(UI-06)。 */
export async function GET(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const auth = await requireAuth(req);
  if (!auth.authenticated) {
    return apiError("AUTH_REQUIRED", "ログインが必要です");
  }
  const { id } = await ctx.params;
  const { workspaceId } = await ensureDefaultWorkspace(auth.user.userId, auth.user.email);

  const responsibility = await db.responsibility.findFirst({
    where: { id, workspaceId, deletedAt: null },
    include: {
      tags: { include: { tag: { select: { id: true, name: true, color: true } } } },
      // 新設(2026-08-21): 元Captureのタイトル・作成日・種別を同梱し、
      // 「もともとどんな文書・音声・画像で抽出したものか」を画面から辿れるようにする。
      originCapture: { select: { id: true, sourceType: true, aiSummary: true, rawText: true, createdAt: true } },
    },
  });
  if (!responsibility) {
    // 他Workspaceの responsibility IDを推測されても存在有無を漏らさない(IDOR対策)
    return apiError("RESOURCE_NOT_FOUND", "指定された責任が見つかりません");
  }

  type WithTags = typeof responsibility & { tags: { tag: { id: string; name: string; color: string } }[] };
  const { tags, ...fields } = responsibility as WithTags;
  return apiOk({
    responsibility: { ...fields, tags: tags.map((t: { tag: { id: string; name: string; color: string } }) => t.tag) },
  });
}

const UpdateSchema = z.object({
  title: z.string().min(1).max(300).optional(),
  description: z.string().max(20000).nullable().optional(),
  domainId: z.string().uuid().optional(),
  importance: z.number().int().min(1).max(5).nullable().optional(),
  hardDeadlineAt: z.string().datetime().nullable().optional(),
  targetAt: z.string().datetime().nullable().optional(),
  startAfterAt: z.string().datetime().nullable().optional(),
  // [2026-08-21追加] タグ編集・PERT図でのノード位置保存(ドラッグ移動)に対応。
  tagIds: z.array(z.string().uuid()).max(20).optional(),
  graphX: z.number().nullable().optional(),
  graphY: z.number().nullable().optional(),
  version: z.number().int(),
});

/** API-RESP-02: PATCH /responsibilities/{id} 更新。楽観ロック(version)必須。 */
export async function PATCH(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const auth = await requireAuth(req);
  if (!auth.authenticated) {
    return apiError("AUTH_REQUIRED", "ログインが必要です");
  }
  if (!requireCsrf(req)) {
    return apiError("ACCESS_DENIED", "CSRFトークンが不正です");
  }

  const json = await req.json().catch(() => null);
  debugServer.input("PATCH /responsibilities/[id]", "requestBody", redactSensitive(json));
  const parsed = UpdateSchema.safeParse(json);
  if (!parsed.success) {
    return apiError("VALIDATION_FAILED", "入力内容を確認してください", {
      fieldErrors: Object.fromEntries(
        Object.entries(parsed.error.flatten().fieldErrors).map(([k, v]) => [k, v?.[0] ?? "不正な値です"]),
      ),
    });
  }
  const { version, domainId, tagIds, ...rest } = parsed.data;

  const { id } = await ctx.params;
  const { workspaceId } = await ensureDefaultWorkspace(auth.user.userId, auth.user.email);

  const existing = await db.responsibility.findFirst({ where: { id, workspaceId, deletedAt: null } });
  if (!existing) {
    return apiError("RESOURCE_NOT_FOUND", "指定された責任が見つかりません");
  }

  let resolvedDomainId: string | undefined;
  if (domainId) {
    const domain = await db.domain.findFirst({
      where: { id: domainId, workspaceId, deletedAt: null },
      select: { id: true },
    });
    if (!domain) {
      return apiError("VALIDATION_FAILED", "指定されたdomainIdが存在しません", {
        fieldErrors: { domainId: "許可されていないDomainです" },
      });
    }
    resolvedDomainId = domain.id;
  }

  // [2026-08-21追加] タグはWorkspace内に実在するものだけを許可する(他Workspaceのタグを
  // 紐付けられるIDOR的な穴を防ぐ)。
  if (tagIds) {
    const validTags = await db.tag.findMany({
      where: { id: { in: tagIds }, workspaceId, deletedAt: null },
      select: { id: true },
    });
    if (validTags.length !== tagIds.length) {
      return apiError("VALIDATION_FAILED", "存在しないタグが含まれています", {
        fieldErrors: { tagIds: "このWorkspaceに存在するタグのみ指定できます" },
      });
    }
  }

  const updateResult = await db.responsibility.updateMany({
    where: { id, version },
    data: {
      ...(rest.title !== undefined ? { title: rest.title } : {}),
      ...(rest.description !== undefined ? { description: rest.description } : {}),
      ...(rest.importance !== undefined ? { importance: rest.importance } : {}),
      ...(rest.hardDeadlineAt !== undefined
        ? { hardDeadlineAt: rest.hardDeadlineAt ? new Date(rest.hardDeadlineAt) : null }
        : {}),
      ...(rest.targetAt !== undefined ? { targetAt: rest.targetAt ? new Date(rest.targetAt) : null } : {}),
      ...(rest.startAfterAt !== undefined
        ? { startAfterAt: rest.startAfterAt ? new Date(rest.startAfterAt) : null }
        : {}),
      ...(rest.graphX !== undefined ? { graphX: rest.graphX } : {}),
      ...(rest.graphY !== undefined ? { graphY: rest.graphY } : {}),
      ...(resolvedDomainId ? { domainId: resolvedDomainId } : {}),
      updatedById: auth.user.userId,
      version: { increment: 1 },
    },
  });

  if (updateResult.count === 0) {
    // 機能別詳細設計書v1.1 18章「競合制御」: 409応答にlatestVersionを含める
    const latest = await db.responsibility.findUnique({ where: { id }, select: { version: true } });
    return apiError("VERSION_CONFLICT", "他の更新と競合しました。最新の状態を取得してください", {
      retryable: true,
      extra: { latestVersion: latest?.version },
    });
  }

  if (tagIds) {
    await db.$transaction([
      db.responsibilityTag.deleteMany({ where: { responsibilityId: id } }),
      ...(tagIds.length > 0
        ? [
            db.responsibilityTag.createMany({
              data: tagIds.map((tagId) => ({ responsibilityId: id, tagId })),
            }),
          ]
        : []),
    ]);
    debugServer.event("PATCH /responsibilities/[id]", "TAGS_UPDATED", { id, tagIds });
  }

  const updated = await db.responsibility.findUniqueOrThrow({
    where: { id },
    include: { tags: { include: { tag: { select: { id: true, name: true, color: true } } } } },
  });
  debugServer.state("PATCH /responsibilities/[id]", "Responsibility", { id, status: updated.status });

  await db.eventLog.create({
    data: {
      aggregateType: "Responsibility",
      aggregateId: id,
      eventType: "RESPONSIBILITY_CHANGED",
      beforeJson: { title: existing.title, description: existing.description, importance: existing.importance },
      afterJson: { title: updated.title, description: updated.description, importance: updated.importance },
      actorType: "USER",
      actorId: auth.user.userId,
    },
  });
  debugServer.event("PATCH /responsibilities/[id]", "RESPONSIBILITY_CHANGED", { aggregateId: id });

  const { tags: updatedTags, ...updatedFields } = updated as typeof updated & {
    tags: { tag: { id: string; name: string; color: string } }[];
  };
  return apiOk({
    responsibility: {
      ...updatedFields,
      tags: updatedTags.map((t: { tag: { id: string; name: string; color: string } }) => t.tag),
    },
  });
}

/** API-RESP-04: DELETE /responsibilities/{id} 論理削除。30日以内は復元可能(復元APIは別スコープ)。 */
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

  const existing = await db.responsibility.findFirst({ where: { id, workspaceId, deletedAt: null } });
  if (!existing) {
    return apiError("RESOURCE_NOT_FOUND", "指定された責任が見つかりません");
  }

  await db.$transaction(async (tx) => {
    await tx.responsibility.update({
      where: { id },
      data: { deletedAt: new Date(), version: { increment: 1 } },
    });
    await tx.eventLog.create({
      data: {
        aggregateType: "Responsibility",
        aggregateId: id,
        eventType: "RESPONSIBILITY_DELETED",
        beforeJson: { deletedAt: null },
        afterJson: { deletedAt: new Date().toISOString() },
        actorType: "USER",
        actorId: auth.user.userId,
      },
    });
    debugServer.event("DELETE /responsibilities/[id]", "RESPONSIBILITY_DELETED", { aggregateId: id });
  });

  // DB設計書v1.1 8章: 通常削除はdeleted_at。30日後にPurge Job(未実装、次回対応)。
  return apiOk({ deleted: true });
}
