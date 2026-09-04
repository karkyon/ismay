-- Gate PATTERN-DETECT-02A: Case Pattern Detection Receipt
-- 出典: Claude向け_ISMAY_3b695d9以降_再監査是正・CasePattern実機能完遂指示_
-- 2026-09-04.md §2 P1-4「Source occurrenceの処理済み管理がない」、§3.2。
--
-- 目的: owner単位workerが同じsource Eventを毎回NO_MATCH判定して新規Patternを
-- 重複作成しないよう、「このsource(+policy+model+sourceVersion)は処理済み」
-- という記録を持つ。CasePatternSourceLinkの一意制約(revision内の重複防止)
-- とは別概念であり、別テーブルとして管理する。

CREATE TABLE "case_pattern_detection_receipts" (
    "id"                          TEXT NOT NULL,
    "workspace_id"                TEXT NOT NULL,
    "owner_subject_user_id"       TEXT NOT NULL,
    "source_event_kind"           TEXT NOT NULL,
    "source_event_id"             TEXT NOT NULL,
    "context_id"                  TEXT NOT NULL,
    "responsibility_id"           TEXT,
    "formation_session_id"        TEXT,
    "input_digest"                TEXT NOT NULL,
    "policy_version"              TEXT NOT NULL,
    "model"                       TEXT NOT NULL,
    "dimensions"                  INTEGER,
    "source_version"              INTEGER NOT NULL,
    "outcome"                     TEXT NOT NULL,
    "matched_pattern_id"          TEXT,
    "matched_pattern_revision_id" TEXT,
    "created_pattern_id"          TEXT,
    "best_similarity"             DECIMAL(6,5),
    "second_similarity"           DECIMAL(6,5),
    "reason_code"                 TEXT,
    "generation"                  INTEGER NOT NULL DEFAULT 1,
    "attempt"                     INTEGER NOT NULL DEFAULT 1,
    "processed_at"                TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_at"                  TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "case_pattern_detection_receipts_pkey" PRIMARY KEY ("id")
);

-- PE2E-02「同一sourceを100回再処理してもPattern/SourceLink/sample増加なし」を
-- 支える冪等unique。PE2E-08「model/dimensions/sourceVersion変更時は旧Embedding
-- と混合せず再処理」も同じ制約列(policy_version, model, source_version)が
-- 入力の一部として変化として扱われることで満たす。
CREATE UNIQUE INDEX "case_pattern_detection_receipts_idempotency_uq"
  ON "case_pattern_detection_receipts"(
    "workspace_id", "owner_subject_user_id", "source_event_kind", "source_event_id",
    "policy_version", "model", "source_version"
  );

CREATE INDEX "case_pattern_detection_receipts_workspace_id_owner_subject_use"
  ON "case_pattern_detection_receipts"("workspace_id", "owner_subject_user_id", "outcome");

ALTER TABLE "case_pattern_detection_receipts" ADD CONSTRAINT "case_pattern_detection_receipts_workspace_id_fkey"
  FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "case_pattern_detection_receipts" ADD CONSTRAINT "case_pattern_detection_receipts_owner_subject_user_id_fkey"
  FOREIGN KEY ("owner_subject_user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "case_pattern_detection_receipts" ADD CONSTRAINT "case_pattern_detection_receipts_context_id_fkey"
  FOREIGN KEY ("context_id", "workspace_id") REFERENCES "project_contexts"("id", "workspace_id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "case_pattern_detection_receipts" ADD CONSTRAINT "case_pattern_detection_receipts_source_event_kind_check"
  CHECK ("source_event_kind" IN ('MATERIALIZATION_RECEIPT_ITEM', 'FORMATION_CANDIDATE_REVISION'));

ALTER TABLE "case_pattern_detection_receipts" ADD CONSTRAINT "case_pattern_detection_receipts_outcome_check"
  CHECK ("outcome" IN ('MATCHED', 'NEW_PATTERN_CREATED', 'AMBIGUOUS', 'SKIPPED', 'FAILED'));

-- DR-2と同じprovenance必須パターン(coreTypes.ts requiredProvenanceFieldFor)を
-- このReceiptでも維持する: MATERIALIZATION_RECEIPT_ITEMはresponsibility_id必須、
-- FORMATION_CANDIDATE_REVISIONはformation_session_id必須。
ALTER TABLE "case_pattern_detection_receipts" ADD CONSTRAINT "case_pattern_detection_receipts_provenance_check"
  CHECK (
    ("source_event_kind" = 'MATERIALIZATION_RECEIPT_ITEM' AND "responsibility_id" IS NOT NULL)
    OR
    ("source_event_kind" = 'FORMATION_CANDIDATE_REVISION' AND "formation_session_id" IS NOT NULL)
  );
