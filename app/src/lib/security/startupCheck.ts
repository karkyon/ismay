import { getTrustedProxyConfig, isPeerAddressStampingActive } from "@/lib/security/clientIp";
import { describeRateLimitBackendMode, isProductionRuntime, resolveRateLimitBackendMode } from "@/lib/security/rateLimitConfig";

/**
 * [SECURITY-RATE-02B新設・2026-09-26] 起動時にrate limit・client IPの構成を1行で出す(instrumentation.ts)。
 * productionでRedis・HMAC keyが未設定/不正、または信頼proxy設定が不正な場合はerrorとして出す
 * (黙って許可しない。実際の縮退はlib/security/rateLimiter.tsが要求ごとに判定する)。
 * 秘密値・URLの認証情報は出さない。
 */
export function logSecurityRateStartupSummary(): void {
  const mode = resolveRateLimitBackendMode();
  const proxy = getTrustedProxyConfig();
  const peer = isPeerAddressStampingActive() ? "peer=custom-server" : "peer=unavailable(client IPは不明として扱う)";
  const proxyText = proxy.ok ? `trustedProxies=${proxy.cidrs.length}` : `trustedProxies=INVALID(${proxy.error})`;
  const line = `[SECURITY-RATE] ${describeRateLimitBackendMode(mode)} ${peer} ${proxyText}`;
  const isError = !proxy.ok || mode.kind === "UNCONFIGURED" || (mode.kind === "LOCAL_DEV" && isProductionRuntime());
  if (isError) console.error(`${line} — 設定を確認してください(docs/runbooks/SECURITY_RATE_RUNBOOK.md)`);
  else console.log(line);
}
