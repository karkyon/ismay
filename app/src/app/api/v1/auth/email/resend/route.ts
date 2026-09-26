import { after, type NextRequest } from "next/server";
import { z } from "zod";
import { debugServer } from "@/lib/debugServer";
import { apiOk, apiError } from "@/lib/auth/response";
import { clientIp } from "@/lib/auth/guard";
import { deliverEmailToken, issueEmailToken } from "@/lib/auth/emailToken";
import { consumeRateLimit } from "@/lib/security/rateLimiter";
import { RATE_LIMIT_POLICIES } from "@/lib/security/rateLimitPolicies";

/**
 * POST /api/v1/auth/email/resend([AUTH-EMAIL-01新設・2026-09-26])。
 * メール未確認のユーザーへ確認メールを再送する。未確認ユーザーはログインできないため未ログインで呼ぶ。
 *
 * 登録有無・確認済みか否か・上限到達かどうかを応答で区別しない(アドレスの列挙対策)。
 * 再送は60秒間隔かつ1時間5回まで(利用者決定)。新しいリンクを発行すると旧リンクは無効になる。
 */
const ResendSchema = z.object({ email: z.string().email() });

const RESEND_ACCEPTED_MESSAGE =
  "登録済みでメール未確認のアドレスであれば、確認メールを送信しました。届かない場合は迷惑メールフォルダを確認し、1分以上あけて再度お試しください";

export async function POST(req: NextRequest) {
  const json = await req.json().catch(() => null);
  const parsed = ResendSchema.safeParse(json);
  if (!parsed.success) {
    return apiError("VALIDATION_FAILED", "メールアドレスを確認してください", {
      fieldErrors: { email: "メールアドレスの形式が正しくありません" },
    });
  }
  const requestIp = clientIp(req);
  // [SECURITY-RATE-02B新設・2026-09-26] IP単位の要求回数制限(Redis)。DB側の発行上限(user・IP)は多層防御として維持する。
  // 上限到達・Redis障害(fail closed)のいずれも応答は変えず、発行・送信だけを行わない(アドレスの列挙対策)。
  const limit = await consumeRateLimit("POST /auth/email/resend", [{ policy: RATE_LIMIT_POLICIES.EMAIL_RESEND_IP, value: requestIp }]);
  if (!limit.allowed) {
    debugServer.event("POST /auth/email/resend", "確認メール未発行(rate limit)", { reason: limit.reason, policies: limit.deniedPolicyIds });
    return apiOk({ accepted: true, message: RESEND_ACCEPTED_MESSAGE });
  }
  const issued = await issueEmailToken({ purpose: "EMAIL_VERIFICATION", email: parsed.data.email, requestIp });
  if (issued.status === "ISSUED") {
    after(async () => {
      try {
        await deliverEmailToken(issued, requestIp);
      } catch (err) {
        debugServer.error("POST /auth/email/resend", "確認メール送信処理で例外", err);
      }
    });
  } else {
    debugServer.event("POST /auth/email/resend", "確認メール未発行", { reason: issued.reason });
  }
  return apiOk({ accepted: true, message: RESEND_ACCEPTED_MESSAGE });
}
