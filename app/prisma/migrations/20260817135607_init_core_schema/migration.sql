/*
  Warnings:

  - You are about to drop the `HealthCheck` table. If the table is not empty, all the data it contains will be lost.

*/
-- CreateExtension
CREATE EXTENSION IF NOT EXISTS "vector";

-- DropTable
DROP TABLE "HealthCheck";

-- CreateTable
CREATE TABLE "users" (
    "id" UUID NOT NULL,
    "email" VARCHAR(320) NOT NULL,
    "status" VARCHAR(24) NOT NULL,
    "locale" VARCHAR(16) NOT NULL,
    "timezone" VARCHAR(64) NOT NULL,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,
    "deleted_at" TIMESTAMPTZ,

    CONSTRAINT "users_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "workspaces" (
    "id" UUID NOT NULL,
    "owner_id" UUID NOT NULL,
    "name" VARCHAR(200) NOT NULL,
    "plan" VARCHAR(32) NOT NULL,
    "data_region" VARCHAR(16) NOT NULL,
    "status" VARCHAR(24) NOT NULL,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,
    "deleted_at" TIMESTAMPTZ,

    CONSTRAINT "workspaces_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "workspace_members" (
    "id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "role" VARCHAR(32) NOT NULL,
    "joined_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "removed_at" TIMESTAMPTZ,

    CONSTRAINT "workspace_members_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "domains" (
    "id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "name" VARCHAR(200) NOT NULL,
    "visibility" VARCHAR(24) NOT NULL,
    "ai_access_policy" VARCHAR(32) NOT NULL,
    "integration_policy" VARCHAR(32) NOT NULL,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,
    "deleted_at" TIMESTAMPTZ,

    CONSTRAINT "domains_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "captures" (
    "id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "domain_id" UUID,
    "created_by" UUID NOT NULL,
    "source_type" VARCHAR(24) NOT NULL,
    "raw_text" TEXT,
    "audio_object_key" TEXT,
    "language" VARCHAR(16) NOT NULL,
    "processing_status" VARCHAR(24) NOT NULL,
    "source_captured_at" TIMESTAMPTZ,
    "consent_id" UUID,
    "version" INTEGER NOT NULL DEFAULT 1,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,
    "deleted_at" TIMESTAMPTZ,

    CONSTRAINT "captures_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "responsibilities" (
    "id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "domain_id" UUID NOT NULL,
    "origin_capture_id" UUID,
    "type" VARCHAR(24) NOT NULL,
    "title" VARCHAR(300) NOT NULL,
    "description" TEXT,
    "status" VARCHAR(32) NOT NULL,
    "importance" SMALLINT,
    "confidence" DECIMAL(4,3),
    "source_kind" VARCHAR(16) NOT NULL,
    "hard_deadline_at" TIMESTAMPTZ,
    "target_at" TIMESTAMPTZ,
    "start_after_at" TIMESTAMPTZ,
    "completed_at" TIMESTAMPTZ,
    "version" INTEGER NOT NULL DEFAULT 1,
    "created_by" UUID NOT NULL,
    "updated_by" UUID NOT NULL,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,
    "deleted_at" TIMESTAMPTZ,

    CONSTRAINT "responsibilities_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "task_details" (
    "responsibility_id" UUID NOT NULL,
    "effort_min" INTEGER,
    "effort_max" INTEGER,
    "cognitive_load" VARCHAR(16),

    CONSTRAINT "task_details_pkey" PRIMARY KEY ("responsibility_id")
);

-- CreateTable
CREATE TABLE "commitment_details" (
    "responsibility_id" UUID NOT NULL,
    "promiser" VARCHAR(200),
    "promisee" VARCHAR(200),
    "fulfillment_condition" TEXT,

    CONSTRAINT "commitment_details_pkey" PRIMARY KEY ("responsibility_id")
);

