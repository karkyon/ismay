/**
 * V5-M1-B6A §3.2.2: parseOpenAiTranscriptionResponse pure test。
 * 実Providerへの通信は一切行わない(固定fixture JSONを直接渡すのみ)。
 * OpenAI verbose_json応答形式(公式文書化された安定契約)のfixtureを使う。
 */
import { parseOpenAiTranscriptionResponse } from "../openaiTranscriptionProvider";

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

console.log("=== openaiTranscriptionParse.test.ts ===");

// [fixture1] segmentsを含む典型的なverbose_json応答。
const fixtureWithSegments = {
  text: "会議を開始します。議題は来週の進捗確認です。",
  duration: 12.5,
  segments: [
    { start: 0, end: 3.2, text: "会議を開始します。" },
    { start: 3.2, end: 12.5, text: "議題は来週の進捗確認です。" },
  ],
};
{
  const result = parseOpenAiTranscriptionResponse(fixtureWithSegments, 500);
  ok("[是正の核心] segments付き応答はok:trueでsegmentsが正規化される", result.ok === true);
  if (result.ok) {
    ok("segmentsが2件", result.segments?.length === 2, String(result.segments?.length));
    ok("1件目のstartMsが0", result.segments?.[0]?.startMs === 0, String(result.segments?.[0]?.startMs));
    ok("1件目のendMsが3200(3.2秒→ミリ秒変換)", result.segments?.[0]?.endMs === 3200, String(result.segments?.[0]?.endMs));
    ok("2件目のstartMsが3200", result.segments?.[1]?.startMs === 3200, String(result.segments?.[1]?.startMs));
    ok("durationSecondsが12.5", result.durationSeconds === 12.5, String(result.durationSeconds));
  }
}

// [fixture2] segmentsを含まない応答(response_format=jsonだった場合等)。
const fixtureWithoutSegments = { text: "短いメモです。" };
{
  const result = parseOpenAiTranscriptionResponse(fixtureWithoutSegments, 300);
  ok("[是正の核心] segmentsが無い応答はsegments=undefined(空配列に捏造しない)", result.ok === true && result.segments === undefined);
}

// [fixture3] 不正なsegment(start>=end)は個別に除外され、他の有効segmentは活かす。
const fixtureWithInvalidSegment = {
  text: "テスト",
  segments: [
    { start: 0, end: 1, text: "有効" },
    { start: 5, end: 5, text: "不正(start===end)" },
    { start: 2, end: 3, text: "有効2" },
  ],
};
{
  const result = parseOpenAiTranscriptionResponse(fixtureWithInvalidSegment, 100);
  ok(
    "不正segment(start>=end)は除外され、有効な2件だけが残る",
    result.ok === true && result.segments?.length === 2,
    JSON.stringify(result.ok ? result.segments : result),
  );
}

// [fixture4] textが空の応答はFATAL。
{
  const result = parseOpenAiTranscriptionResponse({ text: "" }, 200);
  ok("textが空の応答はok:false・kind:FATAL", result.ok === false && result.kind === "FATAL");
}

console.log(`\n${passed}件成功 / ${failed}件失敗`);
if (failed > 0) {
  console.log("\n失敗した項目:");
  for (const f of failures) console.log(`  - ${f}`);
  process.exit(1);
}
