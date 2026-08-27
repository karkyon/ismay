#!/usr/bin/env node
/**
 * scripts/verify_project_context_m1a2_live.ts
 *
 * V5-M1-A2(Project Context API: contexts/links/external-references)について、
 * 実際に稼働中のサーバー(既定 http://localhost:13000)と実DBに対して自動実行し、
 * pass/failを報告する。scripts/verify_gate_2_1_live.tsと同じ規約(専用テストユーザーの
 * 都度登録、実行後のDB直接クリーンアップ、既存データには一切触れない)を踏襲する。
 *
 * [DEC-16(前回セッション)] M1-A2適用パッチには含めず、別途追加するとしていたものが本ファイル。
 *
 * 検証する項目(統合正本v5.0 §26.2「Project Context」の受入条件、DOC-04 §11の
 * 受入条件のうちAPI層で検証可能なものに対応):
 *   1. Context作成(POST)・一覧(GET)・詳細(GET)
 *   2. PATCH version CAS: 不一致は409 VERSION_CONFLICT(latestVersion付き)
 *   3. PATCH lifecycleState: 許可外遷移は422 STATE_TRANSITION_INVALID
 *   4. PATCH lifecycleState: 許可された遷移(ACTIVE→PAUSED)は成功しversionが進む
 *   5. Context lifecycle変更(COMPLETED含む)はResponsibility状態を連鎖変更しない
 *      (DOC-04 3章・統合正本v5.0 §26.2の核心受入条件)
 *   6. POST /links: Idempotency-Keyヘッダ無しは400 VALIDATION_FAILED
 *   7. POST /links: 冪等再送(同一key・同一payload)は新規作成せず同じLinkを返す
 *   8. POST /links: 同一key・異payloadは409 IDEMPOTENCY_KEY_REUSED
 *   9. 同一Responsibilityへの2件目のactive PRIMARY Linkは409 PRIMARY_CONTEXT_CONFLICT
 *      (統合正本v5.0 §26.2「1責任にPRIMARY Context最大1件」)
 *  10. 同一(Context,Responsibility)組への2件目のactive Linkも409(role問わず一意)
 *  11. DELETE /links/:responsibilityId: Idempotency-Keyヘッダ無しは400
 *  12. DELETE /links/:responsibilityId: unlink成功、冪等再送は同一成功応答
 *  13. DELETE /links/:responsibilityId: 存在しないLinkは404 RESOURCE_NOT_FOUND
 *  14. External Reference作成(POST)成功
 *  15. External Reference: 自然key重複・同一内容は200(idempotent的挙動)
 *  16. External Reference: 自然key重複・内容不一致は400 VALIDATION_FAILED
 *  17. Tenant境界: 他Workspaceのcontext/responsibilityは404(存在を漏らさない)
 *      (統合正本v5.0 §26.2「workspaceを跨ぐLink/Reference作成がDB制約で失敗する」)
 *
 * 前提: app/ディレクトリの.env(DATABASE_URL)とlib/dbを使うため、
 * `~/projects/ismay/app`直下から実行すること。サーバーは起動しない
 * (ismay-app.serviceが既に動いている前提)。
 *
 * 実行方法:
 *   cd ~/projects/ismay/app
 *   npx tsx ../scripts/verify_project_context_m1a2_live.ts
 *   (別ホスト/ポート: BASE_URL=http://localhost:13000 npx tsx ../scripts/verify_project_context_m1a2_live.ts)
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
    if (process.env[key] === undefined) {
      process.env[key] = value;
    }
  }
}

// eslint-disable-next-line prefer-const
let db: typeof import("../app/src/lib/db")["db"];

const BASE_URL = process.env.BASE_URL ?? "http://localhost:13000";
const RUN_ID = Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
const EMAIL_PREFIX = "m1a2-verify-";
const TEST_EMAIL = `${EMAIL_PREFIX}${RUN_ID}@example.invalid`;
const TEST_PASSWORD = `M1A2Verify!${RUN_ID}A1`;
const TEST_EMAIL_B = `${EMAIL_PREFIX}${RUN_ID}-b@example.invalid`;
const TEST_PASSWORD_B = `M1A2VerifyB!${RUN_ID}A1`;

type CookieJar = Record<string, string>;

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

function parseSetCookies(res: Response, jar: CookieJar): void {
  const raw = (res.headers as unknown as { getSetCookie?: () => string[] }).getSetCookie?.() ?? [];
  for (const line of raw) {
    const [pair] = line.split(";");
    const eq = pair.indexOf("=");
    if (eq === -1) continue;
    const key = pair.slice(0, eq).trim();
    const value = pair.slice(eq + 1).trim();
    jar[key] = value;
  }
}

function cookieHeader(jar: CookieJar): string {
  return Object.entries(jar)
    .map(([k, v]) => `${k}=${v}`)
    .join("; ");
}

/**
 * [実地検証で判明・追加] 当初はres.json().catch(()=>null)で握り潰していたため、
 * 500応答時に実際のエラー本文(HTMLエラーページやスタックトレース)が一切見えず、
 * 原因調査ができなかった(実機で "status=500 body=null" のみが得られ、
 * 真因がAPI実装のバグかmigration未適用かサーバー未再起動か切り分け不能だった)。
 * JSON parseに失敗した場合は生のレスポンス本文(先頭2000文字)をrawTextとして
 * 保持し、呼び出し側のok()詳細表示に使えるようにする。
 */
