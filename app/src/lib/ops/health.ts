import { db } from "@/lib/db";
import { getTrustedProxyConfig, isPeerAddressStampingActive } from "@/lib/security/clientIp";
import { getRateLimitBackendHealth } from "@/lib/security/rateLimiter";
import { evaluateHealth, runtimeKind, type HealthChecks, type HealthStatus } from "@/lib/ops/healthCore";

/**
 * [SECURITY-RATE-02D新設・2026-10-02] health check(GET /api/v1/health)の実行部。
 * DBへはSELECT 1、RedisへはPINGだけを行い、それぞれ短いtimeoutで打ち切る。例外は投げない。
 */
const DB_TIMEOUT_MS = 2000;

async function checkDatabase(): Promise<HealthChecks["database"]> {
  const started = Date.now();
  let timer: NodeJS.Timeout | undefined;
  try {
    await Promise.race([
      db.$queryRaw`SELECT 1`,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error("timeout")), DB_TIMEOUT_MS);
      }),
    ]);
    return { ok: true, latencyMs: Date.now() - started };
  } catch {
    return { ok: false, latencyMs: null };
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export async function collectHealth(): Promise<{ status: HealthStatus; problems: string[]; checks: HealthChecks; checkedAt: Date }> {
  const [database, rl] = await Promise.all([checkDatabase(), getRateLimitBackendHealth()]);
  const proxy = getTrustedProxyConfig();
  const checks: HealthChecks = {
    runtime: runtimeKind(process.env.NODE_ENV),
    database,
    rateLimit:
      rl.kind === "REDIS"
        ? { kind: "REDIS", ok: rl.ok, hmacRotation: rl.hmacRotation, latencyMs: rl.latencyMs }
        : { kind: rl.kind, ok: rl.ok },
    peer: { stamping: isPeerAddressStampingActive() },
    trustedProxy: { ok: proxy.ok, count: proxy.ok ? proxy.cidrs.length : 0 },
  };
  const result = evaluateHealth(checks);
  return { ...result, checks, checkedAt: new Date() };
}
