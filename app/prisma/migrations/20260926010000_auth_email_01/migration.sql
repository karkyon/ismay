-- AUTH-EMAIL-01 (2026-09-26): メールアドレス確認・パスワード再設定token
-- 利用者決定: SMTP+nodemailer、未確認はログイン不可、確認リンク24時間・1回限り、
-- 再送60秒間隔かつ1時間5回まで、新リンク発行で旧リンク無効、パスワード再設定も同Gateで実装。

CREATE TABLE "auth_email_tokens" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "purpose" TEXT NOT NULL,
    "token_hash" TEXT NOT NULL,
    "sent_to_email" TEXT NOT NULL,
    "request_ip" TEXT,
    "expires_at" TIMESTAMP(3) NOT NULL,
    "consumed_at" TIMESTAMP(3),
    "superseded_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "auth_email_tokens_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "auth_email_tokens_purpose_check" CHECK ("purpose" IN ('EMAIL_VERIFICATION', 'PASSWORD_RESET'))
);

CREATE UNIQUE INDEX "auth_email_tokens_token_hash_key" ON "auth_email_tokens"("token_hash");
CREATE INDEX "auth_email_tokens_user_id_purpose_created_at_idx" ON "auth_email_tokens"("user_id", "purpose", "created_at");
CREATE INDEX "auth_email_tokens_request_ip_created_at_idx" ON "auth_email_tokens"("request_ip", "created_at");

ALTER TABLE "auth_email_tokens" ADD CONSTRAINT "auth_email_tokens_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- 既存ユーザーは登録時に即時検証済み扱いだった(旧register/route.ts)。
-- 念のためemail_verified_atがNULLの既存行も確認済みとして扱い、本Gate適用で
-- 既存ユーザーがログインできなくなることを防ぐ(作成日時を確認日時とする)。
UPDATE "users" SET "email_verified_at" = "created_at" WHERE "email_verified_at" IS NULL;
