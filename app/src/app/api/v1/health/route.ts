import { NextResponse, type NextRequest } from "next/server";
import { collectHealth } from "@/lib/ops/health";
import { healthResponseBody, isLoopbackClient } from "@/lib/ops/healthCore";
import { resolveRequestClientIpText } from "@/lib/security/clientIp";

/**
 * [SECURITY-RATE-02D新設・2026-10-02] GET /api/v1/health(認証不要)。
 * 200 {status:"ok"} / 503 {status:"degraded"}。同一host(loopback)からの要求にだけ各checkの詳細を返す
 * (外部へ構成を開示しない)。監視はscripts/ops/ismay_healthcheck.sh(systemd timer)が行う。
 */
export async function GET(req: NextRequest) {
  const health = await collectHealth();
  const detailed = isLoopbackClient(resolveRequestClientIpText(req));
  const body = healthResponseBody(health, health.checks, detailed, health.checkedAt);
  return NextResponse.json(body, {
    status: health.status === "ok" ? 200 : 503,
    headers: { "Cache-Control": "no-store" },
  });
}
