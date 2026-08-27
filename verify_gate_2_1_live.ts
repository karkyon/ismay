#!/usr/bin/env node
/**
 * verify_gate_2_1_live.ts
 *
 * Completion Gate 2.1について、これまでの外部監査で「実PostgreSQL/実APIでの
 * 確認が必要」として未検証のまま残っていた項目を、実際に稼働中のサーバー
 * (デフォルト http://localhost:13000、ismay-app.service)と実DBに対して
 * 自動実行し、pass/failを報告する。
 *
 * 検証する項目(すべて過去の監査コメントで名指しされたもの):
 *   1. 初回Undo: restored:1
 *   2. 同一payload再送: restored:1、Lifecycle Event件数が増えない
 *   3. 異なるpayload・同一completeEventId: 409 IDEMPOTENCY_KEY_REUSED
 *   4. COMPLETE→REVOKE→REOPENのFK接続(correctionOfEventId/resultingEventId)確認
 *   5. Undo後のEventLog(STATUS_CHANGED)/OutboxEvent(ResponsibilityTransitioned.v1)確認
 *   6. Gate阻害是正の確認: completeEventIdを省略した不正リクエストでも
 *      status がPLANNEDに固定され、任意stateへの直接書き込みができないこと
 *   7. 誤ったcompleteEventId(実在しないUUID)を送るとVALIDATION_FAILED(400)になること
 *   8. 200件規模バッチのUndoが単一トランザクションのタイムアウトに達さず完走すること
 *      (実測時間も出力する)
 *   9. (参考)2件バッチの一方が IDEMPOTENCY_KEY_REUSED になる場合、他方も
 *      ロールバックされ部分適用にならないこと
 *
 * 前提: このスクリプトはapp/ディレクトリの.env(DATABASE_URL)とlib/dbを
 * そのまま使うため、`~/projects/ismay/app`直下から実行すること。
 * サーバーはこのスクリプトが起動しない(ismay-app.serviceが既に動いている前提)。
 *
 * 実行方法:
 *   cd ~/projects/ismay/app
 *   npx tsx ../verify_gate_2_1_live.ts
 *   (別ホスト/ポートの場合: BASE_URL=http://localhost:13000 npx tsx ../verify_gate_2_1_live.ts)
 *
 * このスクリプトは検証用に専用のテストユーザー・専用Workspaceを都度新規登録し、
 * 検証後に作成した全データ(User/Workspace/Responsibility等)をDBから直接削除する
 * (実行したテストデータのゴミを残さない)。既存のユーザーデータには一切触れない。
 */

// [2026-08-26追加] シェルにDATABASE_URLが常にexportされているとは限らない
// (実際にomega-dev2の別セッションでDATABASE_URL未設定エラーが発生し確認済み)。
// db.tsはモジュール読込時にDATABASE_URLを要求するため、db.tsをimportするより
// 前に、app/.envを明示的に読み込む。
//
// [設置場所の注意] このスクリプトはプロジェクトルート直下(app/の外)に置く想定
// (一度きりのスクリプトの配置ルールに従う)。`dotenv/config`のようなbare importは
// Node.jsのモジュール解決規則上、このファイル自身の位置から上位ディレクトリを
// たどってnode_modulesを探すため、app/node_modules/dotenvを見つけられずに失敗する
// (実際に試して確認済み)。外部パッケージに依存しない自前の最小限.envパーサーで
// 代替する。
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

function loadDotEnv(envPath: string): void {
  let content: string;
  try {
    content = readFileSync(envPath, "utf-8");
  } catch {
    return; // .envが無ければ何もしない(既にシェルにexport済みの場合等)
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
    // 既にシェル側でexportされている値を上書きしない(シェル側を優先)。
    if (process.env[key] === undefined) {
      process.env[key] = value;
    }
  }
}

