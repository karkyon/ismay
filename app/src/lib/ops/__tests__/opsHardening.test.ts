/**
 * [SECURITY-RATE-02D新設・2026-10-02] 運用hardening(log中のemail仮名化・health判定・HMAC key rotation設定・
 * docker-composeの公開範囲)のDB/Redis非依存テスト。
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { maskEmailsInText, redactLogArgs, redactSensitive } from "../../debugServer";
import { evaluateHealth, healthResponseBody, isLoopbackClient, runtimeKind, type HealthChecks } from "../healthCore";
import { describeRateLimitBackendMode, resolveRateLimitBackendMode } from "../../security/rateLimitConfig";
import { MIGRATE_BUCKETS_LUA, limiterKey, parseRateLimitHmacKey } from "../../security/rateLimitCore";
import { RATE_LIMIT_POLICIES } from "../../security/rateLimitPolicies";

const __dirname = dirname(fileURLToPath(import.meta.url));

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

console.log("[O1] log中のemail仮名化");
{
  const a = maskEmailsInText("login failed for Alice.Smith+tag@Example.co.jp now");
  ok("emailを含まない", !a.includes("@") && !a.toLowerCase().includes("alice"), a);
  ok("<email:hash10>形式", /<email:[0-9a-f]{10}>/.test(a), a);
  ok("大文字小文字が違っても同じ仮名(追跡可能)", maskEmailsInText("A@B.CO") === maskEmailsInText("a@b.co"));
  ok("別アドレスは別の仮名", maskEmailsInText("a@b.co") !== maskEmailsInText("c@b.co"));
  ok("emailでない@は変えない", maskEmailsInText("@scope/pkg v1 @ 10:00") === "@scope/pkg v1 @ 10:00");
  ok("複数のemailをすべて置換", (maskEmailsInText("x@a.io, y@b.io").match(/<email:/g) ?? []).length === 2);
  const red = redactSensitive({ email: "u@example.invalid", password: "p", nested: { list: ["v@example.invalid", 3] }, token: "t" }) as Record<string, unknown>;
  const s = JSON.stringify(red);
  ok("objectの値・入れ子・配列のemailを置換", !s.includes("example.invalid"), s);
  ok("秘密keyは従来どおり伏せる", red.password === "***REDACTED***" && red.token === "***REDACTED***");
  const err = redactSensitive(new Error("Unique constraint failed on email dup@example.invalid")) as { message: string; stack?: string };
  ok("Errorのmessage・stackのemailを置換", !err.message.includes("dup@") && !(err.stack ?? "").includes("dup@"));
  const d = new Date("2026-10-02T00:00:00Z");
  ok("Dateはそのまま", redactSensitive(d) === d);
  ok("Bufferは中身を出さない", redactSensitive(Buffer.from("a@b.co")) === "[binary 6 bytes]");
  let deep: Record<string, unknown> = { leaf: "z@example.invalid" };
  for (let i = 0; i < 12; i++) deep = { child: deep };
  ok("深い入れ子もマスクを経ない値を出さない", !JSON.stringify(redactSensitive(deep)).includes("z@example"));
  const args = redactLogArgs(["[t] INPUT register › requestBody =", { email: "w@example.invalid" }]);
  ok("debugServerの全引数をマスク", !JSON.stringify(args).includes("w@example"));
}

console.log("[O2] health判定");
{
  const base: HealthChecks = {
    runtime: "production",
    database: { ok: true, latencyMs: 3 },
    rateLimit: { kind: "REDIS", ok: true, hmacRotation: "none", latencyMs: 1 },
    peer: { stamping: true },
    trustedProxy: { ok: true, count: 1 },
  };
  ok("全て正常ならok", evaluateHealth(base).status === "ok");
  ok("DB不通はdegraded", evaluateHealth({ ...base, database: { ok: false, latencyMs: null } }).status === "degraded");
  ok("Redis不通はdegraded", evaluateHealth({ ...base, rateLimit: { kind: "REDIS", ok: false } }).status === "degraded");
  ok("UNCONFIGUREDはdegraded", evaluateHealth({ ...base, rateLimit: { kind: "UNCONFIGURED", ok: false } }).status === "degraded");
  ok("productionでpeer不明はdegraded", evaluateHealth({ ...base, peer: { stamping: false } }).problems.some((p) => p.startsWith("peer")));
  ok("developmentではpeer不明でもok", evaluateHealth({ ...base, runtime: "development", peer: { stamping: false } }).status === "ok");
  ok("信頼proxy設定不正はdegraded", evaluateHealth({ ...base, trustedProxy: { ok: false, count: 0 } }).status === "degraded");
  ok("runtimeKind", runtimeKind("production") === "production" && runtimeKind(undefined) === "other");
  ok("loopback判定", isLoopbackClient("127.0.0.1") && isLoopbackClient("127.10.0.5") && isLoopbackClient("::1"));
  ok("非loopback・不明は詳細なし", !isLoopbackClient("192.168.1.20") && !isLoopbackClient(null) && !isLoopbackClient("::ffff:127.0.0.1x"));
  const r = evaluateHealth(base);
  const pub = healthResponseBody(r, base, false, new Date());
  ok("外部向けはstatusだけ", JSON.stringify(Object.keys(pub)) === JSON.stringify(["status"]));
  const det = healthResponseBody(r, base, true, new Date());
  ok("loopback向けはchecksを含む", "checks" in det && "problems" in det);
}

console.log("[O3] HMAC key rotation設定");
{
  const k1 = Buffer.alloc(32, 1).toString("base64");
  const k2 = Buffer.alloc(32, 2).toString("base64");
  const env = { NODE_ENV: "production" as const, REDIS_URL: "redis://:pw@localhost:16379" };
  const m0 = resolveRateLimitBackendMode({ ...env, RATE_LIMIT_HMAC_KEY: k2 });
  ok("PREVIOUS未設定はrotationなし", m0.kind === "REDIS" && m0.previousHmacKey === null && m0.previousKeyError === null);
  const m1 = resolveRateLimitBackendMode({ ...env, RATE_LIMIT_HMAC_KEY: k2, RATE_LIMIT_HMAC_KEY_PREVIOUS: k1 });
  ok("PREVIOUSありはrotation中", m1.kind === "REDIS" && m1.previousHmacKey !== null && m1.previousHmacKey.equals(Buffer.alloc(32, 1)));
  ok("起動表示にrotation中を出す(秘密値は出さない)", describeRateLimitBackendMode(m1).includes("hmacRotation=previous-key-active") && !describeRateLimitBackendMode(m1).includes(k1));
  ok("起動表示にpasswordを出さない", !describeRateLimitBackendMode(m1).includes("pw"));
  const m2 = resolveRateLimitBackendMode({ ...env, RATE_LIMIT_HMAC_KEY: k2, RATE_LIMIT_HMAC_KEY_PREVIOUS: "short" });
  ok("不正なPREVIOUSは使わずerror(判定は新keyで継続)", m2.kind === "REDIS" && m2.previousHmacKey === null && !!m2.previousKeyError);
  const m3 = resolveRateLimitBackendMode({ ...env, RATE_LIMIT_HMAC_KEY: k2, RATE_LIMIT_HMAC_KEY_PREVIOUS: k2 });
  ok("新keyと同じPREVIOUSはerror", m3.kind === "REDIS" && m3.previousHmacKey === null && !!m3.previousKeyError);
  const kn = parseRateLimitHmacKey(k2);
  const ko = parseRateLimitHmacKey(k1);
  if (kn.ok && ko.ok) {
    ok("新旧keyで同じ値のkeyが異なる", limiterKey(kn.key, RATE_LIMIT_POLICIES.LOGIN_ACCOUNT, "a@b.co") !== limiterKey(ko.key, RATE_LIMIT_POLICIES.LOGIN_ACCOUNT, "a@b.co"));
  }
  ok("移行Luaは新keyが無く旧keyがある場合だけRENAME", MIGRATE_BUCKETS_LUA.includes("EXISTS', KEYS[i]) == 0") && MIGRATE_BUCKETS_LUA.includes("RENAME', KEYS[i + 1], KEYS[i]"));
}

console.log("[O4] docker-composeの公開範囲・Redis認証");
{
  const compose = readFileSync(resolve(__dirname, "../../../../../docker-compose.yml"), "utf-8");
  const portLines = compose.split("\n").filter((l) => /^\s+- "\S*:\d+(:\d+)?"\s*$/.test(l) && !l.includes("/data"));
  ok("公開portはすべて127.0.0.1へbind", portLines.length >= 4 && portLines.every((l) => l.includes('"127.0.0.1:')), portLines.join(" | "));
  ok("Redisはrequirepass必須(未設定ならcomposeが起動を拒否)", compose.includes('"--requirepass", "${REDIS_PASSWORD:?'));
  ok("Redisのhealthcheckはenvで認証(passwordをcommand lineに書かない)", compose.includes("REDISCLI_AUTH: ${REDIS_PASSWORD:?"));
}

console.log("[O5] custom serverは.envを読んでからlisten先を決める");
{
  const server = readFileSync(resolve(__dirname, "../../../../server.mjs"), "utf-8");
  const loadAt = server.indexOf("nextEnv.loadEnvConfig(dir, dev)");
  const readAt = server.indexOf("process.env.ISMAY_LISTEN_HOST ??");
  const portAt = server.indexOf("process.env.PORT ??");
  ok("@next/envで.envを読み込む", loadAt > 0, `load=${loadAt}`);
  ok("ISMAY_LISTEN_HOST・PORTの参照より前に読み込む", loadAt > 0 && loadAt < readAt && loadAt < portAt, `load=${loadAt} host=${readAt} port=${portAt}`);
  const pkg = JSON.parse(readFileSync(resolve(__dirname, "../../../../package.json"), "utf-8")) as { dependencies?: Record<string, string> };
  ok("@next/envを依存関係に明記", typeof pkg.dependencies?.["@next/env"] === "string");
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) {
  console.log("FAILURES:\n" + failures.map((f) => `  - ${f}`).join("\n"));
  process.exit(1);
}
