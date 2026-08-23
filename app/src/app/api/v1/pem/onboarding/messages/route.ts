import type { NextRequest } from "next/server";
import { z } from "zod";
import { db } from "@/lib/db";
import { debugServer, redactSensitive } from "@/lib/debugServer";
import { requireAuth, requireCsrf } from "@/lib/auth/guard";
import { ensureDefaultWorkspace } from "@/lib/workspace";
import { apiOk, apiError } from "@/lib/auth/response";
import { processOnboardingMessage } from "@/lib/ai/pemOnboarding";

/**
 * API-PEM-01: POST /pem/onboarding/messages 初回対話(FN-PEM-01/UI-02)。
 * 出典: API・イベント設計書v1.1 4.5節。
 *
 * Request: conversationId、message、skip?。Response: assistantMessage、proposedFacts、
 * proposedHypotheses、nextQuestion、completion。
 *
 * [設計判断・2026-08-23] 設計書のconversationIdは「1ユーザー1件」の対話を前提に
 * userIdと1:1対応させる(PemOnboardingConversation.userIdがunique)。リクエストの
 * conversationIdは将来の複数対話対応に備えたプレースホルダーとして受け取るが、
 * 現状は無視し常に本人のuserIdへ紐づく対話を使う(他人のconversationIdを渡されても
 * 参照できない設計にすることで、越権アクセスを構造的に防ぐ)。
 */

const RequestSchema = z.object({
  conversationId: z.string().max(128).optional(),
  message: z.string().max(2000).default(""),
  skip: z.boolean().default(false),
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
  debugServer.input("POST /pem/onboarding/messages", "requestBody", redactSensitive(json));
  const parsed = RequestSchema.safeParse(json);
  if (!parsed.success) {
    return apiError("VALIDATION_FAILED", "入力内容を確認してください", {
      fieldErrors: Object.fromEntries(
        Object.entries(parsed.error.flatten().fieldErrors).map(([k, v]) => [k, v?.[0] ?? "不正な値です"]),
      ),
    });
  }
  const { message, skip } = parsed.data;
  if (!skip && !message.trim()) {
    return apiError("VALIDATION_FAILED", "messageを指定するか、skipをtrueにしてください", {
      fieldErrors: { message: "空にできません(スキップする場合はskip=trueを指定してください)" },
    });
  }

  const { workspaceId } = await ensureDefaultWorkspace(auth.user.userId, auth.user.email);

  const result = await processOnboardingMessage(auth.user.userId, workspaceId, message, skip);

  if (result.status === "FAILED") {
    debugServer.error("POST /pem/onboarding/messages", "AI呼び出し失敗", { reason: result.reason });
    return apiError("AI_TEMPORARILY_UNAVAILABLE", "AIとの対話に失敗しました。しばらくしてからもう一度お試しください", {
      retryable: true,
    });
  }

  return apiOk({
    assistantMessage: result.assistantMessage,
    proposedFacts: result.proposedFacts,
    proposedHypotheses: result.proposedHypotheses,
    nextQuestion: result.nextQuestion,
    completion: result.completion,
    state: result.state,
  });
}

/**
 * [2026-08-23新設・設計書に明記は無いが必要と判断] UI-03の未完了バナー表示のため、
 * 対話が未完了かどうかをフロントが軽量に確認できるGETを追加する。
 * POST側は「メッセージ送信」の作用があるため、単純な状態確認に流用しない。
 */
export async function GET(req: NextRequest) {
  const auth = await requireAuth(req);
  if (!auth.authenticated) {
    return apiError("AUTH_REQUIRED", "ログインが必要です");
  }

  const conversation = await db.pemOnboardingConversation.findUnique({
    where: { userId: auth.user.userId },
    select: { state: true, completedAt: true, messages: true },
  });

  return apiOk({
    exists: !!conversation,
    state: conversation?.state ?? "ROLE",
    completed: !!conversation?.completedAt,
    hasStarted: !!conversation && Array.isArray(conversation.messages) && conversation.messages.length > 0,
  });
}
