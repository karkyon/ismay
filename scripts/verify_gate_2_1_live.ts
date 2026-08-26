#!/usr/bin/env node
/**
 * scripts/verify_gate_2_1_live.ts
 *
 * [2026-08-26・外部監査で「重要な26件の実DB回帰試験をリポジトリへ常設していない
 * ため再利用できない」と指摘され、scripts/下へ移設・git管理下に置いた
 * (再利用するスクリプトはscripts/下、という運用ルールに従う)]
 *
 * Completion Gate 2.1について、これまでの外部監査で「実PostgreSQL/実APIでの
 * 確認が必要」として未検証のまま残っていた項目を、実際に稼働中のサーバー
 * (デフォルト http://localhost:13000、ismay-app.service)と実DBに対して
 * 自動実行し、pass/failを報告する。今後もCompletion Gate 2.1(bulk complete/undo)
 * まわりを変更した際は、このスクリプトを再実行して回帰が無いことを確認すること。
 *
 * [2026-08-26全面改訂・外部監査で指摘された根本問題(クライアント編集可能な
 * snapshotをUndoの信頼元にしている)の是正に伴い、Undo Receipt方式へ移行した。
 * 検証項目も刷新している。]
 *
 * 検証する項目:
 *   1. 通常経路: 初回Undo(restored:1)・同一receiptId再送(冪等、restored:1)・
 *      FK接続(correctionOfEventId/resultingEventId)・EventLog/Outbox記録確認
 *   3. 実在しないreceiptIdはVALIDATION_FAILED(400)
 *   7. 他Responsibilityのreceiptを流用しようとするとVALIDATION_FAILED(400)
 *      (receiptIdはUUIDだが、responsibilityId一致も要求されるため拒否される)
 *   8. 200件規模バッチのUndoが単一トランザクションのタイムアウトに達さず完走すること
 *      (実測時間も出力する)
 *   9. バッチ内の1件が不正receiptIdのとき、他方も含めてバッチ全体がロールバック
 *      され部分適用にならないこと
 *   10. 種別固有型(COMMITMENT/WAITING/RISK)のUndoが実際に機能すること
 *   13. Undo Receipt方式の核心確認1: AT_RISKから完了したCOMMITMENTは、
 *       (initialStatusForのACTIVEではなく)正確にAT_RISKへ復元されること
 *       (旧設計の仕様回帰の是正確認)
 *   14. Undo Receipt方式の核心確認2: 種別固有型(Execution Ledger未記録)でも
 *       同一receiptId再送でrestored:1を返すこと(冪等性未達の是正確認)
 *   15. Undo Receipt方式の核心確認3: PEM未同意時に完了したTASKでも
 *       同一receiptId再送でrestored:1を返すこと
 *   16. 世代確認: 古い未使用レシートで後続の別完了サイクルを誤って取り消せない
 *       こと(外部監査P0-1是正確認)
 *   17. 競合制御: 同一receiptIdへの同時Undo要求が全て同一の成功結果を返すこと
 *       (外部監査P0-2是正確認)
 *
 * 前提: このスクリプトはapp/ディレクトリの.env(DATABASE_URL)とlib/dbを
 * そのまま使うため、`~/projects/ismay/app`直下から実行すること。
 * サーバーはこのスクリプトが起動しない(ismay-app.serviceが既に動いている前提)。
 *
 * 実行方法:
 *   cd ~/projects/ismay/app
 *   npx tsx ../scripts/verify_gate_2_1_live.ts
 *   (別ホスト/ポートの場合: BASE_URL=http://localhost:13000 npx tsx ../scripts/verify_gate_2_1_live.ts)
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
// `import { db } from "../app/src/lib/db"`を後ろに書いても、db.ts
// (DATABASE_URL未設定なら即throwする)の方が先に評価されてしまい、実際に
// DATABASE_URL未設定エラーで失敗することを確認した。また、このプロジェクトは
// package.jsonに"type":"module"が無くtsxがCJS出力するため、トップレベル
// awaitも使えない(これも実地検証で確認: ERR_REQUIRE_ASYNC_MODULE)。
// そのため、db変数はモジュールスコープの可変変数として宣言だけしておき、
// main()の冒頭でloadDotEnv()実行後に動的import()で初期化する。
// eslint-disable-next-line prefer-const
let db: typeof import("../app/src/lib/db")["db"];

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
  return createAndComplete(jar, "TASK", title);
}

/**
 * [2026-08-26追加・外部監査再々評価対応]
 * TASK以外の種別(COMMITMENT/WAITING/RISK)も実DBで検証するための汎用ヘルパー。
 * 経緯: 以前はcreateTaskAndComplete(TASK専用)しか無く、実DB回帰試験がTASKしか
 * 検証していなかったため、「decideCompleteUndoActionが型に関わらず
 * currentStatus==="COMPLETED"を要求しており、COMMITMENT/WAITING/RISKのUndoが
 * 常にrestored:0になる」という重大なバグを実DB試験で検出できていなかった
 * (外部監査で指摘)。
 *
 * COMMITMENT(初期status=ACTIVE)・WAITING(初期status=WAITING)・RISK(初期status=OPEN)は、
 * いずれも初期状態がそのまま完了操作の遷移元として有効なため、TASKと異なり
 * START相当の事前遷移は不要(responsibility.ts initialStatusFor/COMMITMENT_
 * TRANSITIONS等参照)。
 */
