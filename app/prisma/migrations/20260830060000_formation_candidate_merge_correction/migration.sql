-- V5-M1-C2B: Candidate MERGE Correction(DEC-MERGE-001)
-- 出典: 2026-08-30確定指示書 Gate M1-C2B。expand-only(既存テーブルへの変更無し)。
--
-- 本ファイルはPrisma engineが本サンドボックスで取得不能なため手動で作成した。

CREATE TABLE "formation_candidate_lineages" (
    "id" TEXT NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "child_revision_id" TEXT NOT NULL,
    "parent_identity_id" TEXT NOT NULL,
    "parent_revision_id" TEXT NOT NULL,
    "correction_kind" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "formation_candidate_lineages_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "formation_candidate_lineages_child_parent_uq" ON "formation_candidate_lineages"("child_revision_id", "parent_identity_id");
CREATE INDEX "formation_candidate_lineages_workspace_id_child_revision_i_idx" ON "formation_candidate_lineages"("workspace_id", "child_revision_id");
CREATE INDEX "formation_candidate_lineages_workspace_id_parent_identity__idx" ON "formation_candidate_lineages"("workspace_id", "parent_identity_id");

ALTER TABLE "formation_candidate_lineages" ADD CONSTRAINT "formation_candidate_lineages_child_revision_id_workspace_i_fkey"
  FOREIGN KEY ("child_revision_id", "workspace_id") REFERENCES "formation_candidate_revisions"("id", "workspace_id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "formation_candidate_lineages" ADD CONSTRAINT "formation_candidate_lineages_parent_identity_id_workspace__fkey"
  FOREIGN KEY ("parent_identity_id", "workspace_id") REFERENCES "formation_candidate_identities"("id", "workspace_id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "formation_candidate_lineages" ADD CONSTRAINT "formation_candidate_lineages_parent_revision_id_workspace__fkey"
  FOREIGN KEY ("parent_revision_id", "workspace_id") REFERENCES "formation_candidate_revisions"("id", "workspace_id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "formation_candidate_lineages" ADD CONSTRAINT "formation_candidate_lineages_correction_kind_check"
  CHECK ("correction_kind" IN ('MERGE', 'SPLIT'));

CREATE TABLE "formation_candidate_merge_events" (
    "id" TEXT NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "session_id" TEXT NOT NULL,
    "client_event_id" TEXT NOT NULL,
    "request_hash" TEXT NOT NULL,
    "new_candidate_id" TEXT NOT NULL,
    "actor_user_id" TEXT NOT NULL,
    "occurred_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "formation_candidate_merge_events_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "formation_candidate_merge_events_workspace_client_uq" ON "formation_candidate_merge_events"("workspace_id", "client_event_id");
CREATE INDEX "formation_candidate_merge_events_workspace_id_session_id_idx" ON "formation_candidate_merge_events"("workspace_id", "session_id");

ALTER TABLE "formation_candidate_merge_events" ADD CONSTRAINT "formation_candidate_merge_events_actor_user_id_fkey"
  FOREIGN KEY ("actor_user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "formation_candidate_merge_events" ADD CONSTRAINT "formation_candidate_merge_events_new_candidate_id_workspac_fkey"
  FOREIGN KEY ("new_candidate_id", "workspace_id") REFERENCES "formation_candidate_identities"("id", "workspace_id") ON DELETE RESTRICT ON UPDATE CASCADE;
