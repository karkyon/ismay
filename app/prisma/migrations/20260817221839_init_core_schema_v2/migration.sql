/*
  Warnings:

  - The primary key for the `ai_inferences` table will be changed. If it partially fails, the table could be left without primary key constraint.
  - The primary key for the `ai_runs` table will be changed. If it partially fails, the table could be left without primary key constraint.
  - You are about to drop the column `completed_at` on the `ai_runs` table. All the data in the column will be lost.
  - You are about to drop the column `correlation_id` on the `ai_runs` table. All the data in the column will be lost.
  - You are about to drop the column `model_version` on the `ai_runs` table. All the data in the column will be lost.
  - You are about to drop the column `purpose` on the `ai_runs` table. All the data in the column will be lost.
  - The primary key for the `audit_logs` table will be changed. If it partially fails, the table could be left without primary key constraint.
  - You are about to drop the column `actor_id` on the `audit_logs` table. All the data in the column will be lost.
  - You are about to drop the column `ip` on the `audit_logs` table. All the data in the column will be lost.
  - You are about to drop the column `target` on the `audit_logs` table. All the data in the column will be lost.
  - You are about to drop the column `user_agent` on the `audit_logs` table. All the data in the column will be lost.
  - The primary key for the `captures` table will be changed. If it partially fails, the table could be left without primary key constraint.
  - The primary key for the `commitment_details` table will be changed. If it partially fails, the table could be left without primary key constraint.
  - You are about to drop the column `fulfillment_condition` on the `commitment_details` table. All the data in the column will be lost.
  - You are about to drop the column `promisee` on the `commitment_details` table. All the data in the column will be lost.
  - You are about to drop the column `promiser` on the `commitment_details` table. All the data in the column will be lost.
  - The primary key for the `consents` table will be changed. If it partially fails, the table could be left without primary key constraint.
  - The primary key for the `constraints` table will be changed. If it partially fails, the table could be left without primary key constraint.
  - You are about to drop the column `hardness` on the `constraints` table. All the data in the column will be lost.
  - You are about to drop the column `valid_from` on the `constraints` table. All the data in the column will be lost.
  - You are about to drop the column `valid_to` on the `constraints` table. All the data in the column will be lost.
  - The primary key for the `decision_details` table will be changed. If it partially fails, the table could be left without primary key constraint.
  - You are about to drop the column `criteria` on the `decision_details` table. All the data in the column will be lost.
  - You are about to drop the column `decision_due_at` on the `decision_details` table. All the data in the column will be lost.
  - You are about to drop the column `decision_question` on the `decision_details` table. All the data in the column will be lost.
  - You are about to drop the column `outcome` on the `decision_details` table. All the data in the column will be lost.
  - The primary key for the `domains` table will be changed. If it partially fails, the table could be left without primary key constraint.
  - You are about to drop the column `ai_access_policy` on the `domains` table. All the data in the column will be lost.
  - You are about to drop the column `integration_policy` on the `domains` table. All the data in the column will be lost.
  - You are about to drop the column `visibility` on the `domains` table. All the data in the column will be lost.
  - The primary key for the `event_logs` table will be changed. If it partially fails, the table could be left without primary key constraint.
  - The primary key for the `evidences` table will be changed. If it partially fails, the table could be left without primary key constraint.
  - You are about to drop the column `access_policy` on the `evidences` table. All the data in the column will be lost.
  - You are about to drop the column `hash` on the `evidences` table. All the data in the column will be lost.
  - You are about to drop the column `metadata` on the `evidences` table. All the data in the column will be lost.
  - You are about to drop the column `source_system` on the `evidences` table. All the data in the column will be lost.
  - The primary key for the `integrations` table will be changed. If it partially fails, the table could be left without primary key constraint.
  - You are about to drop the column `created_at` on the `integrations` table. All the data in the column will be lost.
  - You are about to drop the column `domain_policy` on the `integrations` table. All the data in the column will be lost.
  - You are about to drop the column `last_used_at` on the `integrations` table. All the data in the column will be lost.
  - You are about to drop the column `scopes` on the `integrations` table. All the data in the column will be lost.
  - You are about to drop the column `token_ref` on the `integrations` table. All the data in the column will be lost.
  - The primary key for the `jobs` table will be changed. If it partially fails, the table could be left without primary key constraint.
  - You are about to drop the column `completed_at` on the `jobs` table. All the data in the column will be lost.
  - You are about to drop the column `next_retry_at` on the `jobs` table. All the data in the column will be lost.
  - The primary key for the `notifications` table will be changed. If it partially fails, the table could be left without primary key constraint.
  - The primary key for the `outbox_events` table will be changed. If it partially fails, the table could be left without primary key constraint.
  - You are about to drop the column `aggregate_type` on the `outbox_events` table. All the data in the column will be lost.
  - You are about to drop the column `attempts` on the `outbox_events` table. All the data in the column will be lost.
  - You are about to drop the column `available_at` on the `outbox_events` table. All the data in the column will be lost.
  - You are about to drop the column `delivered_at` on the `outbox_events` table. All the data in the column will be lost.
  - The primary key for the `pem_evidence_links` table will be changed. If it partially fails, the table could be left without primary key constraint.
  - The primary key for the `pem_hypotheses` table will be changed. If it partially fails, the table could be left without primary key constraint.
  - The primary key for the `pem_observations` table will be changed. If it partially fails, the table could be left without primary key constraint.
  - You are about to drop the column `sample_size` on the `pem_observations` table. All the data in the column will be lost.
  - You are about to drop the column `sample_window_from` on the `pem_observations` table. All the data in the column will be lost.
  - You are about to drop the column `sample_window_to` on the `pem_observations` table. All the data in the column will be lost.
  - You are about to drop the column `source_refs` on the `pem_observations` table. All the data in the column will be lost.
  - You are about to drop the column `value` on the `pem_observations` table. All the data in the column will be lost.
  - The primary key for the `recurrence_rules` table will be changed. If it partially fails, the table could be left without primary key constraint.
  - The primary key for the `responsibilities` table will be changed. If it partially fails, the table could be left without primary key constraint.
  - The primary key for the `responsibility_embeddings` table will be changed. If it partially fails, the table could be left without primary key constraint.
  - You are about to drop the column `search_document` on the `responsibility_embeddings` table. All the data in the column will be lost.
  - The primary key for the `responsibility_relations` table will be changed. If it partially fails, the table could be left without primary key constraint.
  - The primary key for the `task_details` table will be changed. If it partially fails, the table could be left without primary key constraint.
  - You are about to drop the column `cognitive_load` on the `task_details` table. All the data in the column will be lost.
  - You are about to drop the column `effort_max` on the `task_details` table. All the data in the column will be lost.
  - You are about to drop the column `effort_min` on the `task_details` table. All the data in the column will be lost.
  - The primary key for the `users` table will be changed. If it partially fails, the table could be left without primary key constraint.
  - You are about to drop the column `timezone` on the `users` table. All the data in the column will be lost.
  - The primary key for the `waiting_details` table will be changed. If it partially fails, the table could be left without primary key constraint.
  - You are about to drop the column `resolved_at` on the `waiting_details` table. All the data in the column will be lost.
  - You are about to drop the column `waiting_for` on the `waiting_details` table. All the data in the column will be lost.
  - The primary key for the `workspace_members` table will be changed. If it partially fails, the table could be left without primary key constraint.
  - You are about to drop the column `removed_at` on the `workspace_members` table. All the data in the column will be lost.
  - The primary key for the `workspaces` table will be changed. If it partially fails, the table could be left without primary key constraint.
  - You are about to drop the column `data_region` on the `workspaces` table. All the data in the column will be lost.
  - You are about to drop the column `owner_id` on the `workspaces` table. All the data in the column will be lost.
  - You are about to drop the column `plan` on the `workspaces` table. All the data in the column will be lost.
  - You are about to drop the column `status` on the `workspaces` table. All the data in the column will be lost.
  - Added the required column `model` to the `ai_runs` table without a default value. This is not possible if the table is not empty.
  - Added the required column `target_type` to the `audit_logs` table without a default value. This is not possible if the table is not empty.
  - Added the required column `source_type` to the `evidences` table without a default value. This is not possible if the table is not empty.
  - Added the required column `scope` to the `integrations` table without a default value. This is not possible if the table is not empty.
  - Added the required column `workspace_id` to the `integrations` table without a default value. This is not possible if the table is not empty.
  - Added the required column `updated_at` to the `jobs` table without a default value. This is not possible if the table is not empty.
  - Added the required column `payload` to the `notifications` table without a default value. This is not possible if the table is not empty.
  - Made the column `scheduled_at` on table `notifications` required. This step will fail if there are existing NULL values in that column.
  - Added the required column `aggregate_version` to the `outbox_events` table without a default value. This is not possible if the table is not empty.
  - Added the required column `updated_at` to the `pem_hypotheses` table without a default value. This is not possible if the table is not empty.
  - Made the column `user_verdict` on table `pem_hypotheses` required. This step will fail if there are existing NULL values in that column.
  - Added the required column `payload` to the `pem_observations` table without a default value. This is not possible if the table is not empty.
  - Added the required column `password_hash` to the `users` table without a default value. This is not possible if the table is not empty.

*/
-- DropForeignKey
ALTER TABLE "ai_inferences" DROP CONSTRAINT "ai_inferences_ai_run_id_fkey";

