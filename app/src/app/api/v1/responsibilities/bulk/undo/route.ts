import type { NextRequest } from "next/server";
import { z } from "zod";
import { debugServer, redactSensitive } from "@/lib/debugServer";
import { requireAuth, requireCsrf } from "@/lib/auth/guard";
import { ensureDefaultWorkspace } from "@/lib/workspace";
import { apiOk, apiError } from "@/lib/auth/response";
import { executeUndo, IdempotencyKeyReusedError, InvalidUndoSnapshotError, type UndoPayload } from "@/lib/bulkOperations";

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
  snapshot: z
    .array(
      z.object({
        id: z.string().uuid(),
        status: z.string(),
        // [2026-08-25改訂・外部監査P1-5是正] ISO日時形式を要求する
        // (他エンドポイントのhardDeadlineAt等と同じ検証方針)。
        completedAt: z.string().datetime().nullable(),
        // [2026-08-25新設・外部監査P1-1是正] bulkComplete側で固定されたCOMPLETE
        // Eventのid。旧形式のクライアントとの互換のためoptionalとし、未指定は
        // nullとして扱う(その場合Undoは対象イベント無しとして安全側に倒す)。
        completeEventId: z.string().uuid().nullable().optional(),
      }),
    )
    // [2026-08-25新設・外部監査P1-3是正] snapshot内のid重複を拒否する
    // (重複を許すとrestored件数が水増しされ得るため)。
    .refine(
      (items) => new Set(items.map((i) => i.id)).size === items.length,
      { message: "snapshot内にidの重複があります" },
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
  // [2026-08-25改訂・Completion Gate 2.1] executeUndoがCOMPLETE取消時にExecution
  // Ledger/ResponsibilityLifecycleEventを記録するようになったため、記録の主体
  // (userId)を渡す必要がある。
  try {
    const result = await executeUndo(parsed.data as UndoPayload, workspaceId, auth.user.userId);
    debugServer.event("POST /responsibilities/bulk/undo", "取り消し完了", { restored: result.restored });
    return apiOk(result);
  } catch (err) {
    if (err instanceof IdempotencyKeyReusedError) {
      return apiError("IDEMPOTENCY_KEY_REUSED", err.message);
    }
    if (err instanceof InvalidUndoSnapshotError) {
      return apiError("VALIDATION_FAILED", err.message);
    }
    throw err;
  }
}