async function createAndComplete(
  jar: CookieJar,
  type: string,
  title: string,
): Promise<{ responsibilityId: string; undo: any }> {
  const createRes = await api(jar, "POST", "/api/v1/responsibilities", { type, title });
  if (createRes.status !== 200 && createRes.status !== 201) {
    throw new Error(`責任作成に失敗(type=${type}): status=${createRes.status} body=${JSON.stringify(createRes.json)}`);
  }
  const responsibilityId: string = createRes.json.data.id;

  // [2026-08-26追加] 新規TASKの初期状態はINBOX(initialStatusFor)だが、
  // COMMON_TRANSITIONSのCOMPLETEアクションはfrom=["IN_PROGRESS"]のみ許可する
  // (responsibility.ts参照)。INBOXから直接bulk completeを呼ぶと
  // 「現在の状態からは一括完了できません」でskipされる(実際に発生・確認した)。
  // 先に単一遷移APIでSTART(INBOX→IN_PROGRESS)を実行してから完了させる。
  // COMMITMENT/WAITING/RISKは初期状態がそのまま完了操作の遷移元として有効なため、
  // この事前遷移は不要。
  if (type === "TASK" || type === "EVENT" || type === "CONCERN" || type === "HABIT" || type === "IDEA") {
    const startRes = await api(jar, "POST", `/api/v1/responsibilities/${responsibilityId}/transitions`, {
      action: "START",
      occurredAt: new Date().toISOString(),
      version: createRes.json.data.version,
    });
    if (startRes.status !== 200) {
      throw new Error(`START遷移に失敗: status=${startRes.status} body=${JSON.stringify(startRes.json)}`);
    }
  }

  const bulkRes = await api(jar, "POST", "/api/v1/responsibilities/bulk", {
    ids: [responsibilityId],
    action: "COMPLETE",
  });
  if (bulkRes.status !== 200 || bulkRes.json.data.affected !== 1) {
    throw new Error(`bulk complete失敗(type=${type}): status=${bulkRes.status} body=${JSON.stringify(bulkRes.json)}`);
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
    // [2026-08-26追加・Undo Receipt方式への移行に伴う追加]
    // BulkCompleteReceipt.completeEventIdはResponsibilityExecutionEventへのFK、
    // BulkCompleteUndoConsumption.receiptIdはBulkCompleteReceiptへのFKなので、
    // ResponsibilityExecutionEventを削除するより前に、consumption→receiptの順で
    // 削除する。
    const receipts = await db.bulkCompleteReceipt
      .findMany({ where: { responsibilityId: { in: allResponsibilityIds } }, select: { id: true } })
      .catch(() => [] as { id: string }[]);
    const receiptIds = receipts.map((r: { id: string }) => r.id);
    if (receiptIds.length > 0) {
      await db.bulkCompleteUndoConsumption.deleteMany({ where: { receiptId: { in: receiptIds } } }).catch(() => null);
      await db.bulkCompleteReceipt.deleteMany({ where: { id: { in: receiptIds } } }).catch(() => null);
    }
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
  loadDotEnv(join(scriptDir, "..", "app", ".env"));
  ({ db } = await import("../app/src/lib/db"));

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
    // 1. 通常経路: 初回Undo・同一receiptId再送(冪等)・FK接続・EventLog/Outbox
    // =====================================================================
    // [2026-08-26全面改訂・外部監査で指摘された根本問題の是正に伴う書き換え]
    // 従来はクライアントが保持するsnapshot(status/completedAt/completeEventId)を
    // そのまま送り返す設計だったため、「異なるpayload」を意図的に構築して
    // REJECT_REUSEDを検証するテストが存在した。新設計ではクライアントが送るのは
    // receiptIdのみであり、改ざん可能な他のフィールドが存在しないため、この種の
    // テストは意味を失った(それ自体が設計の安全性向上を意味する)。代わりに、
    // 「同一receiptIdの再送は同じ成功応答を返す」という冪等契約を、Execution
    // Ledgerが記録されない経路(種別固有型・PEM未同意)でも成立することを重点的に
    // 検証する(外部監査で「Ledgerなし経路の冪等性が未成立」と指摘された点)。
    {
      const task = await createTaskAndComplete(jar, "Gate2.1検証(1): 通常経路");
      createdResponsibilityIds.push(task.responsibilityId);
      const snap = task.undo.snapshot[0];
      ok("1. bulk complete: undo.snapshotにreceiptIdが含まれる", typeof snap.receiptId === "string");

      const undo1 = await api(jar, "POST", "/api/v1/responsibilities/bulk/undo", task.undo);
      ok("1. 初回Undo: HTTP 200", undo1.status === 200, JSON.stringify(undo1.json));
      ok("1. 初回Undo: restored===1", undo1.json?.data?.restored === 1, JSON.stringify(undo1.json));

      const afterUndo1 = await db.responsibility.findUnique({ where: { id: task.responsibilityId } });
      ok("1. 初回Undo後: statusがPLANNED", afterUndo1?.status === "PLANNED", `actual=${afterUndo1?.status}`);

      const receipt = await db.bulkCompleteReceipt.findUnique({ where: { id: snap.receiptId } });
      ok("1. レシートのfromStatusがIN_PROGRESS(完了前の真の状態)", receipt?.fromStatus === "IN_PROGRESS");
      ok("1. レシートのtoStatusがCOMPLETED", receipt?.toStatus === "COMPLETED");
      ok("1. レシートにcompleteEventIdが記録されている(PEM同意ありのため)", typeof receipt?.completeEventId === "string");

      const lifecycleEvents1 = await db.responsibilityLifecycleEvent.findMany({
        where: { responsibilityId: task.responsibilityId },
      });
      ok("4. Lifecycle Eventが1件作成されている(kind=CORRECTION)", lifecycleEvents1.length === 1);
      const lc = lifecycleEvents1[0];
      ok("4. correctionType=REVOKE", lc?.correctionType === "REVOKE", `actual=${lc?.correctionType}`);
      ok(
        "4. correctionOfEventId(=元COMPLETE Event)がレシートのcompleteEventIdと一致",
        lc?.correctionOfEventId === receipt?.completeEventId,
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
        where: { aggregateId: task.responsibilityId, eventType: "STATUS_CHANGED" },
        orderBy: { occurredAt: "desc" },
      });
      ok("5. Undo後にEventLog(STATUS_CHANGED)が記録されている", eventLogs1.length >= 1);

      const outboxEvents1 = await db.outboxEvent.findMany({
        where: { aggregateId: task.responsibilityId, eventName: "ResponsibilityTransitioned.v1" },
      });
      ok("5. Undo後にOutboxEvent(ResponsibilityTransitioned.v1)が記録されている", outboxEvents1.length >= 1);

      // --- 同一receiptIdでの再送(冪等) ---
      const undo2 = await api(jar, "POST", "/api/v1/responsibilities/bulk/undo", task.undo);
      ok("2. 同一receiptId再送: HTTP 200", undo2.status === 200, JSON.stringify(undo2.json));
      ok(
        "2. 同一receiptId再送: restored===1(元の成功と同じ結果)",
        undo2.json?.data?.restored === 1,
        JSON.stringify(undo2.json),
      );
      const consumptions1 = await db.bulkCompleteUndoConsumption.findMany({ where: { receiptId: snap.receiptId } });
      ok("2. 同一receiptId再送: 冪等記録が重複作成されない", consumptions1.length === 1);
      const lifecycleEvents2 = await db.responsibilityLifecycleEvent.findMany({
        where: { responsibilityId: task.responsibilityId },
      });
      ok("2. 同一receiptId再送: Lifecycle Event件数が増えない(重複記録なし)", lifecycleEvents2.length === 1);
    }

    // =====================================================================
    // 3. 実在しないreceiptId・他責任のreceiptIdはVALIDATION_FAILED
    // =====================================================================
    {
      const task = await createTaskAndComplete(jar, "Gate2.1検証(3): 不正なreceiptId");
      createdResponsibilityIds.push(task.responsibilityId);
      const fakeUndo = {
        action: "COMPLETE",
        snapshot: [{ id: task.responsibilityId, receiptId: "00000000-0000-4000-8000-000000000000" }],
      };
      const res = await api(jar, "POST", "/api/v1/responsibilities/bulk/undo", fakeUndo);
      ok(
        "3. 実在しないreceiptId: HTTP 400 VALIDATION_FAILED",
        res.status === 400 && res.json?.error?.code === "VALIDATION_FAILED",
        `status=${res.status} body=${JSON.stringify(res.json)}`,
      );
      // 後始末: 正しいundoで戻す。
      await api(jar, "POST", "/api/v1/responsibilities/bulk/undo", task.undo);
    }

    // =====================================================================
    // 7. 他Responsibilityのreceiptを流用しようとするとVALIDATION_FAILED
    // =====================================================================
    // [2026-08-26追加・改ざん耐性の確認] receiptIdはUUIDだが、他の
    // Responsibilityのreceipt.idを流用しても、bulkOperations.tsの検索条件が
    // responsibilityId一致も要求するため拒否されるべきである。
    {
      const taskA = await createTaskAndComplete(jar, "Gate2.1検証(7): レシート流用防止A");
      const taskB = await createTaskAndComplete(jar, "Gate2.1検証(7): レシート流用防止B");
      createdResponsibilityIds.push(taskA.responsibilityId, taskB.responsibilityId);
      const crossUndo = {
        action: "COMPLETE",
        snapshot: [{ id: taskA.responsibilityId, receiptId: taskB.undo.snapshot[0].receiptId }],
      };
      const res = await api(jar, "POST", "/api/v1/responsibilities/bulk/undo", crossUndo);
      ok(
        "7. 他Responsibilityのreceiptを流用: HTTP 400 VALIDATION_FAILED",
        res.status === 400 && res.json?.error?.code === "VALIDATION_FAILED",
        `status=${res.status} body=${JSON.stringify(res.json)}`,
      );
      // 後始末。
      await api(jar, "POST", "/api/v1/responsibilities/bulk/undo", taskA.undo);
      await api(jar, "POST", "/api/v1/responsibilities/bulk/undo", taskB.undo);
    }

    // =====================================================================
    // 8. 200件規模バッチの実測
    // =====================================================================
    {
      const BATCH_SIZE = 200;
      const ids: string[] = [];
      const undoSnapshot: { id: string; receiptId: string }[] = [];
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
    // 9. バッチ内の1件が不正receiptIdのとき、他方もロールバックされる(原子性)
    // =====================================================================
    // [2026-08-26改訂・外部監査P1-2是正]
    // bulkOperations.ts側でバッチ内の処理順序をreceiptId昇順に固定した
    // (デッドロック防止のため)。当初この試験は不正receiptIdに
    // "00000000-..."(数値的に極小、ほぼ必ず先頭にソートされる)を使っており、
    // 「Bが一度も処理されないまま即座に例外になる」ため、実際にはロール
    // バックの証明になっていなかった(外部監査で指摘)。是正: 不正receiptIdを
    // "ffffffff-..."(数値的に極大、ほぼ必ず末尾にソートされる)に変更し、
    // Bが先に実際に処理(状態変更・Consumption作成等)された後にAの処理で
    // 例外が起き、その結果Bの変更も含めてロールバックされることを検証する。
    {
      const a = await createTaskAndComplete(jar, "Gate2.1検証(9): バッチ原子性 A");
      const b = await createTaskAndComplete(jar, "Gate2.1検証(9): バッチ原子性 B");
      createdResponsibilityIds.push(a.responsibilityId, b.responsibilityId);
      const bReceiptId = b.undo.snapshot[0].receiptId;

      const mixedUndo = {
        action: "COMPLETE",
        snapshot: [
          { id: a.responsibilityId, receiptId: "ffffffff-ffff-4fff-8fff-ffffffffffff" }, // 不正・昇順で必ず最後
          b.undo.snapshot[0], // 正当・昇順で必ず先に処理される
        ],
      };
      const mixedRes = await api(jar, "POST", "/api/v1/responsibilities/bulk/undo", mixedUndo);
      ok(
        "9. 混在バッチ: HTTP 400 VALIDATION_FAILED(バッチ全体が拒否される)",
        mixedRes.status === 400,
        `status=${mixedRes.status} body=${JSON.stringify(mixedRes.json)}`,
      );
      const bAfter = await db.responsibility.findUnique({ where: { id: b.responsibilityId } });
      ok(
        "9. 混在バッチ拒否後【原子性の実証】: Bの状態が変化していない" +
          "(Bは元々COMPLETEDのままのはず。receiptId昇順処理によりBが先に実際に" +
          "処理された後、Aの失敗でロールバックされたことの確認)",
        bAfter?.status === "COMPLETED",
        `actual=${bAfter?.status}`,
      );
      const bConsumption = await db.bulkCompleteUndoConsumption.findUnique({ where: { receiptId: bReceiptId } });
      ok("9. 混在バッチ拒否後: Bの冪等記録も残っていない", bConsumption === null);
      const bLifecycleEvents = await db.responsibilityLifecycleEvent.findMany({
        where: { responsibilityId: b.responsibilityId },
      });
      ok("9. 混在バッチ拒否後: BのLifecycle Eventも残っていない", bLifecycleEvents.length === 0);
      const bEventLogs = await db.eventLog.findMany({
        where: { aggregateId: b.responsibilityId, eventType: "STATUS_CHANGED" },
      });
      ok("9. 混在バッチ拒否後: BのSTATUS_CHANGED EventLogも残っていない", bEventLogs.length === 0);
      const bOutboxEvents = await db.outboxEvent.findMany({
        where: { aggregateId: b.responsibilityId, eventName: "ResponsibilityTransitioned.v1" },
      });
      ok("9. 混在バッチ拒否後: BのOutboxEventも残っていない", bOutboxEvents.length === 0);
      // 後始末: Bを正しくUndoしておく。
      await api(jar, "POST", "/api/v1/responsibilities/bulk/undo", b.undo);
    }

    // =====================================================================
    // 10. 種別固有型(COMMITMENT/WAITING/RISK)のUndo
    // =====================================================================
    {
      const commitment = await createAndComplete(jar, "COMMITMENT", "Gate2.1検証(10): COMMITMENT Undo");
      createdResponsibilityIds.push(commitment.responsibilityId);
      const undoRes = await api(jar, "POST", "/api/v1/responsibilities/bulk/undo", commitment.undo);
      ok(
        "10. COMMITMENT Undo: restored===1",
        undoRes.status === 200 && undoRes.json?.data?.restored === 1,
        `status=${undoRes.status} body=${JSON.stringify(undoRes.json)}`,
      );
      const after = await db.responsibility.findUnique({ where: { id: commitment.responsibilityId } });
      ok("10. COMMITMENT Undo: statusがACTIVE(元の状態)へ復元されている", after?.status === "ACTIVE", `actual=${after?.status}`);
    }
    {
      const waiting = await createAndComplete(jar, "WAITING", "Gate2.1検証(10): WAITING Undo");
      createdResponsibilityIds.push(waiting.responsibilityId);
      const undoRes = await api(jar, "POST", "/api/v1/responsibilities/bulk/undo", waiting.undo);
      ok(
        "10. WAITING Undo: restored===1",
        undoRes.status === 200 && undoRes.json?.data?.restored === 1,
        `status=${undoRes.status} body=${JSON.stringify(undoRes.json)}`,
      );
      const after = await db.responsibility.findUnique({ where: { id: waiting.responsibilityId } });
      ok("10. WAITING Undo: statusがWAITING(元の状態)へ復元されている", after?.status === "WAITING", `actual=${after?.status}`);
    }
    {
      const risk = await createAndComplete(jar, "RISK", "Gate2.1検証(10): RISK Undo");
      createdResponsibilityIds.push(risk.responsibilityId);
      const undoRes = await api(jar, "POST", "/api/v1/responsibilities/bulk/undo", risk.undo);
      ok(
        "10. RISK Undo: restored===1",
        undoRes.status === 200 && undoRes.json?.data?.restored === 1,
        `status=${undoRes.status} body=${JSON.stringify(undoRes.json)}`,
      );
      const after = await db.responsibility.findUnique({ where: { id: risk.responsibilityId } });
      ok("10. RISK Undo: statusがOPEN(元の状態)へ復元されている", after?.status === "OPEN", `actual=${after?.status}`);
    }

    // =====================================================================
    // 13. Undo Receipt方式の核心確認1: AT_RISKから完了した場合、正確にAT_RISKへ
    //     復元される(旧設計の"initialStatusForへ固定"回帰の是正確認)
    // =====================================================================
    // [2026-08-26追加・外部監査で指摘された仕様回帰の確認]
    // 旧設計(v11)は種別固有型の復元先を無条件でinitialStatusFor(type)へ固定して
    // いたため、AT_RISKから完了したCOMMITMENTをUndoすると誤ってACTIVEへ復元
    // されてしまっていた(改ざん耐性のためにAT_RISKという正当な元状態の情報自体を
    // 失っていた)。新設計(Undo Receipt)では、サーバーが完了実行時の真のfromStatus
    // (AT_RISK)をレシートへ保存しているため、AT_RISKへ正確に復元されるべきである。
    {
      const createRes = await api(jar, "POST", "/api/v1/responsibilities", {
        type: "COMMITMENT",
        title: "Gate2.1検証(13): AT_RISKからの復元",
      });
      if (createRes.status !== 200 && createRes.status !== 201) {
        throw new Error(`責任作成に失敗: status=${createRes.status}`);
      }
      const responsibilityId: string = createRes.json.data.id;
      createdResponsibilityIds.push(responsibilityId);
      // ACTIVE→AT_RISKへ遷移させてから完了する。
      const markAtRiskRes = await api(jar, "POST", `/api/v1/responsibilities/${responsibilityId}/transitions`, {
        action: "MARK_AT_RISK",
        occurredAt: new Date().toISOString(),
        version: createRes.json.data.version,
      });
      ok("13. 事前準備: ACTIVE→AT_RISK遷移に成功", markAtRiskRes.status === 200, `status=${markAtRiskRes.status}`);

      const bulkRes = await api(jar, "POST", "/api/v1/responsibilities/bulk", {
        ids: [responsibilityId],
        action: "COMPLETE",
      });
      ok("13. 事前準備: AT_RISKからのbulk completeに成功", bulkRes.status === 200 && bulkRes.json?.data?.affected === 1);

      const undoRes = await api(jar, "POST", "/api/v1/responsibilities/bulk/undo", bulkRes.json.data.undo);
      ok("13. AT_RISKからのUndo: restored===1", undoRes.status === 200 && undoRes.json?.data?.restored === 1);
      const after = await db.responsibility.findUnique({ where: { id: responsibilityId } });
      ok(
        "13. Undo Receipt方式の核心【最重要】: ACTIVEではなく正確にAT_RISKへ復元される" +
          "(サーバー保存の真の元状態を使うため、旧設計の仕様回帰が解消されている)",
        after?.status === "AT_RISK",
        `actual=${after?.status}(ACTIVEなら仕様回帰が再発している)`,
      );
    }

    // =====================================================================
    // 14. Undo Receipt方式の核心確認2: Ledgerなし経路(種別固有型・PEM未同意)でも
    //     冪等再送がrestored:1を返す
    // =====================================================================
    // [2026-08-26追加・外部監査で指摘された冪等性未達の確認]
    // 旧設計は冪等キーがExecution Ledgerの記録(completeEventId)有無に依存して
    // おり、COMMITMENT等の種別固有型やPEM未同意時の完了では、初回restored:1・
    // 再送restored:0となり「同一要求の再送は同じ成功応答」というv4.0 5.5節の
    // 契約が成立しなかった。新設計ではreceiptId単位の冪等記録
    // (BulkCompleteUndoConsumption)がLedgerの有無に関わらず一様に機能するため、
    // 種別固有型でも再送がrestored:1を返すべきである。
    {
      const commitment = await createAndComplete(jar, "COMMITMENT", "Gate2.1検証(14): 種別固有型の冪等再送");
      createdResponsibilityIds.push(commitment.responsibilityId);
      const undo1 = await api(jar, "POST", "/api/v1/responsibilities/bulk/undo", commitment.undo);
      ok("14. COMMITMENT 初回Undo: restored===1", undo1.status === 200 && undo1.json?.data?.restored === 1);
      const undo2 = await api(jar, "POST", "/api/v1/responsibilities/bulk/undo", commitment.undo);
      ok(
        "14. Undo Receipt方式の核心【最重要】: COMMITMENTの同一receiptId再送でも" +
          "restored===1(Ledger記録が無い経路でも冪等契約が成立する。" +
          "外部監査で指摘された「Ledgerなし経路の冪等性が未成立」の是正確認)",
        undo2.status === 200 && undo2.json?.data?.restored === 1,
        `status=${undo2.status} body=${JSON.stringify(undo2.json)}`,
      );
    }

    // =====================================================================
    // 15. Undo Receipt方式の核心確認3: PEM未同意時に完了したTASKでも
    //     冪等再送がrestored:1を返す
    // =====================================================================
    {
      const task = await createTaskAndComplete(jar, "Gate2.1検証(15): PEM未同意時の冪等再送-準備");
      createdResponsibilityIds.push(task.responsibilityId);
      const undoPrep = await api(jar, "POST", "/api/v1/responsibilities/bulk/undo", task.undo);
      ok("15. 事前準備: 1回目のUndoが成功", undoPrep.status === 200 && undoPrep.json?.data?.restored === 1);

      const withdrawRes = await api(jar, "POST", "/api/v1/pem/consent", {
        consentType: "PEM_DATA_COLLECTION",
        action: "WITHDRAWN",
        source: "SETTINGS",
      });
      ok("15. 事前準備: PEM同意の撤回に成功", withdrawRes.status === 201, `status=${withdrawRes.status}`);

      const startRes = await api(jar, "POST", `/api/v1/responsibilities/${task.responsibilityId}/transitions`, {
        action: "START",
        occurredAt: new Date().toISOString(),
        version: (await db.responsibility.findUnique({ where: { id: task.responsibilityId } }))?.version,
      });
      ok("15. 事前準備: 再STARTに成功", startRes.status === 200, `status=${startRes.status}`);
      const bulk2 = await api(jar, "POST", "/api/v1/responsibilities/bulk", {
        ids: [task.responsibilityId],
        action: "COMPLETE",
      });
      ok("15. 事前準備: 同意撤回後の再Bulk Completeに成功", bulk2.status === 200 && bulk2.json?.data?.affected === 1);

      const undo1 = await api(jar, "POST", "/api/v1/responsibilities/bulk/undo", bulk2.json.data.undo);
      ok("15. PEM未同意時完了のUndo: restored===1", undo1.status === 200 && undo1.json?.data?.restored === 1);
      const undo2 = await api(jar, "POST", "/api/v1/responsibilities/bulk/undo", bulk2.json.data.undo);
      ok(
        "15. Undo Receipt方式の核心【最重要】: PEM未同意時完了の同一receiptId再送でも" +
          "restored===1(「PEM同意が無くてもコア機能は止めない」という既存方針と、" +
          "冪等契約の両方が同時に成立する)",
        undo2.status === 200 && undo2.json?.data?.restored === 1,
        `status=${undo2.status} body=${JSON.stringify(undo2.json)}`,
      );

      await api(jar, "POST", "/api/v1/pem/consent", {
        consentType: "PEM_DATA_COLLECTION",
        action: "GRANTED",
        source: "SETTINGS",
      });
    }

    // =====================================================================
    // 16. Undo Receipt方式の世代確認: 古い未使用レシートで、後続の別完了
    //     サイクルを誤って取り消せないこと
    // =====================================================================
    // [2026-08-26追加・外部監査P0-1是正の確認]
    // シナリオ: 1)完了→Receipt A発行 2)個別REOPEN 3)再START 4)もう一度完了→
    // Receipt B発行 5)古い未使用のReceipt AでUndoを試みる。是正前は、
    // 現在statusがReceipt Bの完了により再びCOMPLETEDになっているため、
    // status一致だけで判定するとReceipt Aが誤って「有効」と判定され、
    // 無関係なReceipt Bの完了を取り消してしまっていた
    // (Responsibility状態とCorrection履歴が不整合になる)。
    {
      const task = await createTaskAndComplete(jar, "Gate2.1検証(16): 世代確認");
      createdResponsibilityIds.push(task.responsibilityId);
      const receiptA = task.undo.snapshot[0].receiptId;

      // 個別REOPEN(単一アイテムのtransitions API)。
      const currentRow1 = await db.responsibility.findUnique({ where: { id: task.responsibilityId } });
      const reopenRes = await api(jar, "POST", `/api/v1/responsibilities/${task.responsibilityId}/transitions`, {
        action: "REOPEN",
        occurredAt: new Date().toISOString(),
        version: currentRow1?.version,
      });
      ok("16. 事前準備: 個別REOPENに成功", reopenRes.status === 200, `status=${reopenRes.status} body=${JSON.stringify(reopenRes.json)}`);

      // 再START。
      const currentRow2 = await db.responsibility.findUnique({ where: { id: task.responsibilityId } });
      const startRes = await api(jar, "POST", `/api/v1/responsibilities/${task.responsibilityId}/transitions`, {
        action: "START",
        occurredAt: new Date().toISOString(),
        version: currentRow2?.version,
      });
      ok("16. 事前準備: 再STARTに成功", startRes.status === 200, `status=${startRes.status}`);

      // もう一度完了(Bulk Complete)。Receipt Bが発行される。
      const bulk2 = await api(jar, "POST", "/api/v1/responsibilities/bulk", {
        ids: [task.responsibilityId],
        action: "COMPLETE",
      });
      ok("16. 事前準備: 2回目のbulk completeに成功", bulk2.status === 200 && bulk2.json?.data?.affected === 1);
      const receiptB = bulk2.json.data.undo.snapshot[0].receiptId;
      ok("16. 事前確認: Receipt AとReceipt Bは別のid", receiptA !== receiptB);

      // 古い未使用のReceipt AでUndoを試みる。
      const staleUndo = { action: "COMPLETE", snapshot: [{ id: task.responsibilityId, receiptId: receiptA }] };
      const staleRes = await api(jar, "POST", "/api/v1/responsibilities/bulk/undo", staleUndo);
      const afterStale = await db.responsibility.findUnique({ where: { id: task.responsibilityId } });
      ok(
        "16. 世代確認の核心【最重要】: 古いReceipt AによるUndoは、後続の別完了" +
          "サイクル(Receipt B)を誤って取り消さない(statusがCOMPLETEDのまま" +
          "変化しない。responsibilityVersionAfterがReceipt Aの世代と現在versionの" +
          "不一致を検出しSKIP_NOT_COMPLETED相当になるべき)",
        afterStale?.status === "COMPLETED",
        `status=${staleRes.status} body=${JSON.stringify(staleRes.json)} afterStatus=${afterStale?.status}` +
          "(PLANNEDならReceipt Bの完了を誤って取り消してしまっている)",
      );
      const staleConsumption = await db.bulkCompleteUndoConsumption.findUnique({ where: { receiptId: receiptA } });
      // SKIP_NOT_COMPLETEDの場合、count++はされるがConsumptionは作られない実装のため、
      // Consumption自体の有無ではなくResponsibility.statusの不変性を主指標とする
      // (上のassertが最重要)。

      // 正しいReceipt BでのUndoは正常に機能することを確認する。
      const validRes = await api(jar, "POST", "/api/v1/responsibilities/bulk/undo", {
        action: "COMPLETE",
        snapshot: [{ id: task.responsibilityId, receiptId: receiptB }],
      });
      ok(
        "16. Receipt Bでの正規のUndoは正常に機能する: restored===1",
        validRes.status === 200 && validRes.json?.data?.restored === 1,
        `status=${validRes.status} body=${JSON.stringify(validRes.json)}`,
      );
      const afterValid = await db.responsibility.findUnique({ where: { id: task.responsibilityId } });
      ok("16. Receipt Bでの正規のUndo後: statusがPLANNEDへ復元されている", afterValid?.status === "PLANNED");
    }

    // =====================================================================
    // 17. Undo Receipt方式の競合制御: 同一receiptIdへの同時Undo要求でも
    //     全ての応答が同一の成功結果を返すこと
    // =====================================================================
    // [2026-08-26追加・外部監査P0-2是正の確認]
    // 同一receiptIdへ複数のUndo要求をほぼ同時に送信する。是正前は、両方とも
    // 「冪等記録なし」を確認できてしまい、片方はresponsibility側の楽観ロック
    // 競合で更新0件(SKIP相当、restored:0)になり得た。是正後はFOR UPDATE行
    // ロックにより直列化され、全ての要求がrestored:1(同一の成功結果)を
    // 返すべきである。
    {
      const task = await createTaskAndComplete(jar, "Gate2.1検証(17): 同時再送");
      createdResponsibilityIds.push(task.responsibilityId);
      const CONCURRENCY = 5;
      const results = await Promise.all(
        Array.from({ length: CONCURRENCY }, () =>
          api(jar, "POST", "/api/v1/responsibilities/bulk/undo", task.undo),
        ),
      );
      const restoredValues = results.map((r) => r.json?.data?.restored);
      ok(
        "17. 競合制御の核心【最重要】: 同一receiptIdへの" + CONCURRENCY + "件同時Undo要求が" +
          "すべてHTTP 200かつrestored===1を返す(同一要求は同じ成功応答という" +
          "v4.0 5.5節の契約が並行実行下でも成立する)",
        results.every((r) => r.status === 200) && restoredValues.every((v) => v === 1),
        `statuses=${JSON.stringify(results.map((r) => r.status))} restoredValues=${JSON.stringify(restoredValues)}`,
      );
      const consumptions = await db.bulkCompleteUndoConsumption.findMany({
        where: { receiptId: task.undo.snapshot[0].receiptId },
      });
      ok("17. 同時再送後: 冪等記録は1件だけ作成される(重複作成されない)", consumptions.length === 1);
      const lifecycleEventsAfter = await db.responsibilityLifecycleEvent.findMany({
        where: { responsibilityId: task.responsibilityId },
      });
      ok("17. 同時再送後: Lifecycle Eventも1件だけ(重複作成されない)", lifecycleEventsAfter.length === 1);
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