-- DropForeignKey
ALTER TABLE "ai_inferences" DROP CONSTRAINT "ai_inferences_capture_id_fkey";

-- DropForeignKey
ALTER TABLE "captures" DROP CONSTRAINT "captures_consent_id_fkey";

-- DropForeignKey
ALTER TABLE "captures" DROP CONSTRAINT "captures_domain_id_fkey";

-- DropForeignKey
ALTER TABLE "commitment_details" DROP CONSTRAINT "commitment_details_responsibility_id_fkey";

-- DropForeignKey
ALTER TABLE "consents" DROP CONSTRAINT "consents_subject_id_fkey";

-- DropForeignKey
ALTER TABLE "constraints" DROP CONSTRAINT "constraints_responsibility_id_fkey";

-- DropForeignKey
ALTER TABLE "decision_details" DROP CONSTRAINT "decision_details_responsibility_id_fkey";

-- DropForeignKey
ALTER TABLE "domains" DROP CONSTRAINT "domains_workspace_id_fkey";

-- DropForeignKey
ALTER TABLE "evidences" DROP CONSTRAINT "evidences_responsibility_id_fkey";

-- DropForeignKey
ALTER TABLE "notifications" DROP CONSTRAINT "notifications_user_id_fkey";

-- DropForeignKey
ALTER TABLE "pem_evidence_links" DROP CONSTRAINT "pem_evidence_links_evidence_id_fkey";

-- DropForeignKey
ALTER TABLE "pem_evidence_links" DROP CONSTRAINT "pem_evidence_links_pem_hypothesis_id_fkey";

-- DropForeignKey
ALTER TABLE "pem_evidence_links" DROP CONSTRAINT "pem_evidence_links_pem_observation_id_fkey";

-- DropForeignKey
ALTER TABLE "pem_hypotheses" DROP CONSTRAINT "pem_hypotheses_user_id_fkey";

-- DropForeignKey
ALTER TABLE "pem_observations" DROP CONSTRAINT "pem_observations_user_id_fkey";

