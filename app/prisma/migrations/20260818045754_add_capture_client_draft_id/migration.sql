/*
  Warnings:

  - A unique constraint covering the columns `[workspace_id,created_by,client_draft_id]` on the table `captures` will be added. If there are existing duplicate values, this will fail.

*/
-- AlterTable
ALTER TABLE "captures" ADD COLUMN     "client_draft_id" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "captures_workspace_id_created_by_client_draft_id_key" ON "captures"("workspace_id", "created_by", "client_draft_id");