async function api(
  jar: CookieJar,
  method: string,
  path: string,
  body?: unknown,
  extraHeaders?: Record<string, string>,
): Promise<{ status: number; json: any; rawText?: string }> {
  const headers: Record<string, string> = { "Content-Type": "application/json", ...(extraHeaders ?? {}) };
  if (jar["ismay_csrf"]) headers["x-csrf-token"] = jar["ismay_csrf"];
  if (Object.keys(jar).length > 0) headers["Cookie"] = cookieHeader(jar);
  const res = await fetch(`${BASE_URL}${path}`, {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  parseSetCookies(res, jar);
  const text = await res.text().catch(() => "");
  let json: any = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = null;
  }
  return { status: res.status, json, rawText: json === null ? text.slice(0, 2000) : undefined };
}

/** 診断用: statusが期待外・jsonがnullのとき、rawTextを含めた詳細文字列を作る。 */
function detailOf(res: { status: number; json: any; rawText?: string }): string {
  if (res.json !== null) return `status=${res.status} body=${JSON.stringify(res.json)}`;
  return `status=${res.status} body=null rawText=${JSON.stringify(res.rawText ?? "")}`;
}

async function registerAndLogin(email: string, password: string, displayName: string): Promise<{ jar: CookieJar; userId: string }> {
  const jar: CookieJar = {};
  const regRes = await api(jar, "POST", "/api/v1/auth/register", { email, password, displayName });
  if (regRes.status !== 200 && regRes.status !== 201) {
    throw new Error(`テストユーザー登録に失敗: status=${regRes.status} body=${JSON.stringify(regRes.json)}`);
  }
  const loginRes = await api(jar, "POST", "/api/v1/auth/login", { email, password });
  if (loginRes.status !== 200) {
    throw new Error(`テストユーザーログインに失敗: status=${loginRes.status} body=${JSON.stringify(loginRes.json)}`);
  }
  return { jar, userId: loginRes.json.data.user.id };
}

async function createResponsibility(jar: CookieJar, title: string): Promise<string> {
  const res = await api(jar, "POST", "/api/v1/responsibilities", { type: "TASK", title });
  if (res.status !== 200 && res.status !== 201) {
    throw new Error(`責任作成に失敗: status=${res.status} body=${JSON.stringify(res.json)}`);
  }
  return res.json.data.id;
}

/**
 * 指定ユーザー・Workspaceが所有するM1-A2関連データ+Responsibility+Workspace+Userを
 * FK依存順に削除する。ProjectContextLink/ProjectContextLinkEvent/
 * ExternalContextReferenceはResponsibility/Workspaceの両方へ複合FK(RESTRICT)を
 * 持つため、Responsibility・Workspaceを削除するより前に必ず削除する
 * (migration.sqlのON DELETE RESTRICTを実地確認済みのうえでの順序)。
 */
async function cleanupTestUser(params: { userId: string; workspaceId: string | null }): Promise<void> {
  const { userId, workspaceId } = params;

  if (workspaceId) {
    const contexts = await db.projectContext.findMany({ where: { workspaceId }, select: { id: true } }).catch(() => [] as { id: string }[]);
    const contextIds = contexts.map((c: { id: string }) => c.id);
    if (contextIds.length > 0) {
      await db.projectContextLinkEvent.deleteMany({ where: { contextId: { in: contextIds } } }).catch(() => null);
      await db.projectContextLink.deleteMany({ where: { contextId: { in: contextIds } } }).catch(() => null);
      await db.externalContextReference.deleteMany({ where: { contextId: { in: contextIds } } }).catch(() => null);
      await db.projectContextEmbedding.deleteMany({ where: { contextId: { in: contextIds } } }).catch(() => null);
      await db.eventLog.deleteMany({ where: { aggregateId: { in: contextIds } } }).catch(() => null);
      await db.outboxEvent.deleteMany({ where: { aggregateId: { in: contextIds } } }).catch(() => null);
      await db.projectContext.deleteMany({ where: { id: { in: contextIds } } }).catch(() => null);
    }

    const responsibilities = await db.responsibility.findMany({ where: { workspaceId }, select: { id: true } }).catch(() => [] as { id: string }[]);
    const responsibilityIds = responsibilities.map((r: { id: string }) => r.id);
    if (responsibilityIds.length > 0) {
      await db.eventLog.deleteMany({ where: { aggregateId: { in: responsibilityIds } } }).catch(() => null);
      await db.outboxEvent.deleteMany({ where: { aggregateId: { in: responsibilityIds } } }).catch(() => null);
      await db.responsibility.deleteMany({ where: { id: { in: responsibilityIds } } }).catch(() => null);
    }
  }

  await db.pemConsentEvent.deleteMany({ where: { userId } }).catch(() => null);
  await db.pemMetricConsentEvent.deleteMany({ where: { userId } }).catch(() => null);
  await db.workspaceMember.deleteMany({ where: { userId } }).catch(() => null);
  if (workspaceId) {
    await db.workspace.deleteMany({ where: { id: workspaceId } }).catch(() => null);
  }
  await db.userSession.deleteMany({ where: { userId } }).catch(() => null);
  await db.user.deleteMany({ where: { id: userId } }).catch(() => null);
}

async function sweepOrphanedTestUsers(): Promise<void> {
  const orphans = await db.user.findMany({
    where: { email: { startsWith: EMAIL_PREFIX, endsWith: "@example.invalid" } },
    select: { id: true },
  });
  if (orphans.length === 0) return;
  console.log(`[SWEEP] 過去の実行が残した孤立テストユーザーを${orphans.length}件発見。削除します...`);
  for (const o of orphans) {
    const membership = await db.workspaceMember.findFirst({ where: { userId: o.id }, select: { workspaceId: true } });
    await cleanupTestUser({ userId: o.id, workspaceId: membership?.workspaceId ?? null });
  }
  console.log("[SWEEP] 完了。");
}

async function main(): Promise<void> {
  const scriptDir = dirname(fileURLToPath(import.meta.url));
  loadDotEnv(join(scriptDir, "..", "app", ".env"));
  ({ db } = await import("../app/src/lib/db"));

  await sweepOrphanedTestUsers();

  console.log(`V5-M1-A2 Project Context API 実DB/実API検証 (BASE_URL=${BASE_URL})`);
  console.log(`テスト専用ユーザー: ${TEST_EMAIL} / ${TEST_EMAIL_B}`);

  let userId: string | null = null;
  let workspaceId: string | null = null;
  let userIdB: string | null = null;
  let workspaceIdB: string | null = null;

  try {
    const { jar, userId: uid } = await registerAndLogin(TEST_EMAIL, TEST_PASSWORD, "M1A2 Verify Bot A");
    userId = uid;
    // [実地検証で判明・修正] ensureDefaultWorkspace()はWorkspace/Domainを遅延作成する
    // (register/loginでは作成されない)。既存verify_gate_2_1_live.tsはこの直後にPEM同意
    // POSTを呼んでおり、buildPemAuthorizationContext()内部でensureDefaultWorkspace()が
    // 呼ばれるため間接的にWorkspaceが出来ていた。本スクリプトは元々このウォームアップ呼び出しを
    // 欠いており、ログイン直後にdb.workspaceMember.findFirst()しても何も見つからず
    // 「セットアップ後にWorkspaceを特定できませんでした」で落ちることを実機で確認した。
    // GET /api/v1/project-contexts(ensureDefaultWorkspaceを内部で呼ぶ)を明示的な
    // ウォームアップとして先に呼ぶ。
    const warmupA = await api(jar, "GET", "/api/v1/project-contexts");
    ok("0a. ウォームアップ: GET /project-contexts(Workspace遅延作成のトリガー、A)", warmupA.status === 200,
      detailOf(warmupA));
    if (warmupA.status !== 200) {
      // [実地検証で判明・追加] ここが失敗すると以降の全項目が意味のない連鎖失敗になる
      // (かつては後続の20項目近くが同じ原因でNGを吐き続け、真因の特定を妨げていた)。
      // 生のレスポンス本文を出力したうえで即座に中断し、原因調査に必要な情報だけを残す。
      console.error("\n[FATAL] 最初のAPI疎通(GET /project-contexts)が200を返しませんでした。");
      console.error(`  status: ${warmupA.status}`);
      console.error(`  rawText: ${warmupA.rawText ?? "(なし)"}`);
      console.error("  考えられる原因: (a) migration未適用のDBにAPIがアクセスした, ");
      console.error("  (b) npm run build後にサーバープロセス(ismay-app.service等)が再起動されておらず");
      console.error("      旧ビルドのままリクエストを処理している, (c) 実行時例外(サーバーログを確認)。");
      throw new Error("ウォームアップAPI疎通失敗のため中断(詳細は上記rawText参照)");
    }
    const membership = await db.workspaceMember.findFirst({ where: { userId } });
    workspaceId = membership?.workspaceId ?? null;
    if (!workspaceId) throw new Error("セットアップ後にWorkspaceを特定できませんでした(A)");

    const { jar: jarB, userId: uidB } = await registerAndLogin(TEST_EMAIL_B, TEST_PASSWORD_B, "M1A2 Verify Bot B");
    userIdB = uidB;
    const warmupB = await api(jarB, "GET", "/api/v1/project-contexts");
    ok("0b. ウォームアップ: GET /project-contexts(Workspace遅延作成のトリガー、B)", warmupB.status === 200,
      detailOf(warmupB));
    const membershipB = await db.workspaceMember.findFirst({ where: { userId: userIdB } });
    workspaceIdB = membershipB?.workspaceId ?? null;
    if (!workspaceIdB) throw new Error("セットアップ後にWorkspaceを特定できませんでした(B)");

    // =====================================================================
    // 1. Context作成・一覧・詳細
    // =====================================================================
    const createRes = await api(jar, "POST", "/api/v1/project-contexts", { name: "M1A2検証Context" });
    ok("1. POST /project-contexts: 201・version=0", createRes.status === 201 && createRes.json?.data?.version === 0,
      detailOf(createRes));
    const contextId: string = createRes.json.data.id;

    const listRes = await api(jar, "GET", "/api/v1/project-contexts");
    ok("1. GET /project-contexts: 一覧に作成したContextを含む",
      listRes.status === 200 && listRes.json?.data?.projectContexts?.some((c: any) => c.id === contextId));

    const detailRes = await api(jar, "GET", `/api/v1/project-contexts/${contextId}`);
    ok("1. GET /project-contexts/:id: 詳細取得成功・active linkは0件",
      detailRes.status === 200 && detailRes.json?.data?.projectContext?.id === contextId &&
        detailRes.json?.data?.projectContext?.links?.length === 0,
      detailOf(detailRes));

    // =====================================================================
    // 2. PATCH version CAS: 不一致は409
    // =====================================================================
    const badPatch = await api(jar, "PATCH", `/api/v1/project-contexts/${contextId}`, { name: "改名試行", version: 999 });
    ok("2. PATCH version不一致: 409 VERSION_CONFLICT・latestVersion同梱",
      badPatch.status === 409 && badPatch.json?.error?.code === "VERSION_CONFLICT" && typeof badPatch.json?.error?.latestVersion === "number",
      detailOf(badPatch));

    // =====================================================================
    // 3. PATCH lifecycleState: 許可外遷移は422
    // =====================================================================
    const badTransition = await api(jar, "PATCH", `/api/v1/project-contexts/${contextId}`, { lifecycleState: "ARCHIVED", version: 0 });
    ok("3a. PATCH ACTIVE→ARCHIVED(許可された遷移)は成功する",
      badTransition.status === 200, detailOf(badTransition));
    const afterArchive = badTransition.json?.data?.projectContext;
    const reviveAttempt = await api(jar, "PATCH", `/api/v1/project-contexts/${contextId}`, {
      lifecycleState: "ACTIVE",
      version: afterArchive?.version,
    });
    ok("3b. PATCH ARCHIVED→ACTIVE(許可外遷移): 422 STATE_TRANSITION_INVALID",
      reviveAttempt.status === 422 && reviveAttempt.json?.error?.code === "STATE_TRANSITION_INVALID",
      detailOf(reviveAttempt));

    // 以降の検証用に、別の新規Contextを作り直す(上のContextはARCHIVEDで終端のため)。
    const create2 = await api(jar, "POST", "/api/v1/project-contexts", { name: "M1A2検証Context2" });
    const contextId2: string = create2.json.data.id;

    // =====================================================================
    // 4. PATCH lifecycleState: 許可された遷移(ACTIVE→PAUSED)
    // =====================================================================
    const pauseRes = await api(jar, "PATCH", `/api/v1/project-contexts/${contextId2}`, { lifecycleState: "PAUSED", version: 0 });
    ok("4. PATCH ACTIVE→PAUSED: 成功・versionが1へ進む",
      pauseRes.status === 200 && pauseRes.json?.data?.projectContext?.lifecycleState === "PAUSED" && pauseRes.json?.data?.projectContext?.version === 1,
      detailOf(pauseRes));

    // =====================================================================
    // 5. Context lifecycle変更はResponsibility状態を連鎖変更しない
    // =====================================================================
    const respForLifecycle = await createResponsibility(jar, "M1A2検証: lifecycle非連鎖確認用");
    const linkKey1 = `verify-${RUN_ID}-link1`;
    const linkRes1 = await api(
      jar, "POST", `/api/v1/project-contexts/${contextId2}/links`,
      { responsibilityId: respForLifecycle, role: "PRIMARY" },
      { "Idempotency-Key": linkKey1 },
    );
    ok("5a. PRIMARY Link作成成功", linkRes1.status === 201, detailOf(linkRes1));
    const beforeStatusRes = await api(jar, "GET", `/api/v1/responsibilities/${respForLifecycle}`);
    const statusBefore = beforeStatusRes.json?.data?.responsibility?.status;
    const completeCtx = await api(jar, "PATCH", `/api/v1/project-contexts/${contextId2}`, { lifecycleState: "COMPLETED", version: 1 });
    ok("5b. PATCH lifecycleState=COMPLETED成功", completeCtx.status === 200, `status=${completeCtx.status}`);
    const afterStatusRes = await api(jar, "GET", `/api/v1/responsibilities/${respForLifecycle}`);
    const statusAfter = afterStatusRes.json?.data?.responsibility?.status;
    ok(
      "5c. 核心【最重要】: Context完了(COMPLETED)後もResponsibility状態は不変(連鎖変更0件、DOC-04 3章)",
      statusBefore === statusAfter,
      `before=${statusBefore} after=${statusAfter}`,
    );

    // =====================================================================
    // 6〜10. links(POST) 冪等・PRIMARY一意性
    // =====================================================================
    const contextId3Res = await api(jar, "POST", "/api/v1/project-contexts", { name: "M1A2検証Context3(links専用)" });
    const contextId3: string = contextId3Res.json.data.id;
    const respA = await createResponsibility(jar, "M1A2検証: Link対象A");
    const respB = await createResponsibility(jar, "M1A2検証: Link対象B(PRIMARY競合確認用)");

    const noKeyLink = await api(jar, "POST", `/api/v1/project-contexts/${contextId3}/links`, { responsibilityId: respA, role: "SUPPORTING" });
    ok("6. Idempotency-Keyヘッダ無しのPOST /links: 400 VALIDATION_FAILED", noKeyLink.status === 400,
      detailOf(noKeyLink));

    const linkKeyA = `verify-${RUN_ID}-linkA`;
    const linkA1 = await api(jar, "POST", `/api/v1/project-contexts/${contextId3}/links`, { responsibilityId: respA, role: "SUPPORTING" }, { "Idempotency-Key": linkKeyA });
    ok("7a. POST /links 初回成功(201)", linkA1.status === 201, detailOf(linkA1));
    const linkA2 = await api(jar, "POST", `/api/v1/project-contexts/${contextId3}/links`, { responsibilityId: respA, role: "SUPPORTING" }, { "Idempotency-Key": linkKeyA });
    ok("7b. 同一key・同一payloadの再送は200(冪等、新規重複作成なし)", linkA2.status === 200,
      detailOf(linkA2));
    const linkA3 = await api(jar, "POST", `/api/v1/project-contexts/${contextId3}/links`, { responsibilityId: respA, role: "REFERENCE" }, { "Idempotency-Key": linkKeyA });
    ok("8. 同一key・異payloadの再送は409 IDEMPOTENCY_KEY_REUSED", linkA3.status === 409 && linkA3.json?.error?.code === "IDEMPOTENCY_KEY_REUSED",
      detailOf(linkA3));

    const linkKeyB1 = `verify-${RUN_ID}-linkB1`;
    const linkB1 = await api(jar, "POST", `/api/v1/project-contexts/${contextId3}/links`, { responsibilityId: respB, role: "PRIMARY" }, { "Idempotency-Key": linkKeyB1 });
    ok("9a. respBをPRIMARYとしてContext3へLink成功", linkB1.status === 201, detailOf(linkB1));

    const linkKeyB2 = `verify-${RUN_ID}-linkB2`;
    const linkB2 = await api(jar, "POST", `/api/v1/project-contexts/${contextId2}/links`, { responsibilityId: respB, role: "PRIMARY" }, { "Idempotency-Key": linkKeyB2 });
    ok(
      "9b. 核心: 同一Responsibility(respB)を別ContextへもPRIMARYとしてLinkしようとすると409 PRIMARY_CONTEXT_CONFLICT(workspace内で最大1件)",
      linkB2.status === 409 && linkB2.json?.error?.code === "PRIMARY_CONTEXT_CONFLICT",
      detailOf(linkB2),
    );

    const linkKeyB3 = `verify-${RUN_ID}-linkB3`;
    const linkB3 = await api(jar, "POST", `/api/v1/project-contexts/${contextId3}/links`, { responsibilityId: respB, role: "SUPPORTING" }, { "Idempotency-Key": linkKeyB3 });
    ok(
      "10. 同一(Context,Responsibility)組への2件目のactive Link(role違い)も409(active linkは組ごとに1件まで)",
      linkB3.status === 409 && linkB3.json?.error?.code === "PRIMARY_CONTEXT_CONFLICT",
      detailOf(linkB3),
    );

    // =====================================================================
    // 11〜13. links(DELETE) unlink
    // =====================================================================
    const noKeyUnlink = await api(jar, "DELETE", `/api/v1/project-contexts/${contextId3}/links/${respA}`);
    ok("11. Idempotency-Keyヘッダ無しのDELETE /links/:rid: 400 VALIDATION_FAILED", noKeyUnlink.status === 400,
      detailOf(noKeyUnlink));

    const unlinkKey = `verify-${RUN_ID}-unlinkA`;
    const unlink1 = await api(jar, "DELETE", `/api/v1/project-contexts/${contextId3}/links/${respA}`, undefined, { "Idempotency-Key": unlinkKey });
    ok("12a. DELETE /links/:rid 初回成功", unlink1.status === 200 && unlink1.json?.data?.unlinked === true,
      detailOf(unlink1));
    const unlink2 = await api(jar, "DELETE", `/api/v1/project-contexts/${contextId3}/links/${respA}`, undefined, { "Idempotency-Key": unlinkKey });
    ok("12b. 同一keyの再送は同一成功応答(冪等)", unlink2.status === 200 && unlink2.json?.data?.unlinked === true,
      detailOf(unlink2));

    const unlinkMissingKey = `verify-${RUN_ID}-unlink-missing`;
    const respC = await createResponsibility(jar, "M1A2検証: 未Link責任(404確認用)");
    const unlinkMissing = await api(jar, "DELETE", `/api/v1/project-contexts/${contextId3}/links/${respC}`, undefined, { "Idempotency-Key": unlinkMissingKey });
    ok("13. 存在しないLinkのDELETE: 404 RESOURCE_NOT_FOUND", unlinkMissing.status === 404 && unlinkMissing.json?.error?.code === "RESOURCE_NOT_FOUND",
      detailOf(unlinkMissing));

    // =====================================================================
    // 14〜16. external-references
    // =====================================================================
    const erPayload = {
      provider: "MERIDIAN",
      externalWorkspaceKey: `ws-${RUN_ID}`,
      externalProjectKey: `proj-${RUN_ID}`,
      direction: "IMPORT",
      syncPolicy: "MANUAL",
      status: "ACTIVE",
    };
    const erRes1 = await api(jar, "POST", `/api/v1/project-contexts/${contextId3}/external-references`, erPayload);
    ok("14. External Reference作成成功(201)", erRes1.status === 201, detailOf(erRes1));

    const erRes2 = await api(jar, "POST", `/api/v1/project-contexts/${contextId3}/external-references`, erPayload);
    ok("15. 自然key重複・同一内容の再送は200(idempotent的挙動)", erRes2.status === 200,
      detailOf(erRes2));

    const erRes3 = await api(jar, "POST", `/api/v1/project-contexts/${contextId3}/external-references`, { ...erPayload, status: "PAUSED" });
    ok("16. 自然key重複・内容不一致は400 VALIDATION_FAILED", erRes3.status === 400,
      detailOf(erRes3));

    // =====================================================================
    // 17. Tenant境界
    // =====================================================================
    const crossGet = await api(jarB, "GET", `/api/v1/project-contexts/${contextId3}`);
    ok("17a. 他WorkspaceユーザーがContextをGET: 404(存在を漏らさない)", crossGet.status === 404 && crossGet.json?.error?.code === "RESOURCE_NOT_FOUND",
      detailOf(crossGet));

    const respBOwn = await createResponsibility(jarB, "M1A2検証: B側責任");
    const crossLinkKey = `verify-${RUN_ID}-crosslink`;
    const crossLink = await api(
      jarB, "POST", `/api/v1/project-contexts/${contextId3}/links`,
      { responsibilityId: respBOwn, role: "SUPPORTING" },
      { "Idempotency-Key": crossLinkKey },
    );
    ok("17b. 他WorkspaceユーザーがContextへLink: 404(自Workspace外のContext)", crossLink.status === 404,
      detailOf(crossLink));
  } catch (err) {
    failed++;
    failures.push(`予期しない例外: ${err instanceof Error ? err.message : String(err)}`);
    console.error(err);
  } finally {
    console.log("\n[CLEANUP] テストデータを削除します...");
    if (userId) {
      await cleanupTestUser({ userId, workspaceId });
    }
    if (userIdB) {
      await cleanupTestUser({ userId: userIdB, workspaceId: workspaceIdB });
    }
    console.log("[CLEANUP] 完了。");
  }

  console.log(`\n合計: ${passed}件成功 / ${failed}件失敗`);
  if (failed > 0) {
    console.log("\n失敗した項目:");
    for (const f of failures) console.log(`  - ${f}`);
    process.exit(1);
  }
}

main();
