import type { NextRequest } from "next/server";
import { db } from "@/lib/db";
import { requireAuth } from "@/lib/auth/guard";
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
      audioObjectKey: true,
      processingStatus: true,
      domainId: true,
      consentId: true,
      sourceCapturedAt: true,
      version: true,
      createdAt: true,
      updatedAt: true,
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

  const { aiRuns, ...captureFields } = capture;
  return apiOk({ capture: captureFields, latestAiRun: aiRuns[0] ?? null });
}
