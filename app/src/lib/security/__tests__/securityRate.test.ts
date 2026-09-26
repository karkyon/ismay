/**
 * [SECURITY-RATE-02B新設・2026-09-26] client IP解決・信頼proxy・rate limit規則のDB/Redis非依存テスト。
 * 契約: docs/decisions/DEC-SECURITY-RATE-02.md。
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import {
  cidrContains,
  parseCidr,
  parseForwardedForEntry,
  parseIp,
  parseTrustedProxyCidrs,
  type Cidr,
} from "../ipAddress";
import { MAX_FORWARDED_FOR_LENGTH, MAX_FORWARDED_HOPS, parsePeerStampValue, resolveClientIp } from "../clientIp";
import {
  limiterDigest,
  limiterKey,
  parseRateLimitHmacKey,
  parseTakeBucketsReply,
  refundBucket,
  retryAfterMsFor,
  retryAfterSeconds,
  takeBuckets,
  type BucketState,
  type RateLimitPolicy,
} from "../rateLimitCore";
import { resolveRateLimitBackendMode } from "../rateLimitConfig";
import { RATE_LIMIT_POLICIES, RATE_LIMIT_POLICY_LIST } from "../rateLimitPolicies";

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

function cidrs(text: string): Cidr[] {
  const r = parseTrustedProxyCidrs(text);
  if (!r.ok) throw new Error(r.error);
  return r.cidrs;
}
function ip(text: string) {
  const r = parseIp(text);
  if (!r) throw new Error(`parseIp failed: ${text}`);
  return r;
}

console.log("[P1] IPアドレスparser");
{
  ok("IPv4", parseIp("192.168.1.11")?.text === "192.168.1.11");
  ok("IPv4 0.0.0.0/255.255.255.255", parseIp("0.0.0.0")?.text === "0.0.0.0" && parseIp("255.255.255.255")?.text === "255.255.255.255");
  for (const bad of ["256.1.1.1", "01.2.3.4", "1.2.3", "1.2.3.4.5", "1.2.3.4 ", " 1.2.3.4", "0x7f.0.0.1", "1.2.3.-4", "", "a.b.c.d", "1..2.3"]) {
    ok(`IPv4不正を拒否: ${JSON.stringify(bad)}`, parseIp(bad) === null);
  }
  ok("IPv6 圧縮表記の正規化", parseIp("2001:0DB8:0000:0000:0000:0000:0000:0001")?.text === "2001:db8::1");
  ok("IPv6 ::1", parseIp("::1")?.text === "::1" && parseIp("::1")?.family === 6);
  ok("IPv6 ::", parseIp("::")?.text === "::");
  ok("IPv6 最長の0連続を圧縮(同長は先頭)", parseIp("1:0:0:2:0:0:0:3")?.text === "1:0:0:2::3" && parseIp("1:0:0:2:3:0:0:4")?.text === "1::2:3:0:0:4");
  ok("IPv6 単独の0は圧縮しない", parseIp("1:2:3:4:5:6:0:8")?.text === "1:2:3:4:5:6:0:8");
  ok("IPv6 末尾IPv4埋込み", parseIp("64:ff9b::192.0.2.1")?.text === "64:ff9b::c000:201");
  for (const bad of ["1:::2", "1::2::3", ":1:2:3:4:5:6:7", "1:2:3:4:5:6:7:8:9", "1:2:3:4:5:6:7", "fe80::1%eth0", "12345::1", "::g", "1.2.3.4::", "1:2:3:4:5:6:7::8"]) {
    ok(`IPv6不正を拒否: ${bad}`, parseIp(bad) === null);
  }
  ok("IPv4-mapped IPv6はIPv4へ正規化", parseIp("::ffff:10.0.0.5")?.text === "10.0.0.5" && parseIp("::ffff:10.0.0.5")?.family === 4);
  ok("IPv4-mapped(16進表記)もIPv4へ", parseIp("::ffff:a00:5")?.text === "10.0.0.5");
  ok("長すぎる値を拒否", parseIp("1".repeat(65)) === null);
}

console.log("[P2] CIDR parser(TRUSTED_PROXY_CIDRS)");
{
  ok("未設定は信頼proxyなし", (() => { const r = parseTrustedProxyCidrs(undefined); return r.ok && r.cidrs.length === 0; })());
  ok("空白のみは信頼proxyなし", (() => { const r = parseTrustedProxyCidrs("   "); return r.ok && r.cidrs.length === 0; })());
  ok("複数・空白許容", (() => { const r = parseTrustedProxyCidrs(" 127.0.0.1/32 , 10.0.0.0/8,::1 "); return r.ok && r.cidrs.map((c) => c.text).join(",") === "127.0.0.1/32,10.0.0.0/8,::1/128"; })());
  ok("単一hostは/32・/128", parseCidr("10.1.2.3").ok && (parseCidr("10.1.2.3") as { cidr: Cidr }).cidr.prefix === 32);
  for (const bad of ["10.0.0.1/8", "0.0.0.0/0", "::/0", "10.0.0.0/33", "::1/129", "10.0.0.0/08", "10.0.0.0/", "/8", "::ffff:10.0.0.0/104", "abc", "10.0.0.0/8/1"]) {
    ok(`CIDR不正を拒否: ${bad}`, !parseCidr(bad).ok);
  }
  ok("1要素でも不正なら全体を不正", !parseTrustedProxyCidrs("127.0.0.1/32,10.0.0.1/8").ok);
  ok("空要素(連続カンマ)を拒否", !parseTrustedProxyCidrs("127.0.0.1/32,,10.0.0.0/8").ok);
  ok("33件以上を拒否", !parseTrustedProxyCidrs(new Array(33).fill("127.0.0.1").join(",")).ok);
  const c = parseCidr("172.16.0.0/12");
  ok("CIDR包含(境界)", c.ok && cidrContains(c.cidr, ip("172.31.255.255")) && !cidrContains(c.cidr, ip("172.32.0.0")) && cidrContains(c.cidr, ip("172.16.0.0")));
  const c6 = parseCidr("fd00::/8");
  ok("IPv6 CIDR包含", c6.ok && cidrContains(c6.cidr, ip("fdab::1")) && !cidrContains(c6.cidr, ip("fe00::1")));
  ok("familyが違えば含まない", c.ok && !cidrContains(c.cidr, ip("::1")));
  const c25 = parseCidr("192.168.1.128/25");
  ok("prefixが8の倍数でない境界", c25.ok && cidrContains(c25.cidr, ip("192.168.1.200")) && !cidrContains(c25.cidr, ip("192.168.1.127")));
  ok("mapped addressは信頼判定でもIPv4として扱う", c.ok && cidrContains(c.cidr, ip("::ffff:172.20.0.1")));
}

console.log("[P3] X-Forwarded-For要素");
{
  ok("前後空白", parseForwardedForEntry(" 203.0.113.9 ")?.text === "203.0.113.9");
  ok("IPv4:port", parseForwardedForEntry("203.0.113.9:4711")?.text === "203.0.113.9");
  ok("[IPv6]:port", parseForwardedForEntry("[2001:db8::7]:443")?.text === "2001:db8::7");
  ok("[IPv6]", parseForwardedForEntry("[2001:db8::7]")?.text === "2001:db8::7");
  for (const bad of ["unknown", "", "_hidden", "203.0.113.9:99999", "[203.0.113.9]", "[::1]:x", "203.0.113.9;proto=https"]) {
    ok(`不正要素: ${JSON.stringify(bad)}`, parseForwardedForEntry(bad) === null);
  }
}

console.log("[P4] client IP解決(信頼境界)");
{
  const none: Cidr[] = [];
  const local = cidrs("127.0.0.1/32,::1");
  const r0 = resolveClientIp({ peer: null, forwardedFor: "198.51.100.1", trustedProxies: local });
  ok("peer不明ならheaderがあっても不明", r0.ip === null && r0.source === "UNKNOWN" && r0.reason === "PEER_UNAVAILABLE");
  const r1 = resolveClientIp({ peer: ip("203.0.113.5"), forwardedFor: "198.51.100.1", trustedProxies: none });
  ok("信頼proxy未設定: XFFを使わずpeer", r1.ip?.text === "203.0.113.5" && r1.source === "PEER");
  const r2 = resolveClientIp({ peer: ip("203.0.113.5"), forwardedFor: "198.51.100.1", trustedProxies: local });
  ok("peerが信頼proxyでない: XFFを使わない(偽装XFF)", r2.ip?.text === "203.0.113.5" && r2.source === "PEER");
  const r3 = resolveClientIp({ peer: ip("127.0.0.1"), forwardedFor: "198.51.100.1", trustedProxies: local });
  ok("peerが信頼proxy: XFFの右端", r3.ip?.text === "198.51.100.1" && r3.source === "FORWARDED");
  const r4 = resolveClientIp({ peer: ip("127.0.0.1"), forwardedFor: "6.6.6.6, 198.51.100.1", trustedProxies: local });
  ok("攻撃者が左側に書いた値は採用しない", r4.ip?.text === "198.51.100.1");
  const chain = cidrs("127.0.0.1/32,10.0.0.0/8");
  const r5 = resolveClientIp({ peer: ip("127.0.0.1"), forwardedFor: "6.6.6.6, 198.51.100.1, 10.1.1.1, 10.2.2.2", trustedProxies: chain });
  ok("多段proxy: 右から信頼proxyを飛ばし最初の非信頼", r5.ip?.text === "198.51.100.1");
  const r6 = resolveClientIp({ peer: ip("127.0.0.1"), forwardedFor: "6.6.6.6, garbage, 10.2.2.2", trustedProxies: chain });
  ok("走査中の不正要素は不明", r6.ip === null && r6.source === "UNKNOWN" && r6.reason === "MALFORMED_FORWARDED");
  const r7 = resolveClientIp({ peer: ip("127.0.0.1"), forwardedFor: "garbage, 198.51.100.1", trustedProxies: local });
  ok("非信頼addressより左の不正要素は見ない", r7.ip?.text === "198.51.100.1");
  const r8 = resolveClientIp({ peer: ip("127.0.0.1"), forwardedFor: null, trustedProxies: local });
  ok("信頼proxy自身の要求(XFFなし)はpeer", r8.ip?.text === "127.0.0.1" && r8.source === "PEER");
  const r9 = resolveClientIp({ peer: ip("::ffff:127.0.0.1"), forwardedFor: "::ffff:198.51.100.7", trustedProxies: local });
  ok("mapped peer・mapped XFFもIPv4として扱う", r9.ip?.text === "198.51.100.7");
  const r10 = resolveClientIp({ peer: ip("::1"), forwardedFor: "2001:db8::abcd", trustedProxies: local });
  ok("IPv6 proxy・IPv6 client", r10.ip?.text === "2001:db8::abcd");
  const r11 = resolveClientIp({ peer: ip("127.0.0.1"), forwardedFor: "10.1.1.1, 10.2.2.2", trustedProxies: chain });
  ok("全hopが信頼proxyなら最も左", r11.ip?.text === "10.1.1.1");
  const manyTrusted = new Array(MAX_FORWARDED_HOPS + 1).fill("10.0.0.9").join(", ");
  const r12 = resolveClientIp({ peer: ip("127.0.0.1"), forwardedFor: manyTrusted, trustedProxies: chain });
  ok("信頼hopが上限を超えたら不明", r12.ip === null && r12.source === "UNKNOWN" && r12.reason === "TOO_MANY_HOPS");
  const huge = `${"6.6.6.6, ".repeat(2000)}198.51.100.1`;
  ok("長大header(攻撃者の水増し)でも右端を解決できる", huge.length > MAX_FORWARDED_FOR_LENGTH && resolveClientIp({ peer: ip("127.0.0.1"), forwardedFor: huge, trustedProxies: local }).ip?.text === "198.51.100.1");
  const huge2 = `${"x".repeat(MAX_FORWARDED_FOR_LENGTH + 10)}`;
  ok("切り詰め後に要素が無い場合はpeer(信頼proxy自身)", resolveClientIp({ peer: ip("127.0.0.1"), forwardedFor: huge2, trustedProxies: local }).source === "PEER");
  const multi = ["6.6.6.6", "198.51.100.1"].join(", ");
  ok("複数XFF header(連結後)も右端", resolveClientIp({ peer: ip("127.0.0.1"), forwardedFor: multi, trustedProxies: local }).ip?.text === "198.51.100.1");
  const r13 = resolveClientIp({ peer: ip("127.0.0.1"), forwardedFor: " , ", trustedProxies: local });
  ok("空要素だけのXFFは不明", r13.ip === null);
}

console.log("[P5] custom serverのpeer stamp");
{
  const nonce = "n".repeat(43);
  ok("正しいnonceとaddress", parsePeerStampValue(`${nonce} ::ffff:192.0.2.10`, nonce)?.text === "192.0.2.10");
  ok("nonce不一致(client偽装)", parsePeerStampValue(`${"m".repeat(43)} 192.0.2.10`, nonce) === null);
  ok("nonce長さ違い", parsePeerStampValue(`short 192.0.2.10`, nonce) === null);
  ok("address欠落", parsePeerStampValue(`${nonce} `, nonce) === null);
  ok("header無し", parsePeerStampValue(null, nonce) === null);
  ok("複数値の連結(偽装値+正規値)は不正", parsePeerStampValue(`fake 9.9.9.9, ${nonce} 192.0.2.10`, nonce) === null);
}

console.log("[P6] HMAC key・limiter key");
{
  ok("未設定を拒否", !parseRateLimitHmacKey(undefined).ok && !parseRateLimitHmacKey("").ok);
  ok("短いkeyを拒否", !parseRateLimitHmacKey(Buffer.alloc(16, 1).toString("base64")).ok);
  ok("base64以外を拒否", !parseRateLimitHmacKey("not base64 !!").ok);
  const k1r = parseRateLimitHmacKey(Buffer.alloc(32, 7).toString("base64"));
  const k2r = parseRateLimitHmacKey(Buffer.alloc(32, 8).toString("base64url"));
  ok("32byte base64/base64urlを受理", k1r.ok && k2r.ok);
  if (k1r.ok && k2r.ok) {
    const k1 = k1r.key;
    const k2 = k2r.key;
    const P = RATE_LIMIT_POLICIES;
    const a = limiterKey(k1, P.LOGIN_ACCOUNT, "User@Example.invalid");
    ok("同じ入力は同じkey(安定)", a === limiterKey(k1, P.LOGIN_ACCOUNT, "User@Example.invalid"));
    ok("emailは大小文字・前後空白を正規化", a === limiterKey(k1, P.LOGIN_ACCOUNT, "  user@example.invalid "));
    ok("keyに生のemailを含まない", !a.includes("user") && !a.includes("example"));
    ok("用途(policy)が違えば別key", limiterDigest(k1, P.EMAIL_RESEND_IP, "198.51.100.1") !== limiterDigest(k1, P.PASSWORD_FORGOT_IP, "198.51.100.1"));
    ok("同じIPでもlogin/mfaで別key", limiterKey(k1, P.LOGIN_IP, "198.51.100.1") !== limiterKey(k1, P.MFA_IP, "198.51.100.1"));
    ok("HMAC keyが違えば別key", a !== limiterKey(k2, P.LOGIN_ACCOUNT, "user@example.invalid"));
    ok("異なるuser・IPは別key", limiterKey(k1, P.MFA_USER, "u1") !== limiterKey(k1, P.MFA_USER, "u2") && limiterKey(k1, P.LOGIN_IP, "198.51.100.1") !== limiterKey(k1, P.LOGIN_IP, "198.51.100.2"));
    ok("keyにprefixとpolicy versionを含む", a.startsWith(`ismay:rl:v${P.LOGIN_ACCOUNT.version}:${P.LOGIN_ACCOUNT.id}:`));
    const bumped: RateLimitPolicy = { ...P.LOGIN_ACCOUNT, version: P.LOGIN_ACCOUNT.version + 1 };
    ok("policy versionを上げると別key", limiterKey(k1, bumped, "user@example.invalid") !== a);
    ok("keyに生のIPを含まない", !limiterKey(k1, P.LOGIN_IP, "198.51.100.1").includes("198.51"));
  }
}

console.log("[P7] token bucket(境界・retry-after・全か無か)");
{
  const policy: RateLimitPolicy = { ...RATE_LIMIT_POLICIES.LOGIN_ACCOUNT }; // 15分10回
  let state: BucketState | null = null;
  const t0 = 1_000_000;
  let allowedCount = 0;
  for (let i = 0; i < 10; i++) {
    const r = takeBuckets([{ state, policy }], t0);
    if (r.allowed) allowedCount++;
    state = r.states[0]!;
  }
  ok("上限直前(10回目)まで許可", allowedCount === 10);
  const r11 = takeBuckets([{ state, policy }], t0);
  ok("上限直後(11回目)は拒否", !r11.allowed && r11.deniedIndexes[0] === 0);
  ok("retry-afterは1回分の補充時間(90秒)", r11.retryAfterMs === 90_000, `retryAfterMs=${r11.retryAfterMs}`);
  ok("はじめて拒否になった回だけnewlyBlocked", r11.newlyBlockedIndexes.length === 1);
  const r12 = takeBuckets([{ state: r11.states[0]!, policy }], t0 + 1000);
  ok("拒否が続く間はnewlyBlockedにならない", !r12.allowed && r12.newlyBlockedIndexes.length === 0);
  ok("retry-afterは経過分だけ短くなる", r12.retryAfterMs === 89_000, `retryAfterMs=${r12.retryAfterMs}`);
  const r13 = takeBuckets([{ state: r12.states[0]!, policy }], t0 + 90_000 - 1);
  ok("補充1ms前は拒否", !r13.allowed);
  const r14 = takeBuckets([{ state: r13.states[0]!, policy }], t0 + 90_000);
  ok("補充ちょうどで許可", r14.allowed);
  const r15 = takeBuckets([{ state: r14.states[0]!, policy }], t0 + 90_000);
  ok("直後は再び拒否(境界burstなし)", !r15.allowed);
  // 固定windowの境界2倍burstが起きないこと: 任意の15分区間で通るのは capacity + 補充分 まで
  let s: BucketState | null = null;
  let passedIn15 = 0;
  for (let ms = 0; ms <= 15 * 60 * 1000; ms += 1000) {
    const r = takeBuckets([{ state: s, policy }], t0 + ms);
    s = r.states[0]!;
    if (r.allowed) passedIn15++;
  }
  ok("15分間に1秒ごと試行しても通るのは10+10回", passedIn15 === 20, `passed=${passedIn15}`);
  // 全か無か
  const pa: RateLimitPolicy = { ...policy, id: "a", capacity: 2 };
  const pb: RateLimitPolicy = { ...policy, id: "b", capacity: 1 };
  const m1 = takeBuckets([{ state: null, policy: pa }, { state: null, policy: pb }], t0);
  const m2 = takeBuckets([{ state: m1.states[0]!, policy: pa }, { state: m1.states[1]!, policy: pb }], t0);
  ok("一方が不足なら両方とも消費しない", !m2.allowed && m2.states[0]!.tokens === 1 && m2.deniedIndexes.join() === "1");
  // refund
  const refunded = refundBucket({ tokens: 3, updatedAtMs: t0, blocked: true }, t0, policy);
  ok("REFUNDは1回分戻しblocked解除", refunded?.tokens === 4 && refunded?.blocked === false);
  ok("REFUNDは満杯を超えない", refundBucket({ tokens: 10, updatedAtMs: t0, blocked: false }, t0, policy)?.tokens === 10);
  ok("retryAfterMsFor 残量十分なら0", retryAfterMsFor(1, 1, policy) === 0);
  ok("Retry-After秒は切り上げ・最小1", retryAfterSeconds(1) === 1 && retryAfterSeconds(1001) === 2 && retryAfterSeconds(0) === 1);
}

console.log("[P8] Lua戻り値の解釈");
{
  const p = parseTakeBucketsReply([0, 90000, 123, 0, 1, 1, 5000, 0, 0], 2);
  ok("拒否・retry・bucket別", !p.allowed && p.retryAfterMs === 90000 && p.buckets[0]!.denied && p.buckets[0]!.newlyBlocked && p.buckets[1]!.remainingTokens === 5);
  let threw = false;
  try {
    parseTakeBucketsReply([1, 0], 1);
  } catch {
    threw = true;
  }
  ok("件数不一致は例外", threw);
}

console.log("[P9] backend構成判定");
{
  const key = Buffer.alloc(32, 3).toString("base64");
  ok("REDIS_URL+keyでredis", resolveRateLimitBackendMode({ NODE_ENV: "production", REDIS_URL: "redis://127.0.0.1:16379", RATE_LIMIT_HMAC_KEY: key }).kind === "REDIS");
  ok("productionでREDIS_URL未設定はUNCONFIGURED(黙って許可しない)", resolveRateLimitBackendMode({ NODE_ENV: "production", RATE_LIMIT_HMAC_KEY: key }).kind === "UNCONFIGURED");
  ok("productionでkey未設定はUNCONFIGURED", resolveRateLimitBackendMode({ NODE_ENV: "production", REDIS_URL: "redis://127.0.0.1:16379" }).kind === "UNCONFIGURED");
  ok("productionでkey不正はUNCONFIGURED", resolveRateLimitBackendMode({ NODE_ENV: "production", REDIS_URL: "redis://x", RATE_LIMIT_HMAC_KEY: "short" }).kind === "UNCONFIGURED");
  ok("開発でREDIS_URL未設定はLOCAL_DEV", resolveRateLimitBackendMode({ NODE_ENV: "development" }).kind === "LOCAL_DEV");
  ok("開発でもREDIS_URLありkey不正はUNCONFIGURED", resolveRateLimitBackendMode({ NODE_ENV: "development", REDIS_URL: "redis://x" }).kind === "UNCONFIGURED");
  ok("不正なREDIS_URLはUNCONFIGURED", resolveRateLimitBackendMode({ NODE_ENV: "development", REDIS_URL: "http://x", RATE_LIMIT_HMAC_KEY: key }).kind === "UNCONFIGURED");
}

console.log("[P10] policy registry");
{
  const ids = RATE_LIMIT_POLICY_LIST.map((p) => p.id);
  ok("policy idは一意", new Set(ids).size === ids.length);
  ok("全policyに正の容量・window・basis", RATE_LIMIT_POLICY_LIST.every((p) => p.capacity > 0 && p.windowMs > 0 && p.basis.length > 0 && p.version >= 1));
  ok("login/MFAはLOCAL_FALLBACK、メール送信系はFAIL_CLOSED", RATE_LIMIT_POLICY_LIST.every((p) => (p.id.startsWith("auth.login") || p.id.startsWith("auth.mfa") ? p.onBackendFailure === "LOCAL_FALLBACK" : p.onBackendFailure === "FAIL_CLOSED")));
  ok("login.accountは旧実装の値(15分10回)を継承", RATE_LIMIT_POLICIES.LOGIN_ACCOUNT.capacity === 10 && RATE_LIMIT_POLICIES.LOGIN_ACCOUNT.windowMs === 15 * 60 * 1000);
}

console.log("[P11] 静的検査(旧実装の除去・生値のlog禁止)");
{
  const read = (rel: string) => readFileSync(resolve(__dirname, rel), "utf-8");
  const guard = read("../../auth/guard.ts");
  ok("guard.clientIpはX-Forwarded-For/X-Real-IPを直接読まない", !/x-forwarded-for|x-real-ip/i.test(guard.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "")));
  const login = read("../../../app/api/v1/auth/login/route.ts");
  ok("loginのprocess内Map(failureLog)を除去", !login.includes("failureLog") && login.includes("consumeRateLimit"));
  const mfa = read("../../../app/api/v1/auth/mfa/verify/route.ts");
  ok("MFA verifyにrate limit", mfa.includes("RATE_LIMIT_POLICIES.MFA_USER"));
  const resend = read("../../../app/api/v1/auth/email/resend/route.ts");
  const forgot = read("../../../app/api/v1/auth/password/forgot/route.ts");
  ok("resend/forgotは上限時も同じaccepted応答", /if \(!limit\.allowed\) \{[\s\S]*?return apiOk\(\{ accepted: true/.test(resend) && /if \(!limit\.allowed\) \{[\s\S]*?return apiOk\(\{ accepted: true/.test(forgot));
  const limiter = read("../rateLimiter.ts");
  ok("limiterのlog・監査に生のvalueを渡さない", !/debugServer\.[a-z]+\([^)]*\bc\.value\b/.test(limiter) && !/reason:[^\n]*\bvalue\b/.test(limiter));
  const server = read("../../../../server.mjs");
  ok("custom serverは受信したpeer headerを削除して上書き", server.includes("delete req.headers[PEER_ADDRESS_HEADER]") && server.includes("req.socket.remoteAddress"));
  const routes = ["login", "mfa/verify", "email/resend", "password/forgot", "password/reset", "email/verify", "register", "refresh"];
  ok("認証routeはclientIp(guard)経由でのみIPを得る", routes.every((r) => !/x-forwarded-for|x-real-ip/i.test(read(`../../../app/api/v1/auth/${r}/route.ts`))));
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) {
  console.log("FAILURES:\n" + failures.map((f) => `  - ${f}`).join("\n"));
  process.exit(1);
}
