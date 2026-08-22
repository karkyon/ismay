import type { NextRequest } from "next/server";
import { z } from "zod";
import { debugServer, redactSensitive } from "@/lib/debugServer";
import { requireAuth, requireCsrf } from "@/lib/auth/guard";
import { ensureDefaultWorkspace } from "@/lib/workspace";
import { apiOk, apiError } from "@/lib/auth/response";
import { executeUndo, type UndoPayload } from "@/lib/bulkOperations";

/**
 * API-RESP-06付随: POST /responsibilities/bulk/undo(2026-08-23新設)。
 * POST /responsibilities/bulkのレスポンスに含まれるundoオブジェクトをそのまま渡すと
 * 元に戻せる(ステートレスUndo。詳細はlib/bulkOperations.ts参照)。
 *
 * [既知の制約] 元に戻す時点で他のユーザー操作により対象が別の状態へ変わっていた場合
 * (例: 一括完了後に個別で編集された)、そのユーザー操作を上書きしてしまう可能性がある。
 * MVPでは楽観ロック(version)までは追わず単純上書きとする(一括操作自体が個人利用規模の
 * 短時間の一連操作を想定しているため、実害は限定的と判断)。
 */
const CompleteUndoSchema = z.object({
  action: z.literal("COMPLETE"),
  snapshot: z.array(
    z.object({ id: z.string().uuid(), status: z.string(), completedAt: z.string().nullable() }),
  ),
});
const DeleteUndoSchema = z.object({
  action: z.literal("DELETE"),
  ids: z.array(z.string().uuid()),
});
const TagUndoSchema = z.object({
  action: z.enum(["ADD_TAG", "REMOVE_TAG"]),
  ids: z.array(z.string().uuid()),
  tagId: z.string().uuid(),
});
const UndoSchema = z.union([CompleteUndoSchema, DeleteUndoSchema, TagUndoSchema]);

export async function POST(req: NextRequest) {
  const auth = await requireAuth(req);
  if (!auth.authenticated) {
    return apiError("AUTH_REQUIRED", "ログインが必要です");
  }
  if (!requireCsrf(req)) {
    return apiError("ACCESS_DENIED", "CSRFトークンが不正です");
  }

  const json = await req.json().catch(() => null);
  debugServer.input("POST /responsibilities/bulk/undo", "requestBody", redactSensitive(json));
  const parsed = UndoSchema.safeParse(json);
  if (!parsed.success) {
    return apiError("VALIDATION_FAILED", "入力内容を確認してください");
  }

  const { workspaceId } = await ensureDefaultWorkspace(auth.user.userId, auth.user.email);
  const result = await executeUndo(parsed.data as UndoPayload, workspaceId);
  debugServer.event("POST /responsibilities/bulk/undo", "取り消し完了", { restored: result.restored });

  return apiOk(result);
}
