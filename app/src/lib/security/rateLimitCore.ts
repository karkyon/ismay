import { createHmac } from "node:crypto";

/**
 * [SECURITY-RATE-02B新設・2026-09-26] 永続rate limitの規則(pure)。
 * 契約: docs/decisions/DEC-SECURITY-RATE-02.md §4〜§6。
 *
 * 方式はtoken bucket(全機能仕様一覧 SEC-RATE「Redis token bucket」)。
 *   - 容量capacity、windowMsで空から満杯まで連続的に補充(補充速度 capacity / windowMs)。
 *   - 固定windowのような境界での2倍burstは起きない。任意の長さTの区間で通る件数は
 *     capacity + T × capacity / windowMs 以下。
 *   - 1回の要求で全bucketを判定し、全bucketに残量がある場合だけ全bucketから同時に消費する
 *     (一部だけ消費される状態を作らない)。
 */

export type RateLimitDimension = "account" | "ip" | "user";
/** Redisが使えない・未設定のときの挙動。 */
export type RateLimitBackendFailurePolicy = "LOCAL_FALLBACK" | "FAIL_CLOSED";
/** 保護対象の処理が成功したときの扱い。RESET=満杯へ戻す、REFUND=今回消費した1回分だけ戻す。 */
export type RateLimitSuccessAction = "RESET" | "REFUND" | "NONE";

export interface RateLimitPolicy {
  /** 用途別prefix(Redis keyの一部)。 */
  id: string;
  /** 規則を変えたら上げる(旧versionのkeyは参照されずTTLで消える)。 */
  version: number;
  dimension: RateLimitDimension;
  capacity: number;
  windowMs: number;
  onBackendFailure: RateLimitBackendFailurePolicy;
  onSuccess: RateLimitSuccessAction;
  /** 値の出典・理由(台帳・Decision Recordと同じ文言)。 */
  basis: string;
}

export const RATE_LIMIT_KEY_PREFIX = "ismay:rl";
/** TTL = 空から満杯になるまでの時間 + この余裕。TTL切れ=満杯と同じ意味になる。 */
export const RATE_LIMIT_TTL_MARGIN_MS = 60 * 1000;
/** HMAC keyとして受け付ける最小byte数。 */
export const RATE_LIMIT_HMAC_KEY_MIN_BYTES = 32;

/**
 * 浮動小数の補充計算の誤差(補充ちょうどの時刻に1e-16程度不足する)で拒否しないための許容量。
 * 1回分(1 token)に対して十分小さい。Lua scriptでも同じ値を使う。
 */
export const TOKEN_EPSILON = 1e-6;

export function bucketTtlMs(policy: RateLimitPolicy): number {
  return policy.windowMs + RATE_LIMIT_TTL_MARGIN_MS;
}

// ---------------------------------------------------------------------------
// key(生のemail・IP・userIdをkeyへ入れない)
// ---------------------------------------------------------------------------

export type ParseHmacKeyResult = { ok: true; key: Buffer } | { ok: false; error: string };

/** RATE_LIMIT_HMAC_KEY(base64またはbase64url、decode後32byte以上)。 */
export function parseRateLimitHmacKey(raw: string | undefined | null): ParseHmacKeyResult {
  if (raw === undefined || raw === null || raw.trim() === "") {
    return { ok: false, error: "RATE_LIMIT_HMAC_KEYが未設定です" };
  }
  const text = raw.trim();
  if (!/^[A-Za-z0-9+/_-]+={0,2}$/.test(text)) {
    return { ok: false, error: "RATE_LIMIT_HMAC_KEYはbase64で指定してください" };
  }
  const key = Buffer.from(text.replace(/-/g, "+").replace(/_/g, "/"), "base64");
  if (key.length < RATE_LIMIT_HMAC_KEY_MIN_BYTES) {
    return { ok: false, error: `RATE_LIMIT_HMAC_KEYはdecode後${RATE_LIMIT_HMAC_KEY_MIN_BYTES}byte以上が必要です` };
  }
  return { ok: true, key };
}

/** dimensionごとの正規化。emailは前後空白除去+小文字(users.emailの保存規則と同じ)。 */
export function normalizeDimensionValue(dimension: RateLimitDimension, value: string): string {
  if (dimension === "account") return value.trim().toLowerCase();
  return value.trim();
}