-- DropForeignKey
ALTER TABLE "recurrence_rules" DROP CONSTRAINT "recurrence_rules_responsibility_id_fkey";

-- DropForeignKey
ALTER TABLE "responsibilities" DROP CONSTRAINT "responsibilities_domain_id_fkey";

-- DropForeignKey
ALTER TABLE "responsibilities" DROP CONSTRAINT "responsibilities_origin_capture_id_fkey";

-- DropForeignKey
ALTER TABLE "responsibility_embeddings" DROP CONSTRAINT "responsibility_embeddings_responsibility_id_fkey";

-- DropForeignKey
ALTER TABLE "responsibility_relations" DROP CONSTRAINT "responsibility_relations_from_id_fkey";

-- DropForeignKey
ALTER TABLE "responsibility_relations" DROP CONSTRAINT "responsibility_relations_to_id_fkey";

-- DropForeignKey
ALTER TABLE "task_details" DROP CONSTRAINT "task_details_responsibility_id_fkey";

-- DropForeignKey
ALTER TABLE "waiting_details" DROP CONSTRAINT "waiting_details_responsibility_id_fkey";

-- DropForeignKey
ALTER TABLE "workspace_members" DROP CONSTRAINT "workspace_members_user_id_fkey";

-- DropForeignKey
ALTER TABLE "workspace_members" DROP CONSTRAINT "workspace_members_workspace_id_fkey";

-- DropForeignKey
ALTER TABLE "workspaces" DROP CONSTRAINT "workspaces_owner_id_fkey";

-- DropIndex
DROP INDEX "ai_inferences_capture_id_idx";

-- DropIndex
DROP INDEX "ai_runs_model_version_started_at_idx";

-- DropIndex
DROP INDEX "audit_logs_occurred_at_idx";

-- DropIndex
DROP INDEX "constraints_responsibility_id_idx";

-- DropIndex
DROP INDEX "domains_workspace_id_idx";

-- DropIndex
DROP INDEX "event_logs_aggregate_type_aggregate_id_occurred_at_idx";

-- DropIndex
DROP INDEX "event_logs_correlation_id_idx";

-- DropIndex
DROP INDEX "jobs_status_next_retry_at_idx";

-- DropIndex
DROP INDEX "notifications_user_id_scheduled_at_idx";

-- DropIndex
DROP INDEX "outbox_events_status_available_at_idx";

-- DropIndex
DROP INDEX "pem_hypotheses_user_id_idx";

-- DropIndex
DROP INDEX "pem_observations_user_id_idx";

-- DropIndex
DROP INDEX "responsibilities_workspace_id_domain_id_deleted_at_idx";

-- DropIndex
DROP INDEX "responsibility_relations_from_id_to_id_relation_type_key";

-- DropIndex
DROP INDEX "workspace_members_workspace_id_user_id_key";

-- DropIndex
DROP INDEX "workspaces_owner_id_idx";

-- AlterTable
ALTER TABLE "ai_inferences" DROP CONSTRAINT "ai_inferences_pkey",
ALTER COLUMN "id" SET DATA TYPE TEXT,
ALTER COLUMN "capture_id" SET DATA TYPE TEXT,
ALTER COLUMN "ai_run_id" SET DATA TYPE TEXT,
ALTER COLUMN "inference_type" SET DATA TYPE TEXT,
ALTER COLUMN "decision" SET DEFAULT 'PENDING',
ALTER COLUMN "decision" SET DATA TYPE TEXT,
ALTER COLUMN "decided_by" SET DATA TYPE TEXT,
ALTER COLUMN "decided_at" SET DATA TYPE TIMESTAMP(3),
ALTER COLUMN "created_at" SET DATA TYPE TIMESTAMP(3),
ADD CONSTRAINT "ai_inferences_pkey" PRIMARY KEY ("id");

-- AlterTable
ALTER TABLE "ai_runs" DROP CONSTRAINT "ai_runs_pkey",
DROP COLUMN "completed_at",
DROP COLUMN "correlation_id",
DROP COLUMN "model_version",
DROP COLUMN "purpose",
ADD COLUMN     "capture_id" TEXT,
ADD COLUMN     "finished_at" TIMESTAMP(3),
ADD COLUMN     "model" TEXT NOT NULL,
ALTER COLUMN "id" SET DATA TYPE TEXT,
ALTER COLUMN "provider" SET DATA TYPE TEXT,
ALTER COLUMN "prompt_version" SET DATA TYPE TEXT,
ALTER COLUMN "schema_version" SET DATA TYPE TEXT,
ALTER COLUMN "status" SET DEFAULT 'PENDING',
ALTER COLUMN "status" SET DATA TYPE TEXT,
ALTER COLUMN "error_code" SET DATA TYPE TEXT,
ALTER COLUMN "started_at" SET DEFAULT CURRENT_TIMESTAMP,
ALTER COLUMN "started_at" SET DATA TYPE TIMESTAMP(3),
ADD CONSTRAINT "ai_runs_pkey" PRIMARY KEY ("id");

-- AlterTable
ALTER TABLE "audit_logs" DROP CONSTRAINT "audit_logs_pkey",
DROP COLUMN "actor_id",
DROP COLUMN "ip",
DROP COLUMN "target",
DROP COLUMN "user_agent",
ADD COLUMN     "actor_user_id" TEXT,
ADD COLUMN     "ip_address" TEXT,
ADD COLUMN     "target_id" TEXT,
ADD COLUMN     "target_type" TEXT NOT NULL,
ALTER COLUMN "id" SET DATA TYPE TEXT,
ALTER COLUMN "actor_type" SET DATA TYPE TEXT,
ALTER COLUMN "action" SET DATA TYPE TEXT,
ALTER COLUMN "reason" SET DATA TYPE TEXT,
ALTER COLUMN "result" SET DATA TYPE TEXT,
ALTER COLUMN "occurred_at" SET DATA TYPE TIMESTAMP(3),
ADD CONSTRAINT "audit_logs_pkey" PRIMARY KEY ("id");

