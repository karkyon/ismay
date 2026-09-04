import type { NextRequest } from "next/server";
import { z } from "zod";
import { db } from "@/lib/db";
// [2026-08-22追加] Json?列(requiredTools/options)へnullを設定する際、
// 実サーバーのtsc(実際に生成されたPrisma Client型)で発覚した不備を修正するため
// Prisma.DbNullが必要。プレーンなnullはPrismaのJson入力型として受け付けられない
// (「値が無い(SQLのNULL)」と「JSON値としてのnull」をPrismaは区別するため、
// 前者の意図(準備物・選択肢が未設定)にはPrisma.DbNullを使う)。
import { Prisma } from "@/generated/prisma/client";
import { debugServer, redactSensitive } from "@/lib/debugServer";
import { requireAuth, requireCsrf } from "@/lib/auth/guard";
import { ensureDefaultWorkspace } from "@/lib/workspace";
import { apiOk, apiError } from "@/lib/auth/response";
import { enqueueCaseDetectForResponsibilityCorrection, enqueueCaseDetectForResponsibilityDeletion } from "@/lib/patterns/casePatternTriggers";

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
      // 新設(2026-08-22): 種別固有詳細情報(TBL-007〜010)。schema.prismaにはテーブルが
      // 存在したが、GET/PATCHとも一度も配線されていなかった(カルキョンさんの指摘で発覚)。
      taskDetail: { select: { estimatedMinutesMin: true, estimatedMinutesMax: true, location: true, requiredTools: true } },
      commitmentDetail: { select: { counterpartyName: true, counterpartyContact: true, promiseText: true } },
      decisionDetail: { select: { options: true, chosenOption: true, rationale: true, decidedAt: true } },
      waitingDetail: { select: { waitingOn: true, expectedReplyBy: true, followUpAt: true } },
      // 新設(2026-08-23): TBL-011 constraints(FN-CONS-01)。schema.prismaにはテーブルが
      // 存在したが、GET/PATCHとも一度も配線されていなかった。
      constraints: { select: { id: true, constraintType: true, value: true, note: true, createdAt: true }, orderBy: { createdAt: "asc" } },
      // 新設(2026-08-23): TBL-020 recurrence_rules(FN-REC-01)。GET/PATCHとも一度も配線されていなかった。
      recurrenceRule: { select: { id: true, frequency: true, interval: true, weekdays: true, exceptions: true, pausedUntil: true, carryoverPolicy: true, lastGeneratedAt: true } },
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

