import type { NextRequest } from "next/server";
import { z } from "zod";
import { debugServer, redactSensitive } from "@/lib/debugServer";
import { requireAuth, requireCsrf } from "@/lib/auth/guard";
import { ensureDefaultWorkspace } from "@/lib/workspace";
import { apiOk, apiError } from "@/lib/auth/response";
import { executeBulkAction } from "@/lib/bulkOperations";

/**
 * API-RESP-06: POST /responsibilities/bulk(2026-08-23新設)。
 * FR-WK-09「一括操作を提供する。対象件数と影響を確認し、誤操作を取り消せる」。
 * 「対象件数と影響の確認」はフロント側の確認ダイアログで行い、本APIはaffected/skipped
 * 件数をレスポンスすることでその確認材料を提供する。「取り消し」はレスポンスのundoを
 * そのまま/bulk/undoへ渡すステートレスUndoで実現する(lib/bulkOperations.ts参照)。
 */
const BulkSchema = z.object({
  ids: z.array(z.string().uuid()).min(1).max(200),
  action: z.enum(["COMPLETE", "DELETE", "ADD_TAG", "REMOVE_TAG"]),
  tagId: z.string().uuid().optional(),
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
  debugServer.input("POST /responsibilities/bulk", "requestBody", redactSensitive(json));
  const parsed = BulkSchema.safeParse(json);
  if (!parsed.success) {
    return apiError("VALIDATION_FAILED", "入力内容を確認してください", {
      fieldErrors: Object.fromEntries(
        Object.entries(parsed.error.flatten().fieldErrors).map(([k, v]) => [k, v?.[0] ?? "不正な値です"]),
      ),
    });
  }
  const { ids, action, tagId } = parsed.data;

  if ((action === "ADD_TAG" || action === "REMOVE_TAG") && !tagId) {
    return apiError("VALIDATION_FAILED", "タグ操作にはtagIdが必要です", {
      fieldErrors: { tagId: "tagIdを指定してください" },
    });
  }

  const { workspaceId } = await ensureDefaultWorkspace(auth.user.userId, auth.user.email);
  const result = await executeBulkAction({ action, ids, workspaceId, userId: auth.user.userId, tagId });

  debugServer.event("POST /responsibilities/bulk", "一括操作完了", {
    action,
    requested: ids.length,
    affected: result.affected,
    skipped: result.skipped.length,
  });

  return apiOk(result);
}
