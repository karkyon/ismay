-- V5-M1-B5a: FormationQuestion/FormationAnswerEvent schema expansion
-- 出典: ISMAY_統合正本仕様書_v5_0.md §6.4「Question Policy」・§6.6「FormationQuestion:
--       質問本文、優先度、理由、対象candidate」「FormationAnswerEvent: 本人回答。
--       Question行を更新しない」、DOC-03 §7「POST /:id/answers | clientEventId unique」。
-- 2026-08-30監査(M1-B5a完遂・M1-C連続実装指示)§3.2で要求された最小expand migration。
--
-- [このmigrationの内容]
-- 1. formation_questions へ prompt_text/priority/reason_code/score_value を追加する
--    (質問本文snapshot・優先度・選定理由code・スコア算出値。統合正本§6.6が要求する
--    「質問本文、優先度、理由、対象candidate」のうち対象candidateは既存candidate_idで
--    充足済みのため、残り3項目+算出根拠のscore_valueを追加する)。
-- 2. formation_answer_events へ client_event_id を追加し、
--    (workspace_id, actor_user_id, client_event_id)で一意制約を張る(DOC-03 §7の
--    冪等性契約)。
-- 3. 適用前に両テーブルが空であることをprecheckする。このリポジトリには
--    Question/Answer APIがまだ一度も実装されていない(M1-B5aで新設予定)ため、
--    本番運用中の既存行は存在しない前提だが、想像で仮定せず実際にCOUNTしてから
--    NOT NULL列を追加する。既存行が見つかった場合は例外を出して安全停止し、
--    自動backfillや削除は一切行わない。

DO $$
DECLARE
  existing_questions integer;
  existing_answers integer;
BEGIN
  SELECT COUNT(*) INTO existing_questions FROM formation_questions;
  SELECT COUNT(*) INTO existing_answers FROM formation_answer_events;

  IF existing_questions > 0 OR existing_answers > 0 THEN
    RAISE EXCEPTION
      'Migration aborted: formation_questions has % row(s), formation_answer_events has '
      '% row(s). This migration adds NOT NULL columns (prompt_text, priority, reason_code, '
      'score_value on formation_questions; client_event_id on formation_answer_events) '
      'under the assumption that no Question/Answer API has ever been implemented '
      '(verified against HEAD prior to Gate M1-B5a). Manual backfill required before '
      'proceeding. This migration does not delete or backfill data automatically.',
      existing_questions, existing_answers;
  END IF;
END $$;

-- =====================================================================
-- 1. formation_questions
-- =====================================================================

ALTER TABLE "formation_questions" ADD COLUMN "prompt_text" TEXT;
ALTER TABLE "formation_questions" ALTER COLUMN "prompt_text" SET NOT NULL;

ALTER TABLE "formation_questions" ADD COLUMN "priority" TEXT;
ALTER TABLE "formation_questions" ALTER COLUMN "priority" SET NOT NULL;
ALTER TABLE "formation_questions"
  ADD CONSTRAINT "formation_questions_priority_check"
  CHECK ("priority" IN ('P0', 'P1', 'P2'));

ALTER TABLE "formation_questions" ADD COLUMN "reason_code" TEXT;
ALTER TABLE "formation_questions" ALTER COLUMN "reason_code" SET NOT NULL;

ALTER TABLE "formation_questions" ADD COLUMN "score_value" DECIMAL(7, 4);
ALTER TABLE "formation_questions" ALTER COLUMN "score_value" SET NOT NULL;

-- =====================================================================
-- 2. formation_answer_events: clientEventId冪等性
-- =====================================================================

ALTER TABLE "formation_answer_events" ADD COLUMN "client_event_id" TEXT;
ALTER TABLE "formation_answer_events" ALTER COLUMN "client_event_id" SET NOT NULL;

ALTER TABLE "formation_answer_events"
  ADD CONSTRAINT "formation_answer_events_workspace_actor_client_event_uq"
  UNIQUE ("workspace_id", "actor_user_id", "client_event_id");
