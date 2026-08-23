-- FN-PEM-01対応: 初回対話ConversationState永続化テーブル(TBL番号未採番)
CREATE TABLE "pem_onboarding_conversations" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "state" TEXT NOT NULL DEFAULT 'ROLE',
    "messages" JSONB NOT NULL DEFAULT '[]',
    "proposed_facts" JSONB NOT NULL DEFAULT '[]',
    "proposed_hypotheses" JSONB NOT NULL DEFAULT '[]',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "completed_at" TIMESTAMP(3),

    CONSTRAINT "pem_onboarding_conversations_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "pem_onboarding_conversations_user_id_key" ON "pem_onboarding_conversations"("user_id");

-- AddForeignKey
ALTER TABLE "pem_onboarding_conversations" ADD CONSTRAINT "pem_onboarding_conversations_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- FN-PEM系対応: Captureに紐付かないAI呼び出しのコスト集計用(admin/ai-usage漏れ防止)
ALTER TABLE "ai_runs" ADD COLUMN "workspace_id" TEXT;
