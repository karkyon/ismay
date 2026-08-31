-- R1-05: PII分類の意味修正(監査是正指示書2026-08-31)
-- classifyPii()は"NONE"(分類済みでPII無しと確認)と"UNCLASSIFIED"(未分類/
-- 判定不能)を混同していた。email/電話番号を検出できないことは「PII無しと
-- 確認した」ことを意味しない(氏名・住所等は判定していないため)。
--
-- 本ファイルはPrisma engineが本サンドボックスで取得不能なため手動で作成した。

-- 1) backfill: 既存のformation_source_anchors."NONE"行は、当時のclassifyPii()
--    がemail/電話番号非検出をNONEへ倒していた結果であり、「分類済みでPII無しと
--    確認済み」であることを一切証明できない(作成時のalgorithm/versionを記録
--    するfieldも存在しないため、事後的にも区別できない)。安全側に倒し、
--    全件をUNCLASSIFIEDへ移行する。件数はmigrate deploy実行時のRAISE NOTICEで
--    証跡化する。
DO $$
DECLARE
  backfilled_count INTEGER;
BEGIN
  UPDATE "formation_source_anchors" SET "pii_classification" = 'UNCLASSIFIED' WHERE "pii_classification" = 'NONE';
  GET DIAGNOSTICS backfilled_count = ROW_COUNT;
  RAISE NOTICE '[R1-05 backfill] formation_source_anchors: NONE -> UNCLASSIFIED backfilled % row(s)', backfilled_count;
END $$;

-- 2) switch: DB CHECK制約を新設し、pii_classificationを5値へ制限する
--    (これまでCHECK制約が存在しなかったため、application層のTypeScript型
--    のみに依存していた)。
ALTER TABLE "formation_source_anchors" ADD CONSTRAINT "formation_source_anchors_pii_classification_check"
  CHECK ("pii_classification" IN ('NONE', 'LOW', 'MEDIUM', 'HIGH', 'UNCLASSIFIED'));
