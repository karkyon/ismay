import { randomBytes } from "node:crypto";
import Redis from "ioredis";
import { db } from "@/lib/db";
import { debugServer } from "@/lib/debugServer";
import {
  REFUND_BUCKET_LUA,
  TAKE_BUCKETS_LUA,
  bucketTtlMs,
  limiterDigest,
  limiterKey,
  parseTakeBucketsReply,
  refundBucket,
  takeBuckets,
  type BucketState,
  type RateLimitPolicy,
} from "@/lib/security/rateLimitCore";
import { describeRateLimitBackendMode, resolveRateLimitBackendMode, type RateLimitBackendMode } from "@/lib/security/rateLimitConfig";

/**
 * [SECURITY-RATE-02B新設・2026-09-26] rate limitの実行(Redis+process内縮退)。
 * 契約: docs/decisions/DEC-SECURITY-RATE-02.md §4〜§7。
 *
 * - Redis: 1回のEVAL(TAKE_BUCKETS_LUA)で全bucketを判定・消費する。時刻はRedis serverのTIMEを使い、
 *   複数process・複数hostの時計のずれに依存しない。
 * - Redis障害・未設定(production): policyのonBackendFailureに従う。
 *     LOCAL_FALLBACK … process内のtoken bucketで判定(同じ規則。再起動で消え、process間で共有されない)
 *     FAIL_CLOSED    … 拒否(呼び出し側は応答を変えずに処理だけ行わない)
 *   縮退中はerror logと監査記録(RATE_LIMIT_BACKEND_DEGRADED)を一定間隔で出す。
 * - 生のemail・IP・userIdはRedis key・監査・debug logへ出さない(HMAC digestの先頭のみ)。
 */

export interface RateLimitCheck {
  policy: RateLimitPolicy;
  /** nullのcheckは判定しない(例: client IP不明)。 */
  value: string | null;
}

export type RateLimitBackendUsed = "redis" | "local";

interface ConsumedBucket {
  policy: RateLimitPolicy;
  key: string;
  backend: RateLimitBackendUsed;
}

export type RateLimitDecision =
  | { allowed: true; backend: RateLimitBackendUsed | "none"; degraded: boolean; consumed: ConsumedBucket[] }
  | {
      allowed: false;
      reason: "LIMITED" | "BACKEND_UNAVAILABLE";
      /** 残量不足だったpolicy id(BACKEND_UNAVAILABLE時はfail closedしたpolicy)。 */
      deniedPolicyIds: string[];
      retryAfterMs: number;
      backend: RateLimitBackendUsed | "none";
      degraded: boolean;
    };

// ---------------------------------------------------------------------------
// Redis client(process内で1つ)
// ---------------------------------------------------------------------------

const REDIS_COMMAND_TIMEOUT_MS = 500;
const REDIS_CONNECT_TIMEOUT_MS = 1000;
const REDIS_MAX_RECONNECT_DELAY_MS = 2000;

interface LimiterState {
  mode: RateLimitBackendMode;
  modeRaw: string;
  redis: Redis | null;
  localKey: Buffer;
  local: Map<string, BucketState & { expiresAtMs: number }>;
  lastDegradedLogMs: number;
  lastDegradedAuditMs: number;
  lastRedisErrorLogMs: number;
}

declare global {
  var __ismayRateLimiter: LimiterState | undefined;
}

function envSignature(): string {
  return JSON.stringify([process.env.NODE_ENV ?? "", process.env.REDIS_URL ?? "", process.env.RATE_LIMIT_HMAC_KEY ?? ""]);
}

function getState(): LimiterState {
  const sig = envSignature();
  const current = globalThis.__ismayRateLimiter;
  if (current && current.modeRaw === sig) return current;
  if (current?.redis) current.redis.disconnect();
  const state: LimiterState = {
    mode: resolveRateLimitBackendMode(),
    modeRaw: sig,
    redis: null,
    // process内limiterのkeyにもHMACを使う(生値をMapのkeyにしない)。永続化しないため起動ごとの乱数でよい。
    localKey: randomBytes(32),
    local: current?.local ?? new Map(),
    lastDegradedLogMs: 0,
    lastDegradedAuditMs: 0,
    lastRedisErrorLogMs: 0,
  };
  globalThis.__ismayRateLimiter = state;
  return state;
}

