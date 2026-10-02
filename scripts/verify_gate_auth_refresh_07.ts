#!/usr/bin/env node
/**
 * scripts/verify_gate_auth_refresh_07.ts
 *
 * AUTH-REFRESH-07(回転済みRefresh Tokenの再利用検知、OPEN-AUTH-07)の実DB・HTTP受入試験。
 * 契約: docs/decisions/DEC-AUTH-REFRESH-07.md。
 *
 *   [F1] 回転: 200・新しいtokenを発行し、旧tokenのhashを失効表へ保持する(平文は保存しない)
 *   [F2] 猶予内の旧token再提示: 409 VERSION_CONFLICT、cookieを消さない、sessionは維持(新tokenは有効)
 *   [F3] 猶予を過ぎた旧token再提示: 401、系列(session)をREUSE_DETECTEDで失効、監査AUTH_REFRESH_REUSE_DETECTED(生tokenなし)、
 *        その後は最新tokenも使えない
 *   [F4] 同じtokenで同時に5要求: 成功はちょうど1件、残りは409、sessionは失効しない、成功側の新tokenは有効
 *   [F5] 未知のtoken: 401でcookieを消す
 *   [F6] 保持期間(30日)を過ぎた失効hashは次の回転で削除される
 *   [F7] アカウントPurgeで失効hashも削除される(user scope)
 *   cleanup後の残存0(テストユーザー・失効hash・監査)。
 *
 * 実行方法:
 *   cd ~/projects/ismay/app
 *   npx tsx ../scripts/verify_gate_auth_refresh_07.ts
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { createHash } from "node:crypto";

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

const BASE_URL = process.env.BASE_URL ?? "http://localhost:13000";
const RUN_ID = Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
const EMAIL_PREFIX = "gate-auth-refresh-07-";
const PASSWORD = `RefreshVerify!${RUN_ID}Aa1`;
const DAY_MS = 24 * 60 * 60 * 1000;

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

type Jar = Record<string, string>;
interface HttpResult {
  status: number;
  body: { data?: Record<string, unknown>; error?: { code?: string; retryable?: boolean } } | null;
  setCookies: string[];
}
function storeCookies(raw: string[], jar: Jar): void {
  for (const line of raw) {
    const [pair] = line.split(";");
    const eq = pair!.indexOf("=");
    if (eq === -1) continue;
    jar[pair!.slice(0, eq).trim()] = pair!.slice(eq + 1).trim();
  }
}
async function http(path: string, opts: { method?: string; body?: unknown; cookie?: string; jar?: Jar } = {}): Promise<HttpResult> {
  const headers: Record<string, string> = {};
  if (opts.body !== undefined) headers["content-type"] = "application/json";
  const cookie = opts.cookie ?? (opts.jar ? Object.entries(opts.jar).filter(([, v]) => v !== "").map(([k, v]) => `${k}=${v}`).join("; ") : "");
  if (cookie) headers.cookie = cookie;
  const res = await fetch(`${BASE_URL}${path}`, {
    method: opts.method ?? "POST",
    headers,
    body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
    redirect: "manual",
  });
  const setCookies = (res.headers as unknown as { getSetCookie?: () => string[] }).getSetCookie?.() ?? [];
  if (opts.jar) storeCookies(setCookies, opts.jar);
  const text = await res.text();
  let body: HttpResult["body"] = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = null;
  }
  return { status: res.status, body, setCookies };
}
const refreshWith = (rt: string) => http("/api/v1/auth/refresh", { cookie: `ismay_rt=${rt}` });
const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");
const clearsRefreshCookie = (r: HttpResult) => r.setCookies.some((c) => /^ismay_rt=;/.test(c) || (/^ismay_rt=/.test(c) && /Max-Age=0/i.test(c)));

async function main(): Promise<void> {
  const { db } = await import("../app/src/lib/db");
  const { purgeHttpVerifyUser } = await import("./lib/httpVerifyUserCleanup");
  const { markTestUserEmailVerified } = await import("./lib/testEmailVerification");
  const { REFRESH_REUSE_GRACE_MS } = await import("../app/src/lib/auth/refreshRotation");
  const createdUserIds: string[] = [];
  const cleanupErrors: string[] = [];

  try {
    // SWEEP
    const leftovers = await db.user.findMany({ where: { email: { startsWith: EMAIL_PREFIX, endsWith: "@example.invalid" } }, select: { id: true } });
    for (const u of leftovers) cleanupErrors.push(...(await purgeHttpVerifyUser(db, u.id, EMAIL_PREFIX)));
    if (leftovers.length) console.log(`[SWEEP] 過去実行の孤立テストユーザー${leftovers.length}件を削除しました`);

    const reach = await fetch(`${BASE_URL}/api/v1/auth/me`).then((r) => r.status).catch(() => 0);
    if (reach === 0) {
      ok(`サーバー(${BASE_URL})へ接続できる`, false, "サーバーを起動してください");
      return;
    }

    const email = `${EMAIL_PREFIX}${RUN_ID}@example.invalid`;
    const reg = await http("/api/v1/auth/register", { body: { email, password: PASSWORD } });
    const userId = String((reg.body?.data?.user as { id?: string } | undefined)?.id ?? "");
    if (userId) createdUserIds.push(userId);
    await markTestUserEmailVerified(db, email);
    const login = async (): Promise<Jar> => {
      const jar: Jar = {};
      const r = await http("/api/v1/auth/login", { body: { email, password: PASSWORD }, jar });
      if (r.status !== 200) throw new Error(`login失敗 status=${r.status}`);
      return jar;
    };
    ok("[F0] テストユーザー作成・ログイン", userId.length > 0);

    // =====================================================================
    console.log("[F1] 回転");
    const jar = await login();
    const rt0 = jar.ismay_rt!;
    const r1 = await http("/api/v1/auth/refresh", { jar });
    const rt1 = jar.ismay_rt!;
    const session = await db.userSession.findFirst({ where: { userId, revokedAt: null }, orderBy: { issuedAt: "desc" } });
    ok("[F1] 200で新しいtokenを発行", r1.status === 200 && rt1 !== rt0 && !!rt1);
    const retired0 = await db.userSessionRetiredRefreshToken.findUnique({ where: { tokenHash: sha256(rt0) } });
    ok("[F1] 旧tokenのhashを失効表へ保持(sessionに紐づく)", !!retired0 && retired0.sessionId === session?.id);
    const plainLeak = await db.$queryRawUnsafe<{ n: number }[]>(`SELECT count(*)::int AS n FROM user_session_retired_refresh_tokens WHERE token_hash = $1`, rt0);
    ok("[F1] 平文tokenは保存しない", (plainLeak[0]?.n ?? 0) === 0);

    // =====================================================================
    console.log("[F2] 猶予内の旧token再提示");
    const r2 = await refreshWith(rt0);
    ok("[F2] 409 VERSION_CONFLICT(retryable)", r2.status === 409 && r2.body?.error?.code === "VERSION_CONFLICT" && r2.body?.error?.retryable === true, `status=${r2.status} code=${r2.body?.error?.code}`);
    ok("[F2] cookieを消さない", !clearsRefreshCookie(r2) && r2.setCookies.length === 0);
    const s2 = await db.userSession.findUnique({ where: { id: session!.id } });
    ok("[F2] sessionは失効しない", !!s2 && s2.revokedAt === null);
    const r2b = await http("/api/v1/auth/refresh", { jar });
    ok("[F2] 新tokenは引き続き有効", r2b.status === 200);

    // =====================================================================
    console.log("[F3] 猶予を過ぎた旧token再提示(盗難後の再利用)");
    await db.userSessionRetiredRefreshToken.updateMany({
      where: { sessionId: session!.id },
      data: { retiredAt: new Date(Date.now() - REFRESH_REUSE_GRACE_MS - 60_000) },
    });
    const auditBefore = await db.auditLog.count({ where: { action: "AUTH_REFRESH_REUSE_DETECTED", targetId: userId } });
    const r3 = await refreshWith(rt0);
    ok("[F3] 401 AUTH_REQUIRED", r3.status === 401 && r3.body?.error?.code === "AUTH_REQUIRED");
    const s3 = await db.userSession.findUnique({ where: { id: session!.id } });
    ok("[F3] sessionをREUSE_DETECTEDで失効", !!s3?.revokedAt && s3.revokedReason === "REUSE_DETECTED", `reason=${s3?.revokedReason}`);
    const audits = await db.auditLog.findMany({ where: { action: "AUTH_REFRESH_REUSE_DETECTED", targetId: userId } });
    ok("[F3] 監査を1件記録", audits.length - auditBefore === 1, `count=${audits.length - auditBefore}`);
    ok("[F3] 監査に生token・hashを含まない", audits.every((a) => !(a.reason ?? "").includes(rt0) && !(a.reason ?? "").includes(sha256(rt0)) && (a.reason ?? "").includes("source=RETIRED_TOKEN")));
    const r3b = await http("/api/v1/auth/refresh", { jar });
    ok("[F3] 失効後は最新tokenも使えない", r3b.status === 401);

    // =====================================================================
    console.log("[F4] 同じtokenで同時に5要求");
    const jar4 = await login();
    const rt4 = jar4.ismay_rt!;
    const results = await Promise.all(Array.from({ length: 5 }, () => refreshWith(rt4)));
    const okCount = results.filter((r) => r.status === 200).length;
    const conflict = results.filter((r) => r.status === 409).length;
    ok("[F4] 成功はちょうど1件・残りは409", okCount === 1 && conflict === 4, results.map((r) => r.status).join(","));
    const s4 = await db.userSession.findFirst({ where: { userId, revokedAt: null }, orderBy: { issuedAt: "desc" } });
    ok("[F4] sessionは失効しない", !!s4);
    const winner = results.find((r) => r.status === 200);
    const winnerJar: Jar = {};
    if (winner) storeCookies(winner.setCookies, winnerJar);
    const r4b = winnerJar.ismay_rt ? await refreshWith(winnerJar.ismay_rt) : null;
    ok("[F4] 成功側の新tokenは有効", r4b?.status === 200);

    // =====================================================================
    console.log("[F5] 未知のtoken");
    const r5 = await refreshWith(`unknown-${RUN_ID}`);
    ok("[F5] 401でcookieを消す", r5.status === 401 && clearsRefreshCookie(r5));

    // =====================================================================
    console.log("[F6] 保持期間を過ぎた失効hashの削除");
    {
      const jar6 = await login();
      const s6 = await db.userSession.findFirst({ where: { userId, revokedAt: null }, orderBy: { issuedAt: "desc" } });
      const oldHash = sha256(`old-${RUN_ID}`);
      await db.userSessionRetiredRefreshToken.create({ data: { sessionId: s6!.id, tokenHash: oldHash, retiredAt: new Date(Date.now() - 31 * DAY_MS) } });
      const recentHash = sha256(`recent-${RUN_ID}`);
      await db.userSessionRetiredRefreshToken.create({ data: { sessionId: s6!.id, tokenHash: recentHash, retiredAt: new Date(Date.now() - 1 * DAY_MS) } });
      const r6 = await http("/api/v1/auth/refresh", { jar: jar6 });
      ok("[F6] 回転は成功", r6.status === 200);
      ok("[F6] 30日より古い失効hashは削除", (await db.userSessionRetiredRefreshToken.count({ where: { tokenHash: oldHash } })) === 0);
      ok("[F6] 期間内の失効hashは保持", (await db.userSessionRetiredRefreshToken.count({ where: { tokenHash: recentHash } })) === 1);
    }
  } finally {
    // ============================================================ cleanup([F7]を兼ねる)
    const sessionIds = createdUserIds.length
      ? (await db.userSession.findMany({ where: { userId: { in: createdUserIds } }, select: { id: true } })).map((s) => s.id)
      : [];
    const retiredBefore = sessionIds.length ? await db.userSessionRetiredRefreshToken.count({ where: { sessionId: { in: sessionIds } } }) : 0;
    for (const id of createdUserIds) cleanupErrors.push(...(await purgeHttpVerifyUser(db, id, EMAIL_PREFIX)));
    const retiredAfter = sessionIds.length ? await db.userSessionRetiredRefreshToken.count({ where: { sessionId: { in: sessionIds } } }) : 0;
    console.log("[F7] アカウントPurge");
    ok("[F7] Purge前は失効hashがある", createdUserIds.length === 0 || retiredBefore > 0, `before=${retiredBefore}`);
    ok("[F7] Purgeで失効hashも削除(user scope)", retiredAfter === 0, `after=${retiredAfter}`);
    const remainUsers = await db.user.count({ where: { email: { startsWith: EMAIL_PREFIX, endsWith: "@example.invalid" } } });
    const remainAudit = createdUserIds.length ? await db.auditLog.count({ where: { targetType: "User", targetId: { in: createdUserIds } } }) : 0;
    console.log("[cleanup]");
    ok("[cleanup] cleanup中のエラー0件", cleanupErrors.length === 0, cleanupErrors.join("; "));
    ok("[cleanup] テストユーザーの残存0", remainUsers === 0, `remaining=${remainUsers}`);
    ok("[cleanup] テストユーザーの監査記録の残存0", remainAudit === 0, `remaining=${remainAudit}`);
    await db.$disconnect();
  }
}

main()
  .then(() => {
    console.log(`\n${passed} passed, ${failed} failed`);
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
