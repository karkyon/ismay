-- AlterTable
ALTER TABLE "responsibilities" ADD COLUMN "origin_inference_id" TEXT;

-- AddForeignKey
ALTER TABLE "responsibilities" ADD CONSTRAINT "responsibilities_origin_inference_id_fkey" FOREIGN KEY ("origin_inference_id") REFERENCES "ai_inferences"("id") ON DELETE SET NULL ON UPDATE CASCADE;

