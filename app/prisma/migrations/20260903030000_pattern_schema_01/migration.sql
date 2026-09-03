-- PATTERN-SCHEMA-01: Case Pattern Catalog(M4)永続化スキーマ
-- 出典: ISMAY-V5-DOC-06(Metric・Granularity・Case Pattern Catalog) §5「Case Pattern
-- データ契約」、§6「可変Window・確度」、§7「提案契約」、§10「受入条件」。
-- CHG-041「Prisma: AtomicityAssessmentとPattern 6 table追加(入力/根拠/Revision/
-- Feedback分離)」、CHG-045「Embedding: model/dimensions/sourceVersionを必須化」。
--
-- DR-1/DR-2設計決定(2026-09-03、カルキョンさん指示に基づく)はschema.prisma冒頭の
-- コメント、およびlib/patterns/coreTypes.tsを参照。

-- =====================================================================
-- case_patterns(identity)
-- =====================================================================
CREATE TABLE "case_patterns" (
    "id"                      TEXT NOT NULL,
    "workspace_id"            TEXT NOT NULL,
    "owner_subject_user_id"   TEXT NOT NULL,
    "pattern_key"             TEXT NOT NULL,
    "title"                   TEXT NOT NULL,
    "status"                  TEXT NOT NULL DEFAULT 'NONE',
    "observed_interval_days"  DECIMAL(10,4),
    "window_from"             TIMESTAMP(3),
    "confidence"              DECIMAL(5,4) NOT NULL DEFAULT 0,
    "current_revision"        INTEGER NOT NULL DEFAULT 0,
    "created_at"              TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at"               TIMESTAMP(3) NOT NULL,

    CONSTRAINT "case_patterns_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "case_patterns_owner_key_uq"
  ON "case_patterns"("workspace_id", "owner_subject_user_id", "pattern_key");

CREATE UNIQUE INDEX "case_patterns_id_workspace_uq"
  ON "case_patterns"("id", "workspace_id");

CREATE INDEX "case_patterns_workspace_id_status_idx"
  ON "case_patterns"("workspace_id", "status");

ALTER TABLE "case_patterns" ADD CONSTRAINT "case_patterns_workspace_id_fkey"
  FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "case_patterns" ADD CONSTRAINT "case_patterns_owner_subject_user_id_fkey"
  FOREIGN KEY ("owner_subject_user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- casePatternMath.ts CASE_PATTERN_STAGES(390c380で実装済み)と同一語彙。
ALTER TABLE "case_patterns" ADD CONSTRAINT "case_patterns_status_check"
  CHECK ("status" IN ('NONE', 'CANDIDATE_DISPLAY', 'ACTIVE', 'STRONG_SUGGESTION'));

ALTER TABLE "case_patterns" ADD CONSTRAINT "case_patterns_current_revision_check"
  CHECK ("current_revision" >= 0);

-- =====================================================================
-- case_pattern_revisions(immutable、revision単調増加)
-- =====================================================================
CREATE TABLE "case_pattern_revisions" (
    "id"                      TEXT NOT NULL,
    "workspace_id"            TEXT NOT NULL,
    "pattern_id"              TEXT NOT NULL,
    "revision"                INTEGER NOT NULL,
    "representative_text"     TEXT NOT NULL,
    "decomposition_template"  JSONB NOT NULL,
    "thresholds"              JSONB NOT NULL,
    "schema_version"          TEXT NOT NULL,
    "created_at"              TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "case_pattern_revisions_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "case_pattern_revisions_pattern_revision_uq"
  ON "case_pattern_revisions"("pattern_id", "revision");

CREATE UNIQUE INDEX "case_pattern_revisions_id_workspace_uq"
  ON "case_pattern_revisions"("id", "workspace_id");

ALTER TABLE "case_pattern_revisions" ADD CONSTRAINT "case_pattern_revisions_pattern_id_workspace_id_fkey"
  FOREIGN KEY ("pattern_id", "workspace_id") REFERENCES "case_patterns"("id", "workspace_id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "case_pattern_revisions" ADD CONSTRAINT "case_pattern_revisions_revision_check"
  CHECK ("revision" >= 1);

-- =====================================================================
-- case_pattern_source_links
-- DR-2: sourceEventKind/sourceEventId(既存targetType/targetId多態パターンの
-- 再利用)がsource Eventの同一性を担う。responsibilityId/formationSessionIdは
-- provenance参照のみ(同一性の代用にしない)。
-- =====================================================================
CREATE TABLE "case_pattern_source_links" (
    "id"                    TEXT NOT NULL,
    "workspace_id"          TEXT NOT NULL,
    "pattern_revision_id"   TEXT NOT NULL,
    "context_id"            TEXT NOT NULL,
    "source_event_kind"     TEXT NOT NULL,
    "source_event_id"       TEXT NOT NULL,
    "responsibility_id"     TEXT,
    "formation_session_id"  TEXT,
    "source_occurred_at"    TIMESTAMP(3) NOT NULL,
    "independence_group"    TEXT NOT NULL,
    "independence_weight"   DECIMAL(4,3) NOT NULL DEFAULT 1,
    "quality_weight"        DECIMAL(3,2) NOT NULL DEFAULT 1,
    "created_at"            TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "excluded_at"           TIMESTAMP(3),
    "excluded_reason"       TEXT,

    CONSTRAINT "case_pattern_source_links_pkey" PRIMARY KEY ("id")
);

-- 受入条件PS-01/PS-02: 同一revision内で同一source Eventの重複計上を防ぐ。
-- revision横断では加算しない(過去revisionの同じ根拠行は別revisionの別行として
-- 独立に存在してよい)。
CREATE UNIQUE INDEX "case_pattern_source_links_revision_event_uq"
  ON "case_pattern_source_links"("pattern_revision_id", "source_event_kind", "source_event_id");

CREATE INDEX "case_pattern_source_links_workspace_id_context_id_idx"
  ON "case_pattern_source_links"("workspace_id", "context_id");

CREATE INDEX "case_pattern_source_links_pattern_revision_id_excluded_at_idx"
  ON "case_pattern_source_links"("pattern_revision_id", "excluded_at");

ALTER TABLE "case_pattern_source_links" ADD CONSTRAINT "case_pattern_source_links_pattern_revision_id_workspace_id_fkey"
  FOREIGN KEY ("pattern_revision_id", "workspace_id") REFERENCES "case_pattern_revisions"("id", "workspace_id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "case_pattern_source_links" ADD CONSTRAINT "case_pattern_source_links_context_id_workspace_id_fkey"
  FOREIGN KEY ("context_id", "workspace_id") REFERENCES "project_contexts"("id", "workspace_id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "case_pattern_source_links" ADD CONSTRAINT "case_pattern_source_links_responsibility_id_workspace_id_fkey"
  FOREIGN KEY ("responsibility_id", "workspace_id") REFERENCES "responsibilities"("id", "workspace_id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "case_pattern_source_links" ADD CONSTRAINT "case_pattern_source_links_formation_session_id_workspace_id_fkey"
  FOREIGN KEY ("formation_session_id", "workspace_id") REFERENCES "formation_sessions"("id", "workspace_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- DR-2: lib/patterns/coreTypes.ts CASE_PATTERN_SOURCE_EVENT_KINDSと同一語彙。
ALTER TABLE "case_pattern_source_links" ADD CONSTRAINT "case_pattern_source_links_source_event_kind_check"
  CHECK ("source_event_kind" IN ('MATERIALIZATION_RECEIPT_ITEM', 'FORMATION_CANDIDATE_REVISION'));

-- DR-2: sourceEventKindごとに必須となるprovenance参照列をDBレベルで強制する
-- (指示書「両方nullableの可否・排他/共存条件は、実際のsource catalogを確認して
-- migrationのCHECK制約へ落とす」に対応)。
--   MATERIALIZATION_RECEIPT_ITEM → responsibility_idが必須
--   FORMATION_CANDIDATE_REVISION → formation_session_idが必須
-- 両方を同時に持つことは禁止しない(将来的に両方embedする実装もあり得るため)が、
-- 最低限「そのkindが要求する列」が欠落したINSERTは拒否する。
ALTER TABLE "case_pattern_source_links" ADD CONSTRAINT "case_pattern_source_links_provenance_check"
  CHECK (
    ("source_event_kind" = 'MATERIALIZATION_RECEIPT_ITEM' AND "responsibility_id" IS NOT NULL)
    OR
    ("source_event_kind" = 'FORMATION_CANDIDATE_REVISION' AND "formation_session_id" IS NOT NULL)
  );

ALTER TABLE "case_pattern_source_links" ADD CONSTRAINT "case_pattern_source_links_quality_weight_check"
  CHECK ("quality_weight" >= 0 AND "quality_weight" <= 1);

ALTER TABLE "case_pattern_source_links" ADD CONSTRAINT "case_pattern_source_links_independence_weight_check"
  CHECK ("independence_weight" >= 0 AND "independence_weight" <= 1);

-- =====================================================================
-- case_pattern_evidence_aggregates(revision単位のスナップショット集計)
-- =====================================================================
CREATE TABLE "case_pattern_evidence_aggregates" (
    "id"                      TEXT NOT NULL,
    "workspace_id"            TEXT NOT NULL,
    "revision_id"             TEXT NOT NULL,
    "metric_key"              TEXT NOT NULL,
    "raw_sample_size"         INTEGER NOT NULL,
    "distinct_context_count"  INTEGER NOT NULL,
    "weighted_support"        DECIMAL(10,6) NOT NULL,
    "quality_summary"         JSONB NOT NULL,
    "computed_at"             TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "case_pattern_evidence_aggregates_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "case_pattern_evidence_aggregates_revision_metric_uq"
  ON "case_pattern_evidence_aggregates"("revision_id", "metric_key");

ALTER TABLE "case_pattern_evidence_aggregates" ADD CONSTRAINT "case_pattern_evidence_aggregates_revision_id_workspace_id_fkey"
  FOREIGN KEY ("revision_id", "workspace_id") REFERENCES "case_pattern_revisions"("id", "workspace_id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "case_pattern_evidence_aggregates" ADD CONSTRAINT "case_pattern_evidence_aggregates_raw_sample_size_check"
  CHECK ("raw_sample_size" >= 0);

ALTER TABLE "case_pattern_evidence_aggregates" ADD CONSTRAINT "case_pattern_evidence_aggregates_distinct_context_count_check"
  CHECK ("distinct_context_count" >= 0);

-- =====================================================================
-- case_pattern_feedback_events(append-only)
-- =====================================================================
CREATE TABLE "case_pattern_feedback_events" (
    "id"                    TEXT NOT NULL,
    "workspace_id"          TEXT NOT NULL,
    "pattern_id"            TEXT NOT NULL,
    "pattern_revision_id"   TEXT NOT NULL,
    "suggestion_id"         TEXT NOT NULL,
    "verdict"               TEXT NOT NULL,
    "actor_user_id"         TEXT NOT NULL,
    "occurred_at"           TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "case_pattern_feedback_events_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "case_pattern_feedback_events_workspace_id_pattern_id_idx"
  ON "case_pattern_feedback_events"("workspace_id", "pattern_id");

CREATE INDEX "case_pattern_feedback_events_pattern_revision_id_idx"
  ON "case_pattern_feedback_events"("pattern_revision_id");

ALTER TABLE "case_pattern_feedback_events" ADD CONSTRAINT "case_pattern_feedback_events_pattern_id_workspace_id_fkey"
  FOREIGN KEY ("pattern_id", "workspace_id") REFERENCES "case_patterns"("id", "workspace_id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "case_pattern_feedback_events" ADD CONSTRAINT "case_pattern_feedback_events_pattern_revision_id_workspace_id_fkey"
  FOREIGN KEY ("pattern_revision_id", "workspace_id") REFERENCES "case_pattern_revisions"("id", "workspace_id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "case_pattern_feedback_events" ADD CONSTRAINT "case_pattern_feedback_events_actor_user_id_fkey"
  FOREIGN KEY ("actor_user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- [契約差分・DECISION未確定] suggestion_idにはFK制約を張らない。Suggestion
-- entity自体がこのGateのscope外(PATTERN-DETECT-01以降の提案API §7)のため。
-- Suggestion entity実装時に正式なFKへ移行するmigrationを追加すること。

-- DOC-06 §7「ACCEPT/PARTIAL_ACCEPT/REJECT/LATER/NOT_RELEVANT」。
ALTER TABLE "case_pattern_feedback_events" ADD CONSTRAINT "case_pattern_feedback_events_verdict_check"
  CHECK ("verdict" IN ('ACCEPT', 'PARTIAL_ACCEPT', 'REJECT', 'LATER', 'NOT_RELEVANT'));

-- =====================================================================
-- case_pattern_embeddings
-- 既存project_context_embeddings/responsibility_embeddingsと同じ
-- vector(1536)方式。DOC-06 §8「Pattern数は少ないためexact cosine。ANNを
-- 既定で作らない」— このmigrationではANN index(ivfflat/hnsw)は作らない。
-- =====================================================================
CREATE TABLE "case_pattern_embeddings" (
    "id"              TEXT NOT NULL,
    "workspace_id"    TEXT NOT NULL,
    "revision_id"     TEXT NOT NULL,
    "model"           TEXT NOT NULL,
    "dimensions"      INTEGER NOT NULL,
    "source_version"  INTEGER NOT NULL,
    "embedding"       vector(1536) NOT NULL,
    "updated_at"      TIMESTAMP(3) NOT NULL,

    CONSTRAINT "case_pattern_embeddings_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "case_pattern_embeddings_revision_model_uq"
  ON "case_pattern_embeddings"("workspace_id", "revision_id", "model");

ALTER TABLE "case_pattern_embeddings" ADD CONSTRAINT "case_pattern_embeddings_revision_id_workspace_id_fkey"
  FOREIGN KEY ("revision_id", "workspace_id") REFERENCES "case_pattern_revisions"("id", "workspace_id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "case_pattern_embeddings" ADD CONSTRAINT "case_pattern_embeddings_dimensions_check"
  CHECK ("dimensions" > 0);

-- 受入条件PS-08「dimensionsとvector長不一致、model/sourceVersion欠落は拒否」。
-- pgvectorのvector_dims()関数でCHECK制約として強制する(Prismaでは表現できない
-- ためSQLへ明記、指示書の指示通り)。model/source_versionは列自体がNOT NULLの
-- ためスキーマレベルで既に欠落を拒否する。
ALTER TABLE "case_pattern_embeddings" ADD CONSTRAINT "case_pattern_embeddings_dimensions_match_check"
  CHECK (vector_dims("embedding") = "dimensions");
