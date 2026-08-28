/**
 * [2026-08-28新設] FN-AI-01抽出スキーマの寛容パース不変条件テスト。
 *
 * 実障害の再現テスト: claude-haiku-4-5がevidenceSpansを配列ではなく説明文字列で
 * 返した候補が1件混じっただけで、Zodの厳格な.safeParse(ExtractionResultSchema)が
 * candidates配列全体をinvalidにし、他の正しい候補まで道連れで失われて
 * Capture=FAILEDになっていた(Zod v4は宣言型ではなく実行時の値の型でtoo_big
 * メッセージを組み立てるため、"expected array, received string"と
 * "Too big: expected string to have <=20 characters"の2つのissueが同一fieldから
 * 同時に出る)。parseExtractionResultLenient()は候補単位で検証し、壊れた候補だけを
 * 落として有効な候補を採用する(全滅時のみ失敗扱い)。
 */
import { parseExtractionResultLenient } from "../schema";

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

console.log("FN-AI-01 parseExtractionResultLenient 不変条件テスト");

// -------------------------------------------------------------------
// 実障害の再現: 2件中1件のevidenceSpansが文字列(壊れている)
// -------------------------------------------------------------------
const mixed = {
  candidates: [
    {
      candidateId: "c1",
      type: "TASK",
      title: "VPN回線開設をNTTへ依頼",
      evidenceSpans: [{ start: 0, end: 10 }],
      confidence: 0.8,
    },
    {
      candidateId: "c2",
      type: "TASK",
      title: "壊れた候補",
      // 実障害の再現: 配列ではなく文字列(かつ20文字超)
      evidenceSpans: "この根拠は場所を特定できませんでした(20文字を超える説明文)",
      confidence: 0.5,
    },
  ],
  captureSummary: "工場VPN整備の見積依頼",
};
const mixedResult = parseExtractionResultLenient(mixed);
ok("実障害再現: 混在ケースはok=true(全滅にならない)", mixedResult.ok === true);
if (mixedResult.ok) {
  ok(
    "実障害再現: 壊れていない候補(c1)のみ残る",
    mixedResult.candidates.length === 1 && mixedResult.candidates[0]?.candidateId === "c1",
  );
  ok("実障害再現: droppedCount=1", mixedResult.droppedCount === 1);
  ok(
    "実障害再現: dropReasonsにindex[1]への言及が含まれる",
    mixedResult.dropReasons[0]?.includes("candidates[1]") ?? false,
  );
  ok("実障害再現: captureSummaryは保持される", mixedResult.captureSummary === "工場VPN整備の見積依頼");
}

// -------------------------------------------------------------------
// 全滅(1件だけであり、それが壊れている) → 失敗扱い(再試行対象)
// -------------------------------------------------------------------
const allBroken = {
  candidates: [{ candidateId: "c1", type: "TASK", title: "x", evidenceSpans: "bad", confidence: 0.5 }],
};
const allBrokenResult = parseExtractionResultLenient(allBroken);
ok("全滅ケース: ok=false(有効な候補が1件も残らない場合は失敗扱い)", allBrokenResult.ok === false);

// -------------------------------------------------------------------
// 元々0件(AIが「抽出対象なし」と判断) → 正常系(失敗ではない)
// -------------------------------------------------------------------
const empty = { candidates: [] };
const emptyResult = parseExtractionResultLenient(empty);
ok("0件ケース: ok=true(空は元から正常な結果)", emptyResult.ok === true);
if (emptyResult.ok) {
  ok("0件ケース: candidates=[]", emptyResult.candidates.length === 0);
  ok("0件ケース: droppedCount=0", emptyResult.droppedCount === 0);
}

// -------------------------------------------------------------------
// トップレベル構造自体が壊れている(candidatesが配列ですらない)
// -------------------------------------------------------------------
const structurallyBroken = { candidates: "not an array" };
const structurallyBrokenResult = parseExtractionResultLenient(structurallyBroken);
ok(
  "構造破壊ケース: ok=false(候補単位の問題ではなく構造的失敗として扱う)",
  structurallyBrokenResult.ok === false,
);

