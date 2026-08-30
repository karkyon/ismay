-- V5-M1-B5 Contract Normalization: FormationAnswerEvent.answerKind
-- 出典: ISMAY_統合正本仕様書_v5_0.md §6.4「回答には SELECTED / FREE_TEXT / UNKNOWN /
--       DEFERRED / DO_NOT_MATERIALIZE を許可する」。2026-08-30監査
--       (M1-B5a完遂・M1-C連続実装指示)で、現行DB CHECKが分冊(DOC-03)由来の
--       ANSWERED/UNKNOWN/DEFERRED/DO_NOT_MATERIALIZEのままであり、
--       統合正本(優先)と食い違っていることが判明した。
--
-- [背景] このtable(formation_answer_events)はGate M1-B1で新設されたが、
-- 対応するAnswer API(POST /:id/answers)自体がまだ実装されていない
-- (M1-B5aで新設予定)。したがって既存行は存在しない前提だが、念のため
-- 適用前にprecheckし、破壊的な自動削除は一切行わない。

DO $$
DECLARE
  legacy_answer_kind_rows integer;
BEGIN
  SELECT COUNT(*) INTO legacy_answer_kind_rows
  FROM formation_answer_events
  WHERE answer_kind = 'ANSWERED';

  IF legacy_answer_kind_rows > 0 THEN
    RAISE EXCEPTION
      'Migration aborted: % row(s) in formation_answer_events use the retired '
      'answer_kind ''ANSWERED'' which v5統合正本§6.4 replaces with SELECTED/FREE_TEXT. '
      'Manual backfill/mapping required before dropping the old CHECK. '
      'This migration does not delete or reclassify data automatically.',
      legacy_answer_kind_rows;
  END IF;
END $$;

ALTER TABLE "formation_answer_events"
  DROP CONSTRAINT "formation_answer_events_answer_kind_check";

ALTER TABLE "formation_answer_events"
  ADD CONSTRAINT "formation_answer_events_answer_kind_check"
  CHECK ("answer_kind" IN ('SELECTED', 'FREE_TEXT', 'UNKNOWN', 'DEFERRED', 'DO_NOT_MATERIALIZE'));