-- CreateTable
CREATE TABLE "decision_details" (
    "responsibility_id" UUID NOT NULL,
    "decision_question" TEXT,
    "criteria" JSONB,
    "decision_due_at" TIMESTAMPTZ,
    "outcome" VARCHAR(500),

    CONSTRAINT "decision_details_pkey" PRIMARY KEY ("responsibility_id")
);

-- CreateTable
CREATE TABLE "waiting_details" (
    "responsibility_id" UUID NOT NULL,
    "waiting_for" VARCHAR(300),
    "follow_up_at" TIMESTAMPTZ,
    "resolved_at" TIMESTAMPTZ,

    CONSTRAINT "waiting_details_pkey" PRIMARY KEY ("responsibility_id")
);

-- CreateTable
CREATE TABLE "constraints" (
    "id" UUID NOT NULL,
    "responsibility_id" UUID NOT NULL,
    "constraint_type" VARCHAR(32) NOT NULL,
    "value" JSONB NOT NULL,
    "hardness" VARCHAR(16) NOT NULL,
    "valid_from" TIMESTAMPTZ,
    "valid_to" TIMESTAMPTZ,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "constraints_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "responsibility_relations" (
    "id" UUID NOT NULL,
    "from_id" UUID NOT NULL,
    "to_id" UUID NOT NULL,
    "relation_type" VARCHAR(24) NOT NULL,
    "status" VARCHAR(16) NOT NULL,
    "confidence" DECIMAL(4,3),
    "source_kind" VARCHAR(16),
    "source_ref" UUID,
    "confirmed_by" UUID,
    "confirmed_at" TIMESTAMPTZ,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "deleted_at" TIMESTAMPTZ,

    CONSTRAINT "responsibility_relations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "event_logs" (
    "id" UUID NOT NULL,
    "aggregate_type" VARCHAR(64) NOT NULL,
    "aggregate_id" UUID NOT NULL,
    "event_type" VARCHAR(64) NOT NULL,
    "before_json" JSONB,
    "after_json" JSONB,
    "actor_type" VARCHAR(16) NOT NULL,
    "actor_id" UUID,
    "reason" VARCHAR(500),
    "correlation_id" UUID NOT NULL,
    "occurred_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "event_logs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ai_inferences" (
    "id" UUID NOT NULL,
    "capture_id" UUID NOT NULL,
    "ai_run_id" UUID NOT NULL,
    "inference_type" VARCHAR(32) NOT NULL,
    "payload" JSONB NOT NULL,
    "evidence_spans" JSONB NOT NULL,
    "confidence" DECIMAL(4,3) NOT NULL,
    "decision" VARCHAR(16) NOT NULL,
    "decided_by" UUID,
    "decided_at" TIMESTAMPTZ,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ai_inferences_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ai_runs" (
    "id" UUID NOT NULL,
    "provider" VARCHAR(64) NOT NULL,
    "model_version" VARCHAR(64) NOT NULL,
    "prompt_version" VARCHAR(64) NOT NULL,
    "schema_version" VARCHAR(64) NOT NULL,
    "purpose" VARCHAR(64) NOT NULL,
    "input_tokens" INTEGER,
    "output_tokens" INTEGER,
    "cost_micros" BIGINT,
    "latency_ms" INTEGER,
    "status" VARCHAR(16) NOT NULL,
    "error_code" VARCHAR(64),
    "correlation_id" UUID NOT NULL,
    "started_at" TIMESTAMPTZ NOT NULL,
    "completed_at" TIMESTAMPTZ,

    CONSTRAINT "ai_runs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "pem_observations" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "observation_type" VARCHAR(32) NOT NULL,
    "sample_window_from" TIMESTAMPTZ NOT NULL,
    "sample_window_to" TIMESTAMPTZ NOT NULL,
    "sample_size" INTEGER NOT NULL,
    "value" JSONB NOT NULL,
    "source_refs" JSONB NOT NULL,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "deleted_at" TIMESTAMPTZ,

    CONSTRAINT "pem_observations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "pem_hypotheses" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "statement" VARCHAR(500) NOT NULL,
    "sample_size" INTEGER NOT NULL,
    "window_from" TIMESTAMPTZ NOT NULL,
    "window_to" TIMESTAMPTZ NOT NULL,
    "confidence" DECIMAL(4,3) NOT NULL,
    "valid_until" TIMESTAMPTZ NOT NULL,
    "user_verdict" VARCHAR(16),
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "deleted_at" TIMESTAMPTZ,

    CONSTRAINT "pem_hypotheses_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "pem_evidence_links" (
    "id" UUID NOT NULL,
    "pem_observation_id" UUID,
    "pem_hypothesis_id" UUID,
    "evidence_id" UUID NOT NULL,

    CONSTRAINT "pem_evidence_links_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "evidences" (
    "id" UUID NOT NULL,
    "responsibility_id" UUID,
    "source_system" VARCHAR(64) NOT NULL,
    "source_ref" VARCHAR(500) NOT NULL,
    "captured_at" TIMESTAMPTZ NOT NULL,
    "hash" VARCHAR(128) NOT NULL,
    "metadata" JSONB,
    "access_policy" VARCHAR(32) NOT NULL,

    CONSTRAINT "evidences_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "recurrence_rules" (
    "id" UUID NOT NULL,
    "responsibility_id" UUID NOT NULL,
    "frequency" VARCHAR(16) NOT NULL,
    "interval" SMALLINT NOT NULL,
    "weekdays" JSONB,
    "exceptions" JSONB,
    "paused_until" TIMESTAMPTZ,
    "carryover_policy" VARCHAR(16) NOT NULL,
    "last_generated_at" TIMESTAMPTZ,
    "version" INTEGER NOT NULL DEFAULT 1,

    CONSTRAINT "recurrence_rules_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "notifications" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "type" VARCHAR(32) NOT NULL,
    "channel" VARCHAR(16) NOT NULL,
    "scheduled_at" TIMESTAMPTZ,
    "sent_at" TIMESTAMPTZ,
    "read_at" TIMESTAMPTZ,
    "dedupe_key" VARCHAR(200) NOT NULL,

    CONSTRAINT "notifications_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "consents" (
    "id" UUID NOT NULL,
    "capture_id" UUID,
    "subject_id" UUID NOT NULL,
    "purpose" VARCHAR(64) NOT NULL,
    "scope" JSONB NOT NULL,
    "granted_at" TIMESTAMPTZ NOT NULL,
    "expires_at" TIMESTAMPTZ,
    "withdrawn_at" TIMESTAMPTZ,

    CONSTRAINT "consents_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "integrations" (
    "id" UUID NOT NULL,
    "provider" VARCHAR(64) NOT NULL,
    "scopes" JSONB NOT NULL,
    "domain_policy" VARCHAR(32) NOT NULL,
    "token_ref" VARCHAR(200) NOT NULL,
    "status" VARCHAR(16) NOT NULL,
    "last_used_at" TIMESTAMPTZ,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "integrations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "audit_logs" (
    "id" UUID NOT NULL,
    "actor_type" VARCHAR(16) NOT NULL,
    "actor_id" UUID,
    "action" VARCHAR(64) NOT NULL,
    "target" VARCHAR(200) NOT NULL,
    "reason" VARCHAR(500),
    "result" VARCHAR(16) NOT NULL,
    "ip" VARCHAR(64),
    "user_agent" VARCHAR(300),
    "occurred_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "audit_logs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "outbox_events" (
    "id" UUID NOT NULL,
    "event_name" VARCHAR(64) NOT NULL,
    "event_version" INTEGER NOT NULL,
    "aggregate_type" VARCHAR(64) NOT NULL,
    "aggregate_id" UUID NOT NULL,
    "payload" JSONB NOT NULL,
    "correlation_id" UUID NOT NULL,
    "causation_id" UUID,
    "status" VARCHAR(16) NOT NULL,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "available_at" TIMESTAMPTZ NOT NULL,
    "delivered_at" TIMESTAMPTZ,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "outbox_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "jobs" (
    "id" UUID NOT NULL,
    "job_type" VARCHAR(64) NOT NULL,
    "aggregate_id" UUID NOT NULL,
    "source_version" INTEGER NOT NULL,
    "status" VARCHAR(16) NOT NULL,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "max_attempts" INTEGER NOT NULL DEFAULT 5,
    "next_retry_at" TIMESTAMPTZ,
    "last_error" TEXT,
    "payload" JSONB NOT NULL,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completed_at" TIMESTAMPTZ,

    CONSTRAINT "jobs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "responsibility_embeddings" (
    "responsibility_id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "domain_id" UUID NOT NULL,
    "model_version" VARCHAR(64) NOT NULL,
    "search_document" TEXT NOT NULL,
    "embedding" vector(1536) NOT NULL,
    "updated_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "responsibility_embeddings_pkey" PRIMARY KEY ("responsibility_id")
);

-- CreateIndex
CREATE UNIQUE INDEX "users_email_key" ON "users"("email");

-- CreateIndex
CREATE INDEX "workspaces_owner_id_idx" ON "workspaces"("owner_id");

-- CreateIndex
CREATE UNIQUE INDEX "workspace_members_workspace_id_user_id_key" ON "workspace_members"("workspace_id", "user_id");

-- CreateIndex
CREATE INDEX "domains_workspace_id_idx" ON "domains"("workspace_id");

-- CreateIndex
CREATE INDEX "captures_workspace_id_created_at_idx" ON "captures"("workspace_id", "created_at" DESC);

-- CreateIndex
CREATE INDEX "captures_processing_status_updated_at_idx" ON "captures"("processing_status", "updated_at");

-- CreateIndex
CREATE INDEX "responsibilities_workspace_id_domain_id_deleted_at_idx" ON "responsibilities"("workspace_id", "domain_id", "deleted_at");

-- CreateIndex
CREATE INDEX "constraints_responsibility_id_idx" ON "constraints"("responsibility_id");

-- CreateIndex
CREATE UNIQUE INDEX "responsibility_relations_from_id_to_id_relation_type_key" ON "responsibility_relations"("from_id", "to_id", "relation_type");

-- CreateIndex
CREATE INDEX "event_logs_aggregate_type_aggregate_id_occurred_at_idx" ON "event_logs"("aggregate_type", "aggregate_id", "occurred_at");

-- CreateIndex
CREATE INDEX "event_logs_correlation_id_idx" ON "event_logs"("correlation_id");

-- CreateIndex
CREATE INDEX "ai_inferences_capture_id_idx" ON "ai_inferences"("capture_id");

-- CreateIndex
CREATE INDEX "ai_runs_model_version_started_at_idx" ON "ai_runs"("model_version", "started_at");

-- CreateIndex
CREATE INDEX "pem_observations_user_id_idx" ON "pem_observations"("user_id");

-- CreateIndex
CREATE INDEX "pem_hypotheses_user_id_idx" ON "pem_hypotheses"("user_id");

-- CreateIndex
CREATE UNIQUE INDEX "recurrence_rules_responsibility_id_key" ON "recurrence_rules"("responsibility_id");

-- CreateIndex
CREATE INDEX "notifications_user_id_scheduled_at_idx" ON "notifications"("user_id", "scheduled_at");

-- CreateIndex
CREATE UNIQUE INDEX "notifications_dedupe_key_key" ON "notifications"("dedupe_key");

-- CreateIndex
CREATE INDEX "audit_logs_occurred_at_idx" ON "audit_logs"("occurred_at");

-- CreateIndex
CREATE INDEX "outbox_events_status_available_at_idx" ON "outbox_events"("status", "available_at");

-- CreateIndex
CREATE INDEX "jobs_status_next_retry_at_idx" ON "jobs"("status", "next_retry_at");

-- CreateIndex
CREATE UNIQUE INDEX "jobs_job_type_aggregate_id_source_version_key" ON "jobs"("job_type", "aggregate_id", "source_version");

-- CreateIndex
CREATE INDEX "responsibility_embeddings_workspace_id_domain_id_idx" ON "responsibility_embeddings"("workspace_id", "domain_id");

-- AddForeignKey
ALTER TABLE "workspaces" ADD CONSTRAINT "workspaces_owner_id_fkey" FOREIGN KEY ("owner_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "workspace_members" ADD CONSTRAINT "workspace_members_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "workspace_members" ADD CONSTRAINT "workspace_members_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "domains" ADD CONSTRAINT "domains_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "captures" ADD CONSTRAINT "captures_domain_id_fkey" FOREIGN KEY ("domain_id") REFERENCES "domains"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "captures" ADD CONSTRAINT "captures_consent_id_fkey" FOREIGN KEY ("consent_id") REFERENCES "consents"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "responsibilities" ADD CONSTRAINT "responsibilities_origin_capture_id_fkey" FOREIGN KEY ("origin_capture_id") REFERENCES "captures"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "responsibilities" ADD CONSTRAINT "responsibilities_domain_id_fkey" FOREIGN KEY ("domain_id") REFERENCES "domains"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "task_details" ADD CONSTRAINT "task_details_responsibility_id_fkey" FOREIGN KEY ("responsibility_id") REFERENCES "responsibilities"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "commitment_details" ADD CONSTRAINT "commitment_details_responsibility_id_fkey" FOREIGN KEY ("responsibility_id") REFERENCES "responsibilities"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "decision_details" ADD CONSTRAINT "decision_details_responsibility_id_fkey" FOREIGN KEY ("responsibility_id") REFERENCES "responsibilities"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "waiting_details" ADD CONSTRAINT "waiting_details_responsibility_id_fkey" FOREIGN KEY ("responsibility_id") REFERENCES "responsibilities"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "constraints" ADD CONSTRAINT "constraints_responsibility_id_fkey" FOREIGN KEY ("responsibility_id") REFERENCES "responsibilities"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "responsibility_relations" ADD CONSTRAINT "responsibility_relations_from_id_fkey" FOREIGN KEY ("from_id") REFERENCES "responsibilities"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "responsibility_relations" ADD CONSTRAINT "responsibility_relations_to_id_fkey" FOREIGN KEY ("to_id") REFERENCES "responsibilities"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ai_inferences" ADD CONSTRAINT "ai_inferences_capture_id_fkey" FOREIGN KEY ("capture_id") REFERENCES "captures"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ai_inferences" ADD CONSTRAINT "ai_inferences_ai_run_id_fkey" FOREIGN KEY ("ai_run_id") REFERENCES "ai_runs"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "pem_observations" ADD CONSTRAINT "pem_observations_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "pem_hypotheses" ADD CONSTRAINT "pem_hypotheses_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "pem_evidence_links" ADD CONSTRAINT "pem_evidence_links_pem_observation_id_fkey" FOREIGN KEY ("pem_observation_id") REFERENCES "pem_observations"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "pem_evidence_links" ADD CONSTRAINT "pem_evidence_links_pem_hypothesis_id_fkey" FOREIGN KEY ("pem_hypothesis_id") REFERENCES "pem_hypotheses"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "pem_evidence_links" ADD CONSTRAINT "pem_evidence_links_evidence_id_fkey" FOREIGN KEY ("evidence_id") REFERENCES "evidences"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "evidences" ADD CONSTRAINT "evidences_responsibility_id_fkey" FOREIGN KEY ("responsibility_id") REFERENCES "responsibilities"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "recurrence_rules" ADD CONSTRAINT "recurrence_rules_responsibility_id_fkey" FOREIGN KEY ("responsibility_id") REFERENCES "responsibilities"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "consents" ADD CONSTRAINT "consents_subject_id_fkey" FOREIGN KEY ("subject_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "responsibility_embeddings" ADD CONSTRAINT "responsibility_embeddings_responsibility_id_fkey" FOREIGN KEY ("responsibility_id") REFERENCES "responsibilities"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