/** HMAC-SHA256の先頭128bit(hex 32文字)。用途(policy id・version・dimension)を入力に含めて分離する。 */
export function limiterDigest(hmacKey: Buffer, policy: RateLimitPolicy, value: string): string {
  const normalized = normalizeDimensionValue(policy.dimension, value);
  return createHmac("sha256", hmacKey)
    .update(`ismay-rate-limit\u001f${policy.id}\u001f${policy.version}\u001f${policy.dimension}\u001f${normalized}`, "utf8")
    .digest("hex")
    .slice(0, 32);
}

export function limiterKey(hmacKey: Buffer, policy: RateLimitPolicy, value: string): string {
  return `${RATE_LIMIT_KEY_PREFIX}:v${policy.version}:${policy.id}:${limiterDigest(hmacKey, policy, value)}`;
}

// ---------------------------------------------------------------------------
// token bucket(process内の縮退limiterとpure testで使う。Redis側は同じ式をLuaで実行する)
// ---------------------------------------------------------------------------

export interface BucketState {
  /** 残量(小数を含む)。 */
  tokens: number;
  /** tokensを計算した時刻(ms)。 */
  updatedAtMs: number;
  /** 直近の判定で拒否済みか(拒否へ変わった最初の1回だけ監査するため)。 */
  blocked: boolean;
}

export function refill(state: BucketState | null, nowMs: number, policy: RateLimitPolicy): number {
  if (!state) return policy.capacity;
  const elapsed = Math.max(0, nowMs - state.updatedAtMs);
  return Math.min(policy.capacity, state.tokens + (elapsed * policy.capacity) / policy.windowMs);
}

export function hasTokens(tokens: number, cost: number): boolean {
  return tokens + TOKEN_EPSILON >= cost;
}

export function retryAfterMsFor(tokens: number, cost: number, policy: RateLimitPolicy): number {
  if (hasTokens(tokens, cost)) return 0;
  return Math.ceil(((cost - tokens) * policy.windowMs) / policy.capacity);
}

export interface MultiTakeResult {
  allowed: boolean;
  /** 拒否時に全bucketが再び許可されるまでの最大待ち時間(ms)。 */
  retryAfterMs: number;
  /** 各bucketの判定後状態(入力と同じ順)。 */
  states: BucketState[];
  /** 残量不足だったbucketのindex。 */
  deniedIndexes: number[];
  /** 今回はじめて拒否状態になったbucketのindex。 */
  newlyBlockedIndexes: number[];
}

/** 複数bucketの全か無かの消費(Lua scriptと同じ規則)。 */
export function takeBuckets(
  entries: { state: BucketState | null; policy: RateLimitPolicy }[],
  nowMs: number,
  cost = 1,
): MultiTakeResult {
  const tokens = entries.map((e) => refill(e.state, nowMs, e.policy));
  const deniedIndexes: number[] = [];
  let retryAfterMs = 0;
  tokens.forEach((t, i) => {
    if (!hasTokens(t, cost)) {
      deniedIndexes.push(i);
      retryAfterMs = Math.max(retryAfterMs, retryAfterMsFor(t, cost, entries[i]!.policy));
    }
  });
  const allowed = deniedIndexes.length === 0;
  const newlyBlockedIndexes: number[] = [];
  const states = entries.map((e, i): BucketState => {
    if (allowed) return { tokens: Math.max(0, tokens[i]! - cost), updatedAtMs: nowMs, blocked: false };
    const denied = !hasTokens(tokens[i]!, cost);
    const wasBlocked = e.state?.blocked ?? false;
    if (denied && !wasBlocked) newlyBlockedIndexes.push(i);
    return { tokens: tokens[i]!, updatedAtMs: nowMs, blocked: denied ? true : wasBlocked };
  });
  return { allowed, retryAfterMs, states, deniedIndexes, newlyBlockedIndexes };
}

/** 成功時のREFUND(今回の1回分を戻す。満杯を超えない)。 */
export function refundBucket(state: BucketState | null, nowMs: number, policy: RateLimitPolicy, amount = 1): BucketState | null {
  if (!state) return null;
  return { tokens: Math.min(policy.capacity, refill(state, nowMs, policy) + amount), updatedAtMs: nowMs, blocked: false };
}

// ---------------------------------------------------------------------------
// Redis Lua script(1回のEVALで判定・消費・TTL設定を原子的に行う。時刻はRedis serverのTIME)
// ---------------------------------------------------------------------------

