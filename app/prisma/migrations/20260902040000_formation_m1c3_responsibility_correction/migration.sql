-- M1-C3: Materialized Responsibility Split Correction
-- 出典: 統合正本仕様書v5.0 §11.4「分解Transaction」、EVAL・受入テスト仕様書 EV-A-004。
-- [scope宣言] このGateではSPLITのみ実装する。correction_typeの値としてMERGEを
-- 予約するが、Merge transaction本体は別Gateで実装する(想像で先行実装しない)。

CREATE TABLE "responsibility_correction_receipts" (
    "id"                        TEXT NOT NULL,
    "workspace_id"              TEXT NOT NULL,
    "source_responsibility_id"  TEXT NOT NULL,
    "correction_type"           TEXT NOT NULL,
    "expected_version"          INTEGER NOT NULL,
    "idempotency_key"           TEXT NOT NULL,
    "request_payload_hash"      TEXT NOT NULL,
    "reason_code"               TEXT,
    "actor_user_id"             TEXT NOT NULL,
    "occurred_at"                TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "responsibility_correction_receipts_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "responsibility_correction_result_items" (
    "id"                    TEXT NOT NULL,
    "workspace_id"          TEXT NOT NULL,
    "receipt_id"            TEXT NOT NULL,
    "new_responsibility_id" TEXT NOT NULL,
    "created_at"            TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "responsibility_correction_result_items_pkey" PRIMARY KEY ("id")
);

-- [M1-C3新設] 元Responsibilityが分割済みの場合、対応するReceipt.idを保持する。
-- 統合正本§11.4「元責任の履歴は削除しない」のため、responsibilitiesテーブル自体は
-- 物理削除せずこの列のみ追加する。
ALTER TABLE "responsibilities" ADD COLUMN "superseded_by_receipt_id" TEXT;

CREATE UNIQUE INDEX "rcr_id_workspace_uq"
  ON "responsibility_correction_receipts"("id", "workspace_id");

CREATE UNIQUE INDEX "rcr_idempotency_uq"
  ON "responsibility_correction_receipts"("workspace_id", "idempotency_key");

CREATE INDEX "responsibility_correction_receipts_workspace_id_source_responsibility_id_idx"
  ON "responsibility_correction_receipts"("workspace_id", "source_responsibility_id");

-- [P1012回避・BulkCompleteUndoConsumptionの教訓踏襲] 列順序を
-- Prisma @relation(fields: [newResponsibilityId, workspaceId], ...)と完全一致させる。
CREATE UNIQUE INDEX "rcri_new_resp_workspace_uq"
  ON "responsibility_correction_result_items"("new_responsibility_id", "workspace_id");

CREATE INDEX "responsibility_correction_result_items_workspace_id_receipt_id_idx"
  ON "responsibility_correction_result_items"("workspace_id", "receipt_id");

ALTER TABLE "responsibility_correction_receipts" ADD CONSTRAINT "responsibility_correction_receipts_source_responsibility_id_workspace_id_fkey"
  FOREIGN KEY ("source_responsibility_id", "workspace_id") REFERENCES "responsibilities"("id", "workspace_id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "responsibility_correction_receipts" ADD CONSTRAINT "responsibility_correction_receipts_actor_user_id_fkey"
  FOREIGN KEY ("actor_user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "responsibility_correction_receipts" ADD CONSTRAINT "responsibility_correction_receipts_correction_type_check"
  CHECK ("correction_type" IN ('SPLIT', 'MERGE'));

ALTER TABLE "responsibility_correction_result_items" ADD CONSTRAINT "responsibility_correction_result_items_receipt_id_workspace_id_fkey"
  FOREIGN KEY ("receipt_id", "workspace_id") REFERENCES "responsibility_correction_receipts"("id", "workspace_id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "responsibility_correction_result_items" ADD CONSTRAINT "responsibility_correction_result_items_new_responsibility_id_workspace_id_fkey"
  FOREIGN KEY ("new_responsibility_id", "workspace_id") REFERENCES "responsibilities"("id", "workspace_id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "responsibilities" ADD CONSTRAINT "responsibilities_superseded_by_receipt_id_workspace_id_fkey"
  FOREIGN KEY ("superseded_by_receipt_id", "workspace_id") REFERENCES "responsibility_correction_receipts"("id", "workspace_id") ON DELETE RESTRICT ON UPDATE CASCADE;
