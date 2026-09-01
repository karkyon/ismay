/**
 * V5-M1-B6C-2 §4: transcriptSegmentMapping.ts pure test。
 * AI Providerへの実通信は一切行わない(fixture値を直接関数へ渡すのみ)。
 */
import { locateTranscriptSegmentCharOffsets, findAudioSegmentForSpan } from "../transcriptSegmentMapping";
import type { AiTranscriptionSegment } from "../../ai/transcriptionProvider";

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

console.log("=== transcriptSegmentMapping.test.ts ===");

// ---- locateTranscriptSegmentCharOffsets ----
{
  const rawText = "資料を金曜までに送付する。担当は田中さん。";
  const segments: AiTranscriptionSegment[] = [
    { startMs: 0, endMs: 2000, text: "資料を金曜までに送付する。" },
    { startMs: 2000, endMs: 4000, text: "担当は田中さん。" },
  ];
  const located = locateTranscriptSegmentCharOffsets(rawText, segments);
  ok("[正常系] 2segmentとも位置特定できる", located.length === 2, String(located.length));
  ok("[正常系] 1件目のcharStart=0", located[0]?.charStart === 0);
  ok("[正常系] 1件目のcharEndがsegment1文字数と一致", located[0]?.charEnd === "資料を金曜までに送付する。".length);
  ok("[正常系] 2件目のcharStartが1件目のcharEndと連続する", located[1]?.charStart === located[0]?.charEnd);
  ok("[正常系] segmentIndexが元の配列順を保持する", located[0]?.segmentIndex === 0 && located[1]?.segmentIndex === 1);
}
{
  // [捏造しない・是正の核心] Providerの書き起こし文とtranscript全体文とで表記が
  // 一致しないsegmentは、位置を捏造せず黙って結果から除外する。
  const rawText = "資料を金曜までに送付する。担当は田中さん。";
  const segments: AiTranscriptionSegment[] = [
    { startMs: 0, endMs: 2000, text: "資料を金曜までに送付する。" },
    { startMs: 2000, endMs: 4000, text: "存在しない書き起こし文" },
  ];
  const located = locateTranscriptSegmentCharOffsets(rawText, segments);
  ok("[捏造しない] 位置特定できないsegmentは結果に含まれない", located.length === 1, String(located.length));
  ok("[捏造しない] 位置特定できたsegmentのみ残る(index=0)", located[0]?.segmentIndex === 0);
}
{
  // 空文字のsegment textは位置特定不能として除外する(indexOfの0文字列マッチで
  // 誤って先頭にマッチさせない)。
  const rawText = "資料を送付する。";
  const segments: AiTranscriptionSegment[] = [{ startMs: 0, endMs: 1000, text: "" }];
  const located = locateTranscriptSegmentCharOffsets(rawText, segments);
  ok("[境界値] 空文字segmentは除外される", located.length === 0, String(located.length));
}
{
  // 0件segments。
  const located = locateTranscriptSegmentCharOffsets("資料を送付する。", []);
  ok("[境界値] segments0件はlocated0件", located.length === 0);
}
{
  // 順序保証: 同じtextが複数回登場する場合、直前のsegmentの終了位置より後ろから
  // 探すため、2回目の出現位置が正しく採用される。
  const rawText = "はいはい、了解です。はいはい、対応します。";
  const segments: AiTranscriptionSegment[] = [
    { startMs: 0, endMs: 1500, text: "はいはい、了解です。" },
    { startMs: 1500, endMs: 3000, text: "はいはい、対応します。" },
  ];
  const located = locateTranscriptSegmentCharOffsets(rawText, segments);
  ok("[重複文字列] 2件とも正しい位置で特定される", located.length === 2, String(located.length));
  ok("[重複文字列] 2件目は1件目より後ろの位置", (located[1]?.charStart ?? -1) > (located[0]?.charStart ?? -1));
}

// ---- findAudioSegmentForSpan ----
{
  const rawText = "資料を金曜までに送付する。担当は田中さん。";
  const segments: AiTranscriptionSegment[] = [
    { startMs: 0, endMs: 2000, text: "資料を金曜までに送付する。" },
    { startMs: 2000, endMs: 4000, text: "担当は田中さん。" },
  ];
  const located = locateTranscriptSegmentCharOffsets(rawText, segments);
  const seg1End = "資料を金曜までに送付する。".length;

  const matched = findAudioSegmentForSpan(located, 0, 5);
  ok("[正常系] evidence spanが完全にsegment1に含まれる場合、segment1が返る", matched?.segmentIndex === 0, JSON.stringify(matched));

  const matched2 = findAudioSegmentForSpan(located, seg1End, seg1End + 3);
  ok("[正常系] evidence spanが完全にsegment2に含まれる場合、segment2が返る", matched2?.segmentIndex === 1, JSON.stringify(matched2));

  const crossing = findAudioSegmentForSpan(located, seg1End - 2, seg1End + 2);
  ok(
    "[捏造しない・境界値] evidence spanが2segmentにまたがる場合、どちらのsegmentにも属さずnullを返す",
    crossing === null,
    JSON.stringify(crossing),
  );

  const outOfRange = findAudioSegmentForSpan(located, 1000, 1005);
  ok("[捏造しない] locatedに存在しない範囲はnullを返す", outOfRange === null);
}
{
  // located0件(音声Anchorが一切無いケース、例: Providerがsegmentsを返さなかった)。
  const matched = findAudioSegmentForSpan([], 0, 5);
  ok("[境界値] located0件の場合は常にnull(捏造しない)", matched === null);
}

console.log(`\n${passed}件成功 / ${failed}件失敗`);
if (failed > 0) {
  console.log("\n失敗した項目:");
  for (const f of failures) console.log(`  - ${f}`);
  process.exit(1);
}
