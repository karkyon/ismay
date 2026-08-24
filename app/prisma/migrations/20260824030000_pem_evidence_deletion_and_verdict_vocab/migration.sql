-- Phase 0C-2/0C-3: PEM Evidence Deletion Event新設 + PemHypothesis.userVerdict語彙移行
-- 出典: ISMAY_PEMサブシステム_統合正本仕様書_v4_0 12.2節・16.3節

CREATE TABLE "pem_evidence_deletion_events" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "target_type" TEXT NOT NULL,
    "target_id" TEXT NOT NULL,
    "deletion_mode" TEXT NOT NULL,
    "reason" TEXT,
    "occurred_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "pem_evidence_deletion_events_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "pem_evidence_deletion_events_user_id_target_type_target_id_idx"
  ON "pem_evidence_deletion_events"("user_id", "target_type", "target_id");

ALTER TABLE "pem_evidence_deletion_events"
  ADD CONSTRAINT "pem_evidence_deletion_events_user_id_fkey"
  FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- 既存の論理削除済みPemObservation(POST /pem/resetのみが書き込んでいたdeletedAt)を
-- backfillする。gen_random_uuid()はPostgreSQL 13以降でコア組み込み(拡張不要)。
-- 万一失敗した場合は本マイグレーション全体がロールバックされる(Prismaのmigrate deployは
-- 1マイグレーションを1トランザクションとして適用する)。
INSERT INTO "pem_evidence_deletion_events"
  ("id", "user_id", "target_type", "target_id", "deletion_mode", "reason", "occurred_at")
SELECT
  gen_random_uuid()::text,
  "user_id",
  'PEM_OBSERVATION',
  "id",
  'EXCLUDED_FROM_USE',
  'BACKFILL_FROM_LEGACY_DELETED_AT',
  "deleted_at"
FROM "pem_observations"
WHERE "deleted_at" IS NOT NULL;

-- PemHypothesis.userVerdict語彙移行(v4.0 12.2節)
ALTER TABLE "pem_hypotheses" ADD COLUMN "legacy_user_verdict" TEXT;
UPDATE "pem_hypotheses" SET "legacy_user_verdict" = "user_verdict";

UPDATE "pem_hypotheses" SET "user_verdict" = 'AGREED' WHERE "user_verdict" = 'CONFIRMED';
UPDATE "pem_hypotheses" SET "user_verdict" = 'DISAGREED' WHERE "user_verdict" = 'REJECTED';
-- TEMPORARYは評決ではなくTemporary State側の概念(Phase 1未着手)のため、
-- 暫定的にUNREVIEWEDへ移行する。元の値はlegacy_user_verdict列に残る。
UPDATE "pem_hypotheses" SET "user_verdict" = 'UNREVIEWED' WHERE "user_verdict" IN ('PENDING', 'TEMPORARY');

ALTER TABLE "pem_hypotheses" ALTER COLUMN "user_verdict" SET DEFAULT 'UNREVIEWED';
