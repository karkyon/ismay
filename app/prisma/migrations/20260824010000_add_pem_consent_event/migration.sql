-- Phase 0S: PEM Consent Ledger(insert-only)
-- 出典: ISMAY_PEMサブシステム_統合正本仕様書_v4_0 16.1節
CREATE TABLE "pem_consent_events" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "consent_type" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "policy_version" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "occurred_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "pem_consent_events_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "pem_consent_events_user_id_consent_type_idx" ON "pem_consent_events"("user_id", "consent_type");

ALTER TABLE "pem_consent_events" ADD CONSTRAINT "pem_consent_events_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
