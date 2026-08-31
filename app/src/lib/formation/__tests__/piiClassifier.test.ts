/**
 * V5-M1-B6 PII分類器 pure test。
 * 既存 formation/__tests__/questionPolicy.test.ts と同じdb非依存パターン。
 */
import { classifyPii } from "../piiClassifier";

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

ok("通常の日本語文はNONE", classifyPii("見積書を明日までに送付する") === "NONE");
ok("空文字列はNONE", classifyPii("") === "NONE");

ok("メールアドレスを含む文はHIGH", classifyPii("連絡先は taro.yamada@example.co.jp です") === "HIGH");
ok("メールアドレスのみもHIGH", classifyPii("taro@example.com") === "HIGH");

ok("携帯電話番号(ハイフン区切り)を含む文はHIGH", classifyPii("090-1234-5678へ電話してください") === "HIGH");
ok("固定電話番号(市外局番)を含む文はHIGH", classifyPii("03-1234-5678が代表番号です") === "HIGH");
ok("国際表記(+81)の電話番号もHIGH", classifyPii("+81-90-1234-5678まで") === "HIGH");

ok("単なる日付(2026-08-30)はHIGHにならない(電話番号patternとは区別)", classifyPii("2026-08-30までに提出する") === "NONE", classifyPii("2026-08-30までに提出する"));
ok("単なる金額(1000-2000円)はHIGHにならない", classifyPii("予算は1000-2000円程度") === "NONE", classifyPii("予算は1000-2000円程度"));

console.log(`\n=== 結果: ${passed} passed, ${failed} failed ===`);
if (failed > 0) {
  console.log("失敗一覧:");
  for (const f of failures) console.log(`  - ${f}`);
  process.exit(1);
}
