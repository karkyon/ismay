-- PATTERN-ACTIONSLOT-LEARN-01: split attribution + ActionSlot learn queue
-- 出典: Claude向け_ISMAY_d68e9bf以降_ActionSlot正本準拠・CasePattern実分解
-- 完遂・残工程連続実装指示_2026-09-17.md Gate 5。

-- =====================================================================
-- formation_candidate_decision_events: SPLIT帰属先Pattern列を追加
-- =====================================================================
ALTER TABLE "formation_candidate_decision_events" ADD COLUMN "attributed_case_pattern_id" TEXT;

CREATE INDEX "formation_candidate_decision_events_ws_attributed_pattern_idx"
  ON "formation_candidate_decision_events"("workspace_id", "attributed_case_pattern_id");

ALTER TABLE "formation_candidate_decision_events" ADD CONSTRAINT "formation_candidate_decision_events_attributed_pattern_fkey"
  FOREIGN KEY ("attributed_case_pattern_id", "workspace_id") REFERENCES "case_patterns"("id", "workspace_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- =====================================================================
-- case_pattern_action_slot_learn_jobs
-- =====================================================================
CREATE TABLE "case_pattern_action_slot_learn_jobs" (
    "id"                  TEXT NOT NULL,
    "workspace_id"        TEXT NOT NULL,
    "pattern_id"          TEXT NOT NULL,
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

    CONSTRAINT "case_pattern_action_slot_learn_jobs_pkey" PRIMARY KEY ("id")
);

-- case_pattern_detect_jobs_active_uqと同じ「PENDING/PROCESSINGはpatternごとに1件まで」。
CREATE UNIQUE INDEX "case_pattern_action_slot_learn_jobs_active_uq"
  ON "case_pattern_action_slot_learn_jobs"("workspace_id", "pattern_id")
  WHERE "status" IN ('PENDING', 'PROCESSING');

CREATE INDEX "case_pattern_action_slot_learn_jobs_status_next_attempt_idx"
  ON "case_pattern_action_slot_learn_jobs"("status", "next_attempt_at");

CREATE INDEX "case_pattern_action_slot_learn_jobs_ws_pattern_status_idx"
  ON "case_pattern_action_slot_learn_jobs"("workspace_id", "pattern_id", "status");

ALTER TABLE "case_pattern_action_slot_learn_jobs" ADD CONSTRAINT "case_pattern_action_slot_learn_jobs_workspace_id_fkey"
  FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "case_pattern_action_slot_learn_jobs" ADD CONSTRAINT "case_pattern_action_slot_learn_jobs_pattern_id_fkey"
  FOREIGN KEY ("pattern_id", "workspace_id") REFERENCES "case_patterns"("id", "workspace_id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "case_pattern_action_slot_learn_jobs" ADD CONSTRAINT "case_pattern_action_slot_learn_jobs_status_check"
  CHECK ("status" IN ('PENDING', 'PROCESSING', 'DONE', 'FAILED', 'DEAD_LETTER'));

-- 本Gateで配線する唯一のreason。MANUAL_REBUILD等はGate 10で追加する。
ALTER TABLE "case_pattern_action_slot_learn_jobs" ADD CONSTRAINT "case_pattern_action_slot_learn_jobs_reason_code_check"
  CHECK ("reason_code" IN ('SPLIT_ATTRIBUTED'));
