-- M1-B6C-2: Source Anchor live配線(AUDIO_TIMECODE)
-- 出典: Claude向け ISMAY c503e72以降 M1-B6C・全残件連続実装指示(2026-08-31) §4。
--
-- 文字起こしAiRunがProviderから受け取ったsegments(startMs/endMs/text)を
-- 保存するための列を追加する。既存行は全てNULL(文字起こし以外のAiRun、または
-- このGate以前に作られた文字起こしAiRun=segmentsは元々破棄されていたため
-- 復元不能。これらのCaptureはAUDIO_TIMECODE Anchorが引き続きUNAVAILABLEになる
-- だけで、データ不整合や捏造は発生しない)。

ALTER TABLE "ai_runs" ADD COLUMN "transcript_segments" JSONB;