// -------------------------------------------------------------------
// 全件正常(回帰確認: 従来の正常系を壊していないこと)
// -------------------------------------------------------------------
const allGood = {
  candidates: [
    { candidateId: "c1", type: "TASK", title: "a", evidenceSpans: [{ start: 0, end: 5 }], confidence: 0.9 },
    { candidateId: "c2", type: "WAITING", title: "b", evidenceSpans: [{ start: 6, end: 10 }], confidence: 0.7 },
  ],
};
const allGoodResult = parseExtractionResultLenient(allGood);
ok("全件正常ケース: ok=true・2件とも残る・droppedCount=0", allGoodResult.ok === true);
if (allGoodResult.ok) {
  ok("全件正常ケース: 2件とも残る", allGoodResult.candidates.length === 2);
  ok("全件正常ケース: droppedCount=0", allGoodResult.droppedCount === 0);
}

// -------------------------------------------------------------------
// candidates最大20件の上限はshape段階で維持される
// -------------------------------------------------------------------
const tooMany = { candidates: Array.from({ length: 21 }, (_, i) => ({ candidateId: `c${i}`, type: "TASK", title: "x", evidenceSpans: [{ start: 0, end: 1 }], confidence: 0.5 })) };
const tooManyResult = parseExtractionResultLenient(tooMany);
ok("21件ケース: ok=false(候補数上限20はshape段階で維持される)", tooManyResult.ok === false);

// -------------------------------------------------------------------
// candidatesがJSON化された文字列で返るケース(実障害再現) → coerceして救済される
// -------------------------------------------------------------------
const stringifiedCandidates = {
  candidates: JSON.stringify([
    { candidateId: "c1", type: "TASK", title: "文字列化された配列からの復元", evidenceSpans: [{ start: 0, end: 5 }], confidence: 0.8 },
  ]),
  captureSummary: "文字列化ケース",
};
const stringifiedResult = parseExtractionResultLenient(stringifiedCandidates);
ok("文字列化candidates再現: ok=true(JSON.parseで救済される)", stringifiedResult.ok === true);
if (stringifiedResult.ok) {
  ok("文字列化candidates再現: 候補1件が復元される", stringifiedResult.candidates.length === 1 && stringifiedResult.candidates[0]?.candidateId === "c1");
}

// candidatesが文字列だが、JSONとしてparseできない(本当に壊れている)場合は従来通り失敗
const stringifiedButInvalid = { candidates: "これは配列のJSON文字列ではありません" };
const stringifiedButInvalidResult = parseExtractionResultLenient(stringifiedButInvalid);
ok("文字列化candidates(JSONとして不正): ok=false(救済されない)", stringifiedButInvalidResult.ok === false);

// -------------------------------------------------------------------
// dateMentions.normalizedAtがタイムゾーンオフセット付き(実障害再現) → 受理される
// -------------------------------------------------------------------
const withOffsetDate = {
  candidates: [
    {
      candidateId: "c1",
      type: "TASK",
      title: "来週火曜までに月次レポートを提出",
      evidenceSpans: [{ start: 0, end: 10 }],
      confidence: 0.8,
      dateMentions: [
        {
          rawExpression: "来週火曜",
          // 実障害の再現: UTC('Z')ではなくAsia/Tokyoのオフセット付き(+09:00)。
          // offset:true指定前はz.string().datetime()がこれを一律拒否し、
          // 日付言及を含む候補だけの単発Captureが丸ごとFAILEDになっていた。
          normalizedAt: "2026-09-01T09:00:00+09:00",
          meaning: "HARD_DEADLINE",
          timezone: "Asia/Tokyo",
          confidence: 0.9,
        },
      ],
    },
  ],
};
const withOffsetDateResult = parseExtractionResultLenient(withOffsetDate);
ok("オフセット付き日時再現: ok=true(候補が落ちない)", withOffsetDateResult.ok === true);
if (withOffsetDateResult.ok) {
  ok("オフセット付き日時再現: 候補1件が残る", withOffsetDateResult.candidates.length === 1);
  ok(
    "オフセット付き日時再現: normalizedAtがそのまま保持される",
    withOffsetDateResult.candidates[0]?.dateMentions[0]?.normalizedAt === "2026-09-01T09:00:00+09:00",
  );
}

