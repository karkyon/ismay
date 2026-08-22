import type { NextRequest } from "next/server";
import { z } from "zod";
import { db } from "@/lib/db";
import { debugServer, redactSensitive } from "@/lib/debugServer";
import { requireAuth, requireCsrf } from "@/lib/auth/guard";
import { ensureDefaultWorkspace } from "@/lib/workspace";
import { apiOk, apiError } from "@/lib/auth/response";

/**
 * FN-CONS-01 制約(2026-08-23新設)。TBL-011 constraints。
 * 出典: Webシステム要件定義書v2.1 7.1節「Constraintは独立した責任種別ではなく、
 * 既存の責任(Task/Commitment等)に付随する制約情報として別管理する」、FR-PLAN-03
 * 「時間だけでなく認知強度・場所・道具・権限・体力を制約にできる」。
 *
 * [設計判断・2026-08-23] schema.prismaのConstraint.valueはJson型(自由形式)。
 * 制約種別ごとに構造化スキーマを設計すると過剰実装になりやすいため、value自体は
 * `{ text: string }`という単純な自由記述に統一する(場所なら「〇〇オフィスのみ」、
 * 権限なら「上長承認が必要」等をそのままテキストで表現する)。
 *
 * [スコープ・2026-08-23] FR-PLAN-03の後半「不適合な時間帯・状態では候補順位を下げ、
 * その理由を表示する」(lib/planning.tsのスコアリングへの反映)は、既存のスコアリング
 * ロジックとの整合を取る大きめの変更になるため今回は見送り、まずCRUD(登録・表示・削除)
 * までを実装する(想像で採点ロジックへ組み込まない)。
 */

const CONSTRAINT_TYPES = ["DEADLINE", "LOCATION", "PERMISSION", "RESOURCE", "CAPACITY"] as const;

const CreateConstraintSchema = z.object({
  constraintType: z.enum(CONSTRAINT_TYPES),
  text: z.string().min(1).max(500),
  note: z.string().max(2000).nullable().optional(),
});

/** POST /responsibilities/{id}/constraints: 制約を追加する。 */
export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const auth = await requireAuth(req);
  if (!auth.authenticated) {
    return apiError("AUTH_REQUIRED", "ログインが必要です");
  }
  if (!requireCsrf(req)) {
    return apiError("ACCESS_DENIED", "CSRFトークンが不正です");
  }

  const json = await req.json().catch(() => null);
  debugServer.input("POST /responsibilities/[id]/constraints", "requestBody", redactSensitive(json));
  const parsed = CreateConstraintSchema.safeParse(json);
  if (!parsed.success) {
    return apiError("VALIDATION_FAILED", "入力内容を確認してください", {
      fieldErrors: Object.fromEntries(
        Object.entries(parsed.error.flatten().fieldErrors).map(([k, v]) => [k, v?.[0] ?? "不正な値です"]),
      ),
    });
  }

  const { id } = await ctx.params;
  const { workspaceId } = await ensureDefaultWorkspace(auth.user.userId, auth.user.email);

  const responsibility = await db.responsibility.findFirst({
    where: { id, workspaceId, deletedAt: null },
    select: { id: true },
  });
  if (!responsibility) {
    return apiError("RESOURCE_NOT_FOUND", "指定された責任が見つかりません");
  }

  const { constraintType, text, note } = parsed.data;
  const constraint = await db.constraint.create({
    data: {
      responsibilityId: id,
      constraintType,
      value: { text },
      note: note ?? null,
    },
  });
  debugServer.event("POST /responsibilities/[id]/constraints", "Constraint作成", {
    responsibilityId: id,
    constraintId: constraint.id,
    constraintType,
  });

  return apiOk(
    {
      id: constraint.id,
      constraintType: constraint.constraintType,
      value: constraint.value,
      note: constraint.note,
      createdAt: constraint.createdAt,
    },
    { status: 201 },
  );
}
