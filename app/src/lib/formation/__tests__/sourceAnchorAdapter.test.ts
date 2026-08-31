/**
 * V5-M1-B6A §3.2.2: sourceAnchorAdapter.ts pure test。
 * AI Providerへの実通信は一切行わない(fixture値を直接関数へ渡すのみ)。
 */
import {
  buildAudioTimecodeAnchorFields,
  buildMeetingSpeakerAnchorFields,
  buildImageBboxAnchorFields,
} from "../sourceAnchorAdapter";
import { isValidSourceAnchorKindFields } from "../coreTypes";

let passed = 0;
let failed = 0;
const failures: string[] = [];

function ok(name: string, cond: boolean, detail?: string): void {
  if (cond) {
    passed++;
    console.log(`  ok - ${name}`);
  } else {
    failed++;
    failures.push(name + (detail ? ` (${detail})` : ""));
    console.log(`  NG - ${name}${detail ? ` :: ${detail}` : ""}`);
  }
}

console.log("=== sourceAnchorAdapter.test.ts ===");

// ---- AUDIO_TIMECODE ----
{
  const fields = buildAudioTimecodeAnchorFields({ startMs: 1000, endMs: 4000, text: "議題は…" }, 0);
  ok("segment有り: quality=AVAILABLE", fields.quality === "AVAILABLE");
  ok("segment有り: audioStartMs/audioEndMsが正確に転記される", fields.audioStartMs === 1000 && fields.audioEndMs === 4000);
  ok(
    "[R1-03/§3.2.1のisValidSourceAnchorKindFieldsと整合する]",
    isValidSourceAnchorKindFields({
      sourceKind: "AUDIO_TIMECODE",
      quality: fields.quality,
      unavailableReason: fields.unavailableReason,
      startOffset: null,
      endOffset: null,
      audioStartMs: fields.audioStartMs,
      audioEndMs: fields.audioEndMs,
      speakerLabel: null,
      pageIndex: null,
      imageRegion: null,
      ocrConfidence: null,
    }),
  );
}
{
  const fields = buildAudioTimecodeAnchorFields(null, null);
  ok("[捏造しない・是正の核心] segment無し: quality=UNAVAILABLE、audioStartMs/audioEndMsはnull", fields.quality === "UNAVAILABLE" && fields.audioStartMs === null && fields.audioEndMs === null);
  ok("segment無し: unavailableReasonが設定される", fields.unavailableReason === "PROVIDER_NO_TIMECODE_SEGMENTS");
  ok(
    "[isValidSourceAnchorKindFieldsと整合する(UNAVAILABLE)]",
    isValidSourceAnchorKindFields({
      sourceKind: "AUDIO_TIMECODE",
      quality: fields.quality,
      unavailableReason: fields.unavailableReason,
      startOffset: null,
      endOffset: null,
      audioStartMs: fields.audioStartMs,
      audioEndMs: fields.audioEndMs,
      speakerLabel: null,
      pageIndex: null,
      imageRegion: null,
      ocrConfidence: null,
    }),
  );
}

// ---- MEETING_SPEAKER ----
{
  const fields = buildMeetingSpeakerAnchorFields("Speaker A");
  ok("speakerLabel有り: quality=AVAILABLE", fields.quality === "AVAILABLE" && fields.speakerLabel === "Speaker A");
}
{
  const fields = buildMeetingSpeakerAnchorFields(null);
  ok(
    "[現行Providerの現実を反映] speakerLabel無し(=現行gpt-transcribeの実態): quality=UNAVAILABLE",
    fields.quality === "UNAVAILABLE" && fields.speakerLabel === null && fields.unavailableReason === "PROVIDER_NO_SPEAKER_DIARIZATION",
  );
}
{
  const fields = buildMeetingSpeakerAnchorFields("   ");
  ok("空白のみのspeakerLabelもUNAVAILABLE扱い(捏造値を弾く)", fields.quality === "UNAVAILABLE");
}

// ---- IMAGE_BBOX ----
{
  const fields = buildImageBboxAnchorFields({ pageIndex: 2, text: "…", confidence: 0.8 });
  ok("page有り: quality=AVAILABLE、pageIndex/ocrConfidenceが転記される", fields.quality === "AVAILABLE" && fields.pageIndex === 2 && fields.ocrConfidence === 0.8);
}
{
  const fields = buildImageBboxAnchorFields(null);
  ok(
    "[現行Providerの現実を反映] page無し(=現行anthropicOcrProviderの実態): quality=UNAVAILABLE",
    fields.quality === "UNAVAILABLE" && fields.pageIndex === null && fields.unavailableReason === "PROVIDER_NO_PAGE_ATTRIBUTION",
  );
}

console.log(`\n${passed}件成功 / ${failed}件失敗`);
if (failed > 0) {
  console.log("\n失敗した項目:");
  for (const f of failures) console.log(`  - ${f}`);
  process.exit(1);
}
