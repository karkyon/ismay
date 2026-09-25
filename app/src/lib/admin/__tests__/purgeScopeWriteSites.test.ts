/**
 * [PURGE-SCOPE-03A・2026-09-25新設] 明示的scope列の書込み不変条件(DB非依存の静的検査)。
 *
 * DEC-PURGE-02B(利用者決定)により、event_logs/outbox_events/jobs/consents/ai_runsの
 * 新規行はworkspace_id(30日Purgeの明示的scope列)を必須とする。DB側はBEFORE INSERT
 * trigger(ismay_require_workspace_scope)で拒否するが、それは実行時(該当APIが呼ばれた
 * とき)にしか発覚しない。このテストはsrc配下の全create呼出しを走査し、`data: {`の
 * 第1階層にworkspaceIdがあることを保証する(新しい書込み箇所の追加漏れをtest:allで検出)。
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, relative, resolve } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const SRC = resolve(__dirname, "../../..");

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

function walk(dir: string, out: string[]): void {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (name === "generated" || name === "__tests__" || name === "node_modules") continue;
    const st = statSync(full);
    if (st.isDirectory()) walk(full, out);
    else if (/\.(ts|tsx)$/.test(name)) out.push(full);
  }
}

const CALL = /\.(eventLog|outboxEvent|job|consent|aiRun)\.(create|upsert)\(\{/g;

/** 呼出し位置から`data: {`(upsertは`create: {`)ブロックを取り出し、第1階層にworkspaceIdがあるか。 */
function dataBlockHasWorkspaceId(src: string, callIndex: number, method: string): boolean | null {
  const key = method === "upsert" ? "create: {" : "data: {";
  const start = src.indexOf(key, callIndex);
  if (start < 0 || start - callIndex > 200) return null;
  let depth = 0;
  let line = "";
  for (let i = start + key.length - 1; i < src.length; i++) {
    const ch = src[i];
    if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) return false;
    }
    if (ch === "\n") {
      if (depth === 1 && /^\s*workspaceId\b/.test(line)) return true;
      line = "";
    } else {
      line += ch;
    }
  }
  return null;
}

console.log("=== PURGE-SCOPE-03A: 明示的scope列の書込み不変条件 ===");
const files: string[] = [];
walk(SRC, files);
let sites = 0;
for (const file of files) {
  const src = readFileSync(file, "utf-8");
  for (const m of src.matchAll(CALL)) {
    sites++;
    const lineNo = src.slice(0, m.index).split("\n").length;
    const rel = relative(SRC, file);
    const has = dataBlockHasWorkspaceId(src, m.index ?? 0, m[2]);
    ok(`${rel}:${lineNo} ${m[1]}.${m[2]} はworkspaceIdを設定する`, has === true, has === null ? "dataブロックを解析できない" : "workspaceId無し");
  }
}
ok("走査対象の書込み箇所が見つかる(検査自体が空振りしていない)", sites >= 60, `sites=${sites}`);

console.log(`\n=== 結果: ${passed} passed / ${failed} failed ===`);
if (failed > 0) {
  console.log("失敗一覧:");
  for (const f of failures) console.log(`  - ${f}`);
  process.exit(1);
}