-- AlterTable
ALTER TABLE "captures" DROP CONSTRAINT "captures_pkey",
ALTER COLUMN "id" SET DATA TYPE TEXT,
ALTER COLUMN "workspace_id" SET DATA TYPE TEXT,
ALTER COLUMN "domain_id" SET DATA TYPE TEXT,
ALTER COLUMN "created_by" SET DATA TYPE TEXT,
ALTER COLUMN "source_type" SET DATA TYPE TEXT,
ALTER COLUMN "language" SET DEFAULT 'ja-JP',
ALTER COLUMN "language" SET DATA TYPE TEXT,
ALTER COLUMN "processing_status" SET DEFAULT 'SAVED',
ALTER COLUMN "processing_status" SET DATA TYPE TEXT,
ALTER COLUMN "source_captured_at" SET DATA TYPE TIMESTAMP(3),
ALTER COLUMN "consent_id" SET DATA TYPE TEXT,
ALTER COLUMN "version" SET DEFAULT 0,
ALTER COLUMN "created_at" SET DATA TYPE TIMESTAMP(3),
ALTER COLUMN "updated_at" SET DATA TYPE TIMESTAMP(3),
ALTER COLUMN "deleted_at" SET DATA TYPE TIMESTAMP(3),
ADD CONSTRAINT "captures_pkey" PRIMARY KEY ("id");

-- AlterTable
ALTER TABLE "commitment_details" DROP CONSTRAINT "commitment_details_pkey",
DROP COLUMN "fulfillment_condition",
DROP COLUMN "promisee",
DROP COLUMN "promiser",
ADD COLUMN     "counterparty_contact" TEXT,
ADD COLUMN     "counterparty_name" TEXT,
ADD COLUMN     "promise_text" TEXT,
ALTER COLUMN "responsibility_id" SET DATA TYPE TEXT,
ADD CONSTRAINT "commitment_details_pkey" PRIMARY KEY ("responsibility_id");

-- AlterTable
ALTER TABLE "consents" DROP CONSTRAINT "consents_pkey",
ALTER COLUMN "id" SET DATA TYPE TEXT,
ALTER COLUMN "capture_id" SET DATA TYPE TEXT,
ALTER COLUMN "subject_id" SET DATA TYPE TEXT,
ALTER COLUMN "purpose" SET DATA TYPE TEXT,
ALTER COLUMN "granted_at" SET DEFAULT CURRENT_TIMESTAMP,
ALTER COLUMN "granted_at" SET DATA TYPE TIMESTAMP(3),
ALTER COLUMN "expires_at" SET DATA TYPE TIMESTAMP(3),
ALTER COLUMN "withdrawn_at" SET DATA TYPE TIMESTAMP(3),
ADD CONSTRAINT "consents_pkey" PRIMARY KEY ("id");

-- AlterTable
ALTER TABLE "constraints" DROP CONSTRAINT "constraints_pkey",
DROP COLUMN "hardness",
DROP COLUMN "valid_from",
DROP COLUMN "valid_to",
ADD COLUMN     "note" TEXT,
ALTER COLUMN "id" SET DATA TYPE TEXT,
ALTER COLUMN "responsibility_id" SET DATA TYPE TEXT,
ALTER COLUMN "constraint_type" SET DATA TYPE TEXT,
ALTER COLUMN "created_at" SET DATA TYPE TIMESTAMP(3),
ADD CONSTRAINT "constraints_pkey" PRIMARY KEY ("id");

-- AlterTable
ALTER TABLE "decision_details" DROP CONSTRAINT "decision_details_pkey",
DROP COLUMN "criteria",
DROP COLUMN "decision_due_at",
DROP COLUMN "decision_question",
DROP COLUMN "outcome",
ADD COLUMN     "chosen_option" TEXT,
ADD COLUMN     "decided_at" TIMESTAMP(3),
ADD COLUMN     "options" JSONB,
ADD COLUMN     "rationale" TEXT,
ALTER COLUMN "responsibility_id" SET DATA TYPE TEXT,
ADD CONSTRAINT "decision_details_pkey" PRIMARY KEY ("responsibility_id");

-- AlterTable
ALTER TABLE "domains" DROP CONSTRAINT "domains_pkey",
DROP COLUMN "ai_access_policy",
DROP COLUMN "integration_policy",
DROP COLUMN "visibility",
ADD COLUMN     "ai_policy" JSONB,
ADD COLUMN     "kind" TEXT NOT NULL DEFAULT 'PERSONAL',
ALTER COLUMN "id" SET DATA TYPE TEXT,
ALTER COLUMN "workspace_id" SET DATA TYPE TEXT,
ALTER COLUMN "name" SET DATA TYPE TEXT,
ALTER COLUMN "created_at" SET DATA TYPE TIMESTAMP(3),
ALTER COLUMN "updated_at" SET DATA TYPE TIMESTAMP(3),
ALTER COLUMN "deleted_at" SET DATA TYPE TIMESTAMP(3),
ADD CONSTRAINT "domains_pkey" PRIMARY KEY ("id");