// -------------------------------------------------------------------
// 日付のみ("2026-09-01"、時刻無し)も受理される
// -------------------------------------------------------------------
const withDateOnly = {
  candidates: [
    {
      candidateId: "c1",
      type: "TASK",
      title: "来週火曜までに月次レポートを提出",
      evidenceSpans: [{ start: 0, end: 10 }],
      confidence: 0.8,
      dateMentions: [
        {
          rawExpression: "来週火曜",
          normalizedAt: "2026-09-01",
          meaning: "HARD_DEADLINE",
          timezone: "Asia/Tokyo",
          confidence: 0.9,
        },
      ],
    },
  ],
};
const withDateOnlyResult = parseExtractionResultLenient(withDateOnly);
ok("日付のみnormalizedAt再現: ok=true(候補が落ちない)", withDateOnlyResult.ok === true);
if (withDateOnlyResult.ok) {
  ok("日付のみnormalizedAt再現: 候補1件が残る", withDateOnlyResult.candidates.length === 1);
}

// -------------------------------------------------------------------
// 実障害の生ログをそのまま再現(2026-08-28 omega-dev2 journalctlより採取):
// 配列自体は正しく閉じているが、末尾に"<parameter name=\"captureSummary\">..."という
// XML風の余剰テキストが混入するケース。
// -------------------------------------------------------------------
const realWorldTrailingXmlArtifact = {
  candidates:
    '[\n' +
    '  {\n' +
    '    "candidateId": "cand_001",\n' +
    '    "type": "TASK",\n' +
    '    "title": "月次レポートを作成して提出する",\n' +
    '    "description": "来週火曜までに月次レポートを作成し提出する必要がある",\n' +
    '    "evidenceSpans": [\n' +
    '      {\n' +
    '        "start": 0,\n' +
    '        "end": 27\n' +
    '      }\n' +
    '    ],\n' +
    '    "confidence": 0.95,\n' +
    '    "dateMentions": [\n' +
    '      {\n' +
    '        "rawExpression": "来週火曜",\n' +
    '        "meaning": "HARD_DEADLINE",\n' +
    '        "normalizedAt": "2026-09-01",\n' +
    '        "timezone": "Asia/Tokyo",\n' +
    '        "confidence": 0.9\n' +
    '      }\n' +
    '    ]\n' +
    '  }\n' +
    '],\n' +
    '<parameter name="captureSummary">来週火曜までに月次レポートを作成して提出する',
};
const trailingXmlResult = parseExtractionResultLenient(realWorldTrailingXmlArtifact);
ok("実障害再現(末尾XML風混入): ok=true(末尾切り捨てで救済される)", trailingXmlResult.ok === true);
if (trailingXmlResult.ok) {
  ok("実障害再現(末尾XML風混入): 候補1件が復元される", trailingXmlResult.candidates.length === 1);
  ok(
    "実障害再現(末尾XML風混入): 日付のみのnormalizedAt('2026-09-01')が受理される",
    trailingXmlResult.candidates[0]?.dateMentions[0]?.normalizedAt === "2026-09-01",
  );
}

// 同じ実障害の別バリエーション: 末尾が`"captureSummary": "..."`(JSONの続き)の場合
const realWorldTrailingJsonArtifact = {
  candidates:
    '[\n' +
    '  {\n' +
    '    "candidateId": "cand_001",\n' +
    '    "type": "TASK",\n' +
    '    "title": "月次レポートを作成して提出する",\n' +
    '    "evidenceSpans": [{ "start": 0, "end": 27 }],\n' +
    '    "confidence": 0.95\n' +
    '  }\n' +
    '],\n' +
    '"captureSummary": "来週火曜までに月次レポートを作成して提出する"\n',
};
const trailingJsonResult = parseExtractionResultLenient(realWorldTrailingJsonArtifact);
ok("実障害再現(末尾JSON風混入): ok=true(末尾切り捨てで救済される)", trailingJsonResult.ok === true);
if (trailingJsonResult.ok) {
  ok("実障害再現(末尾JSON風混入): 候補1件が復元される", trailingJsonResult.candidates.length === 1);
}

console.log(`\n${passed}件成功 / ${failed}件失敗`);
if (failed > 0) {
  console.log("\n失敗した項目:");
  for (const f of failures) console.log(`  - ${f}`);
  process.exit(1);
}
