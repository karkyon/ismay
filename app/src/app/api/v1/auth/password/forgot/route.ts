import { after, type NextRequest } from "next/server";
import { z } from "zod";
import { debugServer } from "@/lib/debugServer";
import { apiOk, apiError } from "@/lib/auth/response";
import { clientIp } from "@/lib/auth/guard";
import { deliverEmailToken, issueEmailToken } from "@/lib/auth/emailToken";
import { EMAIL_TOKEN_POLICY, describeTtl } from "@/lib/auth/emailTokenCore";

/**
 * POST /api/v1/auth/password/forgot([AUTH-EMAIL-01新設・2026-09-26])。
 * 全機能仕様一覧 AUTH-RESET「検証済mailのみ利用し安全にpassword再発行」。
 * メール確認済みのユーザーにだけ再設定リンクを送る。登録有無・確認済みか否か・上限到達かどうかを
 * 応答で区別しない(アドレスの列挙対策)。送信は応答後に行う。
 */
const ForgotSchema = z.object({ email: z.string().email() });

const ACCEPTED_MESSAGE = `登録済みでメール確認済みのアドレスであれば、パスワード再設定のメールを送信しました。リンクの有効期限は${describeTtl(
  EMAIL_TOKEN_POLICY.PASSWORD_RESET.ttlMs,
)}です`;

export async function POST(req: NextRequest) {
  const json = await req.json().catch(() => null);
  const parsed = ForgotSchema.safeParse(json);
  if (!parsed.success) {
    return apiError("VALIDATION_FAILED", "メールアドレスを確認してください", {
      fieldErrors: { email: "メールアドレスの形式が正しくありません" },
    });
  }
  const requestIp = clientIp(req);
  const issued = await issueEmailToken({ purpose: "PASSWORD_RESET", email: parsed.data.email, requestIp });
  if (issued.status === "ISSUED") {
    after(async () => {
      try {
        await deliverEmailToken(issued, requestIp);
      } catch (err) {
        debugServer.error("POST /auth/password/forgot", "再設定メール送信処理で例外", err);
      }
    });
  } else {
    debugServer.event("POST /auth/password/forgot", "再設定メール未発行", { reason: issued.reason });
  }
  return apiOk({ accepted: true, message: ACCEPTED_MESSAGE });
}
