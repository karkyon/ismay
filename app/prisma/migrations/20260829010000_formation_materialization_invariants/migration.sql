-- V5-M1-B3.1 Materialization不変条件・競合耐性の是正
-- 出典: ISMAY-V5-DOC-03(Formation Session仕様書) 4章「1候補1生成、tenant複合FK」、
--       6章(Materialization Transaction)。2026-08-29監査(Gate M1-B3.1指示書)
--       B31-01・B31-04・B31-06で指摘。
--
-- [監査で確定した問題]
-- materialization_receipt_items の一意制約は (receipt_id, candidate_id) のみで、
-- 「同一Receipt内」の重複しか防げず、異なるReceipt/operationIdから同じcandidateが
-- 複数回materializeされることをDBレベルで防げていなかった。
-- 同様にformation_candidate_decision_eventsには候補あたりの決定回数を制限する
-- DB制約が一切無く、application層の事前SELECT(ALREADY_DECIDED判定)のみに依存していた。
--
-- [このmigrationの内容]
-- 1. 適用前に、両テーブルで対象キーの重複が既に存在しないことを確認する
--    (存在する場合はEXCEPTIONを発生させてmigration全体を中断し、
--    自動で重複行を削除するような破壊的操作は一切行わない)。
-- 2. materialization_receipt_items へ (workspace_id, candidate_id) のglobal一意制約を追加する。
-- 3. formation_candidate_decision_events へ (workspace_id, candidate_id) の一意制約を追加する
--    (1候補につきDecision Eventは高々1件、という不変条件のDB側多層防御。
--    主たる排他制御はapplication層のSession行FOR UPDATE lockで行う)。

-- =====================================================================
-- 0. 重複データprecheck(破壊的自動修復はしない)
-- =====================================================================

DO $$
DECLARE
  dup_receipt_items integer;
  dup_decision_events integer;
BEGIN
  SELECT COUNT(*) INTO dup_receipt_items FROM (
    SELECT workspace_id, candidate_id
    FROM materialization_receipt_items
    GROUP BY workspace_id, candidate_id
    HAVING COUNT(*) > 1
  ) AS dups;

  IF dup_receipt_items > 0 THEN
    RAISE EXCEPTION
      'Migration aborted: % candidate(s) already materialized more than once '
      '(duplicate workspace_id+candidate_id in materialization_receipt_items). '
      'Manual investigation required before adding the global uniqueness constraint. '
      'This migration does not delete data automatically.',
      dup_receipt_items;
  END IF;

  SELECT COUNT(*) INTO dup_decision_events FROM (
    SELECT workspace_id, candidate_id
    FROM formation_candidate_decision_events
    GROUP BY workspace_id, candidate_id
    HAVING COUNT(*) > 1
  ) AS dups;

  IF dup_decision_events > 0 THEN
    RAISE EXCEPTION
      'Migration aborted: % candidate(s) have more than one CandidateDecisionEvent '
      '(duplicate workspace_id+candidate_id in formation_candidate_decision_events). '
      'Manual investigation required before adding the uniqueness constraint. '
      'This migration does not delete data automatically.',
      dup_decision_events;
  END IF;
END $$;

-- =====================================================================
-- 1. materialization_receipt_items: global 1-candidate-1-materialization
-- =====================================================================

ALTER TABLE "materialization_receipt_items"
  ADD CONSTRAINT "materialization_receipt_items_workspace_candidate_uq"
  UNIQUE ("workspace_id", "candidate_id");

-- =====================================================================
-- 2. formation_candidate_decision_events: 候補あたり決定は高々1件
-- =====================================================================

ALTER TABLE "formation_candidate_decision_events"
  ADD CONSTRAINT "formation_candidate_decision_events_workspace_candidate_uq"
  UNIQUE ("workspace_id", "candidate_id");
