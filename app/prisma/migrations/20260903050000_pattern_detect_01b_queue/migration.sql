-- Gate PATTERN-DETECT-01B: Case Pattern Detect Queue
-- 出典: Claude向け_ISMAY_0fcea2b以降_再監査是正・PATTERN-DETECT連続実装指示_2026-09-03.md
-- §6 PATTERN-DETECT-01B。ProjectionRecomputeJob(pem_recompute_queue Gate)と
-- 同じ設計(lease/generation/backoff/dead-letter)を、Case Pattern検出の単位
-- (workspaceId, ownerSubjectUserId)向けに再実装したqueueテーブル。

CREATE TABLE "case_pattern_detect_jobs" (
    "id"                  TEXT NOT NULL,
    "workspace_id"        TEXT NOT NULL,
    "owner_subject_user_id" TEXT NOT NULL,
    "status"              TEXT NOT NULL DEFAULT 'PENDING',
    "generation"          INTEGER NOT NULL DEFAULT 1,
    "attempt"             INTEGER NOT NULL DEFAULT 0,
    "max_attempts"        INTEGER NOT NULL DEFAULT 8,
    "lease_owner"         TEXT,
    "lease_expires_at"    TIMESTAMP(3),
    "next_attempt_at"     TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "reason_code"         TEXT NOT NULL,
    "last_error_code"     TEXT,
    "last_error_digest"   TEXT,
    "completed_at"        TIMESTAMP(3),
    "created_at"          TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at"          TIMESTAMP(3) NOT NULL,

    CONSTRAINT "case_pattern_detect_jobs_pkey" PRIMARY KEY ("id")
);

-- 正本§22.3と同じ「PENDING/PROCESSINGだけを対象とする部分一意制約」
-- (recomputeQueue.tsのcoalescing前提と同一設計)。
CREATE UNIQUE INDEX "case_pattern_detect_jobs_active_uq"
  ON "case_pattern_detect_jobs"("workspace_id", "owner_subject_user_id")
  WHERE "status" IN ('PENDING', 'PROCESSING');

CREATE INDEX "case_pattern_detect_jobs_status_next_attempt_at_idx"
  ON "case_pattern_detect_jobs"("status", "next_attempt_at");

CREATE INDEX "case_pattern_detect_jobs_workspace_id_owner_subject_user_id_st"
  ON "case_pattern_detect_jobs"("workspace_id", "owner_subject_user_id", "status");

ALTER TABLE "case_pattern_detect_jobs" ADD CONSTRAINT "case_pattern_detect_jobs_workspace_id_fkey"
  FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "case_pattern_detect_jobs" ADD CONSTRAINT "case_pattern_detect_jobs_owner_subject_user_id_fkey"
  FOREIGN KEY ("owner_subject_user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "case_pattern_detect_jobs" ADD CONSTRAINT "case_pattern_detect_jobs_status_check"
  CHECK ("status" IN ('PENDING', 'PROCESSING', 'DONE', 'FAILED', 'DEAD_LETTER'));

ALTER TABLE "case_pattern_detect_jobs" ADD CONSTRAINT "case_pattern_detect_jobs_reason_code_check"
  CHECK ("reason_code" IN ('PRIMARY_LINKED', 'PRIMARY_UNLINKED'));