// [2026-08-22新設] 種別固有詳細情報(TBL-007〜010)。カルキョンさんの指摘
// 「各タスクについてもっと情報を登録できるように指示しなかったか」で発覚した
// 未配線を解消する。detail.typeと一致するキーのみクライアントから送られる想定。
const TaskDetailSchema = z.object({
  estimatedMinutesMin: z.number().int().min(0).max(100000).nullable().optional(),
  estimatedMinutesMax: z.number().int().min(0).max(100000).nullable().optional(),
  location: z.string().max(200).nullable().optional(),
  requiredTools: z.array(z.string().max(100)).max(30).nullable().optional(),
});
const CommitmentDetailSchema = z.object({
  counterpartyName: z.string().max(200).nullable().optional(),
  counterpartyContact: z.string().max(300).nullable().optional(),
  promiseText: z.string().max(2000).nullable().optional(),
});
const DecisionDetailSchema = z.object({
  options: z.array(z.string().max(200)).max(20).nullable().optional(),
  chosenOption: z.string().max(200).nullable().optional(),
  rationale: z.string().max(2000).nullable().optional(),
  decidedAt: z.string().datetime().nullable().optional(),
});
const WaitingDetailSchema = z.object({
  waitingOn: z.string().max(300).nullable().optional(),
  expectedReplyBy: z.string().datetime().nullable().optional(),
  followUpAt: z.string().datetime().nullable().optional(),
});

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
  // [2026-08-22追加] FN-WK-03「今日の最低ライン」。最大3件まで固定できる(上限はAPI側で強制)。
  pinned: z.boolean().optional(),
  taskDetail: TaskDetailSchema.optional(),
  commitmentDetail: CommitmentDetailSchema.optional(),
  decisionDetail: DecisionDetailSchema.optional(),
  waitingDetail: WaitingDetailSchema.optional(),
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
  const { version, domainId, tagIds, taskDetail, commitmentDetail, decisionDetail, waitingDetail, ...rest } = parsed.data;

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

  // [2026-08-22追加] 種別固有詳細情報は、existing.type(現在の責任の種別)と一致する
  // キーのみ許可する。他種別のdetailを混入させるとデータ不整合になるため拒否する。
  if (taskDetail && existing.type !== "TASK") {
    return apiError("VALIDATION_FAILED", "taskDetailはtype=TASKの責任にのみ設定できます");
  }
  if (commitmentDetail && existing.type !== "COMMITMENT") {
    return apiError("VALIDATION_FAILED", "commitmentDetailはtype=COMMITMENTの責任にのみ設定できます");
  }
  if (decisionDetail && existing.type !== "DECISION") {
    return apiError("VALIDATION_FAILED", "decisionDetailはtype=DECISIONの責任にのみ設定できます");
  }
  if (waitingDetail && existing.type !== "WAITING") {
    return apiError("VALIDATION_FAILED", "waitingDetailはtype=WAITINGの責任にのみ設定できます");
  }

  // [2026-08-22追加] FN-WK-03「今日の最低ライン」: pinned=trueへの変更は最大3件まで
  // (Notion「今週のタスク」ダッシュボードの手動ピン留めと同じ発想)。既にpinned=trueの
  // ものを再度trueにする場合(no-op)は上限チェック対象外。
  if (rest.pinned === true && !existing.pinned) {
    const pinnedCount = await db.responsibility.count({
      where: { workspaceId, pinned: true, deletedAt: null },
    });
    if (pinnedCount >= 3) {
      return apiError(
        "VALIDATION_FAILED",
        "今日の最低ラインは最大3件までです。他の固定を解除してから追加してください",
        { fieldErrors: { pinned: "最大3件までです" } },
      );
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
      ...(rest.pinned !== undefined
        ? { pinned: rest.pinned, pinnedAt: rest.pinned ? new Date() : null }
        : {}),
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

  // [PATTERN-DETECT-02B新設・2026-09-04] Case Pattern候補テキストは
  // `${type}: ${title}`のみを使う(typeはこのPATCHの編集対象に含まれない)。
  // titleが実際に変化した場合のみ、Pattern入力に影響するCorrectionとして
  // enqueueする(無差別enqueue禁止、指示書§4)。
  if (rest.title !== undefined && rest.title !== existing.title) {
    await enqueueCaseDetectForResponsibilityCorrection(db, { workspaceId, responsibilityId: id });
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

  // [2026-08-22新設] 種別固有詳細情報(TBL-007〜010)のupsert。responsibilityId主キーの
  // 1:1テーブルのため、無ければ作成・あれば更新する(既存行の欠落フィールドはnull初期化)。
  //
  // [2026-08-22修正] requiredTools/optionsはJson?列のため、TypeScript上のnullを
  // そのまま渡すと実サーバーのtsc(実際に生成されたPrisma Client型)で型エラーになる
  // (発覚: 「Type 'null' is not assignable to type 'NullableJsonNullValueInput |
  // InputJsonValue | undefined'」)。本サンドボックスの簡易スタブはPrisma固有の
  // Json型を再現できず検出できなかった不備。
  // Prisma.JsonNull(JSON値としてのnullを列に書き込む)ではなく、
  // Prisma.DbNull(列自体をSQLのNULLにする、「値が無い」という意図に一致)を使う。
  // 一度JsonNullで実装しかけたが、Prisma公式ドキュメントで意味を再確認し訂正した
  // (「準備物なし」は列が空であるべきで、JSON文字列"null"が入っているのは誤り)。
  if (taskDetail) {
    const { requiredTools, ...taskRest } = taskDetail;
    const requiredToolsValue = requiredTools === null ? Prisma.DbNull : requiredTools;
    await db.taskDetail.upsert({
      where: { responsibilityId: id },
      create: { responsibilityId: id, ...taskRest, requiredTools: requiredToolsValue },
      update: { ...taskRest, requiredTools: requiredToolsValue },
    });
    debugServer.event("PATCH /responsibilities/[id]", "TASK_DETAIL_UPDATED", { id });
  }
  if (commitmentDetail) {
    await db.commitmentDetail.upsert({
      where: { responsibilityId: id },
      create: { responsibilityId: id, ...commitmentDetail },
      update: { ...commitmentDetail },
    });
    debugServer.event("PATCH /responsibilities/[id]", "COMMITMENT_DETAIL_UPDATED", { id });
  }
  if (decisionDetail) {
    const { decidedAt, options, ...decisionRest } = decisionDetail;
    const optionsValue = options === null ? Prisma.DbNull : options;
    await db.decisionDetail.upsert({
      where: { responsibilityId: id },
      create: {
        responsibilityId: id,
        ...decisionRest,
        options: optionsValue,
        decidedAt: decidedAt ? new Date(decidedAt) : null,
      },
      update: { ...decisionRest, options: optionsValue, decidedAt: decidedAt ? new Date(decidedAt) : null },
    });
    debugServer.event("PATCH /responsibilities/[id]", "DECISION_DETAIL_UPDATED", { id });
  }
  if (waitingDetail) {
    const { expectedReplyBy, followUpAt, ...waitingRest } = waitingDetail;
    await db.waitingDetail.upsert({
      where: { responsibilityId: id },
      create: {
        responsibilityId: id,
        ...waitingRest,
        expectedReplyBy: expectedReplyBy ? new Date(expectedReplyBy) : null,
        followUpAt: followUpAt ? new Date(followUpAt) : null,
      },
      update: {
        ...waitingRest,
        expectedReplyBy: expectedReplyBy ? new Date(expectedReplyBy) : null,
        followUpAt: followUpAt ? new Date(followUpAt) : null,
      },
    });
    debugServer.event("PATCH /responsibilities/[id]", "WAITING_DETAIL_UPDATED", { id });
  }

  const updated = await db.responsibility.findUniqueOrThrow({
    where: { id },
    include: {
      tags: { include: { tag: { select: { id: true, name: true, color: true } } } },
      taskDetail: { select: { estimatedMinutesMin: true, estimatedMinutesMax: true, location: true, requiredTools: true } },
      commitmentDetail: { select: { counterpartyName: true, counterpartyContact: true, promiseText: true } },
      decisionDetail: { select: { options: true, chosenOption: true, rationale: true, decidedAt: true } },
      waitingDetail: { select: { waitingOn: true, expectedReplyBy: true, followUpAt: true } },
      // 新設(2026-08-23): TBL-011 constraints(FN-CONS-01)。schema.prismaにはテーブルが
      // 存在したが、GET/PATCHとも一度も配線されていなかった。
      constraints: { select: { id: true, constraintType: true, value: true, note: true, createdAt: true }, orderBy: { createdAt: "asc" } },
      // 新設(2026-08-23): TBL-020 recurrence_rules(FN-REC-01)。GET/PATCHとも一度も配線されていなかった。
      recurrenceRule: { select: { id: true, frequency: true, interval: true, weekdays: true, exceptions: true, pausedUntil: true, carryoverPolicy: true, lastGeneratedAt: true } },
    },
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

  await db.$transaction(async (tx: Prisma.TransactionClient) => {
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
    // [PATTERN-DETECT-02B新設・2026-09-04] このResponsibility由来の
    // CasePatternSourceLinkを除外し、影響を受けたownerへEVIDENCE_EXCLUDEDで
    // enqueueする(指示書§4「Evidence deletionでは対応SourceLinkを
    // projection上excludedにし、raw/weighted/confidenceを減算する」)。
    await enqueueCaseDetectForResponsibilityDeletion(tx, { workspaceId, responsibilityId: id });
    debugServer.event("DELETE /responsibilities/[id]", "RESPONSIBILITY_DELETED", { aggregateId: id });
  });

  // DB設計書v1.1 8章: 通常削除はdeleted_at。30日後にPurge Job(未実装、次回対応)。
  return apiOk({ deleted: true });
}
