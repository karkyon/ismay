/**
 * [SECURITY-RATE-02D新設・2026-10-02] health判定の規則(pure)。
 * 運用: docs/runbooks/SECURITY_RATE_RUNBOOK.md §2(監視)。
 *
 * - DB(SELECT 1)とrate limit backendが使えること、productionではpeer(接続元)が取得できること
 *   (custom server経由で起動していること)、信頼proxy設定が正しいことを「ok」の条件にする。
 * - 外部(loopback以外)からの要求にはstatusだけを返し、構成の詳細は返さない。
 */

export interface HealthChecks {
  runtime: "production" | "development" | "test" | "other";
  database: { ok: boolean; latencyMs: number | null };
  rateLimit: { kind: "REDIS" | "UNCONFIGURED" | "LOCAL_DEV"; ok: boolean; hmacRotation?: "none" | "active" | "invalid"; latencyMs?: number | null };
  peer: { stamping: boolean };
  trustedProxy: { ok: boolean; count: number };
}

export type HealthStatus = "ok" | "degraded";

export function evaluateHealth(checks: HealthChecks): { status: HealthStatus; problems: string[] } {
  const problems: string[] = [];
  if (!checks.database.ok) problems.push("database");
  if (!checks.rateLimit.ok) problems.push(`rateLimit(${checks.rateLimit.kind})`);
  if (checks.runtime === "production" && !checks.peer.stamping) problems.push("peer(custom serverを経由していない)");
  if (!checks.trustedProxy.ok) problems.push("trustedProxy(TRUSTED_PROXY_CIDRSが不正)");
  return { status: problems.length === 0 ? "ok" : "degraded", problems };
}

export function runtimeKind(nodeEnv: string | undefined): HealthChecks["runtime"] {
  if (nodeEnv === "production" || nodeEnv === "development" || nodeEnv === "test") return nodeEnv;
  return "other";
}

/** loopback(同一host)からの要求か。IPv4-mapped表記はclientIp側で正規化済み。 */
export function isLoopbackClient(ipText: string | null): boolean {
  if (!ipText) return false;
  return ipText === "::1" || /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(ipText);
}

/** 応答body。詳細はloopbackからの要求にだけ含める。 */
export function healthResponseBody(
  result: { status: HealthStatus; problems: string[] },
  checks: HealthChecks,
  detailed: boolean,
  checkedAt: Date,
): Record<string, unknown> {
  if (!detailed) return { status: result.status };
  return { status: result.status, checkedAt: checkedAt.toISOString(), problems: result.problems, checks };
}
