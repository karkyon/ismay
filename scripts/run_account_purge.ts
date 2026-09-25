#!/usr/bin/env node
/**
 * scripts/run_account_purge.ts
 *
 * 30日Purge Jobの運用者向けCLI(唯一の実行経路)。
 *
 * [PURGE-SECURITY-02A・2026-09-20] HTTP経路(`/api/v1/admin/purge/*`)は、
 * 全テナント横断の操作を許可する「プラットフォーム管理者」契約が正本に無いため
 * fail closedのまま。サーバーへの直接アクセス権(このコマンドを実行できること)が
 * 実質的な認可境界になる。
 *
 * [PURGE-ELIGIBILITY-02C・2026-09-25] 一覧(findEligibleUsersForPurge)は対象選択の参考値。
 * 実削除はuserIdだけを渡し、transaction内でusers行lock・30日再検証・membership再取得を行う。
 *
 * [PURGE-AUDIT-02D・2026-09-25] 物理削除の成否と監査記録(AuditLog)の成否を分離。
 * 行為者はOS user・hostname・pid・run IDを自動記録し、--operatorは自己申告の補足。
 *
 * [PURGE-SCOPE-03A・2026-09-25] event_logs/outbox_events/jobs/consents/ai_runsは明示的scope列
 * (workspace_id)でPurge対象。FKで到達しない表は保持理由の登録(PURGE_RETENTION_POLICY)が
 * 必須で、未登録の表があればPurgeは実行を拒否する。
 *
 * [PURGE-OPS-03B・2026-09-25] 実行は運用台帳(purge_runs/purge_items/purge_item_objects)に
 * 記録し、DEC-PURGE-02B §7.1の順序(台帳snapshot→MinIO削除→不存在確認→DB物理削除→
 * 匿名化・監査記録→Run完了)で1ユーザーずつ処理する。batch size・lease・retry(指数backoff)・
 * dead-letter・中断再開(--resume)に対応し、dry-run manifestと実行manifestのdigestを台帳で対応付ける。
 *
 * exit code(bitmask、lib/admin/purgeReporting.ts PURGE_EXIT):
 *   0 = run内の全itemが完了し監査記録済み / 1 = 致命的エラー
 *   2 = 完了していないitemがある(SKIPPED・DEAD_LETTER・RETRY_WAIT等) / 4 = 監査記録未完了のitemがある
 *
 * 実行方法(dry-runのみ、既定。何も削除しない):
 *   cd ~/projects/ismay/app
 *   npx tsx ../scripts/run_account_purge.ts [--email=<address> | --all]
 *
 * 実削除(新しいrunを作成して処理):
 *   npx tsx ../scripts/run_account_purge.ts --execute --email=user@example.com --operator=karkyon
 *   npx tsx ../scripts/run_account_purge.ts --execute --all --batch-size=10 --max-attempts=5 --operator=karkyon
 *
 * 中断・retry待ちのrunを再開 / 状況表示:
 *   npx tsx ../scripts/run_account_purge.ts --resume=<runId> --operator=karkyon
 *   npx tsx ../scripts/run_account_purge.ts --status=<runId>
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline/promises";

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

const CONFIRM_TEXT = "物理削除";

interface CliArgs {
  execute: boolean;
  all: boolean;
  email: string | null;
  operator: string | null;
  resume: string | null;
  status: string | null;
  batchSize: number | null;
  maxAttempts: number | null;
}

function parsePositiveInt(raw: string, name: string): number {
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1) throw new Error(`${name} は1以上の整数で指定してください: ${raw}`);
  return n;
}

function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = { execute: false, all: false, email: null, operator: null, resume: null, status: null, batchSize: null, maxAttempts: null };
  for (const raw of argv) {
    if (raw === "--execute") args.execute = true;
    else if (raw === "--all") args.all = true;
    else if (raw.startsWith("--email=")) args.email = raw.slice("--email=".length);
    else if (raw.startsWith("--operator=")) args.operator = raw.slice("--operator=".length);
    else if (raw.startsWith("--resume=")) args.resume = raw.slice("--resume=".length);
    else if (raw.startsWith("--status=")) args.status = raw.slice("--status=".length);
    else if (raw.startsWith("--batch-size=")) args.batchSize = parsePositiveInt(raw.slice("--batch-size=".length), "--batch-size");
    else if (raw.startsWith("--max-attempts=")) args.maxAttempts = parsePositiveInt(raw.slice("--max-attempts=".length), "--max-attempts");
    else {
      throw new Error(
        `未知の引数です: ${raw}(使用可能: --execute, --all, --email=<address>, --operator=<name>, --resume=<runId>, --status=<runId>, --batch-size=<n>, --max-attempts=<n>)`,
      );
    }
  }
  if (args.all && args.email) throw new Error("--all と --email は同時に指定できません。");
  const modes = [args.execute, args.resume !== null, args.status !== null].filter(Boolean).length;
  if (modes > 1) throw new Error("--execute / --resume / --status は同時に指定できません。");
  return args;
}

async function confirm(message: string): Promise<boolean> {
  console.log(message);
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const answer = await rl.question(`続行するには "${CONFIRM_TEXT}" と正確に入力してEnterを押してください: `);
  rl.close();
  return answer === CONFIRM_TEXT;
}

async function main(): Promise<number> {
  const args = parseArgs(process.argv.slice(2));

  const { db } = await import("../app/src/lib/db");
  const { findEligibleUsersForPurge, dryRunPurgeForUser, countLegacyUnscopedRows, PURGE_RETENTION_POLICY } = await import("../app/src/lib/admin/purgeJob");
  const { collectPurgeRunContext } = await import("../app/src/lib/admin/purgeRunner");
  const { maskEmail, PURGE_EXIT } = await import("../app/src/lib/admin/purgeReporting");
  const { createPurgeRun, processPurgeRun, getPurgeRunSummary } = await import("../app/src/lib/admin/purgeLedger");
  const { workspaceObjectPrefix } = await import("../app/src/lib/admin/purgeObjects");
  const { createMinioPurgeObjectStore } = await import("../app/src/lib/storage");
  type Summary = Awaited<ReturnType<typeof getPurgeRunSummary>>;

  const printSummary = async (summary: Summary): Promise<void> => {
    console.log(`\n=== run ${summary.runId}: ${summary.runStatus} ===`);
    console.log(`  plan digest: ${summary.planDigest}`);
    console.log(`  status別: ${JSON.stringify(summary.byStatus)}  phase別: ${JSON.stringify(summary.byPhase)}`);
    console.log(`  不存在確認済みobject: ${summary.objectsVerifiedAbsent}件  完了後に回収した遅延object: ${summary.lateObjectsDeleted}件`);
    console.log(`  dry-runから差分のあったitem: ${summary.driftItems}件  監査記録未完了: ${summary.auditPending}件`);
    const items = await db.purgeItem.findMany({ where: { runId: summary.runId }, orderBy: { createdAt: "asc" } });
    for (const i of items) {
      const extra = [
        i.refusalStatus ? `refusal=${i.refusalStatus}` : null,
        i.lastError ? `lastError=${i.lastError.slice(0, 160)}` : null,
        i.auditError ? `auditError=${i.auditError.slice(0, 160)}` : null,
        i.nextAttemptAt ? `next=${i.nextAttemptAt.toISOString()}` : null,
      ]
        .filter(Boolean)
        .join(" ");
      console.log(`  - item=${i.id} userId=${i.userId} ${i.status}/${i.phase} attempts=${i.attempts}/${i.maxAttempts} audit=${i.auditRecorded ? "ok" : "未"} ${extra}`);
    }
    if (summary.auditPending > 0) console.error(`[運用警告] 監査記録未完了のitemが${summary.auditPending}件あります。--resume=${summary.runId} で再試行してください。`);
    console.log(`exit code=${summary.exitCode}`);
  };
  const logItem = (r: { status: string; phase: string; detail: string | null }, userId: string): void => {
    console.log(`  ${r.status}/${r.phase} userId=${userId} ${r.detail ?? ""}`);
  };

  try {
    const context = collectPurgeRunContext(args.operator);

    if (args.status) {
      const summary = await getPurgeRunSummary(args.status);
      await printSummary(summary);
      return summary.exitCode;
    }

    const store = createMinioPurgeObjectStore();

    if (args.resume) {
      await printSummary(await getPurgeRunSummary(args.resume));
      if (!(await confirm(`\n⚠️ run ${args.resume} の未完了itemを再開します(不可逆な物理削除を含みます)。`))) {
        console.log("[中止] 確認文字列が一致しなかったため、何もせずに終了します。");
        return PURGE_EXIT.OK;
      }
      const summary = await processPurgeRun({ runId: args.resume, store, context: { ...context, runId: args.resume }, onItem: logItem });
      await printSummary(summary);
      return summary.exitCode;
    }

    console.log("=== 30日Purge 運用者CLI ===");
    console.log(`モード: ${args.execute ? "EXECUTE(実削除)" : "DRY-RUN(何も削除しません)"}`);
    console.log(`run=${context.runId} osUser=${context.osUser} host=${context.hostname} pid=${context.pid} operator(自己申告)=${context.operatorDeclared ?? "-"}`);

    let eligible = await findEligibleUsersForPurge();
    console.log(`\n対象候補(deletedAtから30日以上経過・一覧時点の参考値): ${eligible.length}件`);
    if (args.email) {
      eligible = eligible.filter((e) => e.email === args.email);
      if (eligible.length === 0) {
        console.log(`[終了] 指定email(${maskEmail(args.email)})に一致する対象候補がありません(30日未満、または既にPurge済みの可能性)。`);
        return PURGE_EXIT.OK;
      }
    } else if (!args.all) {
      if (eligible.length > 1) console.log("[注意] --email/--all未指定のため、最初の1件のみを対象にします。");
      eligible = eligible.slice(0, 1);
    }
    if (eligible.length === 0) {
      console.log("[終了] 対象候補がいません。");
      return PURGE_EXIT.OK;
    }

    console.log(`\n--- dry-run(transaction内で計画しrollback): ${eligible.length}件 ---`);
    let retainedTables: string[] = [];
    for (const target of eligible) {
      const plan = await dryRunPurgeForUser({ userId: target.userId });
      console.log(`\n  userId=${target.userId} email=${maskEmail(target.email)}`);
      if (plan.status !== "ELIGIBLE") {
        console.log(`    [削除されません] status=${plan.status} ${plan.detail}`);
        continue;
      }
      const m = plan.manifest;
      retainedTables = m.retainedUnscopedTables;
      console.log(`    deletedAt=${m.deletedAt} workspace数=${m.workspaceIds.length} digest=${m.digest}`);
      console.log(
        `    削除見込み: 合計${m.totals.rowsDeleted}行(表=${m.totals.rowsDeleted - m.workspaceRowsDeleted - m.userRowsDeleted} workspace=${m.workspaceRowsDeleted} user=${m.userRowsDeleted}) / 更新見込み: ${m.totals.rowsUpdated}行`,
      );
      for (const t of m.perTable) if (t.count > 0) console.log(`      削除 ${t.tableName}: ${t.count}件`);
      for (const u of m.cycleBreakUpdates) console.log(`      循環遮断NULL化 ${u.tableName}(${u.columnNames.join(",")}): ${u.count}件`);
      for (const u of m.anonymizedReferences) console.log(`      匿名化(参照NULL化・行は保持) ${u.tableName}(${u.columnNames.join(",")}): ${u.count}件`);
      for (const u of m.redactedRetainedRows) console.log(`      保持表の墨消し ${u.tableName}(${u.columnNames.join(",")}): ${u.count}件`);
      try {
        const listed = new Set<string>();
        for (const ws of m.workspaceIds) for (const k of await store.list(workspaceObjectPrefix(ws))) listed.add(k);
        const union = new Set([...plan.dbObjectKeys, ...listed]);
        console.log(`    Object Storage(${store.bucket}): 削除見込み${union.size}件(DB参照${plan.dbObjectKeys.length}件・接頭辞一覧${listed.size}件)`);
      } catch (err) {
        console.log(`    Object Storage: 確認できません(${err instanceof Error ? err.message : String(err)})。実行時はobject削除と不存在確認ができるまでDB削除へ進みません。`);
      }
    }
    if (retainedTables.length > 0) {
      console.log(`\n[保持表] 次の表は行を保持します(保持理由はPURGE_RETENTION_POLICY):`);
      for (const t of retainedTables) console.log(`  - ${t}: ${PURGE_RETENTION_POLICY[t] ?? "(未登録)"}`);
    }
    const legacy = (await countLegacyUnscopedRows()).filter((l) => l.count > 0);
    if (legacy.length > 0) {
      console.log(
        `[注意・PURGE-SCOPE-03A] 明示的scope列がNULLの旧行(migration時に集約を解決できなかった孤立行。どのユーザーのPurgeでも削除されません): ${legacy.map((l) => `${l.tableName}=${l.count}件`).join(", ")}`,
      );
    }

    if (!args.execute) {
      console.log("\n[終了] dry-runのみのため何も削除していません。実削除するには --execute を指定してください。");
      return PURGE_EXIT.OK;
    }

    if (
      !(await confirm(
        `\n⚠️ これは不可逆な物理削除です。上記${eligible.length}件について新しいrunを作成し、Object Storage→DBの順に削除します(実行時にtransaction内で再検証し、条件を満たさない対象は削除しません)。`,
      ))
    ) {
      console.log("[中止] 確認文字列が一致しなかったため、何も削除せずに終了します。");
      return PURGE_EXIT.OK;
    }

    const runId = await createPurgeRun({
      userIds: eligible.map((e) => e.userId),
      context,
      batchSize: args.batchSize ?? undefined,
      maxAttempts: args.maxAttempts ?? undefined,
    });
    console.log(`\n--- run ${runId} を作成しました。処理中 ---`);
    const summary = await processPurgeRun({ runId, store, context, onItem: logItem });
    await printSummary(summary);
    if (summary.byStatus["RETRY_WAIT"] || summary.byStatus["PENDING"]) {
      console.log(`[再開] 未完了のitemがあります。時間をおいて --resume=${runId} で再開してください。`);
    }
    return summary.exitCode;
  } finally {
    await db.$disconnect();
  }
}

main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((err) => {
    console.error("[FATAL]", err instanceof Error ? err.message : String(err));
    process.exitCode = 1;
  });
