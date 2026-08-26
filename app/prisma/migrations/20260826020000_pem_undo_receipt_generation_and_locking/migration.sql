-- Completion Gate 2.1: Undo Receiptの世代確認・tenant整合性強化
-- 出典: 外部監査再評価で指摘されたP0-1(古い未使用Receiptによる別完了サイクルの
--       誤取消)・DB整合性上の不足(ConsumptionのtenantがReceiptと一致することを
--       DB制約で保証していなかった)の是正。

-- [P0-1是正] responsibilityVersionAfter列を追加する。
-- 既存行(bulk_complete_receipts)は基本的に無い想定だが(このテーブルは前回
-- migrationで新設されたばかりで、実運用データは検証スクリプトが都度削除する
-- テスト行のみ)、万一残っている場合に備えてDEFAULT付きで追加してから
-- DEFAULTを外す(以後の挿入ではアプリケーション側が必ず明示的に値を渡す)。
ALTER TABLE "bulk_complete_receipts"
  ADD COLUMN "responsibility_version_after" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "bulk_complete_receipts"
  ALTER COLUMN "responsibility_version_after" DROP DEFAULT;

-- [DB整合性是正] BulkCompleteReceipt側に複合unique(id, workspace_id,
-- subject_user_id)を追加する。Consumption側からの複合FK参照先として使う。
CREATE UNIQUE INDEX "bcr_id_workspace_subject_uq"
  ON "bulk_complete_receipts"("id", "workspace_id", "subject_user_id");

-- [DB整合性是正・Prismaスキーマ検証(P1012)対応]
-- Prismaは一対一リレーションの参照元(BulkCompleteUndoConsumption)に、
-- @relationのfieldsと完全一致するunique制約を要求する。receipt_id単独の
-- unique(既存)だけでは(receipt_id, workspace_id, subject_user_id)という
-- 3列の組み合わせをカバーしないため、この複合uniqueも追加する
-- (receipt_id単独のunique制約は「1レシートにつき冪等記録は1件だけ」という
-- 冪等性の核心を保証するための別の制約であり、そのまま維持する)。
CREATE UNIQUE INDEX "bcuc_receipt_workspace_subject_uq"
  ON "bulk_complete_undo_consumptions"("receipt_id", "workspace_id", "subject_user_id");

-- [DB整合性是正] Consumption側の単一列FK(receipt_id → bulk_complete_receipts.id)を
-- 複合FK(receipt_id, workspace_id, subject_user_id →
-- bulk_complete_receipts(id, workspace_id, subject_user_id))へ差し替える。
-- これにより、ConsumptionのworkspaceId/subjectUserIdがReceiptのそれと一致しない
-- 行はDB制約レベルで拒否されるようになる(アプリケーションコードのWHERE句だけに
-- 依存しない)。
ALTER TABLE "bulk_complete_undo_consumptions"
  DROP CONSTRAINT "bulk_complete_undo_consumptions_receipt_id_fkey";

ALTER TABLE "bulk_complete_undo_consumptions"
  ADD CONSTRAINT "bulk_complete_undo_consumptions_receipt_id_fkey"
  FOREIGN KEY ("receipt_id", "workspace_id", "subject_user_id")
  REFERENCES "bulk_complete_receipts"("id", "workspace_id", "subject_user_id")
  ON DELETE RESTRICT ON UPDATE CASCADE;
