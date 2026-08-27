-- V5-M1-A1 Project Context Domain基盤
-- 出典: ISMAY-V5-DOC-04(Project Context・外部連携境界仕様書) 2章・3章・10章、
--       ISMAY-V5-DOC-10(DB物理設計書) 3.2節・6章。
-- 範囲: 6テーブル新設のみ(expand-only)。既存テーブルへの破壊的変更なし。
-- 注記: 本ファイルはPrisma engineが本サンドボックスで取得不能なため
-- `prisma migrate dev`による自動生成ではなく手動で作成した。omega-dev2側で
-- `prisma migrate diff`等による突合を推奨する(再開手順に記載)。

-- =====================================================================
-- 0. 既存テーブルへの追加制約(このGateで必要な最小変更のみ)
-- =====================================================================

-- [M1-A1指示書 2.2] ProjectContextからDomainへ複合FK参照するため、
-- Domainに(id, workspace_id)複合uniqueを追加する(現状は単一列PKのみ)。
CREATE UNIQUE INDEX "domains_id_workspace_uq" ON "domains"("id", "workspace_id");

-- =====================================================================
-- 1. project_contexts
-- =====================================================================
CREATE TABLE "project_contexts" (
    "id" TEXT NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "domain_id" TEXT NOT NULL,
    "owner_subject_user_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "lifecycle_state" TEXT NOT NULL DEFAULT 'ACTIVE',
    "visibility" TEXT NOT NULL DEFAULT 'PRIVATE',
    "started_at" TIMESTAMP(3),
    "target_end_at" TIMESTAMP(3),
    "version" INTEGER NOT NULL DEFAULT 0,
    "created_by" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "deleted_at" TIMESTAMP(3),

    CONSTRAINT "project_contexts_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "project_contexts_id_workspace_uq" ON "project_contexts"("id", "workspace_id");
CREATE INDEX "project_contexts_workspace_id_lifecycle_state_idx" ON "project_contexts"("workspace_id", "lifecycle_state");
CREATE INDEX "project_contexts_workspace_id_domain_id_idx" ON "project_contexts"("workspace_id", "domain_id");

ALTER TABLE "project_contexts" ADD CONSTRAINT "project_contexts_workspace_id_fkey"
  FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "project_contexts" ADD CONSTRAINT "project_contexts_domain_id_workspace_id_fkey"
  FOREIGN KEY ("domain_id", "workspace_id") REFERENCES "domains"("id", "workspace_id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "project_contexts" ADD CONSTRAINT "project_contexts_owner_subject_user_id_fkey"
  FOREIGN KEY ("owner_subject_user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "project_contexts" ADD CONSTRAINT "project_contexts_created_by_fkey"
  FOREIGN KEY ("created_by") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- [DOC-04 3章] lifecycleState/visibilityの許容値をDB制約でも保証する。
ALTER TABLE "project_contexts" ADD CONSTRAINT "project_contexts_lifecycle_state_check"
  CHECK ("lifecycle_state" IN ('ACTIVE', 'PAUSED', 'COMPLETED', 'ARCHIVED'));
ALTER TABLE "project_contexts" ADD CONSTRAINT "project_contexts_visibility_check"
  CHECK ("visibility" IN ('PRIVATE', 'CONTEXT', 'WORKSPACE', 'EXPLICIT'));

-- =====================================================================
-- 2. project_context_links(active linkのProjection実体)
-- =====================================================================
CREATE TABLE "project_context_links" (
    "id" TEXT NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "context_id" TEXT NOT NULL,
    "responsibility_id" TEXT NOT NULL,
    "role" TEXT NOT NULL,
    "source_kind" TEXT NOT NULL,
    "linked_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "unlinked_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "project_context_links_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "project_context_links_workspace_id_context_id_unlinked_at_role_idx"
  ON "project_context_links"("workspace_id", "context_id", "unlinked_at", "role");
CREATE INDEX "project_context_links_workspace_id_responsibility_id_unlinked_at_idx"
  ON "project_context_links"("workspace_id", "responsibility_id", "unlinked_at");

ALTER TABLE "project_context_links" ADD CONSTRAINT "project_context_links_context_id_workspace_id_fkey"
  FOREIGN KEY ("context_id", "workspace_id") REFERENCES "project_contexts"("id", "workspace_id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "project_context_links" ADD CONSTRAINT "project_context_links_responsibility_id_workspace_id_fkey"
  FOREIGN KEY ("responsibility_id", "workspace_id") REFERENCES "responsibilities"("id", "workspace_id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "project_context_links" ADD CONSTRAINT "project_context_links_role_check"
  CHECK ("role" IN ('PRIMARY', 'SUPPORTING', 'REFERENCE'));
ALTER TABLE "project_context_links" ADD CONSTRAINT "project_context_links_source_kind_check"
  CHECK ("source_kind" IN ('USER', 'AI', 'IMPORT', 'SYSTEM'));
-- unlink済みならunlinked_at >= linked_at(基本的な時系列整合性)。
ALTER TABLE "project_context_links" ADD CONSTRAINT "project_context_links_unlinked_after_linked_check"
  CHECK ("unlinked_at" IS NULL OR "unlinked_at" >= "linked_at");

-- [DOC-04 10章] 同一Responsibilityへのactive PRIMARYは最大1(workspace内)。
CREATE UNIQUE INDEX "project_context_links_one_active_primary"
  ON "project_context_links" ("workspace_id", "responsibility_id")
  WHERE "role" = 'PRIMARY' AND "unlinked_at" IS NULL;

-- [DOC-04 2章] 「active linkのみ一意」: 同一(Context,Responsibility)組は
-- roleを問わずactive linkが同時に1件まで(role変更はunlink→再linkで行う)。
CREATE UNIQUE INDEX "project_context_links_one_active_per_context_responsibility"
  ON "project_context_links" ("workspace_id", "context_id", "responsibility_id")
  WHERE "unlinked_at" IS NULL;

-- =====================================================================
-- 3. project_context_link_events(append-only)
-- =====================================================================
CREATE TABLE "project_context_link_events" (
    "id" TEXT NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "context_id" TEXT NOT NULL,
    "responsibility_id" TEXT NOT NULL,
    "event_type" TEXT NOT NULL,
    "role" TEXT NOT NULL,
    "before_snapshot" JSONB,
    "after_snapshot" JSONB,
    "actor_user_id" TEXT,
    "actor_type" TEXT NOT NULL,
    "idempotency_key" TEXT NOT NULL,
    "request_payload_hash" TEXT NOT NULL,
    "occurred_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "project_context_link_events_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "pcle_idempotency_uq" ON "project_context_link_events"("workspace_id", "context_id", "idempotency_key");
CREATE INDEX "project_context_link_events_workspace_id_responsibility_id_idx" ON "project_context_link_events"("workspace_id", "responsibility_id");

ALTER TABLE "project_context_link_events" ADD CONSTRAINT "project_context_link_events_context_id_workspace_id_fkey"
  FOREIGN KEY ("context_id", "workspace_id") REFERENCES "project_contexts"("id", "workspace_id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "project_context_link_events" ADD CONSTRAINT "project_context_link_events_responsibility_id_workspace_id_fkey"
  FOREIGN KEY ("responsibility_id", "workspace_id") REFERENCES "responsibilities"("id", "workspace_id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "project_context_link_events" ADD CONSTRAINT "project_context_link_events_actor_user_id_fkey"
  FOREIGN KEY ("actor_user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "project_context_link_events" ADD CONSTRAINT "project_context_link_events_event_type_check"
  CHECK ("event_type" IN ('LINK', 'UNLINK'));
ALTER TABLE "project_context_link_events" ADD CONSTRAINT "project_context_link_events_role_check"
  CHECK ("role" IN ('PRIMARY', 'SUPPORTING', 'REFERENCE'));
-- [DOC-10 6章]「actorTypeとactor IDの排他」: actorType=USERの場合のみactor_user_idを必須とする。
ALTER TABLE "project_context_link_events" ADD CONSTRAINT "project_context_link_events_actor_exclusivity_check"
  CHECK (
    ("actor_type" = 'USER' AND "actor_user_id" IS NOT NULL) OR
    ("actor_type" <> 'USER' AND "actor_user_id" IS NULL)
  );

-- =====================================================================
-- 4. external_context_references
-- =====================================================================
CREATE TABLE "external_context_references" (
    "id" TEXT NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "context_id" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "external_workspace_key" TEXT NOT NULL,
    "external_project_key" TEXT NOT NULL,
    "canonical_url" TEXT,
    "direction" TEXT NOT NULL,
    "sync_policy" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "external_context_references_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "ecr_id_workspace_uq" ON "external_context_references"("id", "workspace_id");
CREATE UNIQUE INDEX "ecr_provider_key_uq" ON "external_context_references"("workspace_id", "provider", "external_workspace_key", "external_project_key");
CREATE INDEX "external_context_references_workspace_id_context_id_idx" ON "external_context_references"("workspace_id", "context_id");

ALTER TABLE "external_context_references" ADD CONSTRAINT "external_context_references_context_id_workspace_id_fkey"
  FOREIGN KEY ("context_id", "workspace_id") REFERENCES "project_contexts"("id", "workspace_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- =====================================================================
-- 5. project_context_snapshot_revisions(immutable)
-- =====================================================================
CREATE TABLE "project_context_snapshot_revisions" (
    "id" TEXT NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "reference_id" TEXT NOT NULL,
    "revision" INTEGER NOT NULL,
    "source_version" TEXT,
    "payload" JSONB NOT NULL,
    "payload_hash" TEXT NOT NULL,
    "captured_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expires_at" TIMESTAMP(3),

    CONSTRAINT "project_context_snapshot_revisions_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "pcsr_reference_revision_uq" ON "project_context_snapshot_revisions"("reference_id", "workspace_id", "revision");

ALTER TABLE "project_context_snapshot_revisions" ADD CONSTRAINT "project_context_snapshot_revisions_reference_id_workspace_id_fkey"
  FOREIGN KEY ("reference_id", "workspace_id") REFERENCES "external_context_references"("id", "workspace_id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "project_context_snapshot_revisions" ADD CONSTRAINT "project_context_snapshot_revisions_revision_positive_check"
  CHECK ("revision" > 0);

-- =====================================================================
-- 6. project_context_embeddings(1 current/model)
-- =====================================================================
CREATE TABLE "project_context_embeddings" (
    "id" TEXT NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "context_id" TEXT NOT NULL,
    "model" TEXT NOT NULL,
    "dimensions" INTEGER NOT NULL,
    "source_version" INTEGER NOT NULL,
    "embedding" vector(1536) NOT NULL,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "project_context_embeddings_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "pce_context_model_uq" ON "project_context_embeddings"("workspace_id", "context_id", "model");

ALTER TABLE "project_context_embeddings" ADD CONSTRAINT "project_context_embeddings_context_id_workspace_id_fkey"
  FOREIGN KEY ("context_id", "workspace_id") REFERENCES "project_contexts"("id", "workspace_id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "project_context_embeddings" ADD CONSTRAINT "project_context_embeddings_dimensions_check"
  CHECK ("dimensions" > 0);
