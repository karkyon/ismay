-- M1-B6C-4 §6.3: retry orchestration
-- 出典: Claude向け ISMAY c503e72以降 M1-B6C・全残件連続実装指示(2026-08-31) §6.3。
--
-- FormationShadowCheckpointへ、retryによる新analysis attemptの場合の対象Session
-- IDを保持する列を追加する。既存行は全てNULL(通常の新規Session作成)。

ALTER TABLE "formation_shadow_checkpoints" ADD COLUMN "attach_to_session_id" TEXT;
