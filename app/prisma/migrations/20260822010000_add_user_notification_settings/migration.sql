-- AlterTable
ALTER TABLE "users" ADD COLUMN "notify_quiet_hours_start" TEXT;
ALTER TABLE "users" ADD COLUMN "notify_quiet_hours_end" TEXT;
ALTER TABLE "users" ADD COLUMN "notify_bundle_window_minutes" INTEGER NOT NULL DEFAULT 15;
