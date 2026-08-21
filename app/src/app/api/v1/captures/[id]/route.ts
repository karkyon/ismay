import type { NextRequest } from "next/server";
import { z } from "zod";
import { db } from "@/lib/db";
import { debugServer } from "@/lib/debugServer";
import { requireAuth, requireCsrf } from "@/lib/auth/guard";
import { ensureDefaultWorkspace } from "@/lib/workspace";
import { apiOk, apiError } from "@/lib/auth/response";

/**
 * UI-04向け詳細取得。
 * [2026-08-20追加] processingStatus=FAILEDでも「なぜ失敗したか」が画面から分からず、
 * ターミナルでjournalctlを確認しないと原因調査できなかったため、直近のAiRun
 * (provider/model/status/errorCode/latency)を同梱するよう拡張した。
 * これによりAI Worker側の失敗理由(APIキー未設定等)がInbox画面に直接表示できる。
 */
export async function GET(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const auth = await requireAuth(req);
  if (!auth.authenticated) {
    return apiError("AUTH_REQUIRED", "ログインが必要です");
  }

  const { id } = await ctx.params;
  const { workspaceId } = await ensureDefaultWorkspace(auth.user.userId, auth.user.email);

  const capture = await db.capture.findFirst({
    where: { id, workspaceId, deletedAt: null },
    select: {
      id: true,
      sourceType: true,
      rawText: true,
      aiSummary: true,
      audioObjectKey: true,
      imageObjectKey: true,
      processingStatus: true,
      processingPriority: true,
      domainId: true,
      consentId: true,
      sourceCapturedAt: true,
      version: true,
      createdAt: true,
      updatedAt: true,
      /// 新設(2026-08-21): 画像複数ページ結合。件数のみ返す(URLはまだUI側で使わないため)。
      _count: { select: { images: true } },
      /// 新設(2026-08-21): 音声話題自動分割。分割元Captureのidがあれば返す。
      splitFromCaptureId: true,
      aiRuns: {
        orderBy: { startedAt: "desc" },
        take: 1,
        select: {
          id: true,
          provider: true,
          model: true,
          status: true,
          errorCode: true,
          inputTokens: true,
          outputTokens: true,
          latencyMs: true,
          startedAt: true,
          finishedAt: true,
        },
      },
    },
  });

  if (!capture) {
    // 他Workspaceのcapture IDを推測されても存在有無を漏らさない(IDOR対策。sessions/[id]と同じ方針)
    return apiError("RESOURCE_NOT_FOUND", "指定されたCaptureが見つかりません");
  }

  const { aiRuns, _count, ...captureFields } = capture;
  return apiOk({ capture: { ...captureFields, imagePageCount: _count.images }, latestAiRun: aiRuns[0] ?? null });
}

const UpdateCaptureSchema = z.object({
  // [2026-08-21新設] カルキョンさんの指示「Inboxからの生成タスクのタイトル、概要は
  // 編集できるようにしろ」に対応。aiSummaryはInbox一覧・詳細で「タイトル/概要」として
  // 表示している列であり、AI生成のままだと的外れな場合に手動修正できなかった。
  aiSummary: z.string().max(120).nullable().optional(),
  version: z.number().int(),
});

/** PATCH /api/v1/captures/{id}(2026-08-21新設)。現状aiSummaryのみ編集対象。 */
export async function PATCH(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const auth = await requireAuth(req);
  if (!auth.authenticated) {
    return apiError("AUTH_REQUIRED", "ログインが必要です");
  }
  if (!requireCsrf(req)) {
    return apiError("ACCESS_DENIED", "CSRFトークンが不正です");
  }

  const { id } = await ctx.params;
  const { workspaceId } = await ensureDefaultWorkspace(auth.user.userId, auth.user.email);

  const json = await req.json().catch(() => null);
  const parsed = UpdateCaptureSchema.safeParse(json);
  if (!parsed.success) {
    return apiError("VALIDATION_FAILED", "入力内容を確認してください", {
      fieldErrors: Object.fromEntries(
        Object.entries(parsed.error.flatten().fieldErrors).map(([k, v]) => [k, v?.[0] ?? "不正な値です"]),
      ),
    });
  }

  const existing = await db.capture.findFirst({ where: { id, workspaceId, deletedAt: null }, select: { version: true } });
  if (!existing) {
    return apiError("RESOURCE_NOT_FOUND", "指定されたCaptureが見つかりません");
  }
  if (existing.version !== parsed.data.version) {
    return apiError("VERSION_CONFLICT", "他の変更と競合しました。画面を更新してから再度お試しください");
  }

  const updated = await db.capture.updateMany({
    where: { id, workspaceId, version: parsed.data.version },
    data: { aiSummary: parsed.data.aiSummary, version: { increment: 1 } },
  });
  if (updated.count === 0) {
    return apiError("VERSION_CONFLICT", "他の変更と競合しました。画面を更新してから再度お試しください");
  }
  debugServer.event("PATCH /captures/{id}", "aiSummary手動編集", { captureId: id });

  return apiOk({ id, version: parsed.data.version + 1 });
}