// [重要・実地検証で判明] ESMの`import`文は、ソース上どこに書いても
// モジュール本体の他の文より先に評価される(ホイスティング)。そのため
// `import { db } from "./app/src/lib/db"`を後ろに書いても、db.ts
// (DATABASE_URL未設定なら即throwする)の方が先に評価されてしまい、実際に
// DATABASE_URL未設定エラーで失敗することを確認した。また、このプロジェクトは
// package.jsonに"type":"module"が無くtsxがCJS出力するため、トップレベル
// awaitも使えない(これも実地検証で確認: ERR_REQUIRE_ASYNC_MODULE)。
// そのため、db変数はモジュールスコープの可変変数として宣言だけしておき、
// main()の冒頭でloadDotEnv()実行後に動的import()で初期化する。
// eslint-disable-next-line prefer-const
let db: typeof import("./app/src/lib/db")["db"];

const BASE_URL = process.env.BASE_URL ?? "http://localhost:13000";
const RUN_ID = Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
const TEST_EMAIL = `gate21-verify-${RUN_ID}@example.invalid`;
const TEST_PASSWORD = `Gate21Verify!${RUN_ID}A1`;

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
  // Node.jsのfetchはSet-Cookieを複数ヘッダとして扱うため getSetCookie() を使う。
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
): Promise<{ status: number; json: any }> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (jar["ismay_csrf"]) headers["x-csrf-token"] = jar["ismay_csrf"];
  if (Object.keys(jar).length > 0) headers["Cookie"] = cookieHeader(jar);
  const res = await fetch(`${BASE_URL}${path}`, {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  parseSetCookies(res, jar);
  const json = await res.json().catch(() => null);
  return { status: res.status, json };
}

async function createTaskAndComplete(
  jar: CookieJar,
  title: string,
): Promise<{ responsibilityId: string; undo: any }> {
  const createRes = await api(jar, "POST", "/api/v1/responsibilities", {
    type: "TASK",
    title,
  });
  if (createRes.status !== 200 && createRes.status !== 201) {
    throw new Error(`責任作成に失敗: status=${createRes.status} body=${JSON.stringify(createRes.json)}`);
  }
  const responsibilityId: string = createRes.json.data.id;

  // [2026-08-26追加] 新規TASKの初期状態はINBOX(initialStatusFor)だが、
  // COMMON_TRANSITIONSのCOMPLETEアクションはfrom=["IN_PROGRESS"]のみ許可する
  // (responsibility.ts参照)。INBOXから直接bulk completeを呼ぶと
  // 「現在の状態からは一括完了できません」でskipされる(実際に発生・確認した)。
  // 先に単一遷移APIでSTART(INBOX→IN_PROGRESS)を実行してから完了させる。
  const startRes = await api(jar, "POST", `/api/v1/responsibilities/${responsibilityId}/transitions`, {
    action: "START",
    occurredAt: new Date().toISOString(),
    version: createRes.json.data.version,
  });
  if (startRes.status !== 200) {
    throw new Error(`START遷移に失敗: status=${startRes.status} body=${JSON.stringify(startRes.json)}`);
  }

  const bulkRes = await api(jar, "POST", "/api/v1/responsibilities/bulk", {
    ids: [responsibilityId],
    action: "COMPLETE",
  });
  if (bulkRes.status !== 200 || bulkRes.json.data.affected !== 1) {
    throw new Error(`bulk complete失敗: status=${bulkRes.status} body=${JSON.stringify(bulkRes.json)}`);
  }
  return { responsibilityId, undo: bulkRes.json.data.undo };
}

/**
 * [2026-08-26新設] 指定したテストユーザー(userId)・Workspace(workspaceId)が
 * 所有するデータをDBから直接削除する。FK依存順を守って削除する:
 * ExecutionSessionRevision → ExecutionSessionIdentity →
 * ResponsibilityLifecycleEvent/EventLog/OutboxEvent/ResponsibilityExecutionEvent →
 * Responsibility → PemConsentEvent/PemMetricConsentEvent → WorkspaceMember →
 * Workspace(DomainはonDelete: Cascadeで自動削除) → Session → User。
 *
 * responsibilityIdsに実行中に集めたidを渡せるが、それとは別にworkspaceIdから
 * 直接再クエリもして取りこぼしを防ぐ(実行時に例外で処理が中断し、追跡配列への
 * pushより前にResponsibilityが作られていたケースで、実際に取りこぼしを確認済み)。
 */
async function cleanupTestUser(params: {
  userId: string;
  workspaceId: string | null;
  knownResponsibilityIds?: string[];
}): Promise<void> {
  const { userId, workspaceId } = params;
  let allResponsibilityIds = [...(params.knownResponsibilityIds ?? [])];
  if (workspaceId) {
    const rows = await db.responsibility
      .findMany({ where: { workspaceId }, select: { id: true } })
      .catch(() => [] as { id: string }[]);
    for (const r of rows) {
      if (!allResponsibilityIds.includes(r.id)) allResponsibilityIds.push(r.id);
    }
  }
  // [2026-08-26追加・実行時に発見した不具合の是正]
  // workspaceIdはdb.workspaceMember.findFirst({ where: { userId } })で引いているが、
  // 過去の実行で「workspaceMemberは削除できたがworkspace本体の削除がresponsibilities
  // 経由のFK違反で失敗する」という部分失敗が起きると、次回実行時にはworkspaceMemberが
  // 既に無いためworkspaceIdがnullになり、上のworkspaceId経由のクエリでは
  // Responsibilityを一切見つけられなくなる(実際にomega-dev2でこのケースが発生し、
  // responsibilities_created_by_fkeyでdb.user.deleteMany()が失敗することを確認した)。
  // Responsibility.createdByIdはUserへの直接FKであり、workspaceMemberの有無に
  // 依存しないため、createdById経由でも必ず再クエリし、確実に取りこぼしを無くす。
  const createdByRows = await db.responsibility
    .findMany({ where: { createdById: userId }, select: { id: true } })
    .catch(() => [] as { id: string }[]);
  for (const r of createdByRows) {
    if (!allResponsibilityIds.includes(r.id)) allResponsibilityIds.push(r.id);
  }

  if (allResponsibilityIds.length > 0) {
    const sessionIdentities = await db.executionSessionIdentity
      .findMany({ where: { responsibilityId: { in: allResponsibilityIds } }, select: { id: true } })
      .catch(() => [] as { id: string }[]);
    const sessionIdentityIds = sessionIdentities.map((s: { id: string }) => s.id);
    if (sessionIdentityIds.length > 0) {
      await db.executionSessionRevision
        .deleteMany({ where: { sessionIdentityId: { in: sessionIdentityIds } } })
        .catch(() => null);
      await db.executionSessionIdentity.deleteMany({ where: { id: { in: sessionIdentityIds } } }).catch(() => null);
    }
    await db.responsibilityLifecycleEvent
      .deleteMany({ where: { responsibilityId: { in: allResponsibilityIds } } })
      .catch(() => null);
    // [2026-08-26追加・実行時に発見した不具合の是正]
    // ReasonPrompt.triggerEventIdはResponsibilityExecutionEvent.idへの単一列FKで、
    // INTERRUPT/DEFER/REOPEN等のEventはReasonPromptを発生させる
    // (実際にUndoが記録するREOPEN Eventでreason_prompts_trigger_event_fkey違反が
    // 発生することを確認した)。ResponsibilityExecutionEventを削除するより前に、
    // ReasonPromptStateEvent/ExecutionReasonAnswer(ReasonPromptへの子FK)→
    // ReasonPromptの順で削除する。
    const executionEvents = await db.responsibilityExecutionEvent
      .findMany({ where: { responsibilityId: { in: allResponsibilityIds } }, select: { id: true } })
      .catch(() => [] as { id: string }[]);
    const executionEventIds = executionEvents.map((e: { id: string }) => e.id);
    if (executionEventIds.length > 0) {
      const reasonPrompts = await db.reasonPrompt
        .findMany({ where: { triggerEventId: { in: executionEventIds } }, select: { id: true } })
        .catch(() => [] as { id: string }[]);
      const reasonPromptIds = reasonPrompts.map((p: { id: string }) => p.id);
      if (reasonPromptIds.length > 0) {
        await db.reasonPromptStateEvent.deleteMany({ where: { promptId: { in: reasonPromptIds } } }).catch(() => null);
        await db.executionReasonAnswer.deleteMany({ where: { promptId: { in: reasonPromptIds } } }).catch(() => null);
        await db.reasonPrompt.deleteMany({ where: { id: { in: reasonPromptIds } } }).catch(() => null);
      }
    }
    await db.eventLog.deleteMany({ where: { aggregateId: { in: allResponsibilityIds } } }).catch(() => null);
    await db.outboxEvent.deleteMany({ where: { aggregateId: { in: allResponsibilityIds } } }).catch(() => null);
    await db.responsibilityExecutionEvent
      .deleteMany({ where: { responsibilityId: { in: allResponsibilityIds } } })
      .catch(() => null);
    await db.responsibility.deleteMany({ where: { id: { in: allResponsibilityIds } } }).catch(() => null);
  }

  await db.pemConsentEvent.deleteMany({ where: { userId } }).catch(() => null);
  await db.pemMetricConsentEvent.deleteMany({ where: { userId } }).catch(() => null);
  await db.workspaceMember.deleteMany({ where: { userId } }).catch(() => null);
  if (workspaceId) {
    // Domain(model Domain)はworkspaceへ onDelete: Cascade を持つため、
    // Workspace削除で自動的にカスケード削除される(手動削除不要)。
    await db.workspace.deleteMany({ where: { id: workspaceId } }).catch(() => null);
  }
  // 実スキーマのモデル名はUserSession(db.userSession)。UserSession.userは
  // onDelete: Cascadeが指定されているため本来User削除で自動的に消えるが、
  // 明示的に削除しておく(意図を明確にするため)。
  await db.userSession.deleteMany({ where: { userId } }).catch(() => null);
  await db.user.deleteMany({ where: { id: userId } }).catch(() => null);
}

/**
 * [2026-08-26新設] 過去の実行(このスクリプトの以前のバージョンで発生した
 * クリーンアップ失敗等)が残した孤立テストデータを一掃する。
 * email が `gate21-verify-*@example.invalid` のテスト専用ユーザーのみを対象にし、
 * 実データには一切触れない。
 */
async function sweepOrphanedTestUsers(): Promise<void> {
  const orphans = await db.user.findMany({
    where: { email: { startsWith: "gate21-verify-", endsWith: "@example.invalid" } },
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
  // [ホイスティング対策] main()の最初に、db.tsをimportするより前に.envを
  // 読み込む。db変数(モジュールスコープのletで宣言済み)をここで初期化する。
  const scriptDir = dirname(fileURLToPath(import.meta.url));
  loadDotEnv(join(scriptDir, "app", ".env"));
  ({ db } = await import("./app/src/lib/db"));

  await sweepOrphanedTestUsers();

  console.log(`Completion Gate 2.1 実DB/実API検証 (BASE_URL=${BASE_URL})`);
  console.log(`テスト専用ユーザー: ${TEST_EMAIL}`);

  const createdResponsibilityIds: string[] = [];
  let createdUserId: string | null = null;
  let createdWorkspaceId: string | null = null;

  try {
    // --- セットアップ: 専用ユーザー登録・ログイン・PEM同意付与 ---
    const jar: CookieJar = {};
    const regRes = await api(jar, "POST", "/api/v1/auth/register", {
      email: TEST_EMAIL,
      password: TEST_PASSWORD,
      displayName: "Gate2.1 Verify Bot",
    });
    if (regRes.status !== 200 && regRes.status !== 201) {
      throw new Error(`テストユーザー登録に失敗しました。status=${regRes.status} body=${JSON.stringify(regRes.json)}`);
    }
    const loginRes = await api(jar, "POST", "/api/v1/auth/login", {
      email: TEST_EMAIL,
      password: TEST_PASSWORD,
    });
    if (loginRes.status !== 200) {
      throw new Error(`テストユーザーログインに失敗しました。status=${loginRes.status} body=${JSON.stringify(loginRes.json)}`);
    }
    createdUserId = loginRes.json.data.user.id;

    // Execution Ledgerへの記録はPEM_DATA_COLLECTION同意が無いとスキップされる
    // (recordExecutionLedgerEventが同意なしの場合nullを返す)ため、検証の前提として
    // 明示的にGRANTEDを記録する。
    const consentRes = await api(jar, "POST", "/api/v1/pem/consent", {
      consentType: "PEM_DATA_COLLECTION",
      action: "GRANTED",
      source: "SETTINGS",
    });
    // pem/consent/route.tsはapiOk({ consent: state }, { status: 201 })で返す(200ではない)。
    ok("セットアップ: PEM_DATA_COLLECTION同意の付与に成功", consentRes.status === 201, JSON.stringify(consentRes.json));

    // workspaceIdをDBから引く(以降のDB直接検証で使う)。
    const dbUser = await db.user.findUnique({ where: { id: createdUserId! } });
    const membership = await db.workspaceMember.findFirst({ where: { userId: createdUserId! } });
    createdWorkspaceId = membership?.workspaceId ?? null;
    if (!dbUser || !createdWorkspaceId) {
      throw new Error("セットアップ後にUser/Workspaceを特定できませんでした");
    }

    // =====================================================================
    // 1〜5. 初回Undo・同一payload再送・異なるpayload・FK接続・EventLog/Outbox
    // =====================================================================
    {
      const { responsibilityId, undo } = await createTaskAndComplete(jar, "Gate2.1検証(1-5): 通常経路");
      createdResponsibilityIds.push(responsibilityId);
      const snap = undo.snapshot[0];
      ok("1. bulk complete: undo.snapshotにcompleteEventIdが含まれる", typeof snap.completeEventId === "string");

      // --- 1. 初回Undo ---
      const undo1 = await api(jar, "POST", "/api/v1/responsibilities/bulk/undo", undo);
      ok("1. 初回Undo: HTTP 200", undo1.status === 200, JSON.stringify(undo1.json));
      ok("1. 初回Undo: restored===1", undo1.json?.data?.restored === 1, JSON.stringify(undo1.json));

      const afterUndo1 = await db.responsibility.findUnique({ where: { id: responsibilityId } });
      ok("1. 初回Undo後: statusがPLANNED", afterUndo1?.status === "PLANNED", `actual=${afterUndo1?.status}`);

      const lifecycleEvents1 = await db.responsibilityLifecycleEvent.findMany({
        where: { responsibilityId },
      });
      ok("4. Lifecycle Eventが1件作成されている(kind=CORRECTION)", lifecycleEvents1.length === 1);
      const lc = lifecycleEvents1[0];
      ok(
        "4. correctionType=REVOKE",
        lc?.correctionType === "REVOKE",
        `actual=${lc?.correctionType}`,
      );
      ok(
        "4. correctionOfEventId(=元COMPLETE Event)が設定されている",
        typeof lc?.correctionOfEventId === "string" && lc.correctionOfEventId === snap.completeEventId,
      );
      ok("4. resultingEventId(=新規REOPEN Event)が設定されている", typeof lc?.resultingEventId === "string");

      const reopenEvent = lc?.resultingEventId
        ? await db.responsibilityExecutionEvent.findUnique({ where: { id: lc.resultingEventId } })
        : null;
      ok("4. resultingEventIdの実体がeventType=REOPENである", reopenEvent?.eventType === "REOPEN");
      ok(
        "4. REOPEN Eventのfrom/toがCOMPLETED→PLANNEDである(v4.0許可遷移)",
        reopenEvent?.fromState === "COMPLETED" && reopenEvent?.toState === "PLANNED",
      );

      const eventLogs1 = await db.eventLog.findMany({
        where: { aggregateId: responsibilityId, eventType: "STATUS_CHANGED" },
        orderBy: { occurredAt: "desc" },
      });
      ok("5. Undo後にEventLog(STATUS_CHANGED)が記録されている", eventLogs1.length >= 1);

      const outboxEvents1 = await db.outboxEvent.findMany({
        where: { aggregateId: responsibilityId, eventName: "ResponsibilityTransitioned.v1" },
      });
      ok("5. Undo後にOutboxEvent(ResponsibilityTransitioned.v1)が記録されている", outboxEvents1.length >= 1);

      // --- 2. 同一payloadでの再送(冪等) ---
      const undo2 = await api(jar, "POST", "/api/v1/responsibilities/bulk/undo", undo);
      ok("2. 同一payload再送: HTTP 200", undo2.status === 200, JSON.stringify(undo2.json));
      ok("2. 同一payload再送: restored===1(元の成功と同じ結果)", undo2.json?.data?.restored === 1, JSON.stringify(undo2.json));
      const lifecycleEvents2 = await db.responsibilityLifecycleEvent.findMany({
        where: { responsibilityId },
      });
      ok("2. 同一payload再送: Lifecycle Event件数が増えない(重複記録なし)", lifecycleEvents2.length === 1);

      // --- 3. 異なるpayload・同一completeEventId ---
      const differentPayloadUndo = {
        action: "COMPLETE",
        snapshot: [{ ...snap, completedAt: new Date().toISOString() }],
      };
      const undo3 = await api(jar, "POST", "/api/v1/responsibilities/bulk/undo", differentPayloadUndo);
      ok(
        "3. 異なるpayload・同一completeEventId: HTTP 409 IDEMPOTENCY_KEY_REUSED",
        undo3.status === 409 && undo3.json?.error?.code === "IDEMPOTENCY_KEY_REUSED",
        `status=${undo3.status} body=${JSON.stringify(undo3.json)}`,
      );
    }

    // =====================================================================
    // 6. Gate阻害是正の確認: completeEventId省略で許可遷移を迂回できないこと
    // =====================================================================
    {
      const { responsibilityId, undo } = await createTaskAndComplete(jar, "Gate2.1検証(6): Gate阻害是正");
      createdResponsibilityIds.push(responsibilityId);
      const maliciousUndo = {
        action: "COMPLETE",
        snapshot: [
          {
            id: responsibilityId,
            status: "IN_PROGRESS", // 任意のstatusへ直接書き込もうとする不正リクエスト
            completedAt: null,
            completeEventId: null, // 迂回の鍵: これを省略/nullにする
          },
        ],
      };
      const res = await api(jar, "POST", "/api/v1/responsibilities/bulk/undo", maliciousUndo);
      ok("6. Gate阻害是正: completeEventId省略でもHTTP 200(実行自体は許可される)", res.status === 200);
      const after = await db.responsibility.findUnique({ where: { id: responsibilityId } });
      ok(
        "6. Gate阻害是正【最重要】: statusがIN_PROGRESSではなくPLANNEDに固定される" +
          "(許可遷移COMPLETED→REOPEN→PLANNEDを迂回できない)",
        after?.status === "PLANNED",
        `actual=${after?.status}(IN_PROGRESSならGate阻害が再発している)`,
      );
    }

    // =====================================================================
    // 7. 誤ったcompleteEventIdはVALIDATION_FAILED
    // =====================================================================
    {
      const { responsibilityId, undo } = await createTaskAndComplete(jar, "Gate2.1検証(7): 誤ったcompleteEventId");
      createdResponsibilityIds.push(responsibilityId);
      const snap = undo.snapshot[0];
      const wrongUndo = {
        action: "COMPLETE",
        snapshot: [{ ...snap, completeEventId: "00000000-0000-4000-8000-000000000000" }],
      };
      const res = await api(jar, "POST", "/api/v1/responsibilities/bulk/undo", wrongUndo);
      ok(
        "7. 実在しないcompleteEventId: HTTP 400 VALIDATION_FAILED",
        res.status === 400 && res.json?.error?.code === "VALIDATION_FAILED",
        `status=${res.status} body=${JSON.stringify(res.json)}`,
      );
      // このケースは拒否されているはずなので、後始末のため正しいundoで戻しておく。
      await api(jar, "POST", "/api/v1/responsibilities/bulk/undo", undo);
    }

    // =====================================================================
    // 8. 200件規模バッチの実測
    // =====================================================================
    {
      const BATCH_SIZE = 200;
      const ids: string[] = [];
      for (let i = 0; i < BATCH_SIZE; i++) {
        const createRes = await api(jar, "POST", "/api/v1/responsibilities", {
          type: "TASK",
          title: `Gate2.1検証(8): 200件バッチ #${i}`,
        });
        if (createRes.status !== 200 && createRes.status !== 201) {
          throw new Error(`200件バッチ用の作成に失敗: status=${createRes.status}`);
        }
        const startRes = await api(jar, "POST", `/api/v1/responsibilities/${createRes.json.data.id}/transitions`, {
          action: "START",
          occurredAt: new Date().toISOString(),
          version: createRes.json.data.version,
        });
        if (startRes.status !== 200) {
          throw new Error(`200件バッチ用のSTART遷移に失敗: status=${startRes.status} body=${JSON.stringify(startRes.json)}`);
        }
        ids.push(createRes.json.data.id);
      }
      createdResponsibilityIds.push(...ids);

      const bulkRes = await api(jar, "POST", "/api/v1/responsibilities/bulk", { ids, action: "COMPLETE" });
      ok("8. 200件bulk complete: affected===200", bulkRes.json?.data?.affected === BATCH_SIZE, `status=${bulkRes.status}`);

      const t0 = Date.now();
      const undoRes = await api(jar, "POST", "/api/v1/responsibilities/bulk/undo", bulkRes.json.data.undo);
      const elapsedMs = Date.now() - t0;
      ok(
        "8. 200件Undo: HTTP 200(単一トランザクションのタイムアウトに達しない)",
        undoRes.status === 200,
        `status=${undoRes.status} elapsed=${elapsedMs}ms body=${JSON.stringify(undoRes.json).slice(0, 300)}`,
      );
      ok(
        "8. 200件Undo: restored===200(部分適用が起きていない)",
        undoRes.json?.data?.restored === BATCH_SIZE,
        `actual=${undoRes.json?.data?.restored} elapsed=${elapsedMs}ms`,
      );
      console.log(`     [計測] 200件Undoの所要時間: ${elapsedMs}ms`);
    }

    // =====================================================================
    // 9. バッチ内の1件がIDEMPOTENCY_KEY_REUSEDのとき、他方もロールバックされる
    // =====================================================================
    {
      const a = await createTaskAndComplete(jar, "Gate2.1検証(9): バッチ原子性 A");
      const b = await createTaskAndComplete(jar, "Gate2.1検証(9): バッチ原子性 B");
      createdResponsibilityIds.push(a.responsibilityId, b.responsibilityId);

      // Aだけ先にUndoしておく(このLifecycle Eventが後段でREJECT_REUSEDの種になる)。
      const preUndoA = await api(jar, "POST", "/api/v1/responsibilities/bulk/undo", a.undo);
      ok("9. 事前準備: Aの単独Undoが成功", preUndoA.status === 200 && preUndoA.json?.data?.restored === 1);

      // Aは既にUndo済みの状態で、Aの元payloadとは異なる内容(completedAtを変える)+Bの
      // 正常なUndoを同一バッチで送る。Aの分がREJECT_REUSEDとなり、バッチ全体が
      // ロールバックされるべき(=Bも巻き込まれてリジェクトされ、Bの状態は変化しない)。
      const mixedUndo = {
        action: "COMPLETE",
        snapshot: [
          { ...a.undo.snapshot[0], completedAt: new Date().toISOString() },
          b.undo.snapshot[0],
        ],
      };
      const mixedRes = await api(jar, "POST", "/api/v1/responsibilities/bulk/undo", mixedUndo);
      ok(
        "9. 混在バッチ: HTTP 409 IDEMPOTENCY_KEY_REUSED(バッチ全体が拒否される)",
        mixedRes.status === 409,
        `status=${mixedRes.status} body=${JSON.stringify(mixedRes.json)}`,
      );
      const bAfter = await db.responsibility.findUnique({ where: { id: b.responsibilityId } });
      ok(
        "9. 混在バッチ拒否後: Bの状態が変化していない(部分適用されていない)" +
          "(Bは元々COMPLETEDのままのはず)",
        bAfter?.status === "COMPLETED",
        `actual=${bAfter?.status}`,
      );
      // 後始末: Bを正しくUndoしておく。
      await api(jar, "POST", "/api/v1/responsibilities/bulk/undo", b.undo);
    }
  } catch (err) {
    failed++;
    failures.push(`予期しない例外: ${err instanceof Error ? err.message : String(err)}`);
    console.error(err);
  } finally {
    // -------------------------------------------------------------------
    // 後始末: このスクリプトが作成したテストデータをDBから直接削除する
    // (cleanupTestUser参照。FK依存順の詳細やなぜworkspaceIdから再クエリするか
    // 等の理由はcleanupTestUserの定義コメントを参照)。
    // -------------------------------------------------------------------
    console.log("\n[CLEANUP] テストデータを削除します...");
    if (createdUserId) {
      await cleanupTestUser({
        userId: createdUserId,
        workspaceId: createdWorkspaceId,
        knownResponsibilityIds: createdResponsibilityIds,
      });
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
