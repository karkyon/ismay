-- M1-B6A §3.2.1: 正規化Source Unit(監査是正指示書2026-08-31以降の連続実装)
-- FormationSourceAnchorへAUDIO_TIMECODE/MEETING_SPEAKER/IMAGE_BBOX固有の
-- field群を追加する。既存行(TEXT_OFFSETのみ)には影響しない(全て
-- NULL許容またはdefault値を持つexpand)。

ALTER TABLE "formation_source_anchors"
  ADD COLUMN "audio_start_ms" INTEGER,
  ADD COLUMN "audio_end_ms" INTEGER,
  ADD COLUMN "segment_index" INTEGER,
  ADD COLUMN "speaker_label" TEXT,
  ADD COLUMN "speaker_confirmed" BOOLEAN,
  ADD COLUMN "page_index" INTEGER,
  ADD COLUMN "ocr_confidence" DECIMAL(4,3),
  ADD COLUMN "quality" TEXT NOT NULL DEFAULT 'AVAILABLE',
  ADD COLUMN "unavailable_reason" TEXT,
  ADD COLUMN "anchor_schema_version" TEXT NOT NULL DEFAULT '1.0';

ALTER TABLE "formation_source_anchors" ADD CONSTRAINT "formation_source_anchors_quality_check"
  CHECK ("quality" IN ('AVAILABLE', 'UNAVAILABLE'));

ALTER TABLE "formation_source_anchors" ADD CONSTRAINT "formation_source_anchors_quality_reason_check"
  CHECK (
    "quality" = 'AVAILABLE' OR
    ("quality" = 'UNAVAILABLE' AND "unavailable_reason" IS NOT NULL AND "unavailable_reason" <> '')
  );

ALTER TABLE "formation_source_anchors" ADD CONSTRAINT "formation_source_anchors_audio_ms_check"
  CHECK (
    ("audio_start_ms" IS NULL AND "audio_end_ms" IS NULL) OR
    ("audio_start_ms" IS NOT NULL AND "audio_end_ms" IS NOT NULL AND "audio_start_ms" >= 0 AND "audio_end_ms" > "audio_start_ms")
  );

ALTER TABLE "formation_source_anchors" ADD CONSTRAINT "formation_source_anchors_segment_index_check"
  CHECK ("segment_index" IS NULL OR "segment_index" >= 0);

ALTER TABLE "formation_source_anchors" ADD CONSTRAINT "formation_source_anchors_page_index_check"
  CHECK ("page_index" IS NULL OR "page_index" >= 0);

ALTER TABLE "formation_source_anchors" ADD CONSTRAINT "formation_source_anchors_ocr_confidence_check"
  CHECK ("ocr_confidence" IS NULL OR ("ocr_confidence" >= 0 AND "ocr_confidence" <= 1));
