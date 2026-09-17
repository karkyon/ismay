-- PATTERN-ACTIONSLOT-SCHEMA-01: CasePatternActionSlot(正本§12.2準拠)
-- 出典: ISMAY_統合正本仕様書_v5_0.md §12.2「CasePatternActionSlot」、
-- Claude向け_ISMAY_d68e9bf以降_ActionSlot正本準拠・CasePattern実分解完遂・
-- 残工程連続実装指示_2026-09-17.md Gate 3(Decision Record)・Gate 4。
--
-- 安定identity(case_pattern_action_slots)とappend-only snapshot
-- (case_pattern_action_slot_revisions)を分離する。provenance
-- (case_pattern_action_slot_source_instances)は既存
-- formation_candidate_lineagesをchildRevisionId経由で遡及可能にする
-- ためのslot帰属記録のみを持ち、親candidate/親Revision列は複製しない。

-- =====================================================================
-- case_pattern_action_slots(identity)
-- =====================================================================
CREATE TABLE "case_pattern_action_slots" (
    "id"                       TEXT NOT NULL,
    "workspace_id"             TEXT NOT NULL,
    "pattern_id"                TEXT NOT NULL,
    "slot_key"                 TEXT NOT NULL,
    "grouping_key"             TEXT NOT NULL,
    "grouping_policy_version"  TEXT NOT NULL,
    "current_revision"         INTEGER NOT NULL DEFAULT 0,
    "created_at"               TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at"               TIMESTAMP(3) NOT NULL,

    CONSTRAINT "case_pattern_action_slots_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "case_pattern_action_slots_pattern_slot_uq"
  ON "case_pattern_action_slots"("workspace_id", "pattern_id", "slot_key");

CREATE UNIQUE INDEX "case_pattern_action_slots_pattern_grouping_uq"
  ON "case_pattern_action_slots"("workspace_id", "pattern_id", "grouping_key");

CREATE UNIQUE INDEX "case_pattern_action_slots_id_workspace_uq"
  ON "case_pattern_action_slots"("id", "workspace_id");

CREATE INDEX "case_pattern_action_slots_workspace_id_pattern_id_idx"
  ON "case_pattern_action_slots"("workspace_id", "pattern_id");

ALTER TABLE "case_pattern_action_slots" ADD CONSTRAINT "case_pattern_action_slots_pattern_id_workspace_id_fkey"
  FOREIGN KEY ("pattern_id", "workspace_id") REFERENCES "case_patterns"("id", "workspace_id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "case_pattern_action_slots" ADD CONSTRAINT "case_pattern_action_slots_current_revision_check"
  CHECK ("current_revision" >= 0);

-- =====================================================================
-- case_pattern_action_slot_revisions(append-only、revision単調増加)
-- =====================================================================
CREATE TABLE "case_pattern_action_slot_revisions" (
    "id"                       TEXT NOT NULL,
    "workspace_id"             TEXT NOT NULL,
    "slot_id"                  TEXT NOT NULL,
    "revision"                 INTEGER NOT NULL,
    "pattern_id"               TEXT NOT NULL,
    "pattern_revision_id"      TEXT NOT NULL,
    "normalized_intent"        TEXT NOT NULL,
    "suggested_type"           TEXT NOT NULL,
    "occurrence_probability"   DECIMAL(5,4) NOT NULL,
    "typical_order"            DECIMAL(6,2) NOT NULL,
    "predecessor_slot_keys"    TEXT[] NOT NULL,
    "duration_distribution"    JSONB NOT NULL,
    "atomicity_distribution"   JSONB NOT NULL,
    "raw_sample_size"          INTEGER NOT NULL,
    "schema_version"           TEXT NOT NULL,
    "policy_version"           TEXT NOT NULL,
    "created_at"               TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "case_pattern_action_slot_revisions_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "case_pattern_action_slot_revisions_slot_rev_uq"
  ON "case_pattern_action_slot_revisions"("workspace_id", "slot_id", "revision");

CREATE INDEX "case_pattern_action_slot_revisions_workspace_id_slot_id_idx"
  ON "case_pattern_action_slot_revisions"("workspace_id", "slot_id");

CREATE INDEX "case_pattern_action_slot_revisions_workspace_id_pattern_revision_id_idx"
  ON "case_pattern_action_slot_revisions"("workspace_id", "pattern_revision_id");

ALTER TABLE "case_pattern_action_slot_revisions" ADD CONSTRAINT "case_pattern_action_slot_revisions_slot_id_workspace_id_fkey"
  FOREIGN KEY ("slot_id", "workspace_id") REFERENCES "case_pattern_action_slots"("id", "workspace_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- patternRevisionIdが実際にpatternIdへ属することをDBで保証する
-- (formation_candidate_lineagesのparentRevision複合FKと同じ設計原則)。
ALTER TABLE "case_pattern_action_slot_revisions" ADD CONSTRAINT "case_pattern_action_slot_revisions_pattern_revision_id_fkey"
  FOREIGN KEY ("pattern_revision_id", "pattern_id", "workspace_id") REFERENCES "case_pattern_revisions"("id", "pattern_id", "workspace_id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "case_pattern_action_slot_revisions" ADD CONSTRAINT "case_pattern_action_slot_revisions_revision_check"
  CHECK ("revision" >= 1);

-- Gate 3 Decision Record §3.4「occurrenceProbability: 0..1」。
ALTER TABLE "case_pattern_action_slot_revisions" ADD CONSTRAINT "case_pattern_action_slot_revisions_occurrence_probability_check"
  CHECK ("occurrence_probability" >= 0 AND "occurrence_probability" <= 1);

-- 指示書Gate 4「order非負などDBで表現できるCHECK」。
ALTER TABLE "case_pattern_action_slot_revisions" ADD CONSTRAINT "case_pattern_action_slot_revisions_typical_order_check"
  CHECK ("typical_order" >= 0);

ALTER TABLE "case_pattern_action_slot_revisions" ADD CONSTRAINT "case_pattern_action_slot_revisions_raw_sample_size_check"
  CHECK ("raw_sample_size" >= 0);

-- 指示書Gate 3.5「未知field・壊れたversionをfail closedで拒否する」の
-- 最低限のDBレベル強制: durationDistribution/atomicityDistributionは
-- object型のJSONBであることを強制する(配列やスカラー値の混入を拒否)。
-- schemaVersion/policyVersionが要求する具体的なkey集合はapplication層の
-- Zod契約(Gate 5実装時に追加)が検証する。
ALTER TABLE "case_pattern_action_slot_revisions" ADD CONSTRAINT "case_pattern_action_slot_revisions_duration_distribution_type_check"
  CHECK (jsonb_typeof("duration_distribution") = 'object');

ALTER TABLE "case_pattern_action_slot_revisions" ADD CONSTRAINT "case_pattern_action_slot_revisions_atomicity_distribution_type_check"
  CHECK (jsonb_typeof("atomicity_distribution") = 'object');

-- =====================================================================
-- case_pattern_action_slot_source_instances(provenance、append-only)
-- 1 childRevisionは高々1 slotへのみ帰属する(同一分解内の複数partが同じ
-- slotへ二重計上されない)。親candidate/親Revisionはformation_candidate_
-- lineagesをchild_revision_id経由で遡及すれば得られるため複製しない。
-- =====================================================================
CREATE TABLE "case_pattern_action_slot_source_instances" (
    "id"                    TEXT NOT NULL,
    "workspace_id"          TEXT NOT NULL,
    "slot_id"               TEXT NOT NULL,
    "child_revision_id"     TEXT NOT NULL,
    "order"                 INTEGER NOT NULL,
    "independence_group"    TEXT NOT NULL,
    "created_at"            TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "case_pattern_action_slot_source_instances_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "case_pattern_action_slot_source_instances_child_uq"
  ON "case_pattern_action_slot_source_instances"("workspace_id", "child_revision_id");

CREATE INDEX "case_pattern_action_slot_source_instances_workspace_id_slot_id_idx"
  ON "case_pattern_action_slot_source_instances"("workspace_id", "slot_id");

ALTER TABLE "case_pattern_action_slot_source_instances" ADD CONSTRAINT "case_pattern_action_slot_source_instances_slot_id_workspace_id_fkey"
  FOREIGN KEY ("slot_id", "workspace_id") REFERENCES "case_pattern_action_slots"("id", "workspace_id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "case_pattern_action_slot_source_instances" ADD CONSTRAINT "case_pattern_action_slot_source_instances_child_revision_id_fkey"
  FOREIGN KEY ("child_revision_id", "workspace_id") REFERENCES "formation_candidate_revisions"("id", "workspace_id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "case_pattern_action_slot_source_instances" ADD CONSTRAINT "case_pattern_action_slot_source_instances_order_check"
  CHECK ("order" >= 0);
