-- M1-C3B: Materialized Responsibility Merge Correction
-- 出典: 統合正本仕様書v5.0 §11.4「分解Transaction」原則の統合方向適用、§12.8。
-- SplitはResponsibilityCorrectionReceipt(1 source→N result)を使うが、Mergeは
-- 逆にN source→1 resultであり入力形が非対称なため、独立したtableとする
-- (formation_candidate_merge_eventsがformation_candidate_lineagesとは別tableで
-- ある既存パターンと同じ設計判断)。

CREATE TABLE "responsibility_merge_receipts" (
    "id"                    TEXT NOT NULL,
    "workspace_id"          TEXT NOT NULL,
    "new_responsibility_id" TEXT NOT NULL,
    "idempotency_key"       TEXT NOT NULL,
    "request_payload_hash"  TEXT NOT NULL,
    "reason_code"           TEXT,
    "actor_user_id"         TEXT NOT NULL,
    "occurred_at"           TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "responsibility_merge_receipts_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "responsibility_merge_source_items" (
    "id"                        TEXT NOT NULL,
    "workspace_id"              TEXT NOT NULL,
    "receipt_id"                TEXT NOT NULL,
    "source_responsibility_id"  TEXT NOT NULL,
    "expected_version"          INTEGER NOT NULL,
    "created_at"                TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "responsibility_merge_source_items_pkey" PRIMARY KEY ("id")
);

-- [M1-C3B新設] このResponsibilityがMERGEで統合済み(=source側として吸収された)
-- 場合、対応するResponsibilityMergeReceipt.idを保持する。Split用の
-- superseded_by_receipt_idとは独立した列(N:1というMergeの入力形がSPLITの1:Nと
-- 非対称なため)。
ALTER TABLE "responsibilities" ADD COLUMN "superseded_by_merge_receipt_id" TEXT;

CREATE UNIQUE INDEX "mrr_id_workspace_uq"
  ON "responsibility_merge_receipts"("id", "workspace_id");

CREATE UNIQUE INDEX "mrr_idempotency_uq"
  ON "responsibility_merge_receipts"("workspace_id", "idempotency_key");

-- [P1012回避・1:1relation] Responsibility.mergeReceiptAsNewのFK列順序
-- ([newResponsibilityId, workspaceId])と完全一致させる。
CREATE UNIQUE INDEX "mrr_new_resp_workspace_uq"
  ON "responsibility_merge_receipts"("new_responsibility_id", "workspace_id");

-- [核心制約] 1 Responsibilityは生涯高々1回しかMerge対象(source)になれない。
CREATE UNIQUE INDEX "mrsi_source_workspace_uq"
  ON "responsibility_merge_source_items"("source_responsibility_id", "workspace_id");

CREATE INDEX "responsibility_merge_source_items_workspace_id_receipt_id_idx"
  ON "responsibility_merge_source_items"("workspace_id", "receipt_id");

ALTER TABLE "responsibility_merge_receipts" ADD CONSTRAINT "responsibility_merge_receipts_new_responsibility_id_workspace_id_fkey"
  FOREIGN KEY ("new_responsibility_id", "workspace_id") REFERENCES "responsibilities"("id", "workspace_id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "responsibility_merge_receipts" ADD CONSTRAINT "responsibility_merge_receipts_actor_user_id_fkey"
  FOREIGN KEY ("actor_user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "responsibility_merge_source_items" ADD CONSTRAINT "responsibility_merge_source_items_receipt_id_workspace_id_fkey"
  FOREIGN KEY ("receipt_id", "workspace_id") REFERENCES "responsibility_merge_receipts"("id", "workspace_id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "responsibility_merge_source_items" ADD CONSTRAINT "responsibility_merge_source_items_source_responsibility_id_workspace_id_fkey"
  FOREIGN KEY ("source_responsibility_id", "workspace_id") REFERENCES "responsibilities"("id", "workspace_id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "responsibilities" ADD CONSTRAINT "responsibilities_superseded_by_merge_receipt_id_workspace_id_fkey"
  FOREIGN KEY ("superseded_by_merge_receipt_id", "workspace_id") REFERENCES "responsibility_merge_receipts"("id", "workspace_id") ON DELETE RESTRICT ON UPDATE CASCADE;
