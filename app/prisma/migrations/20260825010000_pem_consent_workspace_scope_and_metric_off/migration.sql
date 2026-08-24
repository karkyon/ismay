-- Phase0S/0A Completion Gate 1: Consent tenant境界・scope・metric単位OFF
-- 出典: ISMAY_PEMサブシステム_統合正本仕様書_v4_0 16.1節・16.2節

-- 1. PemConsentEventへworkspace_id・scope追加
ALTER TABLE "pem_consent_events" ADD COLUMN "workspace_id" TEXT;
ALTER TABLE "pem_consent_events" ADD COLUMN "scope" JSONB;

-- 既存行のworkspace_idをworkspace_membersからbackfillする(MVPは1ユーザー1
-- Workspace前提のため、複数所属時は最初に参加したWorkspaceを採用する)。
UPDATE "pem_consent_events" pce
SET "workspace_id" = (
  SELECT wm."workspace_id" FROM "workspace_members" wm
  WHERE wm."user_id" = pce."user_id"
  ORDER BY wm."joined_at" ASC
  LIMIT 1
)
WHERE pce."workspace_id" IS NULL;

-- backfillできない孤立行が残っていれば、ここでNOT NULL制約違反として
-- マイグレーション全体が失敗する(1マイグレーション=1トランザクションのため、
-- 中途半端な状態にはならない)。
ALTER TABLE "pem_consent_events" ALTER COLUMN "workspace_id" SET NOT NULL;

CREATE INDEX "pem_consent_events_workspace_id_idx" ON "pem_consent_events"("workspace_id");

-- 2. PemMetricConsentEvent新設
CREATE TABLE "pem_metric_consent_events" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "metric_key" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "policy_version" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "occurred_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "pem_metric_consent_events_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "pem_metric_consent_events_user_id_metric_key_idx"
  ON "pem_metric_consent_events"("user_id", "metric_key");

ALTER TABLE "pem_metric_consent_events"
  ADD CONSTRAINT "pem_metric_consent_events_user_fkey"
  FOREIGN KEY ("user_id") REFERENCES "users"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;
