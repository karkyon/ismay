-- Gate PATTERN-SUGGEST-01A: Suggestion identity/revision schema
-- 出典: Claude向け_ISMAY_3b695d9以降_再監査是正・CasePattern実機能完遂指示_
-- 2026-09-04.md §5。
--
-- [前提] case_pattern_feedback_eventsテーブルは、CasePatternFeedbackEvent.create
-- を呼ぶproduction経路がこれまで一度も存在しなかったため、全環境で0行である
-- ことを2026-09-04時点のコード監査で確認済み(想像ではなく、grepによる
-- 呼出し元0件の確認に基づく)。そのためNOT NULL列の追加をbackfillなしで
-- 直接行う。

-- 1. Suggestion identity(1 Candidateにつき1件)
CREATE TABLE "case_pattern_suggestion_identities" (
    "id"                    TEXT NOT NULL,
    "workspace_id"          TEXT NOT NULL,
    "owner_subject_user_id" TEXT NOT NULL,
    "formation_session_id"  TEXT NOT NULL,
    "candidate_id"          TEXT NOT NULL,
    "suggestion_key"        TEXT NOT NULL,
    "current_revision"      INTEGER NOT NULL DEFAULT 0,
    "state"                 TEXT NOT NULL DEFAULT 'PENDING',
    "created_at"            TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at"            TIMESTAMP(3) NOT NULL,

    CONSTRAINT "case_pattern_suggestion_identities_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "case_pattern_suggestion_identities_candidate_uq"
  ON "case_pattern_suggestion_identities"("workspace_id", "formation_session_id", "candidate_id");

CREATE UNIQUE INDEX "case_pattern_suggestion_identities_id_workspace_uq"
  ON "case_pattern_suggestion_identities"("id", "workspace_id");

CREATE INDEX "case_pattern_suggestion_identities_workspace_id_owner_subject_"
  ON "case_pattern_suggestion_identities"("workspace_id", "owner_subject_user_id", "state");

ALTER TABLE "case_pattern_suggestion_identities" ADD CONSTRAINT "case_pattern_suggestion_identities_workspace_id_fkey"
  FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "case_pattern_suggestion_identities" ADD CONSTRAINT "case_pattern_suggestion_identities_owner_subject_user_id_fkey"
  FOREIGN KEY ("owner_subject_user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "case_pattern_suggestion_identities" ADD CONSTRAINT "case_pattern_suggestion_identities_session_ws_fkey"
  FOREIGN KEY ("formation_session_id", "workspace_id") REFERENCES "formation_sessions"("id", "workspace_id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "case_pattern_suggestion_identities" ADD CONSTRAINT "case_pattern_suggestion_identities_candidate_ws_fkey"
  FOREIGN KEY ("candidate_id", "workspace_id") REFERENCES "formation_candidate_identities"("id", "workspace_id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "case_pattern_suggestion_identities" ADD CONSTRAINT "case_pattern_suggestion_identities_state_check"
  CHECK ("state" IN ('PENDING', 'ACCEPT', 'PARTIAL_ACCEPT', 'REJECT', 'LATER', 'NOT_RELEVANT'));

-- 2. Suggestion revision(immutable、revision単調増加)
CREATE TABLE "case_pattern_suggestion_revisions" (
    "id"                            TEXT NOT NULL,
    "workspace_id"                  TEXT NOT NULL,
    "suggestion_id"                 TEXT NOT NULL,
    "revision"                      INTEGER NOT NULL,
    "candidate_id"                  TEXT NOT NULL,
    "source_candidate_revision_id"  TEXT NOT NULL,
    "matched_pattern_id"            TEXT,
    "matched_pattern_revision_id"   TEXT,
    "match_policy_version"          TEXT NOT NULL,
    "similarity"                    DECIMAL(6,5) NOT NULL,
    "decomposition_proposal"        JSONB NOT NULL,
    "evidence_snapshot"             JSONB NOT NULL,
    "schema_version"                TEXT NOT NULL,
    "created_at"                    TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "case_pattern_suggestion_revisions_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "case_pattern_suggestion_revisions_suggestion_revision_uq"
  ON "case_pattern_suggestion_revisions"("suggestion_id", "revision");

CREATE UNIQUE INDEX "case_pattern_suggestion_revisions_id_workspace_uq"
  ON "case_pattern_suggestion_revisions"("id", "workspace_id");

CREATE UNIQUE INDEX "case_pattern_suggestion_revisions_id_suggestion_ws_uq"
  ON "case_pattern_suggestion_revisions"("id", "suggestion_id", "workspace_id");

ALTER TABLE "case_pattern_suggestion_revisions" ADD CONSTRAINT "case_pattern_suggestion_revisions_suggestion_ws_fkey"
  FOREIGN KEY ("suggestion_id", "workspace_id") REFERENCES "case_pattern_suggestion_identities"("id", "workspace_id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "case_pattern_suggestion_revisions" ADD CONSTRAINT "case_pattern_suggestion_revisions_candidate_rev_fkey"
  FOREIGN KEY ("source_candidate_revision_id", "candidate_id", "workspace_id") REFERENCES "formation_candidate_revisions"("id", "candidate_id", "workspace_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- matched_pattern_id/matched_pattern_revision_idはoptional(未来のNO_MATCH系
-- outcome向けに列は用意するが、本Gateではmatched時のみ値を入れる想定)。
-- 部分外部キー(NULLは常に許可され、値が入っている場合のみ整合性を検証する
-- PostgreSQLの標準MATCH SIMPLE挙動)を利用する。
ALTER TABLE "case_pattern_suggestion_revisions" ADD CONSTRAINT "case_pattern_suggestion_revisions_matched_pattern_rev_fkey"
  FOREIGN KEY ("matched_pattern_revision_id", "matched_pattern_id", "workspace_id") REFERENCES "case_pattern_revisions"("id", "pattern_id", "workspace_id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "case_pattern_suggestion_revisions" ADD CONSTRAINT "case_pattern_suggestion_revisions_matched_pair_check"
  CHECK (
    ("matched_pattern_id" IS NULL AND "matched_pattern_revision_id" IS NULL)
    OR
    ("matched_pattern_id" IS NOT NULL AND "matched_pattern_revision_id" IS NOT NULL)
  );

-- 3. case_pattern_feedback_events: suggestion_idへ正式なFKを張り、
--    suggestion_revision_id/idempotency_key/request_payload_hash/
--    supersedes_feedback_event_idを追加する。
ALTER TABLE "case_pattern_feedback_events" ADD COLUMN "suggestion_revision_id" TEXT;
ALTER TABLE "case_pattern_feedback_events" ADD COLUMN "idempotency_key" TEXT;
ALTER TABLE "case_pattern_feedback_events" ADD COLUMN "request_payload_hash" TEXT;
ALTER TABLE "case_pattern_feedback_events" ADD COLUMN "supersedes_feedback_event_id" TEXT;

-- 既存行が無いことを前提にNOT NULLへ昇格する(冒頭の前提を参照)。
-- もし何らかの理由で既存行が存在する場合、このUPDATE文が0件を対象とする
-- ことをもって前提の再確認とする(0件超ならこのmigration自体を停止すべき
-- 状況のため、DO blockでcountを検証してから昇格する)。
DO $$
DECLARE
  existing_count INTEGER;
BEGIN
  SELECT COUNT(*) INTO existing_count FROM "case_pattern_feedback_events";
  IF existing_count > 0 THEN
    RAISE EXCEPTION 'case_pattern_feedback_events has % existing row(s); this migration assumes the table is empty (no production write path has ever existed). Manual backfill required before proceeding.', existing_count;
  END IF;
END $$;

ALTER TABLE "case_pattern_feedback_events" ALTER COLUMN "suggestion_revision_id" SET NOT NULL;
ALTER TABLE "case_pattern_feedback_events" ALTER COLUMN "idempotency_key" SET NOT NULL;
ALTER TABLE "case_pattern_feedback_events" ALTER COLUMN "request_payload_hash" SET NOT NULL;

CREATE UNIQUE INDEX "case_pattern_feedback_events_idempotency_uq"
  ON "case_pattern_feedback_events"("workspace_id", "idempotency_key");

CREATE INDEX "case_pattern_feedback_events_workspace_id_suggestion_id_idx"
  ON "case_pattern_feedback_events"("workspace_id", "suggestion_id");

CREATE INDEX "case_pattern_feedback_events_suggestion_revision_id_idx"
  ON "case_pattern_feedback_events"("suggestion_revision_id");

ALTER TABLE "case_pattern_feedback_events" ADD CONSTRAINT "case_pattern_feedback_events_suggestion_ws_fkey"
  FOREIGN KEY ("suggestion_id", "workspace_id") REFERENCES "case_pattern_suggestion_identities"("id", "workspace_id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "case_pattern_feedback_events" ADD CONSTRAINT "case_pattern_feedback_events_suggestion_rev_fkey"
  FOREIGN KEY ("suggestion_revision_id", "suggestion_id", "workspace_id") REFERENCES "case_pattern_suggestion_revisions"("id", "suggestion_id", "workspace_id") ON DELETE RESTRICT ON UPDATE CASCADE;
