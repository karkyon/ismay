-- V5-M1-C: formation_candidate_decision_events.decision へ SPLIT/MERGED を追加
-- 出典: ISMAY_統合正本仕様書_v5_0.md §6.6「FormationDecisionEvent：
--       ACCEPT/EDIT/REJECT/MERGE/SPLIT/DEFER」、§11.4「分解Transaction」。
--
-- coreTypes.ts CANDIDATE_DECISION_EVENT_VALUESへSPLIT/MERGEDを追加したことに
-- 合わせ、既存のCHECK制約(20260827020000_formation_session_domain_foundation
-- migrationで追加、ACCEPTED/REJECTED/DEFERRED/DO_NOT_MATERIALIZEの4値)を
-- 6値へ拡張する。既存4値は変更しない(expand-only、既存rowへの影響なし)。
--
-- 本ファイルはPrisma engineが本サンドボックスで取得不能なため手動で作成した
-- (これまでのFormation関連migrationと同じ事情)。

ALTER TABLE "formation_candidate_decision_events"
  DROP CONSTRAINT "formation_candidate_decision_events_decision_check";

ALTER TABLE "formation_candidate_decision_events"
  ADD CONSTRAINT "formation_candidate_decision_events_decision_check"
  CHECK ("decision" IN ('ACCEPTED', 'REJECTED', 'DEFERRED', 'DO_NOT_MATERIALIZE', 'SPLIT', 'MERGED'));
