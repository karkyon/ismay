-- R1-04: Event語彙是正(監査是正指示書2026-08-31)
-- sessionEventTypeForDecision()がSPLIT/MERGED決定をCANDIDATE_DEFERREDへ丸めていた
-- ため、Session timeline上で分解・統合が延期に見えていた問題を是正する。
-- FormationSessionEvent.event_typeのDB CHECK制約へCANDIDATE_SPLIT/CANDIDATE_MERGED
-- を追加する(16値->18値)。
--
-- [expand→switch、contractなし] 既存のCANDIDATE_DEFERRED行(過去のSPLIT/MERGED
-- 決定がtimeline上でDEFERREDとして記録されたもの)は書き換えない(履歴改変しない)。
-- CANDIDATE_DEFERREDは新しいCHECK制約でも引き続き許容値のままのため、既存行は
-- そのまま読み取り可能(読み取り互換)。新規書込みのみ、SPLIT/MERGED決定を
-- 専用codeへ記録するようapplication層(materialize.ts sessionEventTypeForDecision)
-- を切り替える。
--
-- 本ファイルはPrisma engineが本サンドボックスで取得不能なため手動で作成した。

ALTER TABLE "formation_session_events"
  DROP CONSTRAINT "formation_session_events_event_type_check";

ALTER TABLE "formation_session_events" ADD CONSTRAINT "formation_session_events_event_type_check"
  CHECK ("event_type" IN (
    'FORMATION_CREATED', 'ANALYSIS_REQUESTED', 'ANALYSIS_SUCCEEDED', 'ANALYSIS_FAILED',
    'CANDIDATE_CREATED', 'CANDIDATE_REVISED', 'SOURCE_ANCHOR_ATTACHED', 'QUESTION_ASKED',
    'ANSWER_RECORDED', 'CANDIDATE_ACCEPTED', 'CANDIDATE_REJECTED', 'CANDIDATE_DEFERRED',
    'CANDIDATE_SPLIT', 'CANDIDATE_MERGED',
    'MATERIALIZATION_COMMITTED', 'SESSION_CONFIRMED', 'SESSION_DISMISSED', 'SESSION_DEFERRED'
  ));
