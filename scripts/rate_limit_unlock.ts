#!/usr/bin/env node
/**
 * scripts/rate_limit_unlock.ts
 *
 * [SECURITY-RATE-02B新設・2026-09-26] rate limitのbucket(Redis key)を計算し、必要なら削除する運用tool。
 * keyは生の値ではなくRATE_LIMIT_HMAC_KEYによるHMACのため、運用者が手で組み立てられない。
 * 手順: docs/runbooks/SECURITY_RATE_RUNBOOK.md §4.1。
 *
 * 使い方(app/.envのREDIS_URL・RATE_LIMIT_HMAC_KEYを使う):
 *   cd ~/projects/ismay/app
 *   npx tsx ../scripts/rate_limit_unlock.ts LOGIN_ACCOUNT user@example.com            # keyと現在値を表示
 *   npx tsx ../scripts/rate_limit_unlock.ts LOGIN_ACCOUNT user@example.com --delete   # 削除(=満杯へ戻す)
 *   policy名: LOGIN_ACCOUNT / LOGIN_IP / MFA_USER / MFA_IP / EMAIL_RESEND_IP / PASSWORD_FORGOT_IP
 * 入力値そのものは表示・記録しない。
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
const APP_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "app");
loadDotEnv(join(APP_DIR, ".env"));

async function main(): Promise<number> {
  const [policyName, value, flag] = process.argv.slice(2);
  const core = await import("../app/src/lib/security/rateLimitCore");
  const { RATE_LIMIT_POLICIES } = await import("../app/src/lib/security/rateLimitPolicies");
  const policies = RATE_LIMIT_POLICIES as Record<string, import("../app/src/lib/security/rateLimitCore").RateLimitPolicy>;
  if (!policyName || !value || !(policyName in policies) || (flag !== undefined && flag !== "--delete")) {
    console.error(`使い方: npx tsx ../scripts/rate_limit_unlock.ts <${Object.keys(policies).join("|")}> <値> [--delete]`);
    return 2;
  }
  const key = core.parseRateLimitHmacKey(process.env.RATE_LIMIT_HMAC_KEY);
  if (!key.ok) {
    console.error(key.error);
    return 2;
  }
  const policy = policies[policyName]!;
  const redisKey = core.limiterKey(key.key, policy, value);
  console.log(`policy=${policy.id} v${policy.version} key=${redisKey}`);
  if (!process.env.REDIS_URL) {
    console.error("REDIS_URLが未設定のため、keyの表示のみ行いました");
    return 0;
  }
  const Redis = createRequire(join(APP_DIR, "package.json"))("ioredis") as new (url: string, o?: Record<string, unknown>) => import("ioredis").default;
  const redis = new Redis(process.env.REDIS_URL, { maxRetriesPerRequest: 1, connectionName: "ismay-rate-limit-unlock" });
  try {
    const current = await redis.hgetall(redisKey);
    const ttl = await redis.pttl(redisKey);
    if (Object.keys(current).length === 0) {
      console.log("bucketはありません(満杯と同じ)");
      return 0;
    }
    console.log(`残量=${Number(current.t).toFixed(3)}/${policy.capacity} 拒否中=${current.b === "1"} TTL=${Math.round(ttl / 1000)}秒`);
    if (flag === "--delete") {
      await redis.del(redisKey);
      console.log("削除しました(満杯へ戻りました)");
    }
    return 0;
  } finally {
    await redis.quit();
  }
}

main()
  .then((code) => process.exit(code))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
