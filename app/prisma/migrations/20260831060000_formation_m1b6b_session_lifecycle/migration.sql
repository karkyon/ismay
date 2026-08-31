-- M1-B6B: Session Lifecycle(defer/dismiss/resume/retry)
-- 出典: Claude向け ISMAY 69b5a87以降 監査是正・M1-B6完遂・PEM-0連続実装指示
--       (2026-08-31) Gate M1-B6B。

-- 1) formation_session_events.event_type CHECKへSESSION_RESUMED/SESSION_RETRIEDを追加
--    (18値->20値。既存行は変更しない=expand+switch、履歴改変しない)。
ALTER TABLE "formation_session_events"
  DROP CONSTRAINT "formation_session_events_event_type_check";

ALTER TABLE "formation_session_events" ADD CONSTRAINT "formation_session_events_event_type_check"
  CHECK ("event_type" IN (
    'FORMATION_CREATED', 'ANALYSIS_REQUESTED', 'ANALYSIS_SUCCEEDED', 'ANALYSIS_FAILED',
    'CANDIDATE_CREATED', 'CANDIDATE_REVISED', 'SOURCE_ANCHOR_ATTACHED', 'QUESTION_ASKED',
    'ANSWER_RECORDED', 'CANDIDATE_ACCEPTED', 'CANDIDATE_REJECTED', 'CANDIDATE_DEFERRED',
    'CANDIDATE_SPLIT', 'CANDIDATE_MERGED',
    'MATERIALIZATION_COMMITTED', 'SESSION_CONFIRMED', 'SESSION_DISMISSED', 'SESSION_DEFERRED',
    'SESSION_RESUMED', 'SESSION_RETRIED'
  ));

-- 2) formation_session_lifecycle_events(defer/dismiss/resume/retryのidempotency
--    記録・append-only audit trail)。
CREATE TABLE "formation_session_lifecycle_events" (
    "id" TEXT NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "session_id" TEXT NOT NULL,
    "client_event_id" TEXT NOT NULL,
    "request_hash" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "from_state" TEXT NOT NULL,
    "to_state" TEXT NOT NULL,
    "reason_code" TEXT,
    "actor_user_id" TEXT NOT NULL,
    "occurred_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "formation_session_lifecycle_events_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "formation_session_lifecycle_events_workspace_client_uq"
  ON "formation_session_lifecycle_events"("workspace_id", "client_event_id");

CREATE INDEX "formation_session_lifecycle_events_workspace_id_session_id_ac_idx"
  ON "formation_session_lifecycle_events"("workspace_id", "session_id", "action", "occurred_at");

ALTER TABLE "formation_session_lifecycle_events" ADD CONSTRAINT "formation_session_lifecycle_events_session_id_workspace_id_fkey"
  FOREIGN KEY ("session_id", "workspace_id") REFERENCES "formation_sessions"("id", "workspace_id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "formation_session_lifecycle_events" ADD CONSTRAINT "formation_session_lifecycle_events_actor_user_id_fkey"
  FOREIGN KEY ("actor_user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "formation_session_lifecycle_events" ADD CONSTRAINT "formation_session_lifecycle_events_action_check"
  CHECK ("action" IN ('DEFER', 'DISMISS', 'RESUME', 'RETRY'));

ALTER TABLE "formation_session_lifecycle_events" ADD CONSTRAINT "formation_session_lifecycle_events_from_state_check"
  CHECK ("from_state" IN ('DRAFT', 'ANALYZING', 'CLARIFYING', 'REVIEW_READY', 'PARTIALLY_CONFIRMED', 'CONFIRMED', 'DISMISSED', 'DEFERRED', 'FAILED'));

ALTER TABLE "formation_session_lifecycle_events" ADD CONSTRAINT "formation_session_lifecycle_events_to_state_check"
  CHECK ("to_state" IN ('DRAFT', 'ANALYZING', 'CLARIFYING', 'REVIEW_READY', 'PARTIALLY_CONFIRMED', 'CONFIRMED', 'DISMISSED', 'DEFERRED', 'FAILED'));
