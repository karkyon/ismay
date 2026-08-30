-- V5-M1-C2A: 状態意味論是正(DEC-STATE-001) + Atomicity Materialize Guard
-- 出典: 2026-08-30確定指示書 Gate M1-C2A。
--
-- (1) formation_atomicity_overrides新設(expand-only)。
-- (2) DEC-STATE-001是正に伴うbackfill: 「PARTIALLY_CONFIRMEDだが
--     MaterializationReceiptItemが1件も無い(=一度もMaterializeされたことが
--     ない)」Sessionは、旧実装(recordCandidateDecisionがACCEPT+pending混在
--     だけでCONFIRM_SOMEを発火していた)が作った異常行である。新実装は
--     Materialize実行時だけ状態遷移するため、これらはREVIEW_READYへ復元する。
--     この処理は再実行安全(idempotent、対象がなくなれば0件更新)であり、
--     Receipt Itemが実在する正常なPARTIALLY_CONFIRMED行には一切触れない。
--
-- 本ファイルはPrisma engineが本サンドボックスで取得不能なため手動で作成した。

CREATE TABLE "formation_atomicity_overrides" (
    "id" TEXT NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "revision_id" TEXT NOT NULL,
    "reason_code" TEXT NOT NULL,
    "actor_user_id" TEXT NOT NULL,
    "occurred_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "formation_atomicity_overrides_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "formation_atomicity_overrides_revision_uq" ON "formation_atomicity_overrides"("revision_id");
CREATE INDEX "formation_atomicity_overrides_workspace_id_revision_id_idx" ON "formation_atomicity_overrides"("workspace_id", "revision_id");

ALTER TABLE "formation_atomicity_overrides" ADD CONSTRAINT "formation_atomicity_overrides_revision_id_workspace_id_fkey"
  FOREIGN KEY ("revision_id", "workspace_id") REFERENCES "formation_candidate_revisions"("id", "workspace_id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "formation_atomicity_overrides" ADD CONSTRAINT "formation_atomicity_overrides_actor_user_id_fkey"
  FOREIGN KEY ("actor_user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ---------------------------------------------------------------------
-- DEC-STATE-001 backfill: 異常PARTIALLY_CONFIRMED行の監査証跡付き修復
-- ---------------------------------------------------------------------
DO $$
DECLARE
  abnormal_count_before INTEGER;
  abnormal_count_after INTEGER;
BEGIN
  SELECT COUNT(*) INTO abnormal_count_before
  FROM formation_sessions fs
  WHERE fs.state = 'PARTIALLY_CONFIRMED'
    AND NOT EXISTS (
      SELECT 1
      FROM materialization_receipt_items mri
      JOIN formation_candidate_identities fci ON fci.id = mri.candidate_id
      WHERE fci.session_id = fs.id
    );

  RAISE NOTICE '[M1-C2A backfill] 異常PARTIALLY_CONFIRMED行(Receipt Item 0件)の修復対象: % 件', abnormal_count_before;

  UPDATE formation_sessions fs
  SET state = 'REVIEW_READY',
      version = fs.version + 1
  WHERE fs.state = 'PARTIALLY_CONFIRMED'
    AND NOT EXISTS (
      SELECT 1
      FROM materialization_receipt_items mri
      JOIN formation_candidate_identities fci ON fci.id = mri.candidate_id
      WHERE fci.session_id = fs.id
    );

  SELECT COUNT(*) INTO abnormal_count_after
  FROM formation_sessions fs
  WHERE fs.state = 'PARTIALLY_CONFIRMED'
    AND NOT EXISTS (
      SELECT 1
      FROM materialization_receipt_items mri
      JOIN formation_candidate_identities fci ON fci.id = mri.candidate_id
      WHERE fci.session_id = fs.id
    );

  RAISE NOTICE '[M1-C2A backfill] 修復後の残存異常行数: % 件(0であること)', abnormal_count_after;

  IF abnormal_count_after <> 0 THEN
    RAISE EXCEPTION '[M1-C2A backfill] 修復後も異常PARTIALLY_CONFIRMED行が%件残存しています。migrationを中断します。', abnormal_count_after;
  END IF;
END $$;
