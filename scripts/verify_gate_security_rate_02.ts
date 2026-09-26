#!/usr/bin/env node
/**
 * scripts/verify_gate_security_rate_02.ts
 *
 * SECURITY-RATE-02B(trusted proxy境界・Redis永続rate limit)の実Redis・実DB・HTTP受入試験。
 * 契約: docs/decisions/DEC-SECURITY-RATE-02.md、運用: docs/runbooks/SECURITY_RATE_RUNBOOK.md。
 *
 * [R] 実Redis(lib/security/rateLimiter.tsとLua script)
 *   [R1] 複数client(8接続)から同じkeyへ同時要求しても上限を超えない
 *   [R2] 複数process(4 process)から同じkeyへ同時要求しても上限を超えない
 *   [R3] TTL(空→満杯の時間+余裕以内)、HMAC keyに生の値を含まない
 *   [R4] atomicity: 複数bucketの一方が不足なら他方も消費しない
 *   [R5] RESET/REFUND、Retry-After、拒否の監査(はじめて拒否した1回だけ・生の値を含まない)
 *   [R6] Redis再接続: limiterの接続をCLIENT KILLで切断しても自動再接続してRedisで判定を続ける
 *   [R7] Redis停止(接続不能): login系はprocess内縮退で上限を守り、メール系はfail closed、縮退の監査
 *   [R8] productionでREDIS_URL未設定: 黙って許可せずR7と同じ縮退
 * [H] HTTP(BASE_URL、既定 http://localhost:13000。`npm run start`で起動したサーバー)
 *   [H1] login連続失敗: 10回目まで401、11回目はACCOUNT_LOCKED+Retry-After、ロック中は正しいパスワードでも拒否
 *   [H2] 正しいパスワードで失敗回数が戻る
 *   [H3] 未登録アドレスも同じ規則・同じ応答(列挙耐性)
 *   [H4] MFA verify: 5回失敗で429、challenge取り直しでも戻らない、正しいコードで回数が戻る
 *   [H5] resend/forgot: 登録有無・確認状態・上限到達で応答が同じ。IP上限では発行しない
 *   [H6] 偽装X-Forwarded-For・偽装x-ismay-peer-addressはclient IPにならない
 *   [H7] 信頼proxy経由(TRUSTED_PROXY_BASE_URLを指定した場合のみ。TRUSTED_PROXY_CIDRSにloopbackを含むサーバー)
 *   [H8] CSRF・cookie・session・refresh回転の既存契約
 *   cleanup後の残存0(テストユーザー・Redis key・監査記録)。
 *
 * 実行方法(app/.envのDATABASE_URL・REDIS_URL・RATE_LIMIT_HMAC_KEYを使う。サーバーと同じ値であること):
 *   cd ~/projects/ismay/app
 *   npx tsx ../scripts/verify_gate_security_rate_02.ts
 *   (信頼proxy試験も行う場合: TRUSTED_PROXY_BASE_URL=http://127.0.0.1:13901 npx tsx ../scripts/verify_gate_security_rate_02.ts)
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { createRequire } from "node:module";
import { spawn } from "node:child_process";

function loadDotEnv(envPath: string): void {
  let content: string;
  try {
    content = readFileSync(envPath, "utf-8");
  } catch {
    return;
  }
  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
    if (value.length >= 2 && value[0] === value[value.length - 1] && (value[0] === '"' || value[0] === "'")) {
      value = value.slice(1, -1);
    }
    if (process.env[key] === undefined) process.env[key] = value;
  }
}
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const APP_DIR = join(__dirname, "..", "app");
loadDotEnv(join(APP_DIR, ".env"));
const appRequire = createRequire(join(APP_DIR, "package.json"));

const BASE_URL = process.env.BASE_URL ?? "http://localhost:13000";
const TRUSTED_PROXY_BASE_URL = process.env.TRUSTED_PROXY_BASE_URL ?? null;
const RUN_ID = Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
const EMAIL_PREFIX = "gate-security-rate-02-";
const PASSWORD = `RateVerify!${RUN_ID}Aa1`;
const LOOPBACKS = ["127.0.0.1", "::1"];

let passed = 0;
let failed = 0;
let skipped = 0;
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
function skip(name: string, why: string): void {
  skipped++;
  console.log(`  SKIP - ${name} :: ${why}`);
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

type Jar = Record<string, string>;
function storeCookies(res: Response, jar: Jar): string[] {
  const raw = (res.headers as unknown as { getSetCookie?: () => string[] }).getSetCookie?.() ?? [];
  for (const line of raw) {
    const [pair] = line.split(";");
    const eq = pair!.indexOf("=");
    if (eq === -1) continue;
    jar[pair!.slice(0, eq).trim()] = pair!.slice(eq + 1).trim();
  }
  return raw;
}
function cookieHeader(jar: Jar): string {
  return Object.entries(jar)
    .filter(([, v]) => v !== "")
    .map(([k, v]) => `${k}=${v}`)
    .join("; ");
}

interface HttpResult {
  status: number;
  body: { data?: Record<string, unknown>; error?: { code?: string; message?: string } } | null;
  headers: Headers;
  setCookies: string[];
}
async function http(
  base: string,
  path: string,
  opts: { method?: string; body?: unknown; jar?: Jar; headers?: Record<string, string>; csrf?: boolean } = {},
): Promise<HttpResult> {
  const headers: Record<string, string> = { ...(opts.headers ?? {}) };
  if (opts.body !== undefined) headers["content-type"] = "application/json";
  if (opts.jar && Object.keys(opts.jar).length > 0) headers.cookie = cookieHeader(opts.jar);
  if (opts.csrf && opts.jar?.ismay_csrf) headers["x-csrf-token"] = opts.jar.ismay_csrf;
  const res = await fetch(`${base}${path}`, {
    method: opts.method ?? "POST",
    headers,
    body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
    redirect: "manual",
  });
  const setCookies = opts.jar ? storeCookies(res, opts.jar) : [];
  const text = await res.text();
  let body: HttpResult["body"] = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = null;
  }
  return { status: res.status, body, headers: res.headers, setCookies };
}

async function main(): Promise<void> {
  const { db } = await import("../app/src/lib/db");
  const core = await import("../app/src/lib/security/rateLimitCore");
  const limiter = await import("../app/src/lib/security/rateLimiter");
  const { RATE_LIMIT_POLICIES: P } = await import("../app/src/lib/security/rateLimitPolicies");
  const { purgeHttpVerifyUser } = await import("./lib/httpVerifyUserCleanup");
  const { markTestUserEmailVerified } = await import("./lib/testEmailVerification");
  const { generate } = appRequire("otplib") as { generate: (o: { secret: string }) => Promise<string> };
  type RedisCtor = new (url: string, opts?: Record<string, unknown>) => import("ioredis").default;
  const Redis = appRequire("ioredis") as RedisCtor;

  const keyParsed = core.parseRateLimitHmacKey(process.env.RATE_LIMIT_HMAC_KEY);
  const redisUrl = process.env.REDIS_URL;
  if (!keyParsed.ok || !redisUrl) {
    console.error("REDIS_URLとRATE_LIMIT_HMAC_KEYをapp/.envに設定してから実行してください(サーバーと同じ値)");
    process.exit(2);
  }
  const hmacKey = keyParsed.key;
  const admin = new Redis(redisUrl, { maxRetriesPerRequest: 1, connectionName: "verify-security-rate-02-admin" });
  const startedAt = new Date(Date.now() - 1000);
  const createdKeys = new Set<string>();
  const auditDigests = new Set<string>();
  const createdUserIds: string[] = [];
  const envBackup = { NODE_ENV: process.env.NODE_ENV, REDIS_URL: process.env.REDIS_URL, RATE_LIMIT_HMAC_KEY: process.env.RATE_LIMIT_HMAC_KEY };

  const keyFor = (policy: import("../app/src/lib/security/rateLimitCore").RateLimitPolicy, value: string) => {
    const k = core.limiterKey(hmacKey, policy, value);
    createdKeys.add(k);
    auditDigests.add(core.limiterDigest(hmacKey, policy, value).slice(0, 16));
    return k;
  };
  const clearIpBuckets = async (ips: string[]) => {
    for (const ipText of ips) {
      for (const policy of [P.LOGIN_IP, P.MFA_IP, P.EMAIL_RESEND_IP, P.PASSWORD_FORGOT_IP]) await admin.del(keyFor(policy, ipText));
    }
  };
  const testPolicy = (suffix: string, capacity: number, windowMs = 60_000, extra: Partial<import("../app/src/lib/security/rateLimitCore").RateLimitPolicy> = {}) => ({
    id: `verify.security_rate_02.${RUN_ID}.${suffix}`,
    version: 1,
    dimension: "account" as const,
    capacity,
    windowMs,
    onBackendFailure: "LOCAL_FALLBACK" as const,
    onSuccess: "RESET" as const,
    basis: "verify",
    ...extra,
  });

  try {
    // SWEEP: 過去の失敗runが残したテストユーザー
    const leftovers = await db.user.findMany({ where: { email: { startsWith: EMAIL_PREFIX, endsWith: "@example.invalid" } }, select: { id: true } });
    for (const u of leftovers) {
      const errs = await purgeHttpVerifyUser(db, u.id, EMAIL_PREFIX);
      if (errs.length) console.log(`  (sweep) ${errs.join("; ")}`);
    }
    const leftoverKeys = await admin.keys(`${core.RATE_LIMIT_KEY_PREFIX}:v1:verify.security_rate_02.*`);
    if (leftoverKeys.length) await admin.del(...leftoverKeys);

    // =====================================================================
    console.log("[R1] 複数clientから同じkeyへ同時要求");
    {
      const policy = testPolicy("r1", 10);
      const key = keyFor(policy, "r1@example.invalid");
      const clients = Array.from({ length: 8 }, () => new Redis(redisUrl, { maxRetriesPerRequest: 1 }));
      const replies = await Promise.all(
        clients.flatMap((c) => Array.from({ length: 5 }, () => c.eval(core.TAKE_BUCKETS_LUA, 1, key, policy.capacity, policy.windowMs, 1, core.bucketTtlMs(policy)))),
      );
      const allowed = replies.map((r) => core.parseTakeBucketsReply(r, 1)).filter((r) => r.allowed).length;
      ok("[R1] 40要求のうち許可はちょうど10(上限を超えない)", allowed === 10, `allowed=${allowed}`);
      await Promise.all(clients.map((c) => c.quit()));
    }

    console.log("[R2] 複数processから同じkeyへ同時要求");
    {
      const policy = testPolicy("r2", 12);
      const key = keyFor(policy, "r2@example.invalid");
      const childCode = `
        const Redis = require(process.env.IOREDIS_PATH);
        const c = new Redis(process.env.REDIS_URL, { maxRetriesPerRequest: 1 });
        (async () => {
          await new Promise((r) => setTimeout(r, Number(process.env.START_AT) - Date.now()));
          const rs = await Promise.all(Array.from({ length: 10 }, () => c.eval(process.env.LUA, 1, process.env.KEY, ${policy.capacity}, ${policy.windowMs}, 1, ${core.bucketTtlMs(policy)})));
          process.stdout.write(String(rs.filter((r) => Number(r[0]) === 1).length));
          await c.quit();
        })().catch((e) => { console.error(e); process.exit(1); });`;
      const startAt = Date.now() + 1500;
      const counts = await Promise.all(
        Array.from({ length: 4 }, () =>
          new Promise<number>((resolveCount, reject) => {
            const child = spawn(process.execPath, ["-e", childCode], {
              env: { ...process.env, IOREDIS_PATH: appRequire.resolve("ioredis"), LUA: core.TAKE_BUCKETS_LUA, KEY: key, START_AT: String(startAt) },
              stdio: ["ignore", "pipe", "inherit"],
            });
            let out = "";
            child.stdout.on("data", (d) => (out += d));
            child.on("exit", (code) => (code === 0 ? resolveCount(Number(out)) : reject(new Error(`child exit ${code}`))));
          }),
        ),
      );
      const total = counts.reduce((a, b) => a + b, 0);
      ok("[R2] 4 process×10要求のうち許可はちょうど12", total === 12, `counts=${counts.join(",")}`);
    }

    console.log("[R3] TTL・key形式");
    {
      const policy = testPolicy("r3", 3, 30_000);
      const key = keyFor(policy, "r3@example.invalid");
      await admin.eval(core.TAKE_BUCKETS_LUA, 1, key, policy.capacity, policy.windowMs, 1, core.bucketTtlMs(policy));
      const pttl = await admin.pttl(key);
      ok("[R3] TTLが設定され、空→満杯の時間+余裕以内", pttl > 0 && pttl <= core.bucketTtlMs(policy), `pttl=${pttl}`);
      ok("[R3] keyに生のemailを含まない", !key.includes("r3@") && !key.includes("example"));
      const h = await admin.hgetall(key);
      ok("[R3] bucketは残量・更新時刻・拒否flagだけ", Object.keys(h).sort().join(",") === "b,t,ts" && Number(h.t) === 2, JSON.stringify(h));
    }

    console.log("[R4] 複数bucketの全か無か");
    {
      const pa = testPolicy("r4a", 5);
      const pb = testPolicy("r4b", 1);
      const ka = keyFor(pa, "r4@example.invalid");
      const kb = keyFor(pb, "r4@example.invalid");
      const args = [pa.capacity, pa.windowMs, 1, core.bucketTtlMs(pa), pb.capacity, pb.windowMs, 1, core.bucketTtlMs(pb)];
      const first = core.parseTakeBucketsReply(await admin.eval(core.TAKE_BUCKETS_LUA, 2, ka, kb, ...args), 2);
      const second = core.parseTakeBucketsReply(await admin.eval(core.TAKE_BUCKETS_LUA, 2, ka, kb, ...args), 2);
      const ta = Number(await admin.hget(ka, "t"));
      ok("[R4] 1回目は両方消費", first.allowed);
      ok("[R4] 2回目はbが不足→拒否、aは消費されない", !second.allowed && second.buckets[1]!.denied && !second.buckets[0]!.denied && Math.abs(ta - 4) < 0.01, `a.t=${ta}`);
    }

    console.log("[R5] limiter API(RESET/REFUND・Retry-After・監査)");
    {
      await limiter.resetRateLimiterForTesting();
      const pr = testPolicy("r5reset", 3, 60_000, { onSuccess: "RESET" });
      const pf = testPolicy("r5refund", 3, 60_000, { dimension: "ip", onSuccess: "REFUND" });
      const acct = "r5@example.invalid";
      const ipv = "198.51.100.55";
      keyFor(pr, acct);
      keyFor(pf, ipv);
      const scope = `verify_gate_security_rate_02 ${RUN_ID}`;
      const d1 = await limiter.consumeRateLimit(scope, [{ policy: pr, value: acct }, { policy: pf, value: ipv }]);
      ok("[R5] Redisで判定", d1.allowed && d1.backend === "redis" && !d1.degraded);
      await limiter.consumeRateLimit(scope, [{ policy: pr, value: acct }, { policy: pf, value: ipv }]);
      await limiter.settleRateLimitSuccess(d1);
      const tf = Number(await admin.hget(core.limiterKey(hmacKey, pf, ipv), "t"));
      const existsReset = await admin.exists(core.limiterKey(hmacKey, pr, acct));
      ok("[R5] RESETはkey削除(満杯)、REFUNDは1回分だけ戻す", existsReset === 0 && Math.abs(tf - 2) < 0.05, `reset.exists=${existsReset} refund.t=${tf}`);
      for (let i = 0; i < 3; i++) await limiter.consumeRateLimit(scope, [{ policy: pr, value: acct }]);
      const denied = await limiter.consumeRateLimit(scope, [{ policy: pr, value: acct }]);
      const denied2 = await limiter.consumeRateLimit(scope, [{ policy: pr, value: acct }]);
      ok("[R5] 上限直後は拒否・retryAfter>0", !denied.allowed && denied.reason === "LIMITED" && denied.retryAfterMs > 0 && denied.retryAfterMs <= 20_000, JSON.stringify(denied));
      ok("[R5] 拒否したpolicy idを返す", !denied.allowed && denied.deniedPolicyIds.join() === pr.id && !denied2.allowed);
      const audits = await db.auditLog.findMany({ where: { action: "RATE_LIMIT_BLOCKED", targetId: pr.id } });
      ok("[R5] 拒否の監査ははじめて拒否した1回だけ", audits.length === 1, `count=${audits.length}`);
      ok("[R5] 監査に生のemailを含まない", audits.every((a) => !(a.reason ?? "").includes(acct) && !(a.reason ?? "").includes("r5@")));
    }

    console.log("[R6] Redis再接続");
    {
      const pol = testPolicy("r6", 100, 60 * 60 * 1000);
      keyFor(pol, "r6@example.invalid");
      const before = await limiter.consumeRateLimit("verify r6", [{ policy: pol, value: "r6@example.invalid" }]);
      const list = String(await admin.client("LIST"));
      const ids = list.split("\n").filter((l) => l.includes("name=ismay-rate-limit")).map((l) => /id=(\d+)/.exec(l)?.[1]).filter(Boolean) as string[];
      for (const id of ids) await admin.client("KILL", "ID", id);
      const client = limiter.getRateLimiterRedisForTesting();
      let ready = false;
      for (let i = 0; i < 50; i++) {
        await sleep(100);
        if (client?.status === "ready") {
          ready = true;
          break;
        }
      }
      const after = await limiter.consumeRateLimit("verify r6", [{ policy: pol, value: "r6@example.invalid" }]);
      ok("[R6] 切断前はRedis", before.allowed && before.backend === "redis");
      ok("[R6] 切断した接続がある(limiter接続を特定できた)", ids.length >= 1, `ids=${ids.length}`);
      ok("[R6] 自動再接続しRedisで判定を続ける", ready && after.allowed && after.backend === "redis", `status=${client?.status} backend=${after.backend}`);
      const t = Number(await admin.hget(core.limiterKey(hmacKey, pol, "r6@example.invalid"), "t"));
      ok("[R6] 再接続後も同じbucketを使う(2回消費)", Math.abs(t - 98) < 0.1, `t=${t}`);
    }

    console.log("[R7] Redis接続不能時のpolicy");
    {
      process.env.REDIS_URL = "redis://127.0.0.1:1";
      await limiter.resetRateLimiterForTesting();
      const beforeAudit = await db.auditLog.count({ where: { action: "RATE_LIMIT_BACKEND_DEGRADED", occurredAt: { gte: startedAt } } });
      const loginLike = testPolicy("r7login", 3, 60_000, { onBackendFailure: "LOCAL_FALLBACK" });
      const mailLike = testPolicy("r7mail", 3, 60_000, { dimension: "ip", onBackendFailure: "FAIL_CLOSED", onSuccess: "NONE" });
      const t0 = Date.now();
      const results = [];
      for (let i = 0; i < 4; i++) results.push(await limiter.consumeRateLimit("verify r7", [{ policy: loginLike, value: "r7@example.invalid" }]));
      const elapsed = Date.now() - t0;
      ok("[R7] login系: process内縮退で3回まで許可", results.slice(0, 3).every((r) => r.allowed && r.backend === "local" && r.degraded));
      ok("[R7] login系: 縮退中も上限を守る(4回目は拒否)", !results[3]!.allowed && results[3]!.reason === "LIMITED");
      ok("[R7] 接続不能でも要求を長く待たせない(4回で5秒未満)", elapsed < 5000, `elapsed=${elapsed}ms`);
      const mail = await limiter.consumeRateLimit("verify r7", [{ policy: mailLike, value: "198.51.100.77" }]);
      ok("[R7] メール系: fail closed", !mail.allowed && mail.reason === "BACKEND_UNAVAILABLE" && mail.deniedPolicyIds.join() === mailLike.id);
      const afterAudit = await db.auditLog.count({ where: { action: "RATE_LIMIT_BACKEND_DEGRADED", occurredAt: { gte: startedAt } } });
      ok("[R7] 縮退を監査に記録(間引きあり)", afterAudit - beforeAudit === 1, `delta=${afterAudit - beforeAudit}`);
      const none = await limiter.consumeRateLimit("verify r7", [{ policy: mailLike, value: null }]);
      ok("[R7] 判定対象が無い(IP不明)ならbackendに依存しない", none.allowed && none.backend === "none");
      process.env.REDIS_URL = envBackup.REDIS_URL;
    }

    console.log("[R8] productionでREDIS_URL未設定");
    {
      (process.env as Record<string, string | undefined>).NODE_ENV = "production";
      delete process.env.REDIS_URL;
      await limiter.resetRateLimiterForTesting();
      const loginLike = testPolicy("r8login", 2);
      const mailLike = testPolicy("r8mail", 2, 60_000, { dimension: "ip", onBackendFailure: "FAIL_CLOSED", onSuccess: "NONE" });
      const a = await limiter.consumeRateLimit("verify r8", [{ policy: loginLike, value: "r8@example.invalid" }]);
      const m = await limiter.consumeRateLimit("verify r8", [{ policy: mailLike, value: "198.51.100.88" }]);
      ok("[R8] login系はprocess内縮退(degraded=true)", a.allowed && a.backend === "local" && a.degraded);
      ok("[R8] メール系はfail closed", !m.allowed && m.reason === "BACKEND_UNAVAILABLE");
      (process.env as Record<string, string | undefined>).NODE_ENV = envBackup.NODE_ENV;
      process.env.REDIS_URL = envBackup.REDIS_URL;
      await limiter.resetRateLimiterForTesting();
    }

    // =====================================================================
    // HTTP
    // =====================================================================
    const reach = await fetch(`${BASE_URL}/api/v1/auth/me`).then((r) => r.status).catch(() => 0);
    if (reach === 0) {
      ok(`[H] サーバー(${BASE_URL})へ接続できる`, false, "サーバーを起動してください(npm run start)");
      return;
    }
    await clearIpBuckets(LOOPBACKS);

    const register = async (label: string): Promise<{ email: string; userId: string }> => {
      const email = `${EMAIL_PREFIX}${label}-${RUN_ID}@example.invalid`;
      const r = await http(BASE_URL, "/api/v1/auth/register", { body: { email, password: PASSWORD } });
      const userId = String((r.body?.data?.user as { id?: string } | undefined)?.id ?? "");
      if (userId) createdUserIds.push(userId);
      keyFor(P.LOGIN_ACCOUNT, email);
      return { email, userId };
    };
    const login = (base: string, email: string, password: string, headers: Record<string, string> = {}, jar?: Jar) =>
      http(base, "/api/v1/auth/login", { body: { email, password }, headers, jar });

    const userA = await register("a");
    await markTestUserEmailVerified(db, userA.email);
    ok("[H0] テストユーザー作成", userA.userId.length > 0);

    console.log("[H1] login連続失敗");
    {
      const codes: number[] = [];
      for (let i = 0; i < 10; i++) codes.push((await login(BASE_URL, userA.email, "WrongPass!1")).status);
      const eleventh = await login(BASE_URL, userA.email, "WrongPass!1");
      const correctWhileLocked = await login(BASE_URL, userA.email, PASSWORD);
      ok("[H1] 10回目までは401 CREDENTIALS_INVALID", codes.every((c) => c === 401), codes.join(","));
      ok("[H1] 11回目は403 ACCOUNT_LOCKED", eleventh.status === 403 && eleventh.body?.error?.code === "ACCOUNT_LOCKED");
      const ra = Number(eleventh.headers.get("retry-after"));
      ok("[H1] Retry-After(秒)が1回分の補充時間以内", ra >= 1 && ra <= 90, `retry-after=${ra}`);
      ok("[H1] ロック中は正しいパスワードでも拒否(総当たりの成功を判別させない)", correctWhileLocked.status === 403 && correctWhileLocked.body?.error?.code === "ACCOUNT_LOCKED");
      const rows = await db.auditLog.findMany({ where: { action: "RATE_LIMIT_BLOCKED", targetId: P.LOGIN_ACCOUNT.id, occurredAt: { gte: startedAt } } });
      const digest = core.limiterDigest(hmacKey, P.LOGIN_ACCOUNT, userA.email).slice(0, 16);
      ok("[H1] ロックを監査(生のemail・パスワードなし)", rows.some((r) => (r.reason ?? "").includes(`key=${digest}`)) && rows.every((r) => !(r.reason ?? "").includes(userA.email) && !(r.reason ?? "").includes("WrongPass")));
      ok("[H1] Redis keyに生のemailが無い", (await admin.keys(`*${userA.email}*`)).length === 0);
      await admin.del(core.limiterKey(hmacKey, P.LOGIN_ACCOUNT, userA.email));
      const after = await login(BASE_URL, userA.email, PASSWORD);
      ok("[H1] ロック解除後は正しいパスワードでログインできる", after.status === 200);
    }
    await clearIpBuckets(LOOPBACKS);

    console.log("[H2] 正しいパスワードで失敗回数が戻る");
    {
      for (let i = 0; i < 9; i++) await login(BASE_URL, userA.email, "WrongPass!1");
      const good = await login(BASE_URL, userA.email, PASSWORD);
      const codes: number[] = [];
      for (let i = 0; i < 10; i++) codes.push((await login(BASE_URL, userA.email, "WrongPass!1")).status);
      const locked = await login(BASE_URL, userA.email, "WrongPass!1");
      ok("[H2] 9回失敗後の正しいパスワードは成功", good.status === 200);
      ok("[H2] 成功後は再び10回まで失敗を受け付ける", codes.every((c) => c === 401), codes.join(","));
      ok("[H2] 11回目はロック", locked.status === 403 && locked.body?.error?.code === "ACCOUNT_LOCKED");
      await admin.del(core.limiterKey(hmacKey, P.LOGIN_ACCOUNT, userA.email));
    }
    await clearIpBuckets(LOOPBACKS);

    console.log("[H3] 未登録アドレスの列挙耐性");
    {
      const ghost = `${EMAIL_PREFIX}ghost-${RUN_ID}@example.invalid`;
      keyFor(P.LOGIN_ACCOUNT, ghost);
      const first = await login(BASE_URL, ghost, "WrongPass!1");
      for (let i = 0; i < 9; i++) await login(BASE_URL, ghost, "WrongPass!1");
      const locked = await login(BASE_URL, ghost, "WrongPass!1");
      const existingFirst = await login(BASE_URL, userA.email, "WrongPass!1");
      ok("[H3] 未登録も登録済みも同じ401・同じmessage", first.status === existingFirst.status && first.body?.error?.message === existingFirst.body?.error?.message);
      ok("[H3] 未登録も11回目で同じACCOUNT_LOCKED", locked.status === 403 && locked.body?.error?.code === "ACCOUNT_LOCKED");
      await admin.del(core.limiterKey(hmacKey, P.LOGIN_ACCOUNT, userA.email));
    }
    await clearIpBuckets(LOOPBACKS);

    console.log("[H4] MFA verify");
    {
      const userB = await register("b");
      await markTestUserEmailVerified(db, userB.email);
      keyFor(P.MFA_USER, userB.userId);
      const jar: Jar = {};
      await login(BASE_URL, userB.email, PASSWORD, {}, jar);
      const enroll = await http(BASE_URL, "/api/v1/auth/mfa/enroll", { jar, csrf: true });
      const secret = String(enroll.body?.data?.secret ?? "");
      const confirm = await http(BASE_URL, "/api/v1/auth/mfa/enroll/confirm", {
        jar,
        csrf: true,
        body: { enrollmentToken: enroll.body?.data?.enrollmentToken, code: await generate({ secret }) },
      });
      ok("[H4] TOTP登録", enroll.status === 200 && confirm.status === 200, `${enroll.status}/${confirm.status}`);
      const challenge = async () => String((await login(BASE_URL, userB.email, PASSWORD)).body?.data?.challengeToken ?? "");
      const wrongCode = async () => {
        const good = await generate({ secret });
        return good === "000000" ? "111111" : "000000";
      };
      const c1 = await challenge();
      const codes: number[] = [];
      for (let i = 0; i < 5; i++) codes.push((await http(BASE_URL, "/api/v1/auth/mfa/verify", { body: { challengeToken: c1, code: await wrongCode() } })).status);
      const sixth = await http(BASE_URL, "/api/v1/auth/mfa/verify", { body: { challengeToken: c1, code: await wrongCode() } });
      ok("[H4] 5回目までは401 MFA_INVALID", codes.every((c) => c === 401), codes.join(","));
      ok("[H4] 6回目は429 RATE_LIMITED+Retry-After", sixth.status === 429 && sixth.body?.error?.code === "RATE_LIMITED" && Number(sixth.headers.get("retry-after")) >= 1);
      const c2 = await challenge();
      const goodWhileLimited = await http(BASE_URL, "/api/v1/auth/mfa/verify", { body: { challengeToken: c2, code: await generate({ secret }) } });
      ok("[H4] challengeを取り直しても回数は戻らない(正しいコードも拒否)", goodWhileLimited.status === 429);
      await admin.del(core.limiterKey(hmacKey, P.MFA_USER, userB.userId));
      await clearIpBuckets(LOOPBACKS);
      const c3 = await challenge();
      for (let i = 0; i < 4; i++) await http(BASE_URL, "/api/v1/auth/mfa/verify", { body: { challengeToken: c3, code: await wrongCode() } });
      const good = await http(BASE_URL, "/api/v1/auth/mfa/verify", { body: { challengeToken: c3, code: await generate({ secret }) } });
      ok("[H4] 4回失敗後の正しいコードは成功", good.status === 200);
      ok("[H4] 成功で回数が戻る(user bucketは満杯=key削除)", (await admin.exists(core.limiterKey(hmacKey, P.MFA_USER, userB.userId))) === 0);
    }
    await clearIpBuckets(LOOPBACKS);

    console.log("[H5] resend/forgotの列挙耐性");
    {
      const unverified = await register("c");
      const ghost = `${EMAIL_PREFIX}ghost2-${RUN_ID}@example.invalid`;
      const res1 = await http(BASE_URL, "/api/v1/auth/email/resend", { body: { email: unverified.email } });
      const res2 = await http(BASE_URL, "/api/v1/auth/email/resend", { body: { email: ghost } });
      const res3 = await http(BASE_URL, "/api/v1/auth/email/resend", { body: { email: userA.email } });
      const same = (a: HttpResult, b: HttpResult) => a.status === b.status && JSON.stringify(a.body?.data) === JSON.stringify(b.body?.data);
      ok("[H5] resend: 未確認・未登録・確認済みで応答が同じ", same(res1, res2) && same(res1, res3) && res1.status === 200);
      const f1 = await http(BASE_URL, "/api/v1/auth/password/forgot", { body: { email: userA.email } });
      const f2 = await http(BASE_URL, "/api/v1/auth/password/forgot", { body: { email: ghost } });
      const f3 = await http(BASE_URL, "/api/v1/auth/password/forgot", { body: { email: unverified.email } });
      ok("[H5] forgot: 確認済み・未登録・未確認で応答が同じ", same(f1, f2) && same(f1, f3) && f1.status === 200);
      // IP上限: client IPが解決できるサーバー(custom server)でのみ判定される
      await sleep(500);
      const before = await db.authEmailToken.count({ where: { userId: userA.userId, purpose: "PASSWORD_RESET" } });
      const statuses: number[] = [];
      for (let i = 0; i < 20; i++) statuses.push((await http(BASE_URL, "/api/v1/auth/password/forgot", { body: { email: `${EMAIL_PREFIX}flood${i}-${RUN_ID}@example.invalid` } })).status);
      // userAの前回発行から60秒以内だとDB側のINTERVALでも発行されないため、DBの発行時刻を過去へずらしておく
      await db.authEmailToken.updateMany({ where: { userId: userA.userId }, data: { createdAt: new Date(Date.now() - 2 * 60 * 60 * 1000) } });
      const limited = await http(BASE_URL, "/api/v1/auth/password/forgot", { body: { email: userA.email } });
      await sleep(1500);
      const after = await db.authEmailToken.count({ where: { userId: userA.userId, purpose: "PASSWORD_RESET" } });
      const ipKnown = await admin.exists(core.limiterKey(hmacKey, P.PASSWORD_FORGOT_IP, "127.0.0.1"), core.limiterKey(hmacKey, P.PASSWORD_FORGOT_IP, "::1"));
      ok("[H5] 上限到達後も同じaccepted応答", limited.status === 200 && same(limited, f1) && statuses.every((s) => s === 200));
      if (ipKnown > 0) {
        ok("[H5] IP上限(21件目)では発行しない", after === before, `before=${before} after=${after}`);
      } else {
        skip("[H5] IP上限(21件目)では発行しない", "サーバーがclient IPを解決できない構成(peer不明)。IP次元のpolicyは判定されない");
      }
    }
    await clearIpBuckets(LOOPBACKS);

    console.log("[H6] 偽装X-Forwarded-For・偽装peer header");
    {
      const failSeries = async (base: string, xff: (i: number) => string | null, extra: Record<string, string> = {}) => {
        const statuses: number[] = [];
        for (let i = 0; i < 31; i++) {
          const email = `${EMAIL_PREFIX}spoof${i}-${RUN_ID}@example.invalid`;
          keyFor(P.LOGIN_ACCOUNT, email);
          const h: Record<string, string> = { ...extra };
          const x = xff(i);
          if (x) h["x-forwarded-for"] = x;
          statuses.push((await login(base, email, "WrongPass!1", h)).status);
        }
        return statuses;
      };
      const sameXff = await failSeries(BASE_URL, () => "203.0.113.77");
      await clearIpBuckets(LOOPBACKS);
      const distinctXff = await failSeries(BASE_URL, (i) => `203.0.113.${i + 1}`, { "x-real-ip": "203.0.113.200", "x-ismay-peer-address": "forged 203.0.113.201" });
      await clearIpBuckets(LOOPBACKS);
      const blockedSame = sameXff[30] === 429;
      const blockedDistinct = distinctXff[30] === 429;
      ok("[H6] 30回目までは401", sameXff.slice(0, 30).every((s) => s === 401) && distinctXff.slice(0, 30).every((s) => s === 401));
      ok("[H6] XFFの値を変えてもIP bucketは分かれない(偽装XFFを信用しない)", blockedSame === blockedDistinct, `same=${sameXff[30]} distinct=${distinctXff[30]}`);
      const mode = blockedSame ? "peer解決(custom server)" : "peer不明";
      console.log(`    (サーバーのclient IP解決: ${mode})`);
      const jar: Jar = {};
      await login(BASE_URL, userA.email, PASSWORD, { "x-forwarded-for": "6.6.6.6", "x-real-ip": "7.7.7.7", "x-ismay-peer-address": "forged 9.9.9.9" }, jar);
      const sessions = await db.userSession.findMany({ where: { userId: userA.userId }, orderBy: { issuedAt: "desc" }, take: 1 });
      const sip = sessions[0]?.ipAddress ?? null;
      ok("[H6] sessionのIPに偽装値を記録しない", sip !== "6.6.6.6" && sip !== "7.7.7.7" && sip !== "9.9.9.9", `ip=${sip}`);
      ok("[H6] sessionのIPはloopback(peer解決時)またはnull(peer不明時)", blockedSame ? sip === "127.0.0.1" || sip === "::1" : sip === null, `ip=${sip}`);
      if (process.env.EXPECT_PEER_RESOLVED === "1") ok("[H6] EXPECT_PEER_RESOLVED=1: サーバーがpeerを解決している", blockedSame);
    }
    await clearIpBuckets(LOOPBACKS);

    console.log("[H7] 信頼proxy経由");
    if (!TRUSTED_PROXY_BASE_URL) {
      skip("[H7] 信頼proxy経由のclient IP", "TRUSTED_PROXY_BASE_URL未指定");
    } else {
      const series = async (xff: (i: number) => string) => {
        const statuses: number[] = [];
        for (let i = 0; i < 31; i++) {
          const email = `${EMAIL_PREFIX}proxy${i}-${RUN_ID}@example.invalid`;
          keyFor(P.LOGIN_ACCOUNT, email);
          statuses.push((await login(TRUSTED_PROXY_BASE_URL, email, "WrongPass!1", { "x-forwarded-for": xff(i) })).status);
        }
        return statuses;
      };
      const ips = Array.from({ length: 31 }, (_, i) => `198.51.100.${i + 1}`);
      await clearIpBuckets([...ips, "198.51.100.200", "198.51.100.9"]);
      const distinct = await series((i) => ips[i]!);
      const same = await series(() => "6.6.6.6, 198.51.100.200");
      ok("[H7] clientごとに別IP bucket(31件とも401)", distinct.every((s) => s === 401), distinct.slice(-3).join(","));
      ok("[H7] 同じclientは31件目で429(左側の偽装値は無視して右端のclientで数える)", same[30] === 429 && same.slice(0, 30).every((s) => s === 401));
      const jar: Jar = {};
      await login(TRUSTED_PROXY_BASE_URL, userA.email, PASSWORD, { "x-forwarded-for": "6.6.6.6, 198.51.100.9" }, jar);
      const s = await db.userSession.findMany({ where: { userId: userA.userId }, orderBy: { issuedAt: "desc" }, take: 1 });
      ok("[H7] sessionのIPはproxyが付けたclient IP", s[0]?.ipAddress === "198.51.100.9", `ip=${s[0]?.ipAddress}`);
      await clearIpBuckets([...ips, "198.51.100.200", "198.51.100.9"]);
    }

    console.log("[H8] CSRF・cookie・session・refresh(既存契約の回帰)");
    {
      const jar: Jar = {};
      const r = await login(BASE_URL, userA.email, PASSWORD, {}, jar);
      const at = r.setCookies.find((c) => c.startsWith("ismay_at="));
      const rt = r.setCookies.find((c) => c.startsWith("ismay_rt="));
      const cs = r.setCookies.find((c) => c.startsWith("ismay_csrf="));
      ok("[H8] access/refresh cookieはHttpOnly・SameSite=Lax", !!at && !!rt && /HttpOnly/i.test(at!) && /HttpOnly/i.test(rt!) && /SameSite=lax/i.test(at!) && /SameSite=lax/i.test(rt!));
      ok("[H8] refresh cookieのpathは/api/v1/auth", !!rt && /Path=\/api\/v1\/auth/i.test(rt!));
      ok("[H8] CSRF cookieはJSから読める(Double Submit)", !!cs && !/HttpOnly/i.test(cs!));
      const me = await http(BASE_URL, "/api/v1/auth/me", { method: "GET", jar });
      ok("[H8] cookieで認証できる", me.status === 200);
      const oldRt = jar.ismay_rt!;
      const refreshed = await http(BASE_URL, "/api/v1/auth/refresh", { jar });
      ok("[H8] refreshで回転する", refreshed.status === 200 && jar.ismay_rt !== oldRt);
      const reuse = await http(BASE_URL, "/api/v1/auth/refresh", { jar: { ismay_rt: oldRt } });
      ok("[H8] 旧refresh tokenの再利用は拒否", reuse.status === 401);
      // 現行契約(rotateSessionは同じsession行のhashを更新する): 旧tokenは見つからず拒否されるだけで、
      // 系列の失効は失効済みsessionのtokenが提示された場合に限られる(DEC-SECURITY-RATE-02 §2の棚卸し参照)。
      const next = await http(BASE_URL, "/api/v1/auth/refresh", { jar });
      ok("[H8] 回転後の新tokenは引き続き有効(現行契約)", next.status === 200);
      const jar2: Jar = {};
      await login(BASE_URL, userA.email, PASSWORD, {}, jar2);
      const noCsrf = await http(BASE_URL, "/api/v1/auth/logout", { jar: jar2 });
      ok("[H8] CSRF headerなしのlogoutは403", noCsrf.status === 403);
      const withCsrf = await http(BASE_URL, "/api/v1/auth/logout", { jar: jar2, csrf: true });
      ok("[H8] CSRF header付きlogoutは成功", withCsrf.status === 200);
    }
  } finally {
    // ============================================================ cleanup
    process.env.NODE_ENV = envBackup.NODE_ENV;
    process.env.REDIS_URL = envBackup.REDIS_URL;
    await limiter.resetRateLimiterForTesting();
    const cleanupErrors: string[] = [];
    for (const id of createdUserIds) cleanupErrors.push(...(await purgeHttpVerifyUser(db, id, EMAIL_PREFIX)));
    if (createdKeys.size > 0) await admin.del(...createdKeys);
    const testKeys = await admin.keys(`${core.RATE_LIMIT_KEY_PREFIX}:v1:verify.security_rate_02.${RUN_ID}.*`);
    if (testKeys.length) await admin.del(...testKeys);
    const auditRows = await db.auditLog.findMany({
      where: { occurredAt: { gte: startedAt }, action: { in: ["RATE_LIMIT_BLOCKED", "RATE_LIMIT_BACKEND_DEGRADED"] } },
      select: { id: true, reason: true, targetId: true },
    });
    const mine = auditRows.filter(
      (r) =>
        (r.targetId ?? "").startsWith(`verify.security_rate_02.${RUN_ID}`) ||
        [...auditDigests].some((d) => (r.reason ?? "").includes(`key=${d}`)) ||
        (r.reason ?? "").startsWith("verify r"),
    );
    if (mine.length) await db.auditLog.deleteMany({ where: { id: { in: mine.map((r) => r.id) } } });
    const remainUsers = await db.user.count({ where: { email: { startsWith: EMAIL_PREFIX } } });
    const remainKeys = [...createdKeys].length ? await admin.exists(...createdKeys) : 0;
    console.log("[cleanup]");
    ok("[cleanup] テストユーザーの残存0", remainUsers === 0 && cleanupErrors.length === 0, cleanupErrors.join("; "));
    ok("[cleanup] 試験で作ったRedis keyの残存0", remainKeys === 0, `remain=${remainKeys}`);
    await admin.quit();
    await db.$disconnect();
  }
}

main()
  .then(() => {
    console.log(`\n${passed} passed, ${failed} failed, ${skipped} skipped`);
    if (failed > 0) {
      console.log("FAILURES:\n" + failures.map((f) => `  - ${f}`).join("\n"));
      process.exit(1);
    }
    process.exit(0);
  })
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
