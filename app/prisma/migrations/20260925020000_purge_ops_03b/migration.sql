-- PURGE-OPS-03B: 30日Purgeの運用台帳(PurgeRun/PurgeItem/PurgeItemObject)。
-- 出典: DEC-PURGE-02B §7.1(2026-09-25利用者決定)のObject Storage削除順序
--   1) DB・Object Storage対象を台帳へsnapshot 2) MinIO object削除 3) object不存在を確認
--   4) DB物理削除 5) 匿名化・監査記録 6) PurgeRun完了
-- と、指示書§8「immutableな対象台帳、batch size、lease、retry/backoff、dead-letter、
-- idempotent再実行、中断再開、1ユーザーtransactionの維持、dry-run manifestと
-- execute manifestのdigest対応」。
--
-- 設計:
--   - purge_items.user_idは意図的にFKを持たない(対象ユーザーの物理削除後も削除証跡として
--     残す)。emailは保存しない。manifestは件数のみ(本文・識別子の一覧を持たない)。
--   - purge_item_objects.object_keyは完了後にNULLへ墨消しし、object_key_hash(sha256)だけを残す
--     (object keyは元ファイル名を含むため)。
--   - phaseは到達済みの工程(上記1〜6)、statusはスケジューリング状態。

CREATE TABLE "purge_runs" (
    "id" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'RUNNING',
    "os_user" TEXT NOT NULL,
    "hostname" TEXT NOT NULL,
    "pid" INTEGER NOT NULL,
    "operator_declared" TEXT,
    "batch_size" INTEGER NOT NULL,
    "max_attempts" INTEGER NOT NULL,
    "item_count" INTEGER NOT NULL,
    "plan_digest" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "finished_at" TIMESTAMP(3),
    CONSTRAINT "purge_runs_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "purge_runs_status_check" CHECK ("status" IN ('RUNNING', 'COMPLETED', 'COMPLETED_WITH_EXCEPTIONS')),
    CONSTRAINT "purge_runs_batch_size_check" CHECK ("batch_size" BETWEEN 1 AND 1000),
    CONSTRAINT "purge_runs_max_attempts_check" CHECK ("max_attempts" BETWEEN 1 AND 50)
);

CREATE TABLE "purge_items" (
    "id" TEXT NOT NULL,
    "run_id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "phase" TEXT NOT NULL DEFAULT 'NONE',
    "planned_digest" TEXT,
    "planned_manifest" JSONB,
    "actual_digest" TEXT,
    "actual_manifest" JSONB,
    "drift_count" INTEGER,
    "refusal_status" TEXT,
    "refusal_detail" TEXT,
    "audit_recorded" BOOLEAN NOT NULL DEFAULT false,
    "audit_error" TEXT,
    "late_objects_deleted" INTEGER NOT NULL DEFAULT 0,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "max_attempts" INTEGER NOT NULL,
    "next_attempt_at" TIMESTAMP(3),
    "last_error" TEXT,
    "lease_owner" TEXT,
    "lease_expires_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "completed_at" TIMESTAMP(3),
    CONSTRAINT "purge_items_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "purge_items_status_check" CHECK ("status" IN ('PENDING', 'IN_PROGRESS', 'RETRY_WAIT', 'COMPLETED', 'SKIPPED', 'DEAD_LETTER')),
    CONSTRAINT "purge_items_phase_check" CHECK ("phase" IN ('NONE', 'OBJECTS_SNAPSHOTTED', 'OBJECTS_DELETED', 'OBJECTS_VERIFIED', 'DB_PURGED', 'AUDITED', 'COMPLETED')),
    CONSTRAINT "purge_items_attempts_check" CHECK ("attempts" >= 0 AND "max_attempts" >= 1)
);

CREATE UNIQUE INDEX "purge_items_run_id_user_id_key" ON "purge_items"("run_id", "user_id");
CREATE INDEX "purge_items_run_id_status_next_attempt_at_idx" ON "purge_items"("run_id", "status", "next_attempt_at");
ALTER TABLE "purge_items" ADD CONSTRAINT "purge_items_run_id_fkey"
  FOREIGN KEY ("run_id") REFERENCES "purge_runs"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE TABLE "purge_item_objects" (
    "id" TEXT NOT NULL,
    "item_id" TEXT NOT NULL,
    "bucket" TEXT NOT NULL,
    "object_key" TEXT,
    "object_key_hash" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "deleted_at" TIMESTAMP(3),
    "verified_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "purge_item_objects_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "purge_item_objects_source_check" CHECK ("source" IN ('DB_REFERENCE', 'PREFIX_LISTING', 'LATE_PREFIX_LISTING')),
    CONSTRAINT "purge_item_objects_status_check" CHECK ("status" IN ('PENDING', 'DELETED', 'VERIFIED_ABSENT'))
);

CREATE UNIQUE INDEX "purge_item_objects_item_id_object_key_hash_key" ON "purge_item_objects"("item_id", "object_key_hash");
ALTER TABLE "purge_item_objects" ADD CONSTRAINT "purge_item_objects_item_id_fkey"
  FOREIGN KEY ("item_id") REFERENCES "purge_items"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