function getRedis(state: LimiterState): Redis | null {
  if (state.mode.kind !== "REDIS") return null;
  if (state.redis) return state.redis;
  const client = new Redis(state.mode.redisUrl, {
    lazyConnect: true,
    enableOfflineQueue: true,
    maxRetriesPerRequest: 1,
    connectTimeout: REDIS_CONNECT_TIMEOUT_MS,
    commandTimeout: REDIS_COMMAND_TIMEOUT_MS,
    retryStrategy: (times) => Math.min(times * 200, REDIS_MAX_RECONNECT_DELAY_MS),
    enableReadyCheck: true,
    // 運用時にCLIENT LISTで識別できるようにする(Runbook §4)
    connectionName: "ismay-rate-limit",
  });
  client.on("error", (err: unknown) => {
    const now = Date.now();
    if (now - state.lastRedisErrorLogMs < 60_000) return;
    state.lastRedisErrorLogMs = now;
    debugServer.error("security/rateLimiter", "Redis接続エラー(rate limitは縮退policyで継続)", err instanceof Error ? err.message : String(err));
  });
  client.connect().catch(() => {
    /* errorイベントで記録済み。retryStrategyで再接続を続ける */
  });
  state.redis = client;
  return client;
}

/** 接続が切れていることが分かっている場合はcommand timeoutを待たずに縮退する。 */
function isRedisKnownDown(client: Redis): boolean {
  return client.status === "reconnecting" || client.status === "close" || client.status === "end";
}

// ---------------------------------------------------------------------------
// process内limiter
// ---------------------------------------------------------------------------

const LOCAL_MAX_ENTRIES = 50_000;

function pruneLocal(state: LimiterState, nowMs: number): void {
  if (state.local.size < LOCAL_MAX_ENTRIES) return;
  for (const [k, v] of state.local) if (v.expiresAtMs <= nowMs) state.local.delete(k);
  // まだ多い場合は古い順(挿入順)に捨てる。捨てられたbucketは満杯扱いになるが、上限なしのメモリ消費よりよい
  while (state.local.size >= LOCAL_MAX_ENTRIES) {
    const first = state.local.keys().next();
    if (first.done) break;
    state.local.delete(first.value);
  }
}

function localTake(state: LimiterState, checks: { policy: RateLimitPolicy; key: string }[], nowMs: number) {
  pruneLocal(state, nowMs);
  const entries = checks.map((c) => {
    const s = state.local.get(c.key);
    return { policy: c.policy, state: s && s.expiresAtMs > nowMs ? s : null };
  });
  const result = takeBuckets(entries, nowMs);
  result.states.forEach((s, i) => {
    const policy = checks[i]!.policy;
    state.local.delete(checks[i]!.key);
    state.local.set(checks[i]!.key, { ...s, expiresAtMs: nowMs + bucketTtlMs(policy) });
  });
  return result;
}

// ---------------------------------------------------------------------------
// 監査・警告
// ---------------------------------------------------------------------------

const DEGRADED_LOG_INTERVAL_MS = 60 * 1000;
const DEGRADED_AUDIT_INTERVAL_MS = 5 * 60 * 1000;

async function reportDegraded(state: LimiterState, scope: string, detail: string): Promise<void> {
  const now = Date.now();
  if (now - state.lastDegradedLogMs >= DEGRADED_LOG_INTERVAL_MS) {
    state.lastDegradedLogMs = now;
    debugServer.error("security/rateLimiter", `[SECURITY-RATE] DEGRADED ${describeRateLimitBackendMode(state.mode)}`, { scope, detail });
  }
  if (now - state.lastDegradedAuditMs >= DEGRADED_AUDIT_INTERVAL_MS) {
    state.lastDegradedAuditMs = now;
    try {
      await db.auditLog.create({
        data: {
          actorUserId: null,
          actorType: "SYSTEM",
          action: "RATE_LIMIT_BACKEND_DEGRADED",
          targetType: "RateLimitBackend",
          targetId: state.mode.kind,
          result: "FAILURE",
          reason: `${scope} ${detail}`.slice(0, 500),
          // client IPは記録しない(対象ユーザーと結びつかない行のためアカウントPurgeの墨消し対象にならない)
          ipAddress: null,
        },
      });
    } catch (err) {
      debugServer.error("security/rateLimiter", "縮退の監査記録に失敗しました", err);
    }
  }
}

