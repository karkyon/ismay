-- 項目9: DEFER_RATE_BY_ESTIMATE → DEFER_RATE_BY_ESTIMATE_BUCKET へのmetricKey改名backfill
-- 出典: ISMAY_PEMサブシステム_統合正本仕様書_v4_0 10.3節(正式名称)
UPDATE "pem_hypotheses"
  SET "source_metric" = 'DEFER_RATE_BY_ESTIMATE_BUCKET'
  WHERE "source_metric" = 'DEFER_RATE_BY_ESTIMATE';

UPDATE "pem_observations"
  SET "payload" = jsonb_set("payload", '{metric}', '"DEFER_RATE_BY_ESTIMATE_BUCKET"')
  WHERE "payload"->>'metric' = 'DEFER_RATE_BY_ESTIMATE';

-- 項目10: BootstrapAssertion新設
-- 出典: ISMAY_PEMサブシステム_統合正本仕様書_v4_0 11章
CREATE TABLE "bootstrap_assertions" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "assertion_type" TEXT NOT NULL,
    "statement" TEXT NOT NULL,
    "source_observation_id" TEXT,
    "source_hypothesis_id" TEXT,
    "conversation_id" TEXT,
    "status" TEXT NOT NULL DEFAULT 'ACTIVE',
    "expires_at" TIMESTAMP(3),
    "supersedes_assertion_id" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "bootstrap_assertions_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "bootstrap_assertions_user_id_assertion_type_idx"
  ON "bootstrap_assertions"("user_id", "assertion_type");

ALTER TABLE "bootstrap_assertions"
  ADD CONSTRAINT "bootstrap_assertions_user_fkey"
  FOREIGN KEY ("user_id") REFERENCES "users"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;
