-- FN-PEM-02対応: 生イベント取り込みのeventId冪等性キー
ALTER TABLE "pem_observations" ADD COLUMN "source_event_log_id" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "pem_observations_source_event_log_id_key" ON "pem_observations"("source_event_log_id");
