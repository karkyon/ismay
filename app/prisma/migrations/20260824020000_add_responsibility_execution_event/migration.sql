-- Phase 0A: PEM Execution Event Ledger本体
-- 出典: ISMAY_PEMサブシステム_統合正本仕様書_v4_0 5章
ALTER TABLE "responsibilities" ADD COLUMN "event_sequence_counter" INTEGER NOT NULL DEFAULT 0;

CREATE TABLE "responsibility_execution_events" (
    "id" TEXT NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "subject_user_id" TEXT NOT NULL,
    "actor_type" TEXT NOT NULL,
    "actor_user_id" TEXT,
    "responsibility_id" TEXT NOT NULL,
    "event_type" TEXT NOT NULL,
    "from_state" TEXT NOT NULL,
    "to_state" TEXT NOT NULL,
    "responsibility_version_before" INTEGER NOT NULL,
    "responsibility_version_after" INTEGER NOT NULL,
    "responsibility_sequence" INTEGER NOT NULL,
    "source" TEXT NOT NULL,
    "client_occurred_at" TIMESTAMP(3) NOT NULL,
    "server_recorded_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "effective_occurred_at" TIMESTAMP(3) NOT NULL,
    "occurred_at_quality" TEXT NOT NULL,
    "schema_version" TEXT NOT NULL,
    "correlation_id" TEXT,
    "causation_id" TEXT,
    "idempotency_key" TEXT NOT NULL,
    "metadata" JSONB,

    CONSTRAINT "responsibility_execution_events_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "ree_responsibility_sequence_uq" ON "responsibility_execution_events"("responsibility_id", "responsibility_sequence");
CREATE UNIQUE INDEX "ree_idempotency_uq" ON "responsibility_execution_events"("workspace_id", "subject_user_id", "idempotency_key");
CREATE INDEX "ree_responsibility_id_idx" ON "responsibility_execution_events"("responsibility_id");

ALTER TABLE "responsibility_execution_events" ADD CONSTRAINT "ree_responsibility_id_fkey" FOREIGN KEY ("responsibility_id") REFERENCES "responsibilities"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
