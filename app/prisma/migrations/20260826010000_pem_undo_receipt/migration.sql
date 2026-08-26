-- Completion Gate 2.1: Undo Receipt方式への全面移行
-- 出典: 外部監査で指摘された根本問題の是正(クライアント編集可能なsnapshotを
--       Undoの信頼元にしていたことによる改ざん耐性・冪等性の欠陥)。
--
-- Bulk Complete実行時に、復元先の真の情報(fromStatus/toStatus/completeEventId)を
-- サーバー側insert-onlyのBulkCompleteReceiptへ必ず保存する(型・PEM同意の有無に
-- 関わらず、100%のケースで作成する)。クライアントはreceiptIdだけを持ち回る。
-- 冪等記録(BulkCompleteUndoConsumption)はreceiptId単位でinsert-onlyに記録し、
-- Execution Ledgerの記録有無に一切依存しない冪等契約を実現する。

CREATE TABLE "bulk_complete_receipts" (
    "id" TEXT NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "subject_user_id" TEXT NOT NULL,
    "responsibility_id" TEXT NOT NULL,
    "operation_id" TEXT NOT NULL,
    "from_status" TEXT NOT NULL,
    "to_status" TEXT NOT NULL,
    "complete_event_id" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "bulk_complete_receipts_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "bulk_complete_receipts_responsibility_id_idx"
  ON "bulk_complete_receipts"("responsibility_id");
CREATE INDEX "bulk_complete_receipts_workspace_id_subject_user_id_idx"
  ON "bulk_complete_receipts"("workspace_id", "subject_user_id");

-- tenant境界の二重防御(v4.0 4.1節「tenantを跨ぐFK参照を禁止する」)。
-- ResponsibilityLifecycleEventと同じ複合FK参照方式を用いる。
ALTER TABLE "bulk_complete_receipts"
  ADD CONSTRAINT "bulk_complete_receipts_responsibility_workspace_fkey"
  FOREIGN KEY ("responsibility_id", "workspace_id")
  REFERENCES "responsibilities"("id", "workspace_id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "bulk_complete_receipts"
  ADD CONSTRAINT "bulk_complete_receipts_complete_event_fkey"
  FOREIGN KEY ("complete_event_id", "workspace_id")
  REFERENCES "responsibility_execution_events"("id", "workspace_id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE TABLE "bulk_complete_undo_consumptions" (
    "id" TEXT NOT NULL,
    "receipt_id" TEXT NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "subject_user_id" TEXT NOT NULL,
    "request_payload_hash" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "bulk_complete_undo_consumptions_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "bulk_complete_undo_consumptions_receipt_id_key"
  ON "bulk_complete_undo_consumptions"("receipt_id");

ALTER TABLE "bulk_complete_undo_consumptions"
  ADD CONSTRAINT "bulk_complete_undo_consumptions_receipt_id_fkey"
  FOREIGN KEY ("receipt_id")
  REFERENCES "bulk_complete_receipts"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;
