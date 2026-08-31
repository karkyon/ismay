import type { AiTranscriptionSegment } from "@/lib/ai/transcriptionProvider";
import type { AiOcrPage } from "@/lib/ai/ocrProvider";
import type { SourceAnchorQuality } from "@/lib/formation/coreTypes";

/**
 * V5-M1-B6A §3.2.2: Provider Adapter層(正規化Source Unit ⇔ FormationSourceAnchor
 * kind固有fieldの変換)。
 *
 * [設計方針] このfileはAI Providerを一切importしない、純粋な変換関数の集まり。
 * 「あるsegment/pageが実際にどのCandidateのevidenceに対応するか」の突合せ
 * ロジック(§3.2.3 Candidate Evidence接続)はここに含まない——この層の責務は
 * 「1件のsegment/page(または'無い'という事実)を、FormationSourceAnchorの
 * kind固有fieldへ機械的に変換する」ことだけに限定する。
 *
 * 全関数に共通する原則(§3.2.2「Providerがtimecode/bbox/speakerを返さない
 * 場合は、それを捏造しない。UNAVAILABLE品質として保存し、Text Anchorへ
 * 安全にfallbackする」): 入力がnull/undefinedの場合は必ずquality=UNAVAILABLE
 * を返し、具体的なunavailableReasonを添える。呼出元(§3.2.3で実装予定)は
 * UNAVAILABLEの場合、TEXT_OFFSET Anchorを代わりに使う。
 */

export interface AudioTimecodeAnchorFields {
  quality: SourceAnchorQuality;
  audioStartMs: number | null;
  audioEndMs: number | null;
  segmentIndex: number | null;
  unavailableReason: string | null;
}

/**
 * 文字起こしsegment1件をAUDIO_TIMECODE Anchor用fieldへ変換する。
 * `segment`が null の場合(Providerがsegmentsを返さなかった、または該当する
 * segmentが見つからなかった)はUNAVAILABLEを返す。
 */
export function buildAudioTimecodeAnchorFields(
  segment: AiTranscriptionSegment | null,
  segmentIndex: number | null,
): AudioTimecodeAnchorFields {
  if (!segment) {
    return {
      quality: "UNAVAILABLE",
      audioStartMs: null,
      audioEndMs: null,
      segmentIndex: null,
      // [openaiTranscriptionProvider.ts参照] response_format=verbose_jsonでも
      // segmentsが空/欠落することは実際にありうる(短い無音音声等)。
      unavailableReason: "PROVIDER_NO_TIMECODE_SEGMENTS",
    };
  }
  return {
    quality: "AVAILABLE",
    audioStartMs: segment.startMs,
    audioEndMs: segment.endMs,
    segmentIndex,
    unavailableReason: null,
  };
}

export interface MeetingSpeakerAnchorFields {
  quality: SourceAnchorQuality;
  speakerLabel: string | null;
  unavailableReason: string | null;
}

/**
 * 話者ラベル1件をMEETING_SPEAKER Anchor用fieldへ変換する。
 * [現状の記録・2026-08-31] このリポジトリのTranscription Provider
 * (openaiTranscriptionProvider.ts、OpenAI gpt-transcribe)は話者分離
 * (speaker diarization)機能を持たないため、実運用では常に`speakerLabel=null`
 * でこの関数が呼ばれ、常にUNAVAILABLEを返す。これは「未実装」ではなく
 * 「現行Providerには無い機能」という診断結果であり、話者分離対応Provider
 * (例: 別事業者のdiarization機能付きAPI)を導入するまで変わらない。
 */
export function buildMeetingSpeakerAnchorFields(speakerLabel: string | null): MeetingSpeakerAnchorFields {
  if (!speakerLabel || speakerLabel.trim().length === 0) {
    return { quality: "UNAVAILABLE", speakerLabel: null, unavailableReason: "PROVIDER_NO_SPEAKER_DIARIZATION" };
  }
  return { quality: "AVAILABLE", speakerLabel, unavailableReason: null };
}

export interface ImageBboxAnchorFields {
  quality: SourceAnchorQuality;
  pageIndex: number | null;
  ocrConfidence: number | null;
  unavailableReason: string | null;
}

/**
 * OCRページ1件をIMAGE_BBOX Anchor用fieldへ変換する。
 * [現状の記録・2026-08-31] 現行OCR Provider(anthropicOcrProvider.ts、Claude
 * Vision)は複数ページを1本の連続した書き起こしへ結合する設計であり、
 * ページ単位で応答を切り分ける手段が無い(ocrProvider.ts AiOcrOutcome型doc
 * 参照)。したがって実運用では常に`page=null`でこの関数が呼ばれ、常に
 * UNAVAILABLEを返す。bbox座標自体もこのProviderには存在しないため、
 * imageRegionを本関数では扱わない(呼出元がAIの元evidenceSpansから別途
 * TEXT_OFFSET Anchorとしてfallbackする)。
 */
export function buildImageBboxAnchorFields(page: AiOcrPage | null): ImageBboxAnchorFields {
  if (!page) {
    return { quality: "UNAVAILABLE", pageIndex: null, ocrConfidence: null, unavailableReason: "PROVIDER_NO_PAGE_ATTRIBUTION" };
  }
  return {
    quality: "AVAILABLE",
    pageIndex: page.pageIndex,
    ocrConfidence: typeof page.confidence === "number" ? page.confidence : null,
    unavailableReason: null,
  };
}
