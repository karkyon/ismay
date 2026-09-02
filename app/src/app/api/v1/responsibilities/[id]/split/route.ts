import type { NextRequest } from "next/server";
import { createHash } from "node:crypto";
import { z } from "zod";
import { debugServer, redactSensitive } from "@/lib/debugServer";
import { requireAuth, requireCsrf } from "@/lib/auth/guard";
import { ensureDefaultWorkspace } from "@/lib/workspace";
import { apiOk, apiError } from "@/lib/auth/response";
import { RESPONSIBILITY_TYPES } from "@/lib/responsibility";
import { splitResponsibility } from "@/lib/formation/responsibilityCorrection";

/**
 * V5-M1-C3 API: POST /api/v1/responsibilities/{id}/split
 * 出典: 統合正本仕様書v5.0 §11.4「分解Transaction」。
 *
 * [DEC-11踏襲] project-contexts/[id]/links/route.tsと同じく、
 * ResponsibilityCorrectionReceiptがidempotency_key/request_payload_hash列を
 * 持つため、クライアント指定のIdempotency-Keyヘッダを必須とする。
 */

const SplitPartSchema = z.object({
  type: z.enum(RESPONSIBILITY_TYPES),
  title: z.string().min(1).max(300),
  description: z.string().max(20000).optional(),
});

const SplitSchema = z.object({
  version: z.number().int(),
  parts: z.array(SplitPartSchema).min(2).max(10),
  reasonCode: z.string().max(500).optional(),
});

export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const auth = await requireAuth(req);
  if (!auth.authenticated) {
    return apiError("AUTH_REQUIRED", "ログインが必要です");
  }
  if (!requireCsrf(req)) {
    return apiError("ACCESS_DENIED", "CSRFトークンが不正です");
  }

  const idempotencyKey = req.headers.get("idempotency-key");
  if (!idempotencyKey) {
    return apiError("VALIDATION_FAILED", "Idempotency-Keyヘッダが必要です", {
      fieldErrors: { "Idempotency-Key": "必須ヘッダです" },
    });
  }

  const json = await req.json().catch(() => null);
  debugServer.input("POST /responsibilities/[id]/split", "requestBody", redactSensitive(json));
  const parsed = SplitSchema.safeParse(json);
  if (!parsed.success) {
    return apiError("VALIDATION_FAILED", "入力内容を確認してください", {
      fieldErrors: Object.fromEntries(
        Object.entries(parsed.error.flatten().fieldErrors).map(([k, v]) => [k, v?.[0] ?? "不正な値です"]),
      ),
    });
  }
  const { version, parts, reasonCode } = parsed.data;
  const requestPayloadHash = createHash("sha256").update(JSON.stringify(parsed.data)).digest("hex");

  const { id } = await ctx.params;
  const { workspaceId } = await ensureDefaultWorkspace(auth.user.userId, auth.user.email);

  const result = await splitResponsibility({
    workspaceId,
    sourceResponsibilityId: id,
    expectedVersion: version,
    parts,
    reasonCode,
    actorUserId: auth.user.userId,
    idempotencyKey,
    requestPayloadHash,
  });

  if (!result.ok) {
    switch (result.error) {
      case "NOT_FOUND":
        return apiError("RESOURCE_NOT_FOUND", "指定された責任が見つかりません");
      case "VERSION_CONFLICT":
        return apiError("VERSION_CONFLICT", "他の更新と競合しました。最新の状態を取得してください", {
          retryable: true,
          extra: { latestVersion: result.latestVersion },
        });
      case "ALREADY_SPLIT":
        return apiError("ALREADY_SPLIT", "この責任は既に分割済みです", {
          extra: { receiptId: result.receiptId },
        });
      case "HAS_RECURRENCE_RULE":
        return apiError("VALIDATION_FAILED", "定期責任は分割できません");
      case "IDEMPOTENCY_KEY_REUSED":
        return apiError("IDEMPOTENCY_KEY_REUSED", "同一のリクエストキーで内容の異なるリクエストが送信されました");
      case "INVALID_SPLIT_PARTS":
        return apiError("VALIDATION_FAILED", result.reason, {
          fieldErrors: { parts: result.reason },
        });
    }
  }

  debugServer.event("POST /responsibilities/[id]/split", "RESPONSIBILITY_SPLIT", {
    id,
    receiptId: result.receiptId,
    newCount: result.newResponsibilities.length,
  });

  return apiOk(
    {
      receiptId: result.receiptId,
      sourceResponsibilityId: result.sourceResponsibilityId,
      newResponsibilities: result.newResponsibilities,
    },
    { status: result.replay ? 200 : 201 },
  );
}
