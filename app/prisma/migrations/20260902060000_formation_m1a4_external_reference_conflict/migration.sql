-- M1-A4: External Reference Conflict Queue
-- 出典: DOC-04(Project Context・外部連携境界仕様書) 4章「conflict queueがある
-- 場合のみ…last-write-winsしない」、EVAL・受入テスト仕様書 EV-C-005。
-- [scope宣言] 外部Providerへの実HTTP通信(Connector/Webhook)は対象外
-- (統合正本仕様書29章6項「External connector別scope、credential、replay防止」
-- が未確定事項のため)。新しいsourceVersionの提示を受け取り、conflict検出・
-- queue化・本人解決のみを実装する。

-- [DOC-04 8.4節論理Entityに明記されているが未実装だった列]
ALTER TABLE "external_context_references" ADD COLUMN "last_observed_version" TEXT;
ALTER TABLE "external_context_references" ADD COLUMN "last_synced_at" TIMESTAMP(3);

-- [M1-A4新設] ExternalReferenceConflict.newSnapshotRevisionIdからの複合FK
-- (id, workspace_id)参照先として必要。
CREATE UNIQUE INDEX "pcsr_id_workspace_uq"
  ON "project_context_snapshot_revisions"("id", "workspace_id");

CREATE TABLE "external_reference_conflicts" (
    "id"                        TEXT NOT NULL,
    "workspace_id"              TEXT NOT NULL,
    "reference_id"              TEXT NOT NULL,
    "previous_observed_version" TEXT,
    "new_source_version"        TEXT NOT NULL,
    "new_snapshot_revision_id"  TEXT NOT NULL,
    "status"                    TEXT NOT NULL DEFAULT 'PENDING',
    "resolution_action"         TEXT,
    "resolved_by"               TEXT,
    "resolved_at"               TIMESTAMP(3),
    "detected_at"               TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "external_reference_conflicts_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "external_reference_conflicts_workspace_id_reference_id_status_idx"
  ON "external_reference_conflicts"("workspace_id", "reference_id", "status");

ALTER TABLE "external_reference_conflicts" ADD CONSTRAINT "external_reference_conflicts_reference_id_workspace_id_fkey"
  FOREIGN KEY ("reference_id", "workspace_id") REFERENCES "external_context_references"("id", "workspace_id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "external_reference_conflicts" ADD CONSTRAINT "external_reference_conflicts_new_snapshot_revision_id_workspace_id_fkey"
  FOREIGN KEY ("new_snapshot_revision_id", "workspace_id") REFERENCES "project_context_snapshot_revisions"("id", "workspace_id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "external_reference_conflicts" ADD CONSTRAINT "external_reference_conflicts_resolved_by_fkey"
  FOREIGN KEY ("resolved_by") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "external_reference_conflicts" ADD CONSTRAINT "external_reference_conflicts_status_check"
  CHECK ("status" IN ('PENDING', 'RESOLVED'));

ALTER TABLE "external_reference_conflicts" ADD CONSTRAINT "external_reference_conflicts_resolution_action_check"
  CHECK ("resolution_action" IS NULL OR "resolution_action" IN ('KEEP_LOCAL', 'APPLY_REMOTE'));