-- AlterTable
ALTER TABLE "event_logs" DROP CONSTRAINT "event_logs_pkey",
ALTER COLUMN "id" SET DATA TYPE TEXT,
ALTER COLUMN "aggregate_type" SET DATA TYPE TEXT,
ALTER COLUMN "aggregate_id" SET DATA TYPE TEXT,
ALTER COLUMN "event_type" SET DATA TYPE TEXT,
ALTER COLUMN "actor_type" SET DATA TYPE TEXT,
ALTER COLUMN "actor_id" SET DATA TYPE TEXT,
ALTER COLUMN "reason" SET DATA TYPE TEXT,
ALTER COLUMN "correlation_id" DROP NOT NULL,
ALTER COLUMN "correlation_id" SET DATA TYPE TEXT,
ALTER COLUMN "occurred_at" SET DATA TYPE TIMESTAMP(3),
ADD CONSTRAINT "event_logs_pkey" PRIMARY KEY ("id");

-- AlterTable
ALTER TABLE "evidences" DROP CONSTRAINT "evidences_pkey",
DROP COLUMN "access_policy",
DROP COLUMN "hash",
DROP COLUMN "metadata",
DROP COLUMN "source_system",
ADD COLUMN     "confidence" DECIMAL(4,3),
ADD COLUMN     "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
ADD COLUMN     "source_type" TEXT NOT NULL,
ADD COLUMN     "status" TEXT NOT NULL DEFAULT 'CANDIDATE',
ALTER COLUMN "id" SET DATA TYPE TEXT,
ALTER COLUMN "responsibility_id" SET DATA TYPE TEXT,
ALTER COLUMN "source_ref" DROP NOT NULL,
ALTER COLUMN "source_ref" SET DATA TYPE TEXT,
ALTER COLUMN "captured_at" DROP NOT NULL,
ALTER COLUMN "captured_at" SET DATA TYPE TIMESTAMP(3),
ADD CONSTRAINT "evidences_pkey" PRIMARY KEY ("id");

-- AlterTable
ALTER TABLE "integrations" DROP CONSTRAINT "integrations_pkey",
DROP COLUMN "created_at",
DROP COLUMN "domain_policy",
DROP COLUMN "last_used_at",
DROP COLUMN "scopes",
DROP COLUMN "token_ref",
ADD COLUMN     "connected_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
ADD COLUMN     "revoked_at" TIMESTAMP(3),
ADD COLUMN     "scope" JSONB NOT NULL,
ADD COLUMN     "workspace_id" TEXT NOT NULL,
ALTER COLUMN "id" SET DATA TYPE TEXT,
ALTER COLUMN "provider" SET DATA TYPE TEXT,
ALTER COLUMN "status" SET DEFAULT 'CONNECTED',
ALTER COLUMN "status" SET DATA TYPE TEXT,
ADD CONSTRAINT "integrations_pkey" PRIMARY KEY ("id");

-- AlterTable
ALTER TABLE "jobs" DROP CONSTRAINT "jobs_pkey",
DROP COLUMN "completed_at",
DROP COLUMN "next_retry_at",
ADD COLUMN     "next_run_at" TIMESTAMP(3),
ADD COLUMN     "updated_at" TIMESTAMP(3) NOT NULL,
ALTER COLUMN "id" SET DATA TYPE TEXT,
ALTER COLUMN "job_type" SET DATA TYPE TEXT,
ALTER COLUMN "aggregate_id" SET DATA TYPE TEXT,
ALTER COLUMN "status" SET DEFAULT 'QUEUED',
ALTER COLUMN "status" SET DATA TYPE TEXT,
ALTER COLUMN "payload" DROP NOT NULL,
ALTER COLUMN "created_at" SET DATA TYPE TIMESTAMP(3),
ADD CONSTRAINT "jobs_pkey" PRIMARY KEY ("id");

-- AlterTable
ALTER TABLE "notifications" DROP CONSTRAINT "notifications_pkey",
ADD COLUMN     "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
ADD COLUMN     "payload" JSONB NOT NULL,
ADD COLUMN     "status" TEXT NOT NULL DEFAULT 'SCHEDULED',
ALTER COLUMN "id" SET DATA TYPE TEXT,
ALTER COLUMN "user_id" SET DATA TYPE TEXT,
ALTER COLUMN "type" SET DATA TYPE TEXT,
ALTER COLUMN "channel" SET DEFAULT 'IN_APP',
ALTER COLUMN "channel" SET DATA TYPE TEXT,
ALTER COLUMN "scheduled_at" SET NOT NULL,
ALTER COLUMN "scheduled_at" SET DATA TYPE TIMESTAMP(3),
ALTER COLUMN "sent_at" SET DATA TYPE TIMESTAMP(3),
ALTER COLUMN "read_at" SET DATA TYPE TIMESTAMP(3),
ALTER COLUMN "dedupe_key" SET DATA TYPE TEXT,
ADD CONSTRAINT "notifications_pkey" PRIMARY KEY ("id");

-- AlterTable
ALTER TABLE "outbox_events" DROP CONSTRAINT "outbox_events_pkey",
DROP COLUMN "aggregate_type",
DROP COLUMN "attempts",
DROP COLUMN "available_at",
DROP COLUMN "delivered_at",
ADD COLUMN     "aggregate_version" INTEGER NOT NULL,
ADD COLUMN     "published_at" TIMESTAMP(3),
ALTER COLUMN "id" SET DATA TYPE TEXT,
ALTER COLUMN "event_name" SET DATA TYPE TEXT,
ALTER COLUMN "event_version" SET DATA TYPE TEXT,
ALTER COLUMN "aggregate_id" SET DATA TYPE TEXT,
ALTER COLUMN "correlation_id" DROP NOT NULL,
ALTER COLUMN "correlation_id" SET DATA TYPE TEXT,
ALTER COLUMN "causation_id" SET DATA TYPE TEXT,
ALTER COLUMN "status" SET DEFAULT 'PENDING',
ALTER COLUMN "status" SET DATA TYPE TEXT,
ALTER COLUMN "created_at" SET DATA TYPE TIMESTAMP(3),
ADD CONSTRAINT "outbox_events_pkey" PRIMARY KEY ("id");

