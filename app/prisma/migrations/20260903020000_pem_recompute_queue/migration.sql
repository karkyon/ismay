-- PEM-RECOMPUTE-QUEUE: Recompute Queue(checkpoint/rebuild)
-- 出典: ISMAY_統合正本仕様書_v5_0 §22.3「Recompute QueueはPENDING/PROCESSING
-- だけを対象とする部分一意制約、FOR UPDATE SKIP LOCKED、lease、heartbeat、
-- 指数backoff、attempt上限、dead letter、generationを持つ。coalescing時に
-- generationを増加し、古いWorker結果をcommitさせない。」、DOC-05
-- (Execution Event・Session Projection仕様書) 8章「新Correctionは影響範囲を
-- mark staleし、read APIはprojectionStatus=FRESH/STALE/REBUILDING/FAILEDを
-- 返す。」、統合正本§22.2差分表CHG-035「Worker: projection
-- checkpoint/dead-letter/rebuild command追加」。

CREATE TABLE "projection_recompute_jobs" (
    "id"                        TEXT NOT NULL,
    "workspace_id"              TEXT NOT NULL,
    "responsibility_id"         TEXT NOT NULL,
    "subject_user_id"           TEXT NOT NULL,
    "projection_type"           TEXT NOT NULL,
    "status"                    TEXT NOT NULL DEFAULT 'PENDING',
    "generation"                INTEGER NOT NULL DEFAULT 1,
    "attempt"                   INTEGER NOT NULL DEFAULT 0,
    "max_attempts"              INTEGER NOT NULL DEFAULT 8,
    "lease_owner"               TEXT,
    "lease_expires_at"          TIMESTAMP(3),
    "next_attempt_at"           TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "last_checkpoint_sequence"  INTEGER,
    "derivation_version"        TEXT NOT NULL,
    "reason_code"                TEXT NOT NULL,
    "last_error_code"           TEXT,
    "last_error_digest"         TEXT,
    "completed_at"              TIMESTAMP(3),
    "created_at"                TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at"                TIMESTAMP(3) NOT NULL,

    CONSTRAINT "projection_recompute_jobs_pkey" PRIMARY KEY ("id")
);

-- [正本§22.3「PENDING/PROCESSINGだけを対象とする部分一意制約」]
-- 同一(workspace_id, responsibility_id, projection_type)についてアクティブな
-- (未完了の)Jobは高々1件。PrismaのDSLでは条件付きindexを表現できないため、
-- 生SQLのみで定義する(schema.prisma側はコメントで契約を明記)。
CREATE UNIQUE INDEX "projection_recompute_jobs_active_uq"
  ON "projection_recompute_jobs"("workspace_id", "responsibility_id", "projection_type")
  WHERE "status" IN ('PENDING', 'PROCESSING');

-- Workerのclaimクエリ(status='PENDING' AND next_attempt_at<=now()、または
-- lease切れのstatus='PROCESSING')向け。
CREATE INDEX "projection_recompute_jobs_status_next_attempt_at_idx"
  ON "projection_recompute_jobs"("status", "next_attempt_at");

CREATE INDEX "projection_recompute_jobs_workspace_id_responsibility_id_projection_type_status_idx"
  ON "projection_recompute_jobs"("workspace_id", "responsibility_id", "projection_type", "status");

ALTER TABLE "projection_recompute_jobs" ADD CONSTRAINT "projection_recompute_jobs_responsibility_id_workspace_id_fkey"
  FOREIGN KEY ("responsibility_id", "workspace_id") REFERENCES "responsibilities"("id", "workspace_id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "projection_recompute_jobs" ADD CONSTRAINT "projection_recompute_jobs_status_check"
  CHECK ("status" IN ('PENDING', 'PROCESSING', 'DONE', 'FAILED', 'DEAD_LETTER'));

ALTER TABLE "projection_recompute_jobs" ADD CONSTRAINT "projection_recompute_jobs_projection_type_check"
  CHECK ("projection_type" IN ('EXECUTION_SESSION'));

ALTER TABLE "projection_recompute_jobs" ADD CONSTRAINT "projection_recompute_jobs_reason_code_check"
  CHECK ("reason_code" IN ('CORRECTION', 'DELAYED_EVENT', 'MANUAL_REBUILD', 'DERIVATION_VERSION_CHANGE'));
