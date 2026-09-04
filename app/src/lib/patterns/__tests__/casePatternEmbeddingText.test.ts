/**
 * Case Pattern Catalog(M4) — casePatternEmbeddingText.ts(Embedding入力テキスト
 * 構築)不変条件テスト。DB非依存パターン(npx tsx で直接実行、DATABASE_URL不要)。
 * 出典: PATTERN-DETECT-01D設計決定(DR-B、2026-09-03)
 * 「Embedding入力は、正本の情報だけで決定論的に構成する」。
 */
import { buildCasePatternEmbeddingText } from "../casePatternEmbeddingText";

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

console.log("Case Pattern Catalog(M4) casePatternEmbeddingText 不変条件テスト(DR-B準拠)");

// -------------------------------------------------------------------
// 決定論性: 同じ入力からは常に同じテキスト
// -------------------------------------------------------------------
{
  const input = { representativeText: "検証用テキスト", decompositionTemplate: { b: 2, a: 1 } };
  const t1 = buildCasePatternEmbeddingText(input);
  const t2 = buildCasePatternEmbeddingText(input);
  ok("同じ入力からは同じ出力になる", t1 === t2);
}

// -------------------------------------------------------------------
// key順の揺れに影響されない(JSON.stringifyのkey順非保証を吸収する)
// -------------------------------------------------------------------
{
  const t1 = buildCasePatternEmbeddingText({ representativeText: "x", decompositionTemplate: { a: 1, b: 2 } });
  const t2 = buildCasePatternEmbeddingText({ representativeText: "x", decompositionTemplate: { b: 2, a: 1 } });
  ok("[是正の核心] decompositionTemplateのkey順が違っても同じテキストになる", t1 === t2, `t1=${t1} t2=${t2}`);
}

// -------------------------------------------------------------------
// 内容が違えば出力も変わる(無意味な定数を返していないことの確認)
// -------------------------------------------------------------------
{
  const t1 = buildCasePatternEmbeddingText({ representativeText: "パターンA", decompositionTemplate: {} });
  const t2 = buildCasePatternEmbeddingText({ representativeText: "パターンB", decompositionTemplate: {} });
  ok("representativeTextが違えば出力も違う", t1 !== t2);
}
{
  const t1 = buildCasePatternEmbeddingText({ representativeText: "x", decompositionTemplate: { steps: ["a"] } });
  const t2 = buildCasePatternEmbeddingText({ representativeText: "x", decompositionTemplate: { steps: ["b"] } });
  ok("decompositionTemplateの中身が違えば出力も違う", t1 !== t2);
}

// -------------------------------------------------------------------
// 配列の順序は意味を持つ(配列は順序をkeyソートしない、ソートすると意味が壊れる)
// -------------------------------------------------------------------
{
  const t1 = buildCasePatternEmbeddingText({ representativeText: "x", decompositionTemplate: { steps: ["a", "b"] } });
  const t2 = buildCasePatternEmbeddingText({ representativeText: "x", decompositionTemplate: { steps: ["b", "a"] } });
  ok("[捏造しない] 配列要素の順序が違えば出力も違う(配列はソートしない)", t1 !== t2);
}

// -------------------------------------------------------------------
// undefined/null decompositionTemplateでも例外を投げない
// -------------------------------------------------------------------
{
  let threw = false;
  let text = "";
  try {
    text = buildCasePatternEmbeddingText({ representativeText: "x", decompositionTemplate: null });
  } catch {
    threw = true;
  }
  ok("decompositionTemplate=nullでも例外を投げない", !threw);
  ok("decompositionTemplate=nullは空オブジェクト相当として扱われる", text.includes("{}"));
}

// -------------------------------------------------------------------
// 長さ上限(lib/ai/embeddingText.tsのbuildEmbeddingTextと同じ8000文字上限を踏襲)
// -------------------------------------------------------------------
{
  const longText = "あ".repeat(20000);
  const text = buildCasePatternEmbeddingText({ representativeText: longText, decompositionTemplate: {} });
  ok("出力は8000文字以内にtruncateされる", text.length <= 8000, `length=${text.length}`);
}

console.log(`\n合計: ${passed} passed, ${failed} failed`);
if (failed > 0) {
  console.log("\n失敗した項目:");
  for (const f of failures) console.log(`  - ${f}`);
  process.exit(1);
}
