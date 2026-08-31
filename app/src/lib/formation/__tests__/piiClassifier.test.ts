/**
 * V5-M1-B6 PII分類器 pure test。
 * 既存 formation/__tests__/questionPolicy.test.ts と同じdb非依存パターン。
 */
import { classifyPii } from "../piiClassifier";
import { PII_CLASSIFICATIONS } from "../../pem/coreTypes";

let passed = 0;
let failed = 0;
const failures: string[] = [];

function ok(name: string, cond: boolean, detail?: string): void {
  if (cond) {
    passed++;
    console.log(`  ok - ${name}`);
  } else {
    failed++;
    failures.push(`${name}${detail ? ` (${detail})` : ""}`);
    console.log(`  FAIL - ${name}${detail ? ` (${detail})` : ""}`);
  }
}

console.log("=== piiClassifier.test.ts ===");

// [R1-05是正・監査是正指示書2026-08-31] 是正前は「通常文はNONE」だったが、
// NONE(分類済みでPII無しと確認)とUNCLASSIFIED(未分類/判定不能)を混同していた。
// email/電話番号を検出できないだけでは「PII無しと確認した」ことにならないため、
// このv1分類器はUNCLASSIFIEDを返す。
ok("PII_CLASSIFICATIONSは5値ちょうど(R1-05でUNCLASSIFIED追加)", PII_CLASSIFICATIONS.length === 5);
ok("PII_CLASSIFICATIONSにUNCLASSIFIEDが含まれる", (PII_CLASSIFICATIONS as readonly string[]).includes("UNCLASSIFIED"));

ok("通常の日本語文はUNCLASSIFIED(NONEではない・是正の核心)", classifyPii("見積書を明日までに送付する") === "UNCLASSIFIED");
ok("空文字列(anchor品質が低い場合)もUNCLASSIFIED(NONEへ倒さない)", classifyPii("") === "UNCLASSIFIED");

ok("メールアドレスを含む文はHIGH", classifyPii("連絡先は taro.yamada@example.co.jp です") === "HIGH");
ok("メールアドレスのみもHIGH", classifyPii("taro@example.com") === "HIGH");

ok("携帯電話番号(ハイフン区切り)を含む文はHIGH", classifyPii("090-1234-5678へ電話してください") === "HIGH");
ok("固定電話番号(市外局番)を含む文はHIGH", classifyPii("03-1234-5678が代表番号です") === "HIGH");
ok("国際表記(+81)の電話番号もHIGH", classifyPii("+81-90-1234-5678まで") === "HIGH");

ok("単なる日付(2026-08-30)はHIGHにならない(電話番号patternとは区別)", classifyPii("2026-08-30までに提出する") === "UNCLASSIFIED", classifyPii("2026-08-30までに提出する"));
ok("単なる金額(1000-2000円)はHIGHにならない", classifyPii("予算は1000-2000円程度") === "UNCLASSIFIED", classifyPii("予算は1000-2000円程度"));

ok(
  "[是正の核心] classifyPiiはどんな入力でもNONEを返さない(このv1はNONEを名乗る資格が無い)",
  ["見積書を明日までに送付する", "", "2026-08-30までに提出する", "予算は1000-2000円程度", "普通の文章です"].every(
    (s) => classifyPii(s) !== "NONE",
  ),
);

console.log(`\n=== 結果: ${passed} passed, ${failed} failed ===`);
if (failed > 0) {
  console.log("失敗一覧:");
  for (const f of failures) console.log(`  - ${f}`);
  process.exit(1);
}
