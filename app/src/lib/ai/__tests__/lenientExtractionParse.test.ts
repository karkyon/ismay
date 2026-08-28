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

console.log(`\n${passed}件成功 / ${failed}件失敗`);
if (failed > 0) {
  console.log("\n失敗した項目:");
  for (const f of failures) console.log(`  - ${f}`);
  process.exit(1);
}
