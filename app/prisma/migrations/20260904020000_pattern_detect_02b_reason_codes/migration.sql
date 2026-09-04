-- Gate PATTERN-DETECT-02B: 欠落enqueue契機の追加(reason_code拡張)
-- 出典: Claude向け_ISMAY_3b695d9以降_再監査是正・CasePattern実機能完遂指示_
-- 2026-09-04.md §4。
--
-- 既存CHECK制約(case_pattern_detect_jobs_reason_code_check、
-- PRIMARY_LINKED/PRIMARY_UNLINKEDのみ許可)を、RESPONSIBILITY_CORRECTED/
-- EVIDENCE_EXCLUDEDを含む4値へ拡張する。既存migrationファイル自体は改変せず、
-- forward-onlyでCHECKを張り替える。

ALTER TABLE "case_pattern_detect_jobs" DROP CONSTRAINT "case_pattern_detect_jobs_reason_code_check";

ALTER TABLE "case_pattern_detect_jobs" ADD CONSTRAINT "case_pattern_detect_jobs_reason_code_check"
  CHECK ("reason_code" IN ('PRIMARY_LINKED', 'PRIMARY_UNLINKED', 'RESPONSIBILITY_CORRECTED', 'EVIDENCE_EXCLUDED'));
