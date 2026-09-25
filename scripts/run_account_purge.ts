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
 * [PURGE-ELIGIBILITY-02C・2026-09-25] 旧版は対象一覧(JS配列)をdry-run表示と
 * 実削除で使い回し、それを「同一スナップショット」と呼んでいたが、DBの
 * snapshotではなかった(確認待ちの間に復元・membership変更があっても古い配列の
 * まま削除し得た)。以後、一覧(findEligibleUsersForPurge)は対象選択の参考値に
 * すぎず、実削除はuserIdだけを渡し、executePurgeForUserがtransaction内で
 * users行lock・30日再検証・membership再取得を行う。dry-runのmanifestは参考値
 * として渡し、実値との差分(drift)とdigestを結果・AuditLogへ記録する。
 *
 * [PURGE-AUDIT-02D・2026-09-25] 物理削除の成否と監査記録(AuditLog)の成否を
 * 分離した(lib/admin/purgeRunner.ts)。AuditLog書込み失敗で完了済みの削除を
 * 「失敗」と数えない。行為者はOS user・hostname・pid・run IDを自動記録し、
 * --operatorは自己申告の補足情報とする。画面出力のemailはmaskする。
 *
 * exit code(bitmask、lib/admin/purgeReporting.ts PURGE_EXIT):
 *   0 = 全件の削除と監査記録が成功 / 1 = 致命的エラー
 *   2 = 1件以上が削除されなかった / 4 = 1件以上で監査記録に失敗 / 6 = 2と4の両方
 *
 * [安全策]
 *   - 既定はdry-runのみ(何も削除しない)。実削除には`--execute`が必要。
 *   - `--execute`時は対話的に確認文字列「物理削除」の入力を要求する。
 *   - 既定では最初の対象1件のみ。全件は`--all`、特定ユーザーは`--email=<address>`。
 *
 * [DEC-PURGE-02B・未決] FKで削除対象へ到達しない表(consents/event_logs/jobs/
 * outbox_events/audit_logs等)は現時点でPurgeの対象外であり、dry-run/実行結果に
 * 「保持表」として表示する(削除・匿名化・法定保持の契約は
 * docs/decisions/DEC-PURGE-02B.md で決定待ち)。
 *
 * 実行方法(dry-runのみ、既定):
 *   cd ~/projects/ismay/app
 *   npx tsx ../scripts/run_account_purge.ts
 *
 * 実行方法(特定の1ユーザーを実削除):
 *   npx tsx ../scripts/run_account_purge.ts --execute --email=user@example.com --operator=karkyon
 *
 * 実行方法(対象全員を実削除・通常は非推奨):
 *   npx tsx ../scripts/run_account_purge.ts --execute --all --operator=karkyon
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
}

function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = { execute: false, all: false, email: null, operator: null };
  for (const raw of argv) {
    if (raw === "--execute") args.execute = true;
    else if (raw === "--all") args.all = true;
    else if (raw.startsWith("--email=")) args.email = raw.slice("--email=".length);
    else if (raw.startsWith("--operator=")) args.operator = raw.slice("--operator=".length);
    else {
      throw new Error(`未知の引数です: ${raw}(使用可能: --execute, --all, --email=<address>, --operator=<name>)`);
    }
  }
  if (args.all && args.email) throw new Error("--all と --email は同時に指定できません。");
  return args;
}

