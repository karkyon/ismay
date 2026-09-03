-- Gate PATTERN-SCHEMA-02B (§3.1)
-- case_pattern_feedback_events.pattern_id と pattern_revision_id の
-- 不整合(別Patternのpattern_idとrevisionIdの混在)をDBレベルで拒否する。
--
-- 従来: (pattern_revision_id, workspace_id) -> case_pattern_revisions への
--       単純FKのみで、pattern_idとの対応は一切検証されていなかった。
-- 修正: case_pattern_revisionsへ(id, pattern_id, workspace_id)の参照用unique
--       indexを追加し、feedback_eventsから複合FKで参照する。
--
-- forward-only migration。既存migrationの改変は行わない。

CREATE UNIQUE INDEX "case_pattern_revisions_id_pattern_ws_uq"
  ON "case_pattern_revisions"("id", "pattern_id", "workspace_id");

ALTER TABLE "case_pattern_feedback_events"
  DROP CONSTRAINT "case_pattern_feedback_events_pattern_revision_id_workspace_id_f";

ALTER TABLE "case_pattern_feedback_events"
  ADD CONSTRAINT "case_pattern_feedback_events_rev_pattern_ws_fkey"
  FOREIGN KEY ("pattern_revision_id", "pattern_id", "workspace_id")
  REFERENCES "case_pattern_revisions"("id", "pattern_id", "workspace_id")
  ON DELETE RESTRICT ON UPDATE CASCADE;
