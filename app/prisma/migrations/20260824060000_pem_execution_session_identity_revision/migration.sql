-- Phase 0B-2: ExecutionSessionIdentity / ExecutionSessionRevision新設
-- 出典: ISMAY_PEMサブシステム_統合正本仕様書_v4_0 7.2節

CREATE TABLE "execution_session_identities" (
    "id" TEXT NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "subject_user_id" TEXT NOT NULL,
    "responsibility_id" TEXT NOT NULL,
    "start_event_id" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "execution_session_identities_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "esi_workspace_start_event_uq"
  ON "execution_session_identities"("workspace_id", "start_event_id");
CREATE INDEX "esi_responsibility_id_idx" ON "execution_session_identities"("responsibility_id");

ALTER TABLE "execution_session_identities"
  ADD CONSTRAINT "esi_responsibility_workspace_fkey"
  FOREIGN KEY ("responsibility_id", "workspace_id")
  REFERENCES "responsibilities"("id", "workspace_id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE TABLE "execution_session_revisions" (
    "id" TEXT NOT NULL,
    "session_identity_id" TEXT NOT NULL,
    "revision" INTEGER NOT NULL,
    "derivation_version" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "started_at" TIMESTAMP(3) NOT NULL,
    "ended_at" TIMESTAMP(3),
    "end_reason" TEXT,
    "raw_elapsed_seconds" INTEGER NOT NULL,
    "corrected_active_seconds" INTEGER,
    "measurement_mode" TEXT NOT NULL,
    "measurement_quality" TEXT NOT NULL,
    "quality_reason_codes" JSONB NOT NULL DEFAULT '[]',
    "time_zone_id" TEXT,
    "utc_offset_minutes" INTEGER,
    "supersedes_revision_id" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "execution_session_revisions_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "esr_identity_revision_uq"
  ON "execution_session_revisions"("session_identity_id", "revision");

ALTER TABLE "execution_session_revisions"
  ADD CONSTRAINT "esr_session_identity_fkey"
  FOREIGN KEY ("session_identity_id") REFERENCES "execution_session_identities"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;
