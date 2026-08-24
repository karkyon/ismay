-- Phase 0E: PemOnboardingConversationの複数履歴化
-- 出典: ISMAY_PEMサブシステム_統合正本仕様書_v4_0 11章

ALTER TABLE "pem_onboarding_conversations"
  ADD COLUMN "conversation_kind" TEXT NOT NULL DEFAULT 'INITIAL';

DROP INDEX "pem_onboarding_conversations_user_id_key";

CREATE INDEX "pem_onboarding_conversations_user_id_created_at_idx"
  ON "pem_onboarding_conversations"("user_id", "created_at");