-- AlterTable
ALTER TABLE "pem_evidence_links" DROP CONSTRAINT "pem_evidence_links_pkey",
ADD COLUMN     "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
ALTER COLUMN "id" SET DATA TYPE TEXT,
ALTER COLUMN "pem_observation_id" SET DATA TYPE TEXT,
ALTER COLUMN "pem_hypothesis_id" SET DATA TYPE TEXT,
ALTER COLUMN "evidence_id" SET DATA TYPE TEXT,
ADD CONSTRAINT "pem_evidence_links_pkey" PRIMARY KEY ("id");

-- AlterTable
ALTER TABLE "pem_hypotheses" DROP CONSTRAINT "pem_hypotheses_pkey",
ADD COLUMN     "updated_at" TIMESTAMP(3) NOT NULL,
ALTER COLUMN "id" SET DATA TYPE TEXT,
ALTER COLUMN "user_id" SET DATA TYPE TEXT,
ALTER COLUMN "statement" SET DATA TYPE TEXT,
ALTER COLUMN "window_from" SET DATA TYPE TIMESTAMP(3),
ALTER COLUMN "window_to" SET DATA TYPE TIMESTAMP(3),
ALTER COLUMN "valid_until" DROP NOT NULL,
ALTER COLUMN "valid_until" SET DATA TYPE TIMESTAMP(3),
ALTER COLUMN "user_verdict" SET NOT NULL,
ALTER COLUMN "user_verdict" SET DEFAULT 'PENDING',
ALTER COLUMN "user_verdict" SET DATA TYPE TEXT,
ALTER COLUMN "created_at" SET DATA TYPE TIMESTAMP(3),
ALTER COLUMN "deleted_at" SET DATA TYPE TIMESTAMP(3),
ADD CONSTRAINT "pem_hypotheses_pkey" PRIMARY KEY ("id");

-- AlterTable
ALTER TABLE "pem_observations" DROP CONSTRAINT "pem_observations_pkey",
DROP COLUMN "sample_size",
DROP COLUMN "sample_window_from",
DROP COLUMN "sample_window_to",
DROP COLUMN "source_refs",
DROP COLUMN "value",
ADD COLUMN     "occurred_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
ADD COLUMN     "payload" JSONB NOT NULL,
ADD COLUMN     "valid_until" TIMESTAMP(3),
ALTER COLUMN "id" SET DATA TYPE TEXT,
ALTER COLUMN "user_id" SET DATA TYPE TEXT,
ALTER COLUMN "observation_type" SET DATA TYPE TEXT,
ALTER COLUMN "created_at" SET DATA TYPE TIMESTAMP(3),
ALTER COLUMN "deleted_at" SET DATA TYPE TIMESTAMP(3),
ADD CONSTRAINT "pem_observations_pkey" PRIMARY KEY ("id");

-- AlterTable
ALTER TABLE "recurrence_rules" DROP CONSTRAINT "recurrence_rules_pkey",
ALTER COLUMN "id" SET DATA TYPE TEXT,
ALTER COLUMN "responsibility_id" SET DATA TYPE TEXT,
ALTER COLUMN "frequency" SET DATA TYPE TEXT,
ALTER COLUMN "interval" SET DATA TYPE INTEGER,
ALTER COLUMN "paused_until" SET DATA TYPE TIMESTAMP(3),
ALTER COLUMN "carryover_policy" SET DATA TYPE TEXT,
ALTER COLUMN "last_generated_at" SET DATA TYPE TIMESTAMP(3),
ALTER COLUMN "version" SET DEFAULT 0,
ADD CONSTRAINT "recurrence_rules_pkey" PRIMARY KEY ("id");

-- AlterTable
ALTER TABLE "responsibilities" DROP CONSTRAINT "responsibilities_pkey",
ALTER COLUMN "id" SET DATA TYPE TEXT,
ALTER COLUMN "workspace_id" SET DATA TYPE TEXT,
ALTER COLUMN "domain_id" SET DATA TYPE TEXT,
ALTER COLUMN "origin_capture_id" SET DATA TYPE TEXT,
ALTER COLUMN "type" SET DATA TYPE TEXT,
ALTER COLUMN "title" SET DATA TYPE TEXT,
ALTER COLUMN "status" SET DATA TYPE TEXT,
ALTER COLUMN "importance" SET DATA TYPE INTEGER,
ALTER COLUMN "source_kind" SET DATA TYPE TEXT,
ALTER COLUMN "hard_deadline_at" SET DATA TYPE TIMESTAMP(3),
ALTER COLUMN "target_at" SET DATA TYPE TIMESTAMP(3),
ALTER COLUMN "start_after_at" SET DATA TYPE TIMESTAMP(3),
ALTER COLUMN "completed_at" SET DATA TYPE TIMESTAMP(3),
ALTER COLUMN "version" SET DEFAULT 0,
ALTER COLUMN "created_by" SET DATA TYPE TEXT,
ALTER COLUMN "updated_by" SET DATA TYPE TEXT,
ALTER COLUMN "created_at" SET DATA TYPE TIMESTAMP(3),
ALTER COLUMN "updated_at" SET DATA TYPE TIMESTAMP(3),
ALTER COLUMN "deleted_at" SET DATA TYPE TIMESTAMP(3),
ADD CONSTRAINT "responsibilities_pkey" PRIMARY KEY ("id");

