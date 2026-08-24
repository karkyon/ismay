-- Phase 0A是正2: Ledger schemaのv4.0必須列とtenant複合制約
-- 出典: ISMAY_PEMサブシステム_統合正本仕様書_v4_0 5.3節・4.1節

-- 1. 新規列追加(NULL許容で追加し、backfill後にNOT NULL化する)
ALTER TABLE "responsibility_execution_events" ADD COLUMN "actor_service_id" TEXT;
ALTER TABLE "responsibility_execution_events" ADD COLUMN "actor_agent_id" TEXT;
ALTER TABLE "responsibility_execution_events" ADD COLUMN "delegated_by_user_id" TEXT;
ALTER TABLE "responsibility_execution_events" ADD COLUMN "authentication_context_id" TEXT;
ALTER TABLE "responsibility_execution_events" ADD COLUMN "request_id" TEXT;
ALTER TABLE "responsibility_execution_events" ADD COLUMN "source_device_id" TEXT;
ALTER TABLE "responsibility_execution_events" ADD COLUMN "client_event_id" TEXT;
ALTER TABLE "responsibility_execution_events" ADD COLUMN "client_sequence" BIGINT;
ALTER TABLE "responsibility_execution_events" ADD COLUMN "clock_offset_seconds" INTEGER;
ALTER TABLE "responsibility_execution_events" ADD COLUMN "clock_offset_measured_at" TIMESTAMP(3);
ALTER TABLE "responsibility_execution_events" ADD COLUMN "request_payload_hash" TEXT;
ALTER TABLE "responsibility_execution_events" ADD COLUMN "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;

-- globalSequence: BIGSERIAL相当(BIGINT + 専用シーケンス + デフォルト)を明示的に構成する。
CREATE SEQUENCE "responsibility_execution_events_global_sequence_seq" AS BIGINT;
ALTER TABLE "responsibility_execution_events"
  ADD COLUMN "global_sequence" BIGINT NOT NULL
  DEFAULT nextval('"responsibility_execution_events_global_sequence_seq"');
ALTER SEQUENCE "responsibility_execution_events_global_sequence_seq"
  OWNED BY "responsibility_execution_events"."global_sequence";

-- 2. backfill(既存行への値の補完)
UPDATE "responsibility_execution_events" SET "metadata" = '{}'::jsonb WHERE "metadata" IS NULL;
UPDATE "responsibility_execution_events" SET "request_id" = gen_random_uuid()::text WHERE "request_id" IS NULL;
UPDATE "responsibility_execution_events" SET "request_payload_hash" = 'BACKFILL_UNKNOWN' WHERE "request_payload_hash" IS NULL;

-- 3. NOT NULL化・デフォルト確定
ALTER TABLE "responsibility_execution_events" ALTER COLUMN "metadata" SET NOT NULL;
ALTER TABLE "responsibility_execution_events" ALTER COLUMN "metadata" SET DEFAULT '{}'::jsonb;
ALTER TABLE "responsibility_execution_events" ALTER COLUMN "request_id" SET NOT NULL;
ALTER TABLE "responsibility_execution_events" ALTER COLUMN "request_payload_hash" SET NOT NULL;

-- 4. clientOccurredAtをnullable化(v4.0 6.1節: SYSTEM/WORKER由来イベントはnull)
ALTER TABLE "responsibility_execution_events" ALTER COLUMN "client_occurred_at" DROP NOT NULL;

-- 5. tenant(workspaceId)複合unique制約(v4.0 5.3節)
DROP INDEX "ree_responsibility_sequence_uq";
CREATE UNIQUE INDEX "ree_workspace_responsibility_sequence_uq"
  ON "responsibility_execution_events"("workspace_id", "responsibility_id", "responsibility_sequence");

CREATE UNIQUE INDEX "ree_workspace_subject_client_event_uq"
  ON "responsibility_execution_events"("workspace_id", "subject_user_id", "client_event_id");

CREATE UNIQUE INDEX "ree_global_sequence_uq" ON "responsibility_execution_events"("global_sequence");

-- 6. tenant複合FK(v4.0 4.1節「tenantを跨ぐFK参照…を禁止する」の機械的保証)
ALTER TABLE "responsibility_execution_events" DROP CONSTRAINT "ree_responsibility_id_fkey";
ALTER TABLE "responsibilities" ADD CONSTRAINT "responsibilities_id_workspace_id_uq" UNIQUE ("id", "workspace_id");
ALTER TABLE "responsibility_execution_events"
  ADD CONSTRAINT "ree_responsibility_workspace_fkey"
  FOREIGN KEY ("responsibility_id", "workspace_id")
  REFERENCES "responsibilities"("id", "workspace_id")
  ON DELETE RESTRICT ON UPDATE CASCADE;