async function auditBlocked(
  policy: RateLimitPolicy,
  digest: string,
  retryAfterMs: number,
  backend: RateLimitBackendUsed,
  scope: string,
): Promise<void> {
  try {
    await db.auditLog.create({
      data: {
        actorUserId: null,
        actorType: "SYSTEM",
        action: "RATE_LIMIT_BLOCKED",
        targetType: "RateLimitPolicy",
        targetId: policy.id,
        result: "FAILURE",
        // digestはHMACの先頭16文字だけ(同一keyの連続を追えるが、元の値へは戻せない)
        reason: `${scope} dimension=${policy.dimension} key=${digest.slice(0, 16)} retryAfterMs=${retryAfterMs} backend=${backend} v=${policy.version}`,
        // client IPは記録しない(同上)。同一keyの追跡はdigestで行う
        ipAddress: null,
      },
    });
  } catch (err) {
    debugServer.error("security/rateLimiter", "rate limit拒否の監査記録に失敗しました", err);
  }
}

// ---------------------------------------------------------------------------
// 公開API
// ---------------------------------------------------------------------------

/**
 * checksの全bucketから1回分を消費する(全か無か)。拒否・縮退の判断は呼び出し側で応答に反映する。
 * 例外は投げない(Redis障害は縮退policyへ変換する)。
 */
export async function consumeRateLimit(scope: string, checks: RateLimitCheck[]): Promise<RateLimitDecision> {
  const active = checks.filter((c): c is { policy: RateLimitPolicy; value: string } => c.value !== null && c.value !== "");
  if (active.length === 0) return { allowed: true, backend: "none", degraded: false, consumed: [] };
  const state = getState();

  if (state.mode.kind === "REDIS") {
    const client = getRedis(state);
    const hmacKey = state.mode.hmacKey;
    const keyed = active.map((c) => ({ policy: c.policy, key: limiterKey(hmacKey, c.policy, c.value), digest: limiterDigest(hmacKey, c.policy, c.value) }));
    if (client && !isRedisKnownDown(client)) {
      try {
        const args: (string | number)[] = [];
        for (const k of keyed) args.push(k.policy.capacity, k.policy.windowMs, 1, bucketTtlMs(k.policy));
        const reply = await client.eval(TAKE_BUCKETS_LUA, keyed.length, ...keyed.map((k) => k.key), ...args);
        const parsed = parseTakeBucketsReply(reply, keyed.length);
        if (parsed.allowed) {
          return { allowed: true, backend: "redis", degraded: false, consumed: keyed.map((k) => ({ policy: k.policy, key: k.key, backend: "redis" as const })) };
        }
        for (let i = 0; i < keyed.length; i++) {
          if (parsed.buckets[i]!.newlyBlocked) await auditBlocked(keyed[i]!.policy, keyed[i]!.digest, parsed.retryAfterMs, "redis", scope);
        }
        return {
          allowed: false,
          reason: "LIMITED",
          deniedPolicyIds: keyed.filter((_, i) => parsed.buckets[i]!.denied).map((k) => k.policy.id),
          retryAfterMs: parsed.retryAfterMs,
          backend: "redis",
          degraded: false,
        };
      } catch (err) {
        await reportDegraded(state, scope, `redis error: ${err instanceof Error ? err.message : String(err)}`.slice(0, 200));
      }
    } else {
      await reportDegraded(state, scope, `redis status=${client?.status ?? "none"}`);
    }
    return degradedDecision(state, scope, active);
  }

  if (state.mode.kind === "UNCONFIGURED") {
    await reportDegraded(state, scope, state.mode.error);
    return degradedDecision(state, scope, active);
  }

  // LOCAL_DEV: production以外でRedis未設定。全policyをprocess内で判定する
  if (state.lastDegradedLogMs === 0) {
    state.lastDegradedLogMs = Date.now();
    console.warn(`[SECURITY-RATE] ${state.mode.warning}`);
  }
  return localDecision(state, scope, active, false);
}

