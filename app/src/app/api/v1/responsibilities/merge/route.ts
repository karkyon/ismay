import type { NextRequest } from "next/server";
import { createHash } from "node:crypto";
import { z } from "zod";
import { debugServer, redactSensitive } from "@/lib/debugServer";
import { requireAuth, requireCsrf } from "@/lib/auth/guard";
import { ensureDefaultWorkspace } from "@/lib/workspace";
import { apiOk, apiError } from "@/lib/auth/response";
import { RESPONSIBILITY_TYPES } from "@/lib/responsibility";
import { mergeResponsibilities } from "@/lib/formation/responsibilityCorrection";

/**
 * V5-M1-C3B API: POST /api/v1/responsibilities/merge
 * 出典: 統合正本仕様書v5.0 §12.8、§11.4の統合方向適用。
 *
 * 単一リソースIDに紐付かない操作(複数sourceを束ねる)のため、
 * `/responsibilities/{id}/...`配下ではなく`/responsibilities/merge`直下に置く
 * (splitは単一sourceに対する操作のため`/responsibilities/{id}/split`のまま)。
 *
 * [DEC-11踏襲] Idempotency-Keyヘッダを必須とする(splitと同じ契約)。
 */

const MergeSourceSchema = z.object({
  responsibilityId: z.string().uuid(),
  version: z.number().int(),
});

const MergeSchema = z.object({
  sources: z.array(MergeSourceSchema).min(2).max(10),
  newType: z.enum(RESPONSIBILITY_TYPES),
  newTitle: z.string().min(1).max(300),
  newDescription: z.string().max(20000).optional(),
  reasonCode: z.string().max(500).optional(),
});

export async function POST(req: NextRequest) {
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
  debugServer.input("POST /responsibilities/merge", "requestBody", redactSensitive(json));
  const parsed = MergeSchema.safeParse(json);
  if (!parsed.success) {
    return apiError("VALIDATION_FAILED", "入力内容を確認してください", {
      fieldErrors: Object.fromEntries(
        Object.entries(parsed.error.flatten().fieldErrors).map(([k, v]) => [k, v?.[0] ?? "不正な値です"]),
      ),
    });
  }
  const { sources, newType, newTitle, newDescription, reasonCode } = parsed.data;
  const requestPayloadHash = createHash("sha256").update(JSON.stringify(parsed.data)).digest("hex");

  const { workspaceId } = await ensureDefaultWorkspace(auth.user.userId, auth.user.email);

  const result = await mergeResponsibilities({
    workspaceId,
    sources: sources.map((s) => ({ responsibilityId: s.responsibilityId, expectedVersion: s.version })),
    newType,
    newTitle,
    newDescription,
    reasonCode,
    actorUserId: auth.user.userId,
    idempotencyKey,
    requestPayloadHash,
  });

  if (!result.ok) {
    switch (result.error) {
      case "NOT_FOUND":
        return apiError("RESOURCE_NOT_FOUND", `指定された責任が見つかりません: ${result.responsibilityId}`);
      case "VERSION_CONFLICT":
        return apiError("VERSION_CONFLICT", "他の更新と競合しました。最新の状態を取得してください", {
          retryable: true,
          extra: { responsibilityId: result.responsibilityId, latestVersion: result.latestVersion },
        });
      case "ALREADY_SPLIT_OR_MERGED":
        return apiError("ALREADY_SPLIT", "指定された責任は既に分割または統合済みです", {
          extra: { responsibilityId: result.responsibilityId, receiptId: result.receiptId },
        });
      case "HAS_RECURRENCE_RULE":
        return apiError("VALIDATION_FAILED", "定期責任は統合できません", {
          extra: { responsibilityId: result.responsibilityId },
        });
      case "DOMAIN_MISMATCH":
        return apiError("VALIDATION_FAILED", "異なるDomainの責任は統合できません");
      case "IDEMPOTENCY_KEY_REUSED":
        return apiError("IDEMPOTENCY_KEY_REUSED", "同一のリクエストキーで内容の異なるリクエストが送信されました");
      case "INVALID_MERGE_SOURCES":
        return apiError("VALIDATION_FAILED", result.reason, {
          fieldErrors: { sources: result.reason },
        });
    }
  }

  debugServer.event("POST /responsibilities/merge", "RESPONSIBILITY_MERGED", {
    receiptId: result.receiptId,
    newResponsibilityId: result.newResponsibilityId,
  });

  return apiOk(
    { receiptId: result.receiptId, newResponsibilityId: result.newResponsibilityId },
    { status: result.replay ? 200 : 201 },
  );
}
