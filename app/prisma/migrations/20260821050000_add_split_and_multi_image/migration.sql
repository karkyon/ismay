-- AlterTable
ALTER TABLE "captures" ADD COLUMN "split_from_capture_id" TEXT;

-- AddForeignKey
ALTER TABLE "captures" ADD CONSTRAINT "captures_split_from_capture_id_fkey"
  FOREIGN KEY ("split_from_capture_id") REFERENCES "captures"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- CreateTable
CREATE TABLE "capture_images" (
    "id" TEXT NOT NULL,
    "capture_id" TEXT NOT NULL,
    "object_key" TEXT NOT NULL,
    "page_index" INTEGER NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "capture_images_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "capture_images_capture_id_page_index_idx" ON "capture_images"("capture_id", "page_index");

-- AddForeignKey
ALTER TABLE "capture_images" ADD CONSTRAINT "capture_images_capture_id_fkey"
  FOREIGN KEY ("capture_id") REFERENCES "captures"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