async function main(): Promise<number> {
  const args = parseArgs(process.argv.slice(2));

  const { db } = await import("../app/src/lib/db");
  const { findEligibleUsersForPurge, dryRunPurgeForUser } = await import("../app/src/lib/admin/purgeJob");
  const { collectPurgeRunContext, runPurgeItem } = await import("../app/src/lib/admin/purgeRunner");
  const { maskEmail, summarizePurgeOutcomes, PURGE_EXIT } = await import("../app/src/lib/admin/purgeReporting");
  type Manifest = import("../app/src/lib/admin/purgeJob").PurgeManifest;
  type Outcome = import("../app/src/lib/admin/purgeReporting").PurgeItemOutcome;

  try {
    const context = collectPurgeRunContext(args.operator);
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
    const expectedByUser = new Map<string, Manifest>();
    let retainedTables: string[] = [];
    for (const target of eligible) {
      const plan = await dryRunPurgeForUser({ userId: target.userId });
      console.log(`\n  userId=${target.userId} email=${maskEmail(target.email)}`);
      if (plan.status !== "ELIGIBLE") {
        console.log(`    [削除されません] status=${plan.status} ${plan.detail}`);
        continue;
      }
      const m = plan.manifest;
      expectedByUser.set(target.userId, m);
      retainedTables = m.retainedUnscopedTables;
      console.log(`    deletedAt=${m.deletedAt} workspace数=${m.workspaceIds.length} digest=${m.digest}`);
      console.log(
        `    削除見込み: 合計${m.totals.rowsDeleted}行(表=${m.totals.rowsDeleted - m.workspaceRowsDeleted - m.userRowsDeleted} workspace=${m.workspaceRowsDeleted} user=${m.userRowsDeleted}) / 更新見込み: ${m.totals.rowsUpdated}行`,
      );
      for (const t of m.perTable) if (t.count > 0) console.log(`      削除 ${t.tableName}: ${t.count}件`);
      for (const u of m.cycleBreakUpdates) console.log(`      循環遮断NULL化 ${u.tableName}(${u.columnNames.join(",")}): ${u.count}件`);
      for (const u of m.anonymizedReferences) console.log(`      匿名化(参照NULL化・行は保持) ${u.tableName}(${u.columnNames.join(",")}): ${u.count}件`);
    }
    if (retainedTables.length > 0) {
      console.log(
        `\n[注意・DEC-PURGE-02B未決] 次の表はFKで削除対象へ到達しないためPurgeでは触れません(個人識別子・payloadが残り得る): ${retainedTables.join(", ")}`,
      );
    }

    if (!args.execute) {
      console.log("\n[終了] dry-runのみのため何も削除していません。実削除するには --execute を指定してください。");
      return PURGE_EXIT.OK;
    }

    console.log(`\n⚠️ これは不可逆な物理削除です。上記${eligible.length}件を削除しますか?(実行時にtransaction内で再検証し、条件を満たさない対象は削除しません)`);
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    const answer = await rl.question(`続行するには "${CONFIRM_TEXT}" と正確に入力してEnterを押してください: `);
    rl.close();
    if (answer !== CONFIRM_TEXT) {
      console.log("[中止] 確認文字列が一致しなかったため、何も削除せずに終了します。");
      return PURGE_EXIT.OK;
    }

    console.log("\n--- 実行中 ---");
    const outcomes: Outcome[] = [];
    for (const target of eligible) {
      const outcome = await runPurgeItem({ userId: target.userId, context, expected: expectedByUser.get(target.userId) ?? null });
      outcomes.push(outcome);
      const label = `userId=${target.userId} email=${maskEmail(target.email)}`;
      if (outcome.purgeSucceeded) {
        console.log(
          `  削除成功 - ${label} 削除=${outcome.totals?.rowsDeleted}行 更新=${outcome.totals?.rowsUpdated}行 drift=${outcome.driftCount ?? "-"} digest=${outcome.digest}`,
        );
        if ((outcome.driftCount ?? 0) > 0) console.log("    [注意] dry-run時点から件数・対象が変化していました(実行時の実値で削除済み)。");
      } else {
        console.log(`  削除せず - ${label} status=${outcome.purgeStatus} ${outcome.detail ?? ""}`);
      }
      if (!outcome.auditRecorded) {
        console.error(
          `  [監査記録失敗] ${label} 削除結果=${outcome.purgeSucceeded ? "削除済み" : "未削除"}(監査記録の失敗は削除結果を変えません) error=${outcome.auditError}`,
        );
      }
    }

    const summary = summarizePurgeOutcomes(outcomes);
    console.log(`\n=== 結果: 削除成功 ${summary.purged}件 / 削除せず ${summary.notPurged}件 / 監査記録失敗 ${summary.auditFailed}件 ===`);
    if (summary.notPurged > 0) console.log(`  削除せずの内訳: ${JSON.stringify(summary.notPurgedByStatus)}`);
    if (summary.auditFailed > 0) {
      console.error(`[運用警告] ${summary.auditFailed}件で監査記録(AuditLog)に失敗しました。run=${context.runId} の出力を保全し、手動で記録してください。`);
    }
    console.log(`exit code=${summary.exitCode}`);
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
