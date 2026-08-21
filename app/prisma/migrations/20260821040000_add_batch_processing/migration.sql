-- AlterTable
ALTER TABLE "captures" ADD COLUMN "processing_priority" TEXT NOT NULL DEFAULT 'REALTIME';

-- AlterTable
ALTER TABLE "ai_runs" ADD COLUMN "batch" BOOLEAN NOT NULL DEFAULT false;
