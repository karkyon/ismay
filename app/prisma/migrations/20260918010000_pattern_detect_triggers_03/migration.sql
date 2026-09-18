-- Gate PATTERN-DETECT-TRIGGERS-03: 残り4 reason配線のうち配線できた2種
-- (EMBEDDING_MODEL_CHANGED/MANUAL_REBUILD)をreason_code CHECK制約へ追加する。
-- 出典: Claude向け_ISMAY_d68e9bf以降_ActionSlot正本準拠・CasePattern実分解
-- 完遂・残工程連続実装指示_2026-09-17.md P1「10. 残り4 reason配線」。
--
-- 既存CHECK制約(case_pattern_detect_jobs_reason_code_check、
-- PRIMARY_LINKED/PRIMARY_UNLINKED/RESPONSIBILITY_CORRECTED/EVIDENCE_EXCLUDED
-- の4値)を、20260904020000_pattern_detect_02b_reason_codesと同じ
-- forward-only張り替えパターンで6値へ拡張する。PATTERN_REVISION_CHANGED/
-- EMBEDDING_SOURCE_VERSION_CHANGEDは、対応する実在のtrigger配線元が無いこと
-- を個別精査済み(casePatternTriggers.ts冒頭コメント参照)のため、この
-- CHECK制約には追加しない(架空の値をDBスキーマへ先行登録しない)。

ALTER TABLE "case_pattern_detect_jobs" DROP CONSTRAINT "case_pattern_detect_jobs_reason_code_check";

ALTER TABLE "case_pattern_detect_jobs" ADD CONSTRAINT "case_pattern_detect_jobs_reason_code_check"
  CHECK ("reason_code" IN ('PRIMARY_LINKED', 'PRIMARY_UNLINKED', 'RESPONSIBILITY_CORRECTED', 'EVIDENCE_EXCLUDED', 'EMBEDDING_MODEL_CHANGED', 'MANUAL_REBUILD'));
