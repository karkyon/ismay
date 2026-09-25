import { after, type NextRequest } from "next/server";
import { z } from "zod";
import { db } from "@/lib/db";
import { debugServer, redactSensitive } from "@/lib/debugServer";
import { hashPassword, validatePasswordPolicy } from "@/lib/auth/password";
import { apiOk, apiError } from "@/lib/auth/response";
import { clientIp } from "@/lib/auth/guard";
import { deliverEmailToken, issueEmailToken } from "@/lib/auth/emailToken";

const RegisterSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1),
  displayName: z.string().min(1).max(100).optional(),
});

export async function POST(req: NextRequest) {
  const json = await req.json().catch(() => null);
  debugServer.input("POST /auth/register", "requestBody", redactSensitive(json));
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

  // [AUTH-EMAIL-01・2026-09-26] 旧実装はメール送信基盤が無いため emailVerifiedAt を即時設定していた。
  // 現在は未確認(null)で作成し、確認メールのリンク(POST /auth/email/verify)で確認を完了する。
  // 未確認のユーザーはログインできない(利用者決定)。
  const user = await db.user.create({
    data: {
      email: email.toLowerCase(),
      passwordHash,
      displayName: displayName ?? null,
      emailVerifiedAt: null,
    },
    select: { id: true, email: true, displayName: true, createdAt: true },
  });

  const requestIp = clientIp(req);
  const issued = await issueEmailToken({ purpose: "EMAIL_VERIFICATION", userId: user.id, requestIp });
  if (issued.status === "ISSUED") {
    // 送信は応答後に行う(SMTPの遅延・障害で登録応答を止めない)。結果はaudit_logsへ記録する。
    after(async () => {
      try {
        await deliverEmailToken(issued, requestIp);
      } catch (err) {
        debugServer.error("POST /auth/register", "確認メール送信処理で例外", err);
      }
    });
  } else {
    debugServer.event("POST /auth/register", "確認メール未発行", { userId: user.id, reason: issued.reason });
  }

  return apiOk({ user, verificationRequired: true }, { status: 201 });
}
