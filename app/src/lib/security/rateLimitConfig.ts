import { parseRateLimitHmacKey } from "@/lib/security/rateLimitCore";

/**
 * [SECURITY-RATE-02B新設・2026-09-26] rate limit backendの構成判定(Redis接続は行わない)。
 *
 *   REDIS          … REDIS_URLとRATE_LIMIT_HMAC_KEYが共に有効
 *   UNCONFIGURED   … production(NODE_ENV=production)でどちらかが未設定・不正。
 *                    Redis障害と同じ扱い(login/MFAはprocess内縮退、メール送信系はfail closed)で、
 *                    起動時とその後の定期的なerror log・監査記録を出す(黙って許可しない)
 *   LOCAL_DEV      … production以外でREDIS_URL未設定。全policyをprocess内limiterで判定する
 */
export type RateLimitBackendMode =
  | { kind: "REDIS"; redisUrl: string; hmacKey: Buffer }
  | { kind: "UNCONFIGURED"; error: string }
  | { kind: "LOCAL_DEV"; warning: string };

export function isProductionRuntime(): boolean {
  return process.env.NODE_ENV === "production";
}

function parseRedisUrl(raw: string | undefined): { ok: true; url: string } | { ok: false; error: string } {
  if (!raw || raw.trim() === "") return { ok: false, error: "REDIS_URLが未設定です" };
  const text = raw.trim();
  let parsed: URL;
  try {
    parsed = new URL(text);
  } catch {
    return { ok: false, error: "REDIS_URLをURLとして解釈できません" };
  }
  if (parsed.protocol !== "redis:" && parsed.protocol !== "rediss:") {
    return { ok: false, error: "REDIS_URLはredis://またはrediss://で指定してください" };
  }
  return { ok: true, url: text };
}

export function resolveRateLimitBackendMode(env: NodeJS.ProcessEnv = process.env): RateLimitBackendMode {
  const production = env.NODE_ENV === "production";
  const url = parseRedisUrl(env.REDIS_URL);
  const key = parseRateLimitHmacKey(env.RATE_LIMIT_HMAC_KEY);
  if (url.ok && key.ok) return { kind: "REDIS", redisUrl: url.url, hmacKey: key.key };
  if (!url.ok && env.REDIS_URL !== undefined && env.REDIS_URL.trim() !== "") {
    // 値はあるが不正: productionか否かに関わらず設定誤りとして扱う
    return { kind: "UNCONFIGURED", error: url.error };
  }
  if (url.ok && !key.ok) return { kind: "UNCONFIGURED", error: key.error };
  if (production) return { kind: "UNCONFIGURED", error: url.ok ? "RATE_LIMIT_HMAC_KEYが不正です" : url.error };
  return { kind: "LOCAL_DEV", warning: "REDIS_URL未設定のため、rate limitはprocess内のみで判定します(開発環境)" };
}

/** 起動時表示用の要約(秘密値・URLの認証情報は含めない)。 */
export function describeRateLimitBackendMode(mode: RateLimitBackendMode): string {
  if (mode.kind === "REDIS") {
    let host = "(unknown)";
    try {
      const u = new URL(mode.redisUrl);
      host = `${u.protocol}//${u.hostname}${u.port ? `:${u.port}` : ""}${u.pathname && u.pathname !== "/" ? u.pathname : ""}`;
    } catch {
      /* resolve時に検証済み */
    }
    return `backend=redis ${host}`;
  }
  if (mode.kind === "UNCONFIGURED") return `backend=UNCONFIGURED(${mode.error})`;
  return `backend=local(dev)`;
}
