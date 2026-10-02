#!/usr/bin/env node
/**
 * scripts/verify_gate_prod_deploy_01.ts
 *
 * PROD-DEPLOY-01(本番化: HTTPS reverse proxy・Secure Cookie・信頼proxy・production起動)の受入試験。
 * 運用: docs/runbooks/PRODUCTION_RUNBOOK.md。
 *
 *   [P1] HTTPS(Caddy内部CA)でhealthが200。証明書をroot証明書で検証できる。HSTSを返し、Server headerを出さない
 *   [P2] HTTPS経由のregister/login: 認証cookie(ismay_at・ismay_rt・ismay_csrf)がすべてSecure・HttpOnly(csrf以外)・SameSite=Lax。
 *        偽装したX-Forwarded-For・X-Real-IP・x-ismay-peer-addressはsessionのIPにならない(proxyが付けた接続元を記録)
 *   [P3] HTTPS経由でcookie認証・refresh回転・CSRF付きlogoutが成立する
 *   [P4] appはproduction・custom server経由(peer取得)・信頼proxy1件で動いている(loopbackからのhealth詳細)
 *   [P5] appのHTTP portはLANのaddressから到達できない(PUBLIC_DIRECT_URLを指定した場合)
 *   cleanup後の残存0(テストユーザー)。
 *
 * 実行方法(配備scriptが実行する。Caddyのroot証明書をNODE_EXTRA_CA_CERTSで渡す):
 *   cd ~/projects/ismay/app
 *   NODE_EXTRA_CA_CERTS=../docker-data/caddy/data/caddy/pki/authorities/local/root.crt \
 *   HTTPS_BASE_URL=https://localhost:10443 BASE_URL=http://127.0.0.1:13000 PUBLIC_DIRECT_URL=http://192.168.1.11:13000 \
 *   npx tsx ../scripts/verify_gate_prod_deploy_01.ts
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

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
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
loadDotEnv(join(__dirname, "..", "app", ".env"));

const HTTPS_BASE_URL = process.env.HTTPS_BASE_URL ?? "https://localhost:10443";
const BASE_URL = process.env.BASE_URL ?? "http://127.0.0.1:13000";
const PUBLIC_DIRECT_URL = process.env.PUBLIC_DIRECT_URL ?? null;
const RUN_ID = Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
const EMAIL_PREFIX = "gate-prod-deploy-01-";
const PASSWORD = `ProdVerify!${RUN_ID}Aa1`;
const SPOOFED = ["6.6.6.6", "7.7.7.7", "9.9.9.9"];

let passed = 0;
let failed = 0;
let skipped = 0;
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
function skip(name: string, why: string): void {
  skipped++;
  console.log(`  SKIP - ${name} :: ${why}`);
}

type Jar = Record<string, string>;
interface HttpResult {
  status: number;
  body: { data?: Record<string, unknown>; error?: { code?: string } } | null;
  headers: Headers;
  setCookies: string[];
}
async function http(
  base: string,
  path: string,
  opts: { method?: string; body?: unknown; jar?: Jar; headers?: Record<string, string>; csrf?: boolean } = {},
): Promise<HttpResult> {
  const headers: Record<string, string> = { ...(opts.headers ?? {}) };
  if (opts.body !== undefined) headers["content-type"] = "application/json";
  if (opts.jar && Object.keys(opts.jar).length) {
    headers.cookie = Object.entries(opts.jar).filter(([, v]) => v !== "").map(([k, v]) => `${k}=${v}`).join("; ");
  }
  if (opts.csrf && opts.jar?.ismay_csrf) headers["x-csrf-token"] = opts.jar.ismay_csrf;
  const res = await fetch(`${base}${path}`, {
    method: opts.method ?? "POST",
    headers,
    body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
    redirect: "manual",
  });
  const setCookies = (res.headers as unknown as { getSetCookie?: () => string[] }).getSetCookie?.() ?? [];
  if (opts.jar) {
    for (const line of setCookies) {
      const [pair] = line.split(";");
      const eq = pair!.indexOf("=");
      if (eq !== -1) opts.jar[pair!.slice(0, eq).trim()] = pair!.slice(eq + 1).trim();
    }
  }
  const text = await res.text();
  let body: HttpResult["body"] = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = null;
  }
  return { status: res.status, body, headers: res.headers, setCookies };
}
const isLoopback = (ip: string | null | undefined) => !!ip && (ip === "::1" || /^127\./.test(ip));

async function main(): Promise<void> {
  const { db } = await import("../app/src/lib/db");
  const { purgeHttpVerifyUser } = await import("./lib/httpVerifyUserCleanup");
  const { markTestUserEmailVerified } = await import("./lib/testEmailVerification");
  const createdUserIds: string[] = [];
  const cleanupErrors: string[] = [];

  try {
    const leftovers = await db.user.findMany({ where: { email: { startsWith: EMAIL_PREFIX, endsWith: "@example.invalid" } }, select: { id: true } });
    for (const u of leftovers) cleanupErrors.push(...(await purgeHttpVerifyUser(db, u.id, EMAIL_PREFIX)));

    // =====================================================================
    console.log(`[P1] HTTPS(${HTTPS_BASE_URL})`);
    let tlsError = "";
    const h = await fetch(`${HTTPS_BASE_URL}/api/v1/health`).catch((e: unknown) => {
      tlsError = e instanceof Error ? `${e.message} ${String((e as { cause?: unknown }).cause ?? "")}` : String(e);
      return null;
    });
    ok("[P1] root証明書で検証したHTTPS接続でhealthが200", h?.status === 200, tlsError || `status=${h?.status}`);
    if (!h) return;
    ok("[P1] HSTSを返す", (h.headers.get("strict-transport-security") ?? "").includes("max-age="));
    ok("[P1] Server headerを出さない", h.headers.get("server") === null, `server=${h.headers.get("server")}`);

    // =====================================================================
    console.log("[P2] HTTPS経由のregister/login");
    const email = `${EMAIL_PREFIX}${RUN_ID}@example.invalid`;
    const reg = await http(HTTPS_BASE_URL, "/api/v1/auth/register", { body: { email, password: PASSWORD } });
    const userId = String((reg.body?.data?.user as { id?: string } | undefined)?.id ?? "");
    if (userId) createdUserIds.push(userId);
    ok("[P2] HTTPS経由で登録できる", reg.status === 200 || reg.status === 201, `status=${reg.status}`);
    await markTestUserEmailVerified(db, email);
    const jar: Jar = {};
    const login = await http(HTTPS_BASE_URL, "/api/v1/auth/login", {
      body: { email, password: PASSWORD },
      jar,
      headers: { "x-forwarded-for": SPOOFED[0]!, "x-real-ip": SPOOFED[1]!, "x-ismay-peer-address": `forged ${SPOOFED[2]}` },
    });
    ok("[P2] HTTPS経由でloginできる", login.status === 200, `status=${login.status}`);
    const cookie = (name: string) => login.setCookies.find((c) => c.startsWith(`${name}=`)) ?? "";
    for (const name of ["ismay_at", "ismay_rt", "ismay_csrf"]) {
      ok(`[P2] ${name}はSecure・SameSite=Lax`, /;\s*Secure/i.test(cookie(name)) && /SameSite=lax/i.test(cookie(name)), cookie(name).replace(/=[^;]+/, "=***"));
    }
    ok("[P2] ismay_at・ismay_rtはHttpOnly", /HttpOnly/i.test(cookie("ismay_at")) && /HttpOnly/i.test(cookie("ismay_rt")));
    const s = await db.userSession.findFirst({ where: { userId }, orderBy: { issuedAt: "desc" } });
    ok("[P2] sessionのIPに偽装値を記録しない", !!s && !SPOOFED.includes(s.ipAddress ?? ""), `ip=${s?.ipAddress}`);
    ok("[P2] sessionのIPはproxyが付けた接続元(この試験ではloopback)", isLoopback(s?.ipAddress), `ip=${s?.ipAddress}`);

    // =====================================================================
    console.log("[P3] HTTPS経由のcookie認証・refresh・CSRF");
    const me = await http(HTTPS_BASE_URL, "/api/v1/auth/me", { method: "GET", jar });
    ok("[P3] cookieで認証できる", me.status === 200);
    const oldRt = jar.ismay_rt;
    const ref = await http(HTTPS_BASE_URL, "/api/v1/auth/refresh", { jar });
    ok("[P3] refreshで回転", ref.status === 200 && jar.ismay_rt !== oldRt);
    const noCsrf = await http(HTTPS_BASE_URL, "/api/v1/auth/logout", { jar });
    ok("[P3] CSRF headerなしのlogoutは403", noCsrf.status === 403);
    const out = await http(HTTPS_BASE_URL, "/api/v1/auth/logout", { jar, csrf: true });
    ok("[P3] CSRF header付きlogoutは成功", out.status === 200);

    // =====================================================================
    console.log(`[P4] app(${BASE_URL})の起動構成`);
    const d = await fetch(`${BASE_URL}/api/v1/health`).catch(() => null);
    const db4 = (await d?.json().catch(() => null)) as {
      status?: string;
      checks?: { runtime?: string; peer?: { stamping?: boolean }; trustedProxy?: { ok?: boolean; count?: number } };
    } | null;
    ok("[P4] production", db4?.checks?.runtime === "production", JSON.stringify(db4?.checks ?? {}));
    ok("[P4] custom server経由(peer取得)", db4?.checks?.peer?.stamping === true);
    ok("[P4] 信頼proxyは1件(Caddyの::1)", db4?.checks?.trustedProxy?.ok === true && db4.checks.trustedProxy.count === 1);
    ok("[P4] status=ok", db4?.status === "ok");

    // =====================================================================
    console.log("[P5] appのHTTP portをLANから到達できない");
    if (!PUBLIC_DIRECT_URL) {
      skip("[P5] LAN addressからの直接接続", "PUBLIC_DIRECT_URL未指定");
    } else {
      const direct = await fetch(`${PUBLIC_DIRECT_URL}/api/v1/health`, { signal: AbortSignal.timeout(5000) }).then((r) => r.status).catch(() => 0);
      ok(`[P5] ${PUBLIC_DIRECT_URL} へは接続できない(appはloopbackだけでlisten)`, direct === 0, `status=${direct}`);
    }
  } finally {
    for (const id of createdUserIds) cleanupErrors.push(...(await purgeHttpVerifyUser(db, id, EMAIL_PREFIX)));
    const remain = await db.user.count({ where: { email: { startsWith: EMAIL_PREFIX, endsWith: "@example.invalid" } } });
    console.log("[cleanup]");
    ok("[cleanup] cleanup中のエラー0件", cleanupErrors.length === 0, cleanupErrors.join("; "));
    ok("[cleanup] テストユーザーの残存0", remain === 0, `remaining=${remain}`);
    await db.$disconnect();
  }
}

main()
  .then(() => {
    console.log(`\n${passed} passed, ${failed} failed, ${skipped} skipped`);
    if (failed > 0) {
      console.log("FAILURES:\n" + failures.map((f) => `  - ${f}`).join("\n"));
      process.exit(1);
    }
    process.exit(0);
  })
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
