-- M1-B6C-1: Formation Shadow Reconciliation/Checkpoint
-- 出典: Claude向け ISMAY c503e72以降 M1-B6C・全残件連続実装指示(2026-08-31)
-- §3 Gate M1-B6C-1。

CREATE TABLE "formation_shadow_checkpoints" (
    "id"                TEXT NOT NULL,
    "workspace_id"      TEXT NOT NULL,
    "capture_id"        TEXT NOT NULL,
    "ai_run_id"         TEXT NOT NULL,
    "status"            TEXT NOT NULL DEFAULT 'PENDING',
    "attempt"           INTEGER NOT NULL DEFAULT 0,
    "max_attempts"      INTEGER NOT NULL DEFAULT 5,
    "next_run_at"       TIMESTAMP(3),
    "last_error_code"   TEXT,
    "last_error_digest" TEXT,
    "request_hash"      TEXT NOT NULL,
    "completed_at"      TIMESTAMP(3),
    "created_at"        TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at"        TIMESTAMP(3) NOT NULL,

    CONSTRAINT "formation_shadow_checkpoints_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "formation_shadow_checkpoints_ai_run_uq"
  ON "formation_shadow_checkpoints"("workspace_id", "ai_run_id");

CREATE INDEX "formation_shadow_checkpoints_status_next_run_at_idx"
  ON "formation_shadow_checkpoints"("status", "next_run_at");

CREATE INDEX "formation_shadow_checkpoints_workspace_id_capture_id_idx"
  ON "formation_shadow_checkpoints"("workspace_id", "capture_id");

ALTER TABLE "formation_shadow_checkpoints" ADD CONSTRAINT "formation_shadow_checkpoints_capture_id_workspace_id_fkey"
  FOREIGN KEY ("capture_id", "workspace_id") REFERENCES "captures"("id", "workspace_id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "formation_shadow_checkpoints" ADD CONSTRAINT "formation_shadow_checkpoints_ai_run_id_fkey"
  FOREIGN KEY ("ai_run_id") REFERENCES "ai_runs"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "formation_shadow_checkpoints" ADD CONSTRAINT "formation_shadow_checkpoints_status_check"
  CHECK ("status" IN ('PENDING', 'RUNNING', 'SUCCEEDED', 'RETRY_WAIT', 'DEAD_LETTER', 'CANCELLED'));

ALTER TABLE "formation_shadow_checkpoints" ADD CONSTRAINT "formation_shadow_checkpoints_attempt_check"
  CHECK ("attempt" >= 0 AND "max_attempts" >= 1 AND "attempt" <= "max_attempts" + 1);
