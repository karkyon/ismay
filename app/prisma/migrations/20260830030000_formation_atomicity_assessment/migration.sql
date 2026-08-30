-- V5-M1-C: Atomicity Assessment新設
-- 出典: ISMAY_統合正本仕様書_v5_0.md §11(Atomicity Assessmentと分解提案)、
--       ISMAY-V5-DOC-10(DB物理設計書) 3.3節「atomicity_assessments」
--       (テーブル名のみ列挙されたDESIGNED段階、列定義はこのmigrationで新規に確定する)。
--
-- 本ファイルはPrisma engineが本サンドボックスで取得不能なため手動で作成した
-- (project_context_domain_foundation / formation_session_domain_foundation
-- migrationと同じ事情。omega-dev2側で`prisma migrate diff`等による突合を推奨する)。
--
-- [設計方針] §11.3「AssessmentはObservationであり、責任を自動分割しない」に従い、
-- 新規テーブル1件のみを追加する(expand-only、既存テーブルへの変更は無い)。
-- FormationCandidateRevisionは既にformation_candidate_revisions_id_workspace_uqを
-- 持つため、複合FK(revision_id, workspace_id)で参照できる。

CREATE TABLE "formation_atomicity_assessments" (
    "id" TEXT NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "revision_id" TEXT NOT NULL,
    "assessment" TEXT NOT NULL,
    "reason_code" TEXT NOT NULL,
    "evidence" JSONB NOT NULL,
    "confidence" DECIMAL(5, 4) NOT NULL,
    "algorithm_version" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "formation_atomicity_assessments_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "formation_atomicity_assessments_revision_uq" ON "formation_atomicity_assessments"("revision_id");
CREATE INDEX "formation_atomicity_assessments_workspace_id_revision_id_idx" ON "formation_atomicity_assessments"("workspace_id", "revision_id");

ALTER TABLE "formation_atomicity_assessments" ADD CONSTRAINT "formation_atomicity_assessments_revision_id_workspace_id_fkey"
  FOREIGN KEY ("revision_id", "workspace_id") REFERENCES "formation_candidate_revisions"("id", "workspace_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- [統合正本§11.1] coreTypes.ts ATOMICITY_ASSESSMENTSと同じ5値をDB制約でも保証する。
ALTER TABLE "formation_atomicity_assessments" ADD CONSTRAINT "formation_atomicity_assessments_assessment_check"
  CHECK ("assessment" IN ('ATOMIC', 'PROBABLY_ATOMIC', 'NEEDS_CLARIFICATION', 'SHOULD_DECOMPOSE', 'CONTEXT_LIKE'));

-- [DOC-10 4章 v5列パターン「Confidence numeric(5,4), 0<=x<=1」]
ALTER TABLE "formation_atomicity_assessments" ADD CONSTRAINT "formation_atomicity_assessments_confidence_check"
  CHECK ("confidence" >= 0 AND "confidence" <= 1);
