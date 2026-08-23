import type { NextRequest } from "next/server";
import { z } from "zod";
import { db } from "@/lib/db";
import { debugServer, redactSensitive } from "@/lib/debugServer";
import { requireAuth, requireCsrf } from "@/lib/auth/guard";
import { apiOk, apiError } from "@/lib/auth/response";

/**
 * API-PEM-02: GET/PATCH /pem/hypotheses/{id} 閲覧・訂正(FN-PEM-03/UI-09)。
 * 出典: API・イベント設計書v1.1 4.5節、AI・PEM設計書v1.0 14章「訂正・忘却・リセット」。
 *
 * 訂正: 「正しい／違う／一時的」→userVerdict(CONFIRMED/REJECTED/TEMPORARY)。
 * 忘却(「今後使わない」相当): forget=trueでdeletedAt設定(論理削除)。
 * 「証拠を除外できるが履歴に理由を残す」は、削除ではなくvalidUntil即時失効という形で
 * 対応済み(lib/pem.tsのrecomputeAggregates参照)。個別仮説の物理削除はしない。
 */

const PatchSchema = z
  .object({
    userVerdict: z.enum(["CONFIRMED", "REJECTED", "TEMPORARY"]).optional(),
    forget: z.boolean().optional(),
  })
  .refine((v) => v.userVerdict !== undefined || v.forget !== undefined, {
    message: "userVerdictまたはforgetのいずれかを指定してください",
  });

export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const auth = await requireAuth(req);
  if (!auth.authenticated) {
    return apiError("AUTH_REQUIRED", "ログインが必要です");
  }
  const { id } = await params;

  const hypothesis = await db.pemHypothesis.findFirst({
    where: { id, userId: auth.user.userId, deletedAt: null },
  });
  if (!hypothesis) {
    return apiError("RESOURCE_NOT_FOUND", "指定された仮説が見つかりません");
  }

  return apiOk({
    id: hypothesis.id,
    statement: hypothesis.statement,
    sampleSize: hypothesis.sampleSize,
    windowFrom: hypothesis.windowFrom.toISOString(),
    windowTo: hypothesis.windowTo.toISOString(),
    confidence: Number(hypothesis.confidence),
    userVerdict: hypothesis.userVerdict,
    createdAt: hypothesis.createdAt.toISOString(),
  });
}

export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const auth = await requireAuth(req);
  if (!auth.authenticated) {
    return apiError("AUTH_REQUIRED", "ログインが必要です");
  }
  if (!requireCsrf(req)) {
    return apiError("ACCESS_DENIED", "CSRFトークンが不正です");
  }
  const { id } = await params;

  const json = await req.json().catch(() => null);
  debugServer.input("PATCH /pem/hypotheses/[id]", "requestBody", redactSensitive(json));
  const parsed = PatchSchema.safeParse(json);
  if (!parsed.success) {
    return apiError("VALIDATION_FAILED", "入力内容を確認してください", {
      fieldErrors: Object.fromEntries(
        Object.entries(parsed.error.flatten().fieldErrors).map(([k, v]) => [k, v?.[0] ?? "不正な値です"]),
      ),
    });
  }

  const existing = await db.pemHypothesis.findFirst({ where: { id, userId: auth.user.userId, deletedAt: null } });
  if (!existing) {
    return apiError("RESOURCE_NOT_FOUND", "指定された仮説が見つかりません");
  }

  const { userVerdict, forget } = parsed.data;
  const updated = await db.pemHypothesis.update({
    where: { id },
    data: {
      ...(userVerdict !== undefined ? { userVerdict } : {}),
      ...(forget ? { deletedAt: new Date() } : {}),
    },
  });
  debugServer.state("PATCH /pem/hypotheses/[id]", "PemHypothesis", {
    id,
    userVerdict: updated.userVerdict,
    forgotten: !!updated.deletedAt,
  });

  return apiOk({
    id: updated.id,
    userVerdict: updated.userVerdict,
    forgotten: !!updated.deletedAt,
  });
}
