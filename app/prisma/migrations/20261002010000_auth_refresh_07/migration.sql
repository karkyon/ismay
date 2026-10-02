-- AUTH-REFRESH-07 (2026-10-02): 回転済みRefresh Tokenの再利用検知(OPEN-AUTH-07)。
-- 旧実装は回転時に同じuser_sessions行のrefresh_token_hashを上書きするだけで、旧tokenの再提示は
-- 「見つからない」として拒否されるだけだった(系列失効しない)。回転で失効したhashを保持し、
-- 猶予時間を過ぎた再提示をtoken盗難後の再利用として検知・失効させる。

CREATE TABLE "user_session_retired_refresh_tokens" (
    "id" TEXT NOT NULL,
    "session_id" TEXT NOT NULL,
    "token_hash" TEXT NOT NULL,
    "retired_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "user_session_retired_refresh_tokens_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "user_session_retired_refresh_tokens_token_hash_key" ON "user_session_retired_refresh_tokens"("token_hash");
CREATE INDEX "user_session_retired_refresh_tokens_session_id_retired_at_idx" ON "user_session_retired_refresh_tokens"("session_id", "retired_at");

ALTER TABLE "user_session_retired_refresh_tokens" ADD CONSTRAINT "user_session_retired_refresh_tokens_session_id_fkey" FOREIGN KEY ("session_id") REFERENCES "user_sessions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- 回転のたびに提示hashでuser_sessionsを引くため(従来はindexなしの全件走査)
CREATE INDEX "user_sessions_refresh_token_hash_idx" ON "user_sessions"("refresh_token_hash");
