-- R1-03: DB不変条件(監査是正指示書2026-08-31)
-- - FormationCandidateMergeEvent(sessionId,workspaceId) -> FormationSession複合FK
-- - FormationCandidateLineage.parentRevisionがparentIdentityに属することを
--   複合FKで保証(2列FK -> 3列FKへ強化)
--
-- 本ファイルはPrisma engineが本サンドボックスで取得不能なため手動で作成した。
-- 既存データは全て正しいtx経路(mergeCorrection.ts/splitCorrection.ts)でのみ
-- 作られており、この制約強化に違反する行が無いことを前提とする
-- (違反行があれば、それ自体が発見すべきバグのため、migration失敗は許容する)。

-- 1) FormationCandidateRevision: (id, candidate_id, workspace_id)複合unique。
--    idは既にPKで単独一意なため、既存データへの実質的な制約追加は無い
--    (FK参照先として複合uniqueが必要なだけ)。
CREATE UNIQUE INDEX "formation_candidate_revisions_id_candidate_workspace_uq"
  ON "formation_candidate_revisions"("id", "candidate_id", "workspace_id");

-- 2) FormationCandidateLineage: parent_revision_idのFKを2列->3列へ強化。
ALTER TABLE "formation_candidate_lineages"
  DROP CONSTRAINT "formation_candidate_lineages_parent_revision_id_workspace__fkey";

ALTER TABLE "formation_candidate_lineages" ADD CONSTRAINT "formation_candidate_lineages_parent_rev_identity_ws_fkey"
  FOREIGN KEY ("parent_revision_id", "parent_identity_id", "workspace_id")
  REFERENCES "formation_candidate_revisions"("id", "candidate_id", "workspace_id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

-- 3) FormationCandidateMergeEvent: (session_id, workspace_id)複合FKを新設。
ALTER TABLE "formation_candidate_merge_events" ADD CONSTRAINT "formation_candidate_merge_events_session_id_workspace_id_fkey"
  FOREIGN KEY ("session_id", "workspace_id")
  REFERENCES "formation_sessions"("id", "workspace_id")
  ON DELETE RESTRICT ON UPDATE CASCADE;
