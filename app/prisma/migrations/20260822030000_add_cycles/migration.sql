-- CreateTable: cycles (TBL-027 週次サイクル)
CREATE TABLE "cycles" (
    "id" TEXT NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "start_at" TIMESTAMP(3) NOT NULL,
    "end_at" TIMESTAMP(3) NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'ACTIVE',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "cycles_pkey" PRIMARY KEY ("id")
);

-- CreateTable: cycle_items (TBL-028 サイクルへコミットした責任)
CREATE TABLE "cycle_items" (
    "id" TEXT NOT NULL,
    "cycle_id" TEXT NOT NULL,
    "responsibility_id" TEXT NOT NULL,
    "carried_from_cycle_id" TEXT,
    "added_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "cycle_items_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "cycles_workspace_id_start_at_key" ON "cycles"("workspace_id", "start_at");

-- CreateIndex
CREATE UNIQUE INDEX "cycle_items_cycle_id_responsibility_id_key" ON "cycle_items"("cycle_id", "responsibility_id");

-- AddForeignKey
ALTER TABLE "cycles" ADD CONSTRAINT "cycles_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "cycle_items" ADD CONSTRAINT "cycle_items_cycle_id_fkey" FOREIGN KEY ("cycle_id") REFERENCES "cycles"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "cycle_items" ADD CONSTRAINT "cycle_items_responsibility_id_fkey" FOREIGN KEY ("responsibility_id") REFERENCES "responsibilities"("id") ON DELETE CASCADE ON UPDATE CASCADE;