-- AlterTable
ALTER TABLE "responsibility_embeddings" DROP CONSTRAINT "responsibility_embeddings_pkey",
DROP COLUMN "search_document",
ADD COLUMN     "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
ALTER COLUMN "responsibility_id" SET DATA TYPE TEXT,
ALTER COLUMN "workspace_id" SET DATA TYPE TEXT,
ALTER COLUMN "domain_id" SET DATA TYPE TEXT,
ALTER COLUMN "model_version" SET DATA TYPE TEXT,
ALTER COLUMN "updated_at" SET DATA TYPE TIMESTAMP(3),
ADD CONSTRAINT "responsibility_embeddings_pkey" PRIMARY KEY ("responsibility_id");

-- AlterTable
ALTER TABLE "responsibility_relations" DROP CONSTRAINT "responsibility_relations_pkey",
ALTER COLUMN "id" SET DATA TYPE TEXT,
ALTER COLUMN "from_id" SET DATA TYPE TEXT,
ALTER COLUMN "to_id" SET DATA TYPE TEXT,
ALTER COLUMN "relation_type" SET DATA TYPE TEXT,
ALTER COLUMN "status" SET DATA TYPE TEXT,
ALTER COLUMN "source_kind" SET DATA TYPE TEXT,
ALTER COLUMN "source_ref" SET DATA TYPE TEXT,
ALTER COLUMN "confirmed_by" SET DATA TYPE TEXT,
ALTER COLUMN "confirmed_at" SET DATA TYPE TIMESTAMP(3),
ALTER COLUMN "created_at" SET DATA TYPE TIMESTAMP(3),
ALTER COLUMN "deleted_at" SET DATA TYPE TIMESTAMP(3),
ADD CONSTRAINT "responsibility_relations_pkey" PRIMARY KEY ("id");

-- AlterTable
ALTER TABLE "task_details" DROP CONSTRAINT "task_details_pkey",
DROP COLUMN "cognitive_load",
DROP COLUMN "effort_max",
DROP COLUMN "effort_min",
ADD COLUMN     "estimated_minutes_max" INTEGER,
ADD COLUMN     "estimated_minutes_min" INTEGER,
ADD COLUMN     "location" TEXT,
ADD COLUMN     "required_tools" JSONB,
ALTER COLUMN "responsibility_id" SET DATA TYPE TEXT,
ADD CONSTRAINT "task_details_pkey" PRIMARY KEY ("responsibility_id");

-- AlterTable
ALTER TABLE "users" DROP CONSTRAINT "users_pkey",
DROP COLUMN "timezone",
ADD COLUMN     "display_name" TEXT,
ADD COLUMN     "email_verified_at" TIMESTAMP(3),
ADD COLUMN     "password_hash" TEXT NOT NULL,
ADD COLUMN     "time_zone" TEXT NOT NULL DEFAULT 'Asia/Tokyo',
ADD COLUMN     "version" INTEGER NOT NULL DEFAULT 0,
ALTER COLUMN "id" SET DATA TYPE TEXT,
ALTER COLUMN "email" SET DATA TYPE TEXT,
ALTER COLUMN "status" SET DEFAULT 'ACTIVE',
ALTER COLUMN "status" SET DATA TYPE TEXT,
ALTER COLUMN "locale" SET DEFAULT 'ja-JP',
ALTER COLUMN "locale" SET DATA TYPE TEXT,
ALTER COLUMN "created_at" SET DATA TYPE TIMESTAMP(3),
ALTER COLUMN "updated_at" SET DATA TYPE TIMESTAMP(3),
ALTER COLUMN "deleted_at" SET DATA TYPE TIMESTAMP(3),
ADD CONSTRAINT "users_pkey" PRIMARY KEY ("id");

-- AlterTable
ALTER TABLE "waiting_details" DROP CONSTRAINT "waiting_details_pkey",
DROP COLUMN "resolved_at",
DROP COLUMN "waiting_for",
ADD COLUMN     "expected_reply_by" TIMESTAMP(3),
ADD COLUMN     "reminder_sent_at" TIMESTAMP(3),
ADD COLUMN     "waiting_on" TEXT,
ALTER COLUMN "responsibility_id" SET DATA TYPE TEXT,
ALTER COLUMN "follow_up_at" SET DATA TYPE TIMESTAMP(3),
ADD CONSTRAINT "waiting_details_pkey" PRIMARY KEY ("responsibility_id");

-- AlterTable
ALTER TABLE "workspace_members" DROP CONSTRAINT "workspace_members_pkey",
DROP COLUMN "removed_at",
ADD COLUMN     "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
ADD COLUMN     "left_at" TIMESTAMP(3),
ALTER COLUMN "id" SET DATA TYPE TEXT,
ALTER COLUMN "workspace_id" SET DATA TYPE TEXT,
ALTER COLUMN "user_id" SET DATA TYPE TEXT,
ALTER COLUMN "role" SET DEFAULT 'MEMBER',
ALTER COLUMN "role" SET DATA TYPE TEXT,
ALTER COLUMN "joined_at" SET DATA TYPE TIMESTAMP(3),
ADD CONSTRAINT "workspace_members_pkey" PRIMARY KEY ("id");

-- AlterTable
ALTER TABLE "workspaces" DROP CONSTRAINT "workspaces_pkey",
DROP COLUMN "data_region",
DROP COLUMN "owner_id",
DROP COLUMN "plan",
DROP COLUMN "status",
ADD COLUMN     "version" INTEGER NOT NULL DEFAULT 0,
ALTER COLUMN "id" SET DATA TYPE TEXT,
ALTER COLUMN "name" SET DATA TYPE TEXT,
ALTER COLUMN "created_at" SET DATA TYPE TIMESTAMP(3),
ALTER COLUMN "updated_at" SET DATA TYPE TIMESTAMP(3),
ALTER COLUMN "deleted_at" SET DATA TYPE TIMESTAMP(3),
ADD CONSTRAINT "workspaces_pkey" PRIMARY KEY ("id");