async function degradedDecision(
  state: LimiterState,
  scope: string,
  active: { policy: RateLimitPolicy; value: string }[],
): Promise<RateLimitDecision> {
  const closed = active.filter((c) => c.policy.onBackendFailure === "FAIL_CLOSED");
  if (closed.length > 0) {
    return {
      allowed: false,
      reason: "BACKEND_UNAVAILABLE",
      deniedPolicyIds: closed.map((c) => c.policy.id),
      retryAfterMs: 60 * 1000,
      backend: "none",
      degraded: true,
    };
  }
  return localDecision(state, scope, active, true);
}

async function localDecision(
  state: LimiterState,
  scope: string,
  active: { policy: RateLimitPolicy; value: string }[],
  degraded: boolean,
): Promise<RateLimitDecision> {
  const keyed = active.map((c) => ({ policy: c.policy, key: limiterKey(state.localKey, c.policy, c.value), digest: limiterDigest(state.localKey, c.policy, c.value) }));
  const result = localTake(state, keyed, Date.now());
  if (result.allowed) {
    return { allowed: true, backend: "local", degraded, consumed: keyed.map((k) => ({ policy: k.policy, key: k.key, backend: "local" as const })) };
  }
  for (const i of result.newlyBlockedIndexes) await auditBlocked(keyed[i]!.policy, keyed[i]!.digest, result.retryAfterMs, "local", scope);
  return {
    allowed: false,
    reason: "LIMITED",
    deniedPolicyIds: result.deniedIndexes.map((i) => keyed[i]!.policy.id),
    retryAfterMs: result.retryAfterMs,
    backend: "local",
    degraded,
  };
}

/**
 * 保護対象の処理が成功したときに呼ぶ(policyのonSuccess: RESET=満杯へ、REFUND=1回分を戻す)。
 * 例外は投げない。
 */
export async function settleRateLimitSuccess(decision: RateLimitDecision): Promise<void> {
  if (!decision.allowed) return;
  const state = getState();
  for (const c of decision.consumed) {
    if (c.policy.onSuccess === "NONE") continue;
    if (c.backend === "local") {
      if (c.policy.onSuccess === "RESET") {
        state.local.delete(c.key);
      } else {
        const now = Date.now();
        const s = state.local.get(c.key) ?? null;
        const next = refundBucket(s, now, c.policy);
        if (next) state.local.set(c.key, { ...next, expiresAtMs: now + bucketTtlMs(c.policy) });
      }
      continue;
    }
    const client = getRedis(state);
    if (!client) continue;
    try {
      if (c.policy.onSuccess === "RESET") {
        await client.del(c.key);
      } else {
        await client.eval(REFUND_BUCKET_LUA, 1, c.key, c.policy.capacity, c.policy.windowMs, 1, bucketTtlMs(c.policy));
      }
    } catch (err) {
      debugServer.error("security/rateLimiter", "成功時のbucket更新に失敗しました(次回判定は消費済みのまま)", err instanceof Error ? err.message : String(err));
    }
  }
}

/** 受入試験用: process内の状態(Redis接続・process内bucket)を破棄する。 */
export async function resetRateLimiterForTesting(): Promise<void> {
  const current = globalThis.__ismayRateLimiter;
  if (current?.redis) {
    try {
      await current.redis.quit();
    } catch {
      current.redis.disconnect();
    }
  }
  globalThis.__ismayRateLimiter = undefined;
}

/** 受入試験用: 現在のRedis client(接続状態の確認・再接続試験に使う)。 */
export function getRateLimiterRedisForTesting(): Redis | null {
  return getRedis(getState());
}
