#!/usr/bin/env node
/**
 * scripts/verify_gate_m1a_acceptance.ts
 *
 * Gate M1-A(Project Context)の正式Acceptance Evidence取得スクリプト。
 * 出典: ISMAY-V5-DOC-12(EVAL・受入テスト仕様書) 3章「Gate M1-A Project Context」
 *       EV-C-001〜006、ISMAY-V5-DOC-13(Traceability・実装状況台帳) 5章
 *       「Gate M1-A Exit: EV-C全PASS」。
 *
 * scripts/verify_project_context_m1a2_live.ts(M1-A2適用時に作成)と同じ実行規約
 * (専用テストユーザーの都度登録、実DBに対する直接cleanup、既存データ不変)を踏襲する。
 * M1-A2スクリプトはAPI回帰確認が目的の一般検証だったのに対し、本スクリプトは
 * DOC-12のTest ID(EV-C-001〜006)に1対1で対応させ、PASS/FAIL/BLOCKED/NOT_RUNを
 * 明示的に記録するGate Evidence専用スクリプトである(DOC-12 1章
 * 「結果はPASS/FAIL/BLOCKED/NOT_RUN。外部依存やDATABASE_URL不足はBLOCKEDでありPASSではない」)。
 *
 * 各Test IDの対応:
 *   EV-C-001 CRUD/lifecycle・許可遷移のみ・version競合409
 *     → 作成/一覧/詳細、version不一致409、許可外遷移422、許可遷移成功(M1-A2スクリプトの
 *       1〜4番と同じ検証ロジックを流用・再検証)
 *   EV-C-002 parallel PRIMARY・同時2要求の成功1件
 *     → 同一Responsibilityへ2つの異なるContextから、Promise.allによる真の同時リクエストで
 *       PRIMARY Linkを要求し、201が1件・409 PRIMARY_CONTEXT_CONFLICTが1件になることをDB実測込みで確認
 *       (M1-A2スクリプトの9bは逐次実行のみだったため、本スクリプトが並行性を初めて検証する)
 *   EV-C-003 tenant crossing・service/DB双方で拒否
 *     → service層: 他WorkspaceからのGET/POST /linksが404になること(M1-A2スクリプト17と同じ)
 *       DB層: Prisma db.projectContextLink.createへ実在するcontextIdだが異なるworkspaceIdを
 *       直接渡し、複合FK(contextId, workspaceId)→(id, workspaceId)によりDB自体が拒否することを確認
 *       (schema.prisma 1474行の複合FK定義に対する直接検証。ここが本スクリプトの新規部分)
 *   EV-C-004 Context complete・linked Responsibility状態不変
 *     → M1-A2スクリプトの5番と同じ検証ロジックを流用・再検証
 *   EV-C-005 external snapshot conflict・conflict queue・LWW 0
 *     → [DEC-9](app/src/app/api/v1/project-contexts/[id]/external-references/route.ts冒頭)
 *       によりrefresh・Webhook・conflict queue・ProjectContextSnapshotRevision作成は
 *       このGateで意図的に未実装(29章の未確定事項に該当するconnector別scope/credential/
 *       replay防止が確定していないため)。実行せずBLOCKEDとして記録する
 *       (想像で実装してPASSを偽装しない。DOC-12 1章の原則に従う)。
 *   EV-C-006 exact cosine p95・目標100ms内またはHNSW Gate記録
 *     → Project Context自体のCRUD/Link/外部参照とは独立した、pgvector全体の性能検証
 *       (既存ResponsibilityEmbeddingと共通のexact cosine実装)であり、専用の負荷試験基盤
 *       (大量embeddingのseed、p95計測ハーネス)がまだ存在しない。本スクリプトの対象外として
 *       NOT_RUNとし、別途FR-GR-01(Embedding類似責任候補)側のPerformance Gateとして
 *       切り出すことを推奨する(想像でこの場しのぎの計測を行わない)。
 *
 * 実行方法:
 *   cd ~/projects/ismay/app
 *   npx tsx ../scripts/verify_gate_m1a_acceptance.ts
 *   (別ホスト/ポート: BASE_URL=http://localhost:13000 npx tsx ../scripts/verify_gate_m1a_acceptance.ts)
 *
 * 前提: app/の.env(DATABASE_URL)とlib/dbを使うため、~/projects/ismay/app直下から実行すること。
 * サーバーは起動しない(ismay-app.serviceが既に動いている前提)。
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
const EMAIL_PREFIX = "gate-m1a-verify-";
const TEST_EMAIL = `${EMAIL_PREFIX}${RUN_ID}@example.invalid`;
const TEST_PASSWORD = `GateM1A!${RUN_ID}A1`;
const TEST_EMAIL_B = `${EMAIL_PREFIX}${RUN_ID}-b@example.invalid`;
const TEST_PASSWORD_B = `GateM1ABv!${RUN_ID}A1`;

type CookieJar = Record<string, string>;
type GateResult = "PASS" | "FAIL" | "BLOCKED" | "NOT_RUN";

interface EvidenceRow {
  id: string;
  scenario: string;
  result: GateResult;
  detail: string;
}

const evidence: EvidenceRow[] = [];
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

function record(id: string, scenario: string, result: GateResult, detail: string): void {
  evidence.push({ id, scenario, result, detail });
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

function detailOf(res: { status: number; json: any; rawText?: string }): string {
  if (res.json !== null) return `status=${res.status} body=${JSON.stringify(res.json)}`;
  return `status=${res.status} body=null rawText=${JSON.stringify(res.rawText ?? "")}`;
}

async function registerAndLogin(
  email: string,
  password: string,
  displayName: string,
): Promise<{ jar: CookieJar; userId: string }> {
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

/** verify_project_context_m1a2_live.tsと同じFK依存順cleanup(コピー・同一設計)。 */
async function cleanupTestUser(params: { userId: string; workspaceId: string | null }): Promise<void> {
  const { userId, workspaceId } = params;
  if (workspaceId) {
    const contexts = await db.projectContext
      .findMany({ where: { workspaceId }, select: { id: true } })
      .catch(() => [] as { id: string }[]);
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
    const responsibilities = await db.responsibility
      .findMany({ where: { workspaceId }, select: { id: true } })
      .catch(() => [] as { id: string }[]);
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

function printEvidenceTable(): void {
  console.log("\n=== Gate M1-A Evidence(DOC-12 3章 EV-C-001〜006) ===");
  console.log(`日時: ${new Date().toISOString()}`);
  console.log(`実行コマンド: npx tsx scripts/verify_gate_m1a_acceptance.ts`);
  console.log(`環境: BASE_URL=${BASE_URL}`);
  for (const row of evidence) {
    console.log(`  [${row.result.padEnd(8)}] ${row.id}  ${row.scenario}`);
    if (row.detail) console.log(`             ${row.detail}`);
  }
  const closingIds = ["EV-C-001", "EV-C-002", "EV-C-003", "EV-C-004"];
  const allCoreAssertionsPass = closingIds.every(
    (id) => evidence.find((e) => e.id === id)?.result === "PASS",
  );
  const c5 = evidence.find((e) => e.id === "EV-C-005");
  const c6 = evidence.find((e) => e.id === "EV-C-006");
  console.log("\n--- Gate M1-A 判定 ---");
  if (allCoreAssertionsPass) {
    console.log("EV-C-001〜004: 全PASS。");
    console.log(
      `EV-C-005: ${c5?.result}(理由: [DEC-9]により未確定事項確定まで実装停止中。DOC-13 7章DEC-003相当の"実装停止"扱い)。`,
    );
    console.log(
      `EV-C-006: ${c6?.result}(理由: Context固有ではなくpgvector全体のPerformance Gateのため、別Gateとして切り出しを推奨)。`,
    );
    console.log(
      "結論: EV-C-001〜004(Context CRUD/lifecycle/並行性/tenant境界/Complete非連鎖)は全PASSであり、" +
        "M1-A(Context DB/API/UI)としての機能受入条件は満たされている。EV-C-005は未確定事項による意図的" +
        "実装停止、EV-C-006はGate範囲外(別Gateへ切り出し)として台帳へ明記することで、" +
        "Gate M1-Aは『機能面クローズ・EV-C-005/006は理由付きで別管理』として次Gate(M1-B)へ進める状態である。",
    );
  } else {
    console.log("EV-C-001〜004のいずれかが未PASSのため、Gate M1-Aはまだクローズできません。上記NGを解消してください。");
  }
}

async function main(): Promise<void> {
  const scriptDir = dirname(fileURLToPath(import.meta.url));
  loadDotEnv(join(scriptDir, "..", "app", ".env"));
  ({ db } = await import("../app/src/lib/db"));

  await sweepOrphanedTestUsers();

  console.log(`Gate M1-A(Project Context) Acceptance Evidence取得 (BASE_URL=${BASE_URL})`);
  console.log(`テスト専用ユーザー: ${TEST_EMAIL} / ${TEST_EMAIL_B}`);

  let userId: string | null = null;
  let workspaceId: string | null = null;
  let userIdB: string | null = null;
  let workspaceIdB: string | null = null;

  try {
    const { jar, userId: uid } = await registerAndLogin(TEST_EMAIL, TEST_PASSWORD, "Gate M1A Verify Bot A");
    userId = uid;
    const warmupA = await api(jar, "GET", "/api/v1/project-contexts");
    ok("0a. ウォームアップ: GET /project-contexts(Workspace遅延作成のトリガー、A)", warmupA.status === 200, detailOf(warmupA));
    if (warmupA.status !== 200) {
      console.error("\n[FATAL] 最初のAPI疎通(GET /project-contexts)が200を返しませんでした。");
      console.error(`  status: ${warmupA.status}`);
      console.error(`  rawText: ${warmupA.rawText ?? "(なし)"}`);
      throw new Error("ウォームアップAPI疎通失敗のため中断(詳細は上記rawText参照)");
    }
    const membership = await db.workspaceMember.findFirst({ where: { userId } });
    workspaceId = membership?.workspaceId ?? null;
    if (!workspaceId) throw new Error("セットアップ後にWorkspaceを特定できませんでした(A)");

    const { jar: jarB, userId: uidB } = await registerAndLogin(TEST_EMAIL_B, TEST_PASSWORD_B, "Gate M1A Verify Bot B");
    userIdB = uidB;
    const warmupB = await api(jarB, "GET", "/api/v1/project-contexts");
    ok("0b. ウォームアップ: GET /project-contexts(Workspace遅延作成のトリガー、B)", warmupB.status === 200, detailOf(warmupB));
    const membershipB = await db.workspaceMember.findFirst({ where: { userId: userIdB } });
    workspaceIdB = membershipB?.workspaceId ?? null;
    if (!workspaceIdB) throw new Error("セットアップ後にWorkspaceを特定できませんでした(B)");

    // =====================================================================
    // EV-C-001: CRUD/lifecycle・許可遷移のみ・version競合409
    // =====================================================================
    const createRes = await api(jar, "POST", "/api/v1/project-contexts", { name: "Gate M1A検証Context" });
    const c001a = createRes.status === 201 && createRes.json?.data?.version === 0;
    ok("EV-C-001a. POST /project-contexts: 201・version=0", c001a, detailOf(createRes));
    const contextId: string = createRes.json.data.id;

    const listRes = await api(jar, "GET", "/api/v1/project-contexts");
    const c001b = listRes.status === 200 && listRes.json?.data?.projectContexts?.some((c: any) => c.id === contextId);
    ok("EV-C-001b. GET /project-contexts: 一覧に作成したContextを含む", c001b);

    const badPatch = await api(jar, "PATCH", `/api/v1/project-contexts/${contextId}`, { name: "改名試行", version: 999 });
    const c001c =
      badPatch.status === 409 && badPatch.json?.error?.code === "VERSION_CONFLICT" && typeof badPatch.json?.error?.latestVersion === "number";
    ok("EV-C-001c. PATCH version不一致: 409 VERSION_CONFLICT・latestVersion同梱", c001c, detailOf(badPatch));

    const archiveRes = await api(jar, "PATCH", `/api/v1/project-contexts/${contextId}`, { lifecycleState: "ARCHIVED", version: 0 });
    const c001d = archiveRes.status === 200;
    ok("EV-C-001d. PATCH ACTIVE→ARCHIVED(許可された遷移)は成功する", c001d, detailOf(archiveRes));
    const afterArchive = archiveRes.json?.data?.projectContext;
    const reviveAttempt = await api(jar, "PATCH", `/api/v1/project-contexts/${contextId}`, {
      lifecycleState: "ACTIVE",
      version: afterArchive?.version,
    });
    const c001e = reviveAttempt.status === 422 && reviveAttempt.json?.error?.code === "STATE_TRANSITION_INVALID";
    ok("EV-C-001e. PATCH ARCHIVED→ACTIVE(許可外遷移): 422 STATE_TRANSITION_INVALID", c001e, detailOf(reviveAttempt));

    const ev001pass = c001a && c001b && c001c && c001d && c001e;
    record("EV-C-001", "CRUD/lifecycle、許可遷移のみ・version競合409", ev001pass ? "PASS" : "FAIL", `a=${c001a} b=${c001b} c=${c001c} d=${c001d} e=${c001e}`);

    // =====================================================================
    // EV-C-004: Context complete・linked Responsibility状態不変
    // (EV-C-002の対象Contextと重複させないよう先に実施)
    // =====================================================================
    const create2 = await api(jar, "POST", "/api/v1/project-contexts", { name: "Gate M1A検証Context2(complete用)" });
    const contextId2: string = create2.json.data.id;
    const respForLifecycle = await createResponsibility(jar, "Gate M1A検証: EV-C-004 lifecycle非連鎖確認用");
    const linkRes1 = await api(
      jar, "POST", `/api/v1/project-contexts/${contextId2}/links`,
      { responsibilityId: respForLifecycle, role: "PRIMARY" },
      { "Idempotency-Key": `gate-${RUN_ID}-c004-link` },
    );
    const c004a = linkRes1.status === 201;
    ok("EV-C-004a. PRIMARY Link作成成功", c004a, detailOf(linkRes1));
    const beforeStatusRes = await api(jar, "GET", `/api/v1/responsibilities/${respForLifecycle}`);
    const statusBefore = beforeStatusRes.json?.data?.responsibility?.status;
    const completeCtx = await api(jar, "PATCH", `/api/v1/project-contexts/${contextId2}`, { lifecycleState: "COMPLETED", version: 0 });
    const c004b = completeCtx.status === 200;
    ok("EV-C-004b. PATCH lifecycleState=COMPLETED成功", c004b, detailOf(completeCtx));
    const afterStatusRes = await api(jar, "GET", `/api/v1/responsibilities/${respForLifecycle}`);
    const statusAfter = afterStatusRes.json?.data?.responsibility?.status;
    const c004c = statusBefore === statusAfter;
    ok("EV-C-004c. 核心: Context完了(COMPLETED)後もResponsibility状態は不変", c004c, `before=${statusBefore} after=${statusAfter}`);

    const ev004pass = c004a && c004b && c004c;
    record("EV-C-004", "Context complete、linked Responsibility状態不変", ev004pass ? "PASS" : "FAIL", `a=${c004a} b=${c004b} c=${c004c}(before=${statusBefore},after=${statusAfter})`);

    // =====================================================================
    // EV-C-002: parallel PRIMARY・同時2要求の成功1件
    // =====================================================================
    const raceContext1Res = await api(jar, "POST", "/api/v1/project-contexts", { name: "Gate M1A検証: EV-C-002 race Context1" });
    const raceContext2Res = await api(jar, "POST", "/api/v1/project-contexts", { name: "Gate M1A検証: EV-C-002 race Context2" });
    const raceContextId1: string = raceContext1Res.json.data.id;
    const raceContextId2: string = raceContext2Res.json.data.id;
    const raceResp = await createResponsibility(jar, "Gate M1A検証: EV-C-002 race対象責任");

    const [raceRes1, raceRes2] = await Promise.all([
      api(jar, "POST", `/api/v1/project-contexts/${raceContextId1}/links`, { responsibilityId: raceResp, role: "PRIMARY" }, { "Idempotency-Key": `gate-${RUN_ID}-race1` }),
      api(jar, "POST", `/api/v1/project-contexts/${raceContextId2}/links`, { responsibilityId: raceResp, role: "PRIMARY" }, { "Idempotency-Key": `gate-${RUN_ID}-race2` }),
    ]);
    const raceResults = [raceRes1, raceRes2];
    const successCount = raceResults.filter((r) => r.status === 201).length;
    const conflictCount = raceResults.filter((r) => r.status === 409 && r.json?.error?.code === "PRIMARY_CONTEXT_CONFLICT").length;
    const c002a = successCount === 1 && conflictCount === 1;
    ok(
      "EV-C-002a. 同時2要求(異なるContextへ同一Responsibility・PRIMARY)は成功1件・409(PRIMARY_CONTEXT_CONFLICT)1件になる",
      c002a,
      `statuses=${raceResults.map((r) => r.status).join(",")} successCount=${successCount} conflictCount=${conflictCount}`,
    );
    const activeDbCount = await db.projectContextLink.count({
      where: { workspaceId, responsibilityId: raceResp, role: "PRIMARY", unlinkedAt: null },
    });
    const c002b = activeDbCount === 1;
    ok("EV-C-002b. DB実測: active PRIMARY Linkは競合後も1件のみ(partial unique indexの実効性)", c002b, `activeDbCount=${activeDbCount}`);

    const ev002pass = c002a && c002b;
    record("EV-C-002", "parallel PRIMARY、同時2要求の成功1件", ev002pass ? "PASS" : "FAIL", `a=${c002a} b=${c002b}(activeDbCount=${activeDbCount})`);

    // =====================================================================
    // EV-C-003: tenant crossing・service/DB双方で拒否
    // =====================================================================
    const crossGet = await api(jarB, "GET", `/api/v1/project-contexts/${contextId2}`);
    const c003a = crossGet.status === 404 && crossGet.json?.error?.code === "RESOURCE_NOT_FOUND";
    ok("EV-C-003a. service層: 他WorkspaceユーザーがContextをGET: 404(存在を漏らさない)", c003a, detailOf(crossGet));

    const respBOwn = await createResponsibility(jarB, "Gate M1A検証: B側責任(EV-C-003)");
    const crossLink = await api(
      jarB, "POST", `/api/v1/project-contexts/${contextId2}/links`,
      { responsibilityId: respBOwn, role: "SUPPORTING" },
      { "Idempotency-Key": `gate-${RUN_ID}-crosslink` },
    );
    const c003b = crossLink.status === 404;
    ok("EV-C-003b. service層: 他WorkspaceユーザーがContextへLink: 404(自Workspace外のContext)", c003b, detailOf(crossLink));

    // DB層: 実在するcontextId(workspaceId所属)へ、異なるworkspaceIdを直接指定して
    // Prisma経由でLink作成を試み、複合FK(contextId, workspaceId)違反で拒否されることを確認する。
    let c003c = false;
    let c003cDetail = "";
    try {
      await db.projectContextLink.create({
        data: {
          workspaceId: workspaceIdB,
          contextId: contextId2,
          responsibilityId: respBOwn,
          role: "REFERENCE",
          sourceKind: "SYSTEM",
        },
      });
      c003cDetail = "例外が発生せず作成が成功してしまった(DB制約が機能していない)";
    } catch (err) {
      c003c = true;
      c003cDetail = err instanceof Error ? err.message.slice(0, 300) : String(err).slice(0, 300);
    }
    ok("EV-C-003c. DB層: 実在contextId+他workspaceIdでのProjectContextLink直接作成は複合FK違反で拒否される", c003c, c003cDetail);

    const ev003pass = c003a && c003b && c003c;
    record("EV-C-003", "tenant crossing、service/DB双方で拒否", ev003pass ? "PASS" : "FAIL", `a=${c003a} b=${c003b} c=${c003c}(${c003cDetail})`);

    // =====================================================================
    // EV-C-005: external snapshot conflict・conflict queue・LWW 0
    // =====================================================================
    record(
      "EV-C-005",
      "external snapshot conflict、conflict queue、LWW 0",
      "BLOCKED",
      "[DEC-9](external-references/route.ts)により、このGateではrefresh/Webhook/conflict queue/" +
        "ProjectContextSnapshotRevision作成を実装していない(29章の未確定事項が確定するまで実装停止)。" +
        "実行対象コード自体が存在しないためBLOCKED。",
    );

    // =====================================================================
    // EV-C-006: exact cosine p95・目標100ms内またはHNSW Gate記録
    // =====================================================================
    record(
      "EV-C-006",
      "exact cosine p95、目標100ms内またはHNSW Gate記録",
      "NOT_RUN",
      "Project Context固有ではなく既存ResponsibilityEmbeddingと共通のpgvector exact cosine実装全体の" +
        "Performance Gateであり、専用の負荷試験ハーネス(embedding大量seed・p95計測)が未整備。" +
        "本スクリプトの対象外とし、FR-GR-01側のPerformance Gateとして別途切り出すことを推奨する。",
    );
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

  console.log(`\n合計(個別assertion): ${passed}件成功 / ${failed}件失敗`);
  if (failed > 0) {
    console.log("\n失敗した項目:");
    for (const f of failures) console.log(`  - ${f}`);
  }

  printEvidenceTable();

  const anyCoreFail = evidence.some((e) => ["EV-C-001", "EV-C-002", "EV-C-003", "EV-C-004"].includes(e.id) && e.result !== "PASS");
  if (failed > 0 || anyCoreFail) {
    process.exit(1);
  }
}

main();
