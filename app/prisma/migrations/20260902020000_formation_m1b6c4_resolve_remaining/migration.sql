-- M1-B6C-4 §6.4: resolve remaining
-- 出典: Claude向け ISMAY c503e72以降 M1-B6C・全残件連続実装指示(2026-08-31) §6.4。
--
-- formation_session_lifecycle_events.actionのCHECK制約へRESOLVE_REMAININGを追加する。
-- (PostgreSQLにALTER CONSTRAINTでの値追加は無いため、DROP→再ADDする)

ALTER TABLE "formation_session_lifecycle_events" DROP CONSTRAINT "formation_session_lifecycle_events_action_check";

ALTER TABLE "formation_session_lifecycle_events" ADD CONSTRAINT "formation_session_lifecycle_events_action_check"
  CHECK ("action" IN ('DEFER', 'DISMISS', 'RESUME', 'RETRY', 'RESOLVE_REMAINING'));
