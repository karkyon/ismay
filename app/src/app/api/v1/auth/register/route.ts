import type { NextRequest } from "next/server";
import { z } from "zod";
import { db } from "@/lib/db";
import { hashPassword, validatePasswordPolicy } from "@/lib/auth/password";
import { apiOk, apiError } from "@/lib/auth/response";

const RegisterSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1),
  displayName: z.string().min(1).max(100).optional(),
});

export async function POST(req: NextRequest) {
  const json = await req.json().catch(() => null);
  const parsed = RegisterSchema.safeParse(json);
  if (!parsed.success) {
    return apiError("VALIDATION_FAILED", "入力内容を確認してください", {
      fieldErrors: Object.fromEntries(
        Object.entries(parsed.error.flatten().fieldErrors).map(([k, v]) => [k, v?.[0] ?? "不正な値です"]),
      ),
    });
  }
  const { email, password, displayName } = parsed.data;

  const policy = validatePasswordPolicy(password);
  if (!policy.valid) {
    return apiError("VALIDATION_FAILED", policy.reason ?? "パスワードが要件を満たしません", {
      fieldErrors: { password: policy.reason ?? "" },
    });
  }

  const existing = await db.user.findUnique({ where: { email: email.toLowerCase() } });
  if (existing) {
    // FR-AUTH-01: 重複登録を防止する。列挙攻撃対策として詳細は伏せずメッセージのみ共通化。
    return apiError("VALIDATION_FAILED", "このメールアドレスは既に登録されています", {
      fieldErrors: { email: "既に登録されています" },
    });
  }

  const passwordHash = await hashPassword(password);

  // TODO(FR-AUTH-01): メール送信基盤(Notification/MOD-08)が未実装のため、
  // 暫定的に emailVerifiedAt を即時設定している。基盤実装後は検証メール送信＋
  // 別途確認エンドポイントでの検証完了を必須化すること。
  const user = await db.user.create({
    data: {
      email: email.toLowerCase(),
      passwordHash,
      displayName: displayName ?? null,
      emailVerifiedAt: new Date(),
    },
    select: { id: true, email: true, displayName: true, createdAt: true },
  });

  return apiOk({ user }, { status: 201 });
}
