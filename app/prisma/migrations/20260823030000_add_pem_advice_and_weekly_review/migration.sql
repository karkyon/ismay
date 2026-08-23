-- FN-PEM-03対応: 仮説の自動生成元メトリクスキー(再提案防止に使う)
ALTER TABLE "pem_hypotheses" ADD COLUMN "source_metric" TEXT;

-- FN-PEM-03対応: 週次レビュー(AI-08)のキャッシュ
CREATE TABLE "pem_weekly_reviews" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "week_start" TIMESTAMP(3) NOT NULL,
    "week_end" TIMESTAMP(3) NOT NULL,
    "summary_json" JSONB NOT NULL,
    "generated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "pem_weekly_reviews_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "pem_weekly_reviews_user_id_week_start_key" ON "pem_weekly_reviews"("user_id", "week_start");

-- AddForeignKey
ALTER TABLE "pem_weekly_reviews" ADD CONSTRAINT "pem_weekly_reviews_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