-- CreateTable
CREATE TABLE "user_sessions" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "device_label" TEXT,
    "user_agent" TEXT,
    "ip_address" TEXT,
    "refresh_token_hash" TEXT NOT NULL,
    "refresh_token_family" TEXT NOT NULL,
    "issued_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "last_used_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expires_at" TIMESTAMP(3) NOT NULL,
    "revoked_at" TIMESTAMP(3),
    "revoked_reason" TEXT,

    CONSTRAINT "user_sessions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "user_totp_secrets" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "secret_encrypted" TEXT NOT NULL,
    "recovery_codes_hash" JSONB NOT NULL,
    "enrolled_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "disabled_at" TIMESTAMP(3),

    CONSTRAINT "user_totp_secrets_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "user_sessions_user_id_revoked_at_idx" ON "user_sessions"("user_id", "revoked_at");

-- CreateIndex
CREATE INDEX "user_sessions_refresh_token_family_idx" ON "user_sessions"("refresh_token_family");

-- CreateIndex
CREATE UNIQUE INDEX "user_totp_secrets_user_id_key" ON "user_totp_secrets"("user_id");

-- CreateIndex
CREATE INDEX "audit_logs_target_type_target_id_idx" ON "audit_logs"("target_type", "target_id");

-- CreateIndex
CREATE INDEX "event_logs_aggregate_type_aggregate_id_idx" ON "event_logs"("aggregate_type", "aggregate_id");

-- CreateIndex
CREATE INDEX "jobs_status_next_run_at_idx" ON "jobs"("status", "next_run_at");

-- CreateIndex
CREATE INDEX "notifications_user_id_status_idx" ON "notifications"("user_id", "status");

-- CreateIndex
CREATE INDEX "outbox_events_status_created_at_idx" ON "outbox_events"("status", "created_at");

-- CreateIndex
CREATE INDEX "responsibilities_workspace_id_id_idx" ON "responsibilities"("workspace_id", "id");

-- CreateIndex
CREATE INDEX "workspace_members_workspace_id_user_id_idx" ON "workspace_members"("workspace_id", "user_id");

-- AddForeignKey
ALTER TABLE "user_sessions" ADD CONSTRAINT "user_sessions_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "user_totp_secrets" ADD CONSTRAINT "user_totp_secrets_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "workspace_members" ADD CONSTRAINT "workspace_members_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "workspace_members" ADD CONSTRAINT "workspace_members_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "domains" ADD CONSTRAINT "domains_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "captures" ADD CONSTRAINT "captures_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "captures" ADD CONSTRAINT "captures_domain_id_fkey" FOREIGN KEY ("domain_id") REFERENCES "domains"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "captures" ADD CONSTRAINT "captures_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "captures" ADD CONSTRAINT "captures_consent_id_fkey" FOREIGN KEY ("consent_id") REFERENCES "consents"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "responsibilities" ADD CONSTRAINT "responsibilities_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "responsibilities" ADD CONSTRAINT "responsibilities_domain_id_fkey" FOREIGN KEY ("domain_id") REFERENCES "domains"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "responsibilities" ADD CONSTRAINT "responsibilities_origin_capture_id_fkey" FOREIGN KEY ("origin_capture_id") REFERENCES "captures"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "responsibilities" ADD CONSTRAINT "responsibilities_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "responsibilities" ADD CONSTRAINT "responsibilities_updated_by_fkey" FOREIGN KEY ("updated_by") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "task_details" ADD CONSTRAINT "task_details_responsibility_id_fkey" FOREIGN KEY ("responsibility_id") REFERENCES "responsibilities"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "commitment_details" ADD CONSTRAINT "commitment_details_responsibility_id_fkey" FOREIGN KEY ("responsibility_id") REFERENCES "responsibilities"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "decision_details" ADD CONSTRAINT "decision_details_responsibility_id_fkey" FOREIGN KEY ("responsibility_id") REFERENCES "responsibilities"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "waiting_details" ADD CONSTRAINT "waiting_details_responsibility_id_fkey" FOREIGN KEY ("responsibility_id") REFERENCES "responsibilities"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "constraints" ADD CONSTRAINT "constraints_responsibility_id_fkey" FOREIGN KEY ("responsibility_id") REFERENCES "responsibilities"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "responsibility_relations" ADD CONSTRAINT "responsibility_relations_from_id_fkey" FOREIGN KEY ("from_id") REFERENCES "responsibilities"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "responsibility_relations" ADD CONSTRAINT "responsibility_relations_to_id_fkey" FOREIGN KEY ("to_id") REFERENCES "responsibilities"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "recurrence_rules" ADD CONSTRAINT "recurrence_rules_responsibility_id_fkey" FOREIGN KEY ("responsibility_id") REFERENCES "responsibilities"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ai_inferences" ADD CONSTRAINT "ai_inferences_capture_id_fkey" FOREIGN KEY ("capture_id") REFERENCES "captures"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ai_inferences" ADD CONSTRAINT "ai_inferences_ai_run_id_fkey" FOREIGN KEY ("ai_run_id") REFERENCES "ai_runs"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ai_runs" ADD CONSTRAINT "ai_runs_capture_id_fkey" FOREIGN KEY ("capture_id") REFERENCES "captures"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "responsibility_embeddings" ADD CONSTRAINT "responsibility_embeddings_responsibility_id_fkey" FOREIGN KEY ("responsibility_id") REFERENCES "responsibilities"("id") ON DELETE CASCADE ON UPDATE CASCADE;

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
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "integrations" ADD CONSTRAINT "integrations_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "audit_logs" ADD CONSTRAINT "audit_logs_actor_user_id_fkey" FOREIGN KEY ("actor_user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
