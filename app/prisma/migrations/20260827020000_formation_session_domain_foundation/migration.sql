-- V5-M1-B1 Formation Session Domain基盤
-- 出典: ISMAY-V5-DOC-03(Formation Session仕様書) 3章・4章・5章・6章、
--       ISMAY-V5-DOC-10(DB物理設計書) 3.1節・5章・6章、
--       ISMAY-V5-DOC-02(用語・状態・EventCode定義書) 6章・7.3節。
-- 範囲: 10テーブル新設(expand-only)。既存Capture/AiInferenceフローへの
-- 挙動変更は無い(DOC-03 10章「M1-B1はshadow Session生成のみ」のDB基盤部分)。
-- 本ファイルはPrisma engineが本サンドボックスで取得不能なため手動で作成した
-- (project_context_domain_foundation migrationと同じ事情。omega-dev2側で
-- `prisma migrate diff`等による突合を推奨する)。

-- =====================================================================
-- 0. 既存テーブルへの追加制約(このGateで必要な最小変更のみ)
-- =====================================================================

-- FormationSession/FormationSourceAnchorからCaptureへ複合FK(id, workspace_id)で
-- 参照するため、Capturesに複合uniqueを追加する(現状は単一列PKのみ)。
CREATE UNIQUE INDEX "captures_id_workspace_uq" ON "captures"("id", "workspace_id");

