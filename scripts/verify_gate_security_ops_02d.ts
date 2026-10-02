#!/usr/bin/env node
/**
 * scripts/verify_gate_security_ops_02d.ts
 *
 * SECURITY-RATE-02D(運用hardening)の実Redis・HTTP受入試験。
 * 運用: docs/runbooks/SECURITY_RATE_RUNBOOK.md。
 *
 *   [D1] Redisは認証必須(passwordなしの接続はNOAUTH)。app/.envのREDIS_URL(password付き)では接続できる
 *   [D2] HMAC key rotation: RATE_LIMIT_HMAC_KEY_PREVIOUSを指定すると旧keyのbucket(残量・TTL)を新keyへ移して判定を続ける。
 *        移した後は旧keyが残らない。PREVIOUSを外した後も新keyのbucketで判定を続ける
 *   [D3] GET /api/v1/health: loopbackからは200 status=ok と各checkの詳細。応答に接続文字列・秘密値を含まない。
 *        偽装X-Forwarded-Forを付けても(信頼proxyでない接続元からは)扱いが変わらない
 *   cleanup後の残存0(試験で作ったRedis key)。
 *
 * 実行方法(app/.envのREDIS_URL・RATE_LIMIT_HMAC_KEYを使う。サーバーと同じ値であること):
 *   cd ~/projects/ismay/app
 *   npx tsx ../scripts/verify_gate_security_ops_02d.ts
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { createRequire } from "node:module";

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
const RUN_ID = Date.now().toString(36) + Math.random().toString(36).slice(2, 8);

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

async function main(): Promise<void> {
  const core = await import("../app/src/lib/security/rateLimitCore");
  const limiter = await import("../app/src/lib/security/rateLimiter");
  // ioredisの型はapp/node_modulesにあり、scripts/からは解決できないため、使う操作だけの構造型で受ける
  interface RedisLike {
    connect(): Promise<void>;
    ping(): Promise<string>;
    hget(key: string, field: string): Promise<string | null>;
    pttl(key: string): Promise<number>;
    exists(...keys: string[]): Promise<number>;
    del(...keys: string[]): Promise<number>;
    keys(pattern: string): Promise<string[]>;
    quit(): Promise<unknown>;
    disconnect(): void;
  }
  type RedisCtor = new (url: string, opts?: Record<string, unknown>) => RedisLike;
  const Redis = appRequire("ioredis") as RedisCtor;

  const redisUrl = process.env.REDIS_URL;
  const keyParsed = core.parseRateLimitHmacKey(process.env.RATE_LIMIT_HMAC_KEY);
  if (!redisUrl || !keyParsed.ok) {
    console.error("REDIS_URLとRATE_LIMIT_HMAC_KEYをapp/.envに設定してから実行してください(サーバーと同じ値)");
    process.exit(2);
  }
  const admin = new Redis(redisUrl, { maxRetriesPerRequest: 1, connectionName: "verify-security-ops-02d-admin" });
  const envBackup = {
    RATE_LIMIT_HMAC_KEY: process.env.RATE_LIMIT_HMAC_KEY,
    RATE_LIMIT_HMAC_KEY_PREVIOUS: process.env.RATE_LIMIT_HMAC_KEY_PREVIOUS,
  };
  const createdKeys = new Set<string>();
  const secretsToHide: string[] = [];

  try {
    // =====================================================================
    console.log("[D1] Redisの認証");
    {
      const u = new URL(redisUrl);
      if (u.password) secretsToHide.push(decodeURIComponent(u.password));
      ok("[D1] REDIS_URLにpasswordがある", u.password !== "");
      const noAuth = new URL(redisUrl);
      noAuth.password = "";
      noAuth.username = "";
      const anon = new Redis(noAuth.toString(), { maxRetriesPerRequest: 0, lazyConnect: true, enableReadyCheck: false, retryStrategy: () => null });
      let anonError = "";
      try {
        await anon.connect();
        await anon.ping();
      } catch (e) {
        anonError = e instanceof Error ? e.message : String(e);
      } finally {
        anon.disconnect();
      }
      ok("[D1] passwordなしの接続はNOAUTHで拒否", /NOAUTH|Authentication required/i.test(anonError), anonError || "(拒否されなかった)");
      ok("[D1] password付きのREDIS_URLでは接続できる", (await admin.ping()) === "PONG");
    }

    // =====================================================================
    console.log("[D2] HMAC key rotation(旧keyのbucketを新keyへ移す)");
    {
      const oldKeyText = Buffer.from(Array.from({ length: 32 }, (_, i) => (i * 7 + 3) % 256)).toString("base64");
      const newKeyText = Buffer.from(Array.from({ length: 32 }, (_, i) => (i * 11 + 5) % 256)).toString("base64");
      const oldKey = core.parseRateLimitHmacKey(oldKeyText);
      const newKey = core.parseRateLimitHmacKey(newKeyText);
      if (!oldKey.ok || !newKey.ok) throw new Error("試験用keyの生成に失敗");
      const policy = {
        id: `verify.security_ops_02d.${RUN_ID}.rotation`,
        version: 1,
        dimension: "account" as const,
        capacity: 5,
        windowMs: 60 * 60 * 1000,
        onBackendFailure: "LOCAL_FALLBACK" as const,
        onSuccess: "NONE" as const,
        basis: "verify",
      };
      const value = `rotation-${RUN_ID}@example.invalid`;
      const kOld = core.limiterKey(oldKey.key, policy, value);
      const kNew = core.limiterKey(newKey.key, policy, value);
      createdKeys.add(kOld);
      createdKeys.add(kNew);

      process.env.RATE_LIMIT_HMAC_KEY = oldKeyText;
      delete process.env.RATE_LIMIT_HMAC_KEY_PREVIOUS;
      await limiter.resetRateLimiterForTesting();
      for (let i = 0; i < 3; i++) await limiter.consumeRateLimit("verify d2", [{ policy, value }]);
      const tOld = Number(await admin.hget(kOld, "t"));
      ok("[D2] 旧keyで3回消費(残量2)", Math.abs(tOld - 2) < 0.01, `t=${tOld}`);

      process.env.RATE_LIMIT_HMAC_KEY = newKeyText;
      process.env.RATE_LIMIT_HMAC_KEY_PREVIOUS = oldKeyText;
      await limiter.resetRateLimiterForTesting();
      const d = await limiter.consumeRateLimit("verify d2", [{ policy, value }]);
      const tNew = Number(await admin.hget(kNew, "t"));
      const pttl = await admin.pttl(kNew);
      ok("[D2] rotation中の判定はRedisで許可", d.allowed && d.backend === "redis");
      ok("[D2] 旧bucketの残量を引き継いで1回消費(残量1)", Math.abs(tNew - 1) < 0.01, `t=${tNew}`);
      ok("[D2] 旧keyは残らない(RENAME)", (await admin.exists(kOld)) === 0);
      ok("[D2] TTLが設定されている", pttl > 0 && pttl <= core.bucketTtlMs(policy), `pttl=${pttl}`);
      const d2 = await limiter.consumeRateLimit("verify d2", [{ policy, value }]);
      const denied = await limiter.consumeRateLimit("verify d2", [{ policy, value }]);
      ok("[D2] 引き継いだ残量で上限を守る(残量0の次は拒否)", d2.allowed && !denied.allowed && denied.reason === "LIMITED");

      delete process.env.RATE_LIMIT_HMAC_KEY_PREVIOUS;
      await limiter.resetRateLimiterForTesting();
      const after = await limiter.consumeRateLimit("verify d2", [{ policy, value }]);
      ok("[D2] PREVIOUSを外した後も新keyのbucketで判定を続ける(拒否のまま)", !after.allowed && after.reason === "LIMITED");
    }

    // =====================================================================
    console.log("[D3] GET /api/v1/health");
    {
      const res = await fetch(`${BASE_URL}/api/v1/health`).catch(() => null);
      if (!res) {
        ok(`[D3] サーバー(${BASE_URL})へ接続できる`, false, "サーバーを起動してください");
      } else {
        const text = await res.text();
        let body: { status?: string; checks?: Record<string, unknown>; problems?: string[] } = {};
        try {
          body = JSON.parse(text);
        } catch {
          /* 下でNG */
        }
        ok("[D3] 200 status=ok", res.status === 200 && body.status === "ok", `status=${res.status} body=${text.slice(0, 300)}`);
        ok("[D3] loopbackからは詳細(checks)を返す", !!body.checks && Array.isArray(body.problems));
        const checks = body.checks as { database?: { ok?: boolean }; rateLimit?: { kind?: string; ok?: boolean } } | undefined;
        ok("[D3] DB・rate limit(Redis)が正常", checks?.database?.ok === true && checks?.rateLimit?.kind === "REDIS" && checks?.rateLimit?.ok === true, JSON.stringify(checks ?? {}));
        ok("[D3] 応答に接続文字列・秘密値を含まない", !/redis:\/\/|postgres(ql)?:\/\//i.test(text) && secretsToHide.every((s) => !text.includes(s)));
        ok("[D3] Cache-Control: no-store", (res.headers.get("cache-control") ?? "").includes("no-store"));
        const spoofed = await fetch(`${BASE_URL}/api/v1/health`, { headers: { "x-forwarded-for": "203.0.113.9", "x-ismay-peer-address": "forged 203.0.113.10" } });
        const spoofedBody = (await spoofed.json().catch(() => ({}))) as { checks?: unknown };
        ok("[D3] 偽装headerで扱いが変わらない(信頼proxyでない接続元)", spoofed.status === res.status && !!spoofedBody.checks === !!body.checks);
      }
    }
  } finally {
    process.env.RATE_LIMIT_HMAC_KEY = envBackup.RATE_LIMIT_HMAC_KEY;
    if (envBackup.RATE_LIMIT_HMAC_KEY_PREVIOUS === undefined) delete process.env.RATE_LIMIT_HMAC_KEY_PREVIOUS;
    else process.env.RATE_LIMIT_HMAC_KEY_PREVIOUS = envBackup.RATE_LIMIT_HMAC_KEY_PREVIOUS;
    await limiter.resetRateLimiterForTesting();
    if (createdKeys.size) await admin.del(...createdKeys);
    const leftover = await admin.keys(`${core.RATE_LIMIT_KEY_PREFIX}:v1:verify.security_ops_02d.${RUN_ID}.*`);
    if (leftover.length) await admin.del(...leftover);
    const remain = createdKeys.size ? await admin.exists(...createdKeys) : 0;
    console.log("[cleanup]");
    ok("[cleanup] 試験で作ったRedis keyの残存0", remain === 0, `remain=${remain}`);
    const { db } = await import("../app/src/lib/db");
    // [D2]の拒否で記録された監査(RATE_LIMIT_BLOCKED、target=試験用policy)
    await db.auditLog.deleteMany({ where: { action: "RATE_LIMIT_BLOCKED", targetId: { startsWith: `verify.security_ops_02d.${RUN_ID}` } } });
    const remainAudit = await db.auditLog.count({ where: { targetId: { startsWith: `verify.security_ops_02d.${RUN_ID}` } } });
    ok("[cleanup] 試験で作った監査記録の残存0", remainAudit === 0, `remain=${remainAudit}`);
    await admin.quit();
    await db.$disconnect();
  }
}

main()
  .then(() => {
    console.log(`\n${passed} passed, ${failed} failed`);
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
