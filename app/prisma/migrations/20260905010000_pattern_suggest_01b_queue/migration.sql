-- Gate PATTERN-SUGGEST-01B: Case Pattern Suggest Job queue
-- 出典: Claude向け_ISMAY_3b695d9以降_再監査是正・CasePattern実機能完遂指示_
-- 2026-09-04.md §6 PATTERN-SUGGEST-01B。
-- case_pattern_detect_jobs(20260903050000)と同一の状態機械設計(lease/
-- generation/backoff/dead-letter)を、FormationCandidateIdentity単位の
-- Suggestion生成queue向けに再実装したもの。

CREATE TABLE "case_pattern_suggest_jobs" (
    "id"                  TEXT NOT NULL,
    "workspace_id"        TEXT NOT NULL,
    "owner_subject_user_id" TEXT NOT NULL,
    "candidate_id"        TEXT NOT NULL,
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

    CONSTRAINT "case_pattern_suggest_jobs_pkey" PRIMARY KEY ("id")
);

-- case_pattern_detect_jobs_active_uqと同じ「PENDING/PROCESSINGはcandidateごとに1件まで」。
CREATE UNIQUE INDEX "case_pattern_suggest_jobs_active_uq"
  ON "case_pattern_suggest_jobs"("workspace_id", "candidate_id")
  WHERE "status" IN ('PENDING', 'PROCESSING');

CREATE INDEX "case_pattern_suggest_jobs_status_next_attempt_at_idx"
  ON "case_pattern_suggest_jobs"("status", "next_attempt_at");

CREATE INDEX "case_pattern_suggest_jobs_workspace_id_candidate_id_status_idx"
  ON "case_pattern_suggest_jobs"("workspace_id", "candidate_id", "status");

ALTER TABLE "case_pattern_suggest_jobs" ADD CONSTRAINT "case_pattern_suggest_jobs_workspace_id_fkey"
  FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "case_pattern_suggest_jobs" ADD CONSTRAINT "case_pattern_suggest_jobs_owner_subject_user_id_fkey"
  FOREIGN KEY ("owner_subject_user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "case_pattern_suggest_jobs" ADD CONSTRAINT "case_pattern_suggest_jobs_candidate_id_workspace_id_fkey"
  FOREIGN KEY ("candidate_id", "workspace_id") REFERENCES "formation_candidate_identities"("id", "workspace_id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "case_pattern_suggest_jobs" ADD CONSTRAINT "case_pattern_suggest_jobs_status_check"
  CHECK ("status" IN ('PENDING', 'PROCESSING', 'DONE', 'FAILED', 'DEAD_LETTER'));

ALTER TABLE "case_pattern_suggest_jobs" ADD CONSTRAINT "case_pattern_suggest_jobs_reason_code_check"
  CHECK ("reason_code" IN ('CANDIDATE_REVISION_CREATED'));
