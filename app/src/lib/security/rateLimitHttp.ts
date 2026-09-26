import type { NextResponse } from "next/server";
import { retryAfterSeconds } from "@/lib/security/rateLimitCore";

/** [SECURITY-RATE-02B新設・2026-09-26] 拒否応答へRetry-After(秒)を付ける。 */
export function withRetryAfter<T extends NextResponse>(res: T, retryAfterMs: number): T {
  res.headers.set("Retry-After", String(retryAfterSeconds(retryAfterMs)));
  return res;
}