/**
 * KEYS: bucket key群。ARGV: bucketごとに [capacity, windowMs, cost, ttlMs]。
 * 戻り値: [allowed(0/1), retryAfterMs, nowMs, (remainingMilliTokens, denied(0/1), newlyBlocked(0/1)) × bucket数]
 */
export const TAKE_BUCKETS_LUA = `
local t = redis.call('TIME')
local now = tonumber(t[1]) * 1000 + math.floor(tonumber(t[2]) / 1000)
local n = #KEYS
local tokens = {}
local allowed = 1
local retry = 0
for i = 1, n do
  local base = (i - 1) * 4
  local cap = tonumber(ARGV[base + 1])
  local win = tonumber(ARGV[base + 2])
  local cost = tonumber(ARGV[base + 3])
  local h = redis.call('HMGET', KEYS[i], 't', 'ts')
  local tk = tonumber(h[1])
  local ts = tonumber(h[2])
  if tk == nil or ts == nil then
    tk = cap
    ts = now
  end
  if now > ts then
    tk = math.min(cap, tk + (now - ts) * cap / win)
  end
  tokens[i] = tk
  if tk + 0.000001 < cost then
    allowed = 0
    local r = math.ceil((cost - tk) * win / cap)
    if r > retry then retry = r end
  end
end
local result = {allowed, retry, now}
for i = 1, n do
  local base = (i - 1) * 4
  local cost = tonumber(ARGV[base + 3])
  local ttl = tonumber(ARGV[base + 4])
  local tk = tokens[i]
  local denied = 0
  local newly = 0
  local b = '0'
  if allowed == 1 then
    tk = math.max(0, tk - cost)
  else
    local prev = redis.call('HGET', KEYS[i], 'b')
    if tk + 0.000001 < cost then
      denied = 1
      b = '1'
      if prev ~= '1' then newly = 1 end
    elseif prev == '1' then
      b = '1'
    end
  end
  redis.call('HSET', KEYS[i], 't', tostring(tk), 'ts', tostring(now), 'b', b)
  redis.call('PEXPIRE', KEYS[i], ttl)
  table.insert(result, math.floor(tk * 1000))
  table.insert(result, denied)
  table.insert(result, newly)
end
return result
`;

/** KEYS[1]、ARGV: [capacity, windowMs, amount, ttlMs]。keyが無い(=満杯)なら何もしない。 */
export const REFUND_BUCKET_LUA = `
local h = redis.call('HMGET', KEYS[1], 't', 'ts')
local tk = tonumber(h[1])
local ts = tonumber(h[2])
if tk == nil or ts == nil then return 0 end
local t = redis.call('TIME')
local now = tonumber(t[1]) * 1000 + math.floor(tonumber(t[2]) / 1000)
local cap = tonumber(ARGV[1])
local win = tonumber(ARGV[2])
if now > ts then tk = math.min(cap, tk + (now - ts) * cap / win) end
tk = math.min(cap, tk + tonumber(ARGV[3]))
redis.call('HSET', KEYS[1], 't', tostring(tk), 'ts', tostring(now), 'b', '0')
redis.call('PEXPIRE', KEYS[1], tonumber(ARGV[4]))
return 1
`;

/** Lua戻り値の解釈。 */
export function parseTakeBucketsReply(reply: unknown, bucketCount: number): {
  allowed: boolean;
  retryAfterMs: number;
  nowMs: number;
  buckets: { remainingTokens: number; denied: boolean; newlyBlocked: boolean }[];
} {
  if (!Array.isArray(reply) || reply.length !== 3 + bucketCount * 3) {
    throw new Error("rate limit scriptの戻り値が不正です");
  }
  const num = (v: unknown): number => {
    const n = typeof v === "number" ? v : Number(v);
    if (!Number.isFinite(n)) throw new Error("rate limit scriptの戻り値が数値ではありません");
    return n;
  };
  const buckets = [];
  for (let i = 0; i < bucketCount; i++) {
    const base = 3 + i * 3;
    buckets.push({
      remainingTokens: num(reply[base]) / 1000,
      denied: num(reply[base + 1]) === 1,
      newlyBlocked: num(reply[base + 2]) === 1,
    });
  }
  return { allowed: num(reply[0]) === 1, retryAfterMs: num(reply[1]), nowMs: num(reply[2]), buckets };
}

/** Retry-After header値(秒、切り上げ、最小1)。 */
export function retryAfterSeconds(retryAfterMs: number): number {
  return Math.max(1, Math.ceil(retryAfterMs / 1000));
}