-- =====================================================================
-- 1. formation_sessions
-- =====================================================================
CREATE TABLE "formation_sessions" (
    "id" TEXT NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "domain_id" TEXT NOT NULL,
    "subject_user_id" TEXT NOT NULL,
    "capture_id" TEXT NOT NULL,
    "client_session_key" TEXT NOT NULL,
    "state" TEXT NOT NULL DEFAULT 'DRAFT',
    "version" INTEGER NOT NULL DEFAULT 0,
    "question_count" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "formation_sessions_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "formation_sessions_idempotency_uq" ON "formation_sessions"("workspace_id", "capture_id", "client_session_key");
CREATE UNIQUE INDEX "formation_sessions_id_workspace_uq" ON "formation_sessions"("id", "workspace_id");
CREATE INDEX "formation_sessions_workspace_id_capture_id_idx" ON "formation_sessions"("workspace_id", "capture_id");
CREATE INDEX "formation_sessions_workspace_id_state_idx" ON "formation_sessions"("workspace_id", "state");

ALTER TABLE "formation_sessions" ADD CONSTRAINT "formation_sessions_workspace_id_fkey"
  FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "formation_sessions" ADD CONSTRAINT "formation_sessions_domain_id_workspace_id_fkey"
  FOREIGN KEY ("domain_id", "workspace_id") REFERENCES "domains"("id", "workspace_id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "formation_sessions" ADD CONSTRAINT "formation_sessions_subject_user_id_fkey"
  FOREIGN KEY ("subject_user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "formation_sessions" ADD CONSTRAINT "formation_sessions_capture_id_workspace_id_fkey"
  FOREIGN KEY ("capture_id", "workspace_id") REFERENCES "captures"("id", "workspace_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- [DOC-02 6章] FormationSession状態の許容値をDB制約でも保証する。
ALTER TABLE "formation_sessions" ADD CONSTRAINT "formation_sessions_state_check"
  CHECK ("state" IN ('DRAFT', 'ANALYZING', 'CLARIFYING', 'REVIEW_READY', 'PARTIALLY_CONFIRMED', 'CONFIRMED', 'DISMISSED', 'DEFERRED', 'FAILED'));
-- [DOC-03 3章Guard「questionCount<=3」]
ALTER TABLE "formation_sessions" ADD CONSTRAINT "formation_sessions_question_count_check"
  CHECK ("question_count" >= 0 AND "question_count" <= 3);

-- =====================================================================
-- 2. formation_session_events(append-only、Session全体timeline)
-- =====================================================================
CREATE TABLE "formation_session_events" (
    "id" TEXT NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "session_id" TEXT NOT NULL,
    "sequence" INTEGER NOT NULL,
    "event_type" TEXT NOT NULL,
    "actor_type" TEXT NOT NULL,
    "actor_user_id" TEXT,
    "payload" JSONB NOT NULL,
    "occurred_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "formation_session_events_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "formation_session_events_session_sequence_uq" ON "formation_session_events"("session_id", "sequence");
CREATE INDEX "formation_session_events_workspace_id_session_id_idx" ON "formation_session_events"("workspace_id", "session_id");

ALTER TABLE "formation_session_events" ADD CONSTRAINT "formation_session_events_session_id_workspace_id_fkey"
  FOREIGN KEY ("session_id", "workspace_id") REFERENCES "formation_sessions"("id", "workspace_id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "formation_session_events" ADD CONSTRAINT "formation_session_events_actor_user_id_fkey"
  FOREIGN KEY ("actor_user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "formation_session_events" ADD CONSTRAINT "formation_session_events_sequence_positive_check"
  CHECK ("sequence" > 0);
ALTER TABLE "formation_session_events" ADD CONSTRAINT "formation_session_events_event_type_check"
  CHECK ("event_type" IN (
    'FORMATION_CREATED', 'ANALYSIS_REQUESTED', 'ANALYSIS_SUCCEEDED', 'ANALYSIS_FAILED',
    'CANDIDATE_CREATED', 'CANDIDATE_REVISED', 'SOURCE_ANCHOR_ATTACHED', 'QUESTION_ASKED',
    'ANSWER_RECORDED', 'CANDIDATE_ACCEPTED', 'CANDIDATE_REJECTED', 'CANDIDATE_DEFERRED',
    'MATERIALIZATION_COMMITTED', 'SESSION_CONFIRMED', 'SESSION_DISMISSED', 'SESSION_DEFERRED'
  ));
-- [DOC-10 6章]「actorTypeとactor IDの排他」: actorType=USERの場合のみactor_user_idを必須とする。
ALTER TABLE "formation_session_events" ADD CONSTRAINT "formation_session_events_actor_exclusivity_check"
  CHECK (
    ("actor_type" = 'USER' AND "actor_user_id" IS NOT NULL) OR
    ("actor_type" <> 'USER' AND "actor_user_id" IS NULL)
  );

-- =====================================================================
-- 3. formation_candidate_identities(Session内安定ID)
-- =====================================================================
CREATE TABLE "formation_candidate_identities" (
    "id" TEXT NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "session_id" TEXT NOT NULL,
    "candidate_key" TEXT NOT NULL,
    "current_revision" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "formation_candidate_identities_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "formation_candidate_identities_session_key_uq" ON "formation_candidate_identities"("session_id", "candidate_key");
CREATE UNIQUE INDEX "formation_candidate_identities_id_workspace_uq" ON "formation_candidate_identities"("id", "workspace_id");

ALTER TABLE "formation_candidate_identities" ADD CONSTRAINT "formation_candidate_identities_session_id_workspace_id_fkey"
  FOREIGN KEY ("session_id", "workspace_id") REFERENCES "formation_sessions"("id", "workspace_id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "formation_candidate_identities" ADD CONSTRAINT "formation_candidate_identities_current_revision_check"
  CHECK ("current_revision" >= 0);

-- =====================================================================
-- 4. formation_candidate_revisions(immutable、revision単調増加)
-- =====================================================================
CREATE TABLE "formation_candidate_revisions" (
    "id" TEXT NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "candidate_id" TEXT NOT NULL,
    "revision" INTEGER NOT NULL,
    "type" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT,
    "proposed_fields" JSONB NOT NULL,
    "confidence" DECIMAL(5,4) NOT NULL,
    "schema_version" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "formation_candidate_revisions_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "formation_candidate_revisions_candidate_revision_uq" ON "formation_candidate_revisions"("candidate_id", "revision");
CREATE UNIQUE INDEX "formation_candidate_revisions_id_workspace_uq" ON "formation_candidate_revisions"("id", "workspace_id");

ALTER TABLE "formation_candidate_revisions" ADD CONSTRAINT "formation_candidate_revisions_candidate_id_workspace_id_fkey"
  FOREIGN KEY ("candidate_id", "workspace_id") REFERENCES "formation_candidate_identities"("id", "workspace_id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "formation_candidate_revisions" ADD CONSTRAINT "formation_candidate_revisions_revision_positive_check"
  CHECK ("revision" > 0);
-- [DOC-10 4章] Confidence numeric(5,4), 0<=x<=1。
ALTER TABLE "formation_candidate_revisions" ADD CONSTRAINT "formation_candidate_revisions_confidence_range_check"
  CHECK ("confidence" >= 0 AND "confidence" <= 1);
-- [既存Responsibility.typeと同じ9種別]
ALTER TABLE "formation_candidate_revisions" ADD CONSTRAINT "formation_candidate_revisions_type_check"
  CHECK ("type" IN ('TASK', 'COMMITMENT', 'DECISION', 'WAITING', 'EVENT', 'RISK', 'CONCERN', 'HABIT', 'IDEA'));

-- =====================================================================
-- 5. formation_source_anchors(原文位置根拠)
-- =====================================================================
CREATE TABLE "formation_source_anchors" (
    "id" TEXT NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "revision_id" TEXT NOT NULL,
    "source_kind" TEXT NOT NULL,
    "capture_id" TEXT NOT NULL,
    "start_offset" INTEGER,
    "end_offset" INTEGER,
    "image_region" JSONB,
    "excerpt_hash" TEXT NOT NULL,
    "pii_classification" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "formation_source_anchors_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "formation_source_anchors_workspace_id_revision_id_idx" ON "formation_source_anchors"("workspace_id", "revision_id");

ALTER TABLE "formation_source_anchors" ADD CONSTRAINT "formation_source_anchors_revision_id_workspace_id_fkey"
  FOREIGN KEY ("revision_id", "workspace_id") REFERENCES "formation_candidate_revisions"("id", "workspace_id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "formation_source_anchors" ADD CONSTRAINT "formation_source_anchors_capture_id_workspace_id_fkey"
  FOREIGN KEY ("capture_id", "workspace_id") REFERENCES "captures"("id", "workspace_id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "formation_source_anchors" ADD CONSTRAINT "formation_source_anchors_source_kind_check"
  CHECK ("source_kind" IN ('TEXT_OFFSET', 'AUDIO_TIMECODE', 'MEETING_SPEAKER', 'IMAGE_BBOX'));
-- [DOC-10 6章]「Source Anchor text offsetは0<=start<end<=sourceLength」のうち
-- DB CHECKで保証できる範囲(sourceLengthはCapture側の値のためapplication層で追加検証する)。
-- 両方null(text offset不使用)か、両方非nullで0<=start<endのいずれかのみ許可する。
ALTER TABLE "formation_source_anchors" ADD CONSTRAINT "formation_source_anchors_text_offset_check"
  CHECK (
    ("start_offset" IS NULL AND "end_offset" IS NULL) OR
    ("start_offset" IS NOT NULL AND "end_offset" IS NOT NULL AND "start_offset" >= 0 AND "end_offset" > "start_offset")
  );

-- =====================================================================
-- 6. formation_questions(最大3件、ordinal 1..3)
-- =====================================================================
CREATE TABLE "formation_questions" (
    "id" TEXT NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "session_id" TEXT NOT NULL,
    "candidate_id" TEXT,
    "ordinal" INTEGER NOT NULL,
    "question_code" TEXT NOT NULL,
    "prompt_version" TEXT NOT NULL,
    "asked_event_id" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "formation_questions_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "formation_questions_session_ordinal_uq" ON "formation_questions"("session_id", "ordinal");
CREATE UNIQUE INDEX "formation_questions_id_workspace_uq" ON "formation_questions"("id", "workspace_id");

ALTER TABLE "formation_questions" ADD CONSTRAINT "formation_questions_session_id_workspace_id_fkey"
  FOREIGN KEY ("session_id", "workspace_id") REFERENCES "formation_sessions"("id", "workspace_id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "formation_questions" ADD CONSTRAINT "formation_questions_candidate_id_workspace_id_fkey"
  FOREIGN KEY ("candidate_id", "workspace_id") REFERENCES "formation_candidate_identities"("id", "workspace_id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "formation_questions" ADD CONSTRAINT "formation_questions_asked_event_id_fkey"
  FOREIGN KEY ("asked_event_id") REFERENCES "formation_session_events"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- [DOC-03 3章Guard「questionCount<=3」、EV-F-002「4問目拒否」]
ALTER TABLE "formation_questions" ADD CONSTRAINT "formation_questions_ordinal_check"
  CHECK ("ordinal" >= 1 AND "ordinal" <= 3);

-- =====================================================================
-- 7. formation_answer_events(append-only、訂正はrevisionOf)
-- =====================================================================
CREATE TABLE "formation_answer_events" (
    "id" TEXT NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "question_id" TEXT NOT NULL,
    "answer_kind" TEXT NOT NULL,
    "value_json" JSONB,
    "actor_user_id" TEXT NOT NULL,
    "occurred_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "revision_of_id" TEXT,

    CONSTRAINT "formation_answer_events_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "formation_answer_events_workspace_id_question_id_idx" ON "formation_answer_events"("workspace_id", "question_id");

ALTER TABLE "formation_answer_events" ADD CONSTRAINT "formation_answer_events_question_id_workspace_id_fkey"
  FOREIGN KEY ("question_id", "workspace_id") REFERENCES "formation_questions"("id", "workspace_id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "formation_answer_events" ADD CONSTRAINT "formation_answer_events_actor_user_id_fkey"
  FOREIGN KEY ("actor_user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "formation_answer_events" ADD CONSTRAINT "formation_answer_events_revision_of_id_fkey"
  FOREIGN KEY ("revision_of_id") REFERENCES "formation_answer_events"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "formation_answer_events" ADD CONSTRAINT "formation_answer_events_answer_kind_check"
  CHECK ("answer_kind" IN ('ANSWERED', 'UNKNOWN', 'DEFERRED', 'DO_NOT_MATERIALIZE'));

-- =====================================================================
-- 8. formation_candidate_decision_events
-- =====================================================================
CREATE TABLE "formation_candidate_decision_events" (
    "id" TEXT NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "candidate_id" TEXT NOT NULL,
    "revision_id" TEXT NOT NULL,
    "decision" TEXT NOT NULL,
    "reason_code" TEXT,
    "actor_user_id" TEXT NOT NULL,
    "occurred_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "formation_candidate_decision_events_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "formation_candidate_decision_events_workspace_id_candidate_id_idx" ON "formation_candidate_decision_events"("workspace_id", "candidate_id");

ALTER TABLE "formation_candidate_decision_events" ADD CONSTRAINT "formation_candidate_decision_events_candidate_id_workspace_id_fkey"
  FOREIGN KEY ("candidate_id", "workspace_id") REFERENCES "formation_candidate_identities"("id", "workspace_id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "formation_candidate_decision_events" ADD CONSTRAINT "formation_candidate_decision_events_revision_id_workspace_id_fkey"
  FOREIGN KEY ("revision_id", "workspace_id") REFERENCES "formation_candidate_revisions"("id", "workspace_id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "formation_candidate_decision_events" ADD CONSTRAINT "formation_candidate_decision_events_actor_user_id_fkey"
  FOREIGN KEY ("actor_user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- [DOC-02 6章CandidateDecisionのうちPENDINGを除く4値。PENDINGは既定Projection値でEvent化しない]
ALTER TABLE "formation_candidate_decision_events" ADD CONSTRAINT "formation_candidate_decision_events_decision_check"
  CHECK ("decision" IN ('ACCEPTED', 'REJECTED', 'DEFERRED', 'DO_NOT_MATERIALIZE'));

-- =====================================================================
-- 9. materialization_receipts
-- =====================================================================
CREATE TABLE "materialization_receipts" (
    "id" TEXT NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "session_id" TEXT NOT NULL,
    "operation_id" TEXT NOT NULL,
    "request_hash" TEXT NOT NULL,
    "committed_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "materialization_receipts_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "materialization_receipts_operation_uq" ON "materialization_receipts"("workspace_id", "operation_id");
CREATE UNIQUE INDEX "materialization_receipts_id_workspace_uq" ON "materialization_receipts"("id", "workspace_id");

ALTER TABLE "materialization_receipts" ADD CONSTRAINT "materialization_receipts_session_id_workspace_id_fkey"
  FOREIGN KEY ("session_id", "workspace_id") REFERENCES "formation_sessions"("id", "workspace_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- =====================================================================
-- 10. materialization_receipt_items(1候補1生成)
-- =====================================================================
CREATE TABLE "materialization_receipt_items" (
    "id" TEXT NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "receipt_id" TEXT NOT NULL,
    "candidate_id" TEXT NOT NULL,
    "candidate_revision_id" TEXT NOT NULL,
    "responsibility_id" TEXT NOT NULL,

    CONSTRAINT "materialization_receipt_items_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "materialization_receipt_items_receipt_candidate_uq" ON "materialization_receipt_items"("receipt_id", "candidate_id");

ALTER TABLE "materialization_receipt_items" ADD CONSTRAINT "materialization_receipt_items_receipt_id_workspace_id_fkey"
  FOREIGN KEY ("receipt_id", "workspace_id") REFERENCES "materialization_receipts"("id", "workspace_id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "materialization_receipt_items" ADD CONSTRAINT "materialization_receipt_items_candidate_id_workspace_id_fkey"
  FOREIGN KEY ("candidate_id", "workspace_id") REFERENCES "formation_candidate_identities"("id", "workspace_id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "materialization_receipt_items" ADD CONSTRAINT "materialization_receipt_items_candidate_revision_id_workspace_id_fkey"
  FOREIGN KEY ("candidate_revision_id", "workspace_id") REFERENCES "formation_candidate_revisions"("id", "workspace_id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "materialization_receipt_items" ADD CONSTRAINT "materialization_receipt_items_responsibility_id_workspace_id_fkey"
  FOREIGN KEY ("responsibility_id", "workspace_id") REFERENCES "responsibilities"("id", "workspace_id") ON DELETE RESTRICT ON UPDATE CASCADE;
