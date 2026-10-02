/**
 * [AUTH-REFRESH-07新設・2026-10-02] Refresh Token回転・再利用検知の規則(pure)と配線の静的確認。
 * 実DBでの挙動(比較更新・同時要求・系列失効・監査)は scripts/verify_gate_auth_refresh_07.ts。
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import {
  REFRESH_REUSE_GRACE_MS,
  classifyRetiredTokenPresentation,
  refreshFailureResponse,
  retiredTokenPruneBefore,
} from "../refreshRotation";
import { REFRESH_TOKEN_TTL_MS } from "../tokens";

const __dirname = dirname(fileURLToPath(import.meta.url));

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

console.log("[F1] 失効済みtokenの再提示の判定");
{
  const retired = new Date("2026-10-02T00:00:00.000Z");
  const at = (ms: number) => new Date(retired.getTime() + ms);
  ok("猶予時間は10秒(実装上の既定値)", REFRESH_REUSE_GRACE_MS === 10_000);
  ok("直後は猶予内(同時要求の競合)", classifyRetiredTokenPresentation(retired, at(50)) === "WITHIN_GRACE");
  ok("猶予ちょうどは猶予内", classifyRetiredTokenPresentation(retired, at(REFRESH_REUSE_GRACE_MS)) === "WITHIN_GRACE");
  ok("猶予を1ms過ぎたら再利用", classifyRetiredTokenPresentation(retired, at(REFRESH_REUSE_GRACE_MS + 1)) === "REUSE");
  ok("時計の逆行は猶予内(誤って系列を失効させない)", classifyRetiredTokenPresentation(retired, at(-5000)) === "WITHIN_GRACE");
  ok("猶予時間を引数で変えられる", classifyRetiredTokenPresentation(retired, at(2000), 1000) === "REUSE");
}

console.log("[F2] 保持期間");
{
  const now = new Date("2026-10-02T00:00:00.000Z");
  ok("Refresh Tokenの有効期間より古いhashを削除対象にする", now.getTime() - retiredTokenPruneBefore(now).getTime() === REFRESH_TOKEN_TTL_MS);
}

console.log("[F3] refresh APIの応答");
{
  const s = refreshFailureResponse("SUPERSEDED");
  ok("SUPERSEDEDは409(VERSION_CONFLICT)でcookieを消さない", s.code === "VERSION_CONFLICT" && !s.clearCookies);
  for (const r of ["NOT_FOUND", "EXPIRED", "REVOKED", "REUSE_DETECTED"] as const) {
    const x = refreshFailureResponse(r);
    ok(`${r}は401(AUTH_REQUIRED)でcookieを消す`, x.code === "AUTH_REQUIRED" && x.clearCookies);
  }
}

console.log("[F4] 配線(静的確認)");
{
  const read = (rel: string) => readFileSync(resolve(__dirname, rel), "utf-8");
  const session = read("../session.ts");
  ok("回転は現在のhashとの比較更新(同時要求は1件だけ成功)", /updateMany\(\{\s*where: \{ id: session\.id, refreshTokenHash: presentedHash, revokedAt: null \}/.test(session));
  ok("回転したhashを保持する", session.includes("userSessionRetiredRefreshToken.create({ data: { sessionId: session.id, tokenHash: presentedHash"));
  ok("猶予を過ぎた再提示は系列を失効", session.includes('classifyRetiredTokenPresentation(retired.retiredAt, now) === "WITHIN_GRACE"') && session.includes('revokedReason: "REUSE_DETECTED"'));
  ok("再利用検知を監査", session.includes('action: "AUTH_REFRESH_REUSE_DETECTED"') && session.includes('targetType: "User"'));
  ok("全体を1 transactionで行う", session.includes("db.$transaction(async (tx): Promise<RotateOutcome>"));
  const route = read("../../../app/api/v1/auth/refresh/route.ts");
  ok("refresh routeはSUPERSEDEDでcookieを消さない", route.includes("refreshFailureResponse(result.reason)") && route.includes("if (!r.clearCookies)"));
  const client = read("../client.ts");
  ok("clientは409なら待って再送する", client.includes("res.status === 409"));
  const schema = read("../../../../prisma/schema.prisma");
  ok("schema: 失効hash表はsessionへCASCADE・hash一意", /model UserSessionRetiredRefreshToken \{[\s\S]*onDelete: Cascade[\s\S]*tokenHash String\s+@unique/.test(schema));
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) {
  console.log("FAILURES:\n" + failures.map((f) => `  - ${f}`).join("\n"));
  process.exit(1);
}
