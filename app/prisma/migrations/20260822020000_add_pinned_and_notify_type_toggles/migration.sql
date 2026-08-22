-- AlterTable: responsibilities (FN-WK-03 今日の最低ライン)
ALTER TABLE "responsibilities" ADD COLUMN "pinned" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "responsibilities" ADD COLUMN "pinned_at" TIMESTAMP(3);

-- AlterTable: users (FN-NTF-01 通知種別ごとの受信可否)
ALTER TABLE "users" ADD COLUMN "notify_deadline_enabled" BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE "users" ADD COLUMN "notify_follow_up_enabled" BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE "users" ADD COLUMN "notify_risk_enabled" BOOLEAN NOT NULL DEFAULT true;
