#!/usr/bin/env node
/**
 * scripts/run_account_purge.ts
 *
 * PATTERN-PURGE-01(30日Purge Job)の運用者向けCLI実行ツール。
 *
 * [PURGE-SECURITY-02A・2026-09-20新設] 実DB再監査(2026-09-19)で、
 * `POST /api/v1/admin/purge/dry-run`・`POST /api/v1/admin/purge/execute`の
 * 2つのHTTP経路が、呼出者の既定WorkspaceでのOWNER/ADMIN確認しか行わず、
 * 削除対象自体はworkspace条件なしで全テナントから列挙していたことが判明
 * した(P0)。`WorkspaceMember.role`は単一Workspace内のMOD-10 Admin向けに
 * 設計されたものであり、全テナント横断の操作を許可する「プラットフォーム
 * 管理者」という概念はこのコードベース・正本のどこにも定義されていない
 * (調査済み・想像で発明しない)。
 *
 * 正本側でプラットフォーム管理者ロールの契約(Decision Record)が確定する
 * までの間、2つのHTTP経路はfail closedにした(該当route.ts参照)。この
 * CLIはその代替であり、サーバーへの直接アクセス権を持つ運用者
 * (`~/projects/ismay`のデプロイ環境で直接実行できる者)だけが実行できる
 * ことを前提とする——アプリケーションのHTTP認可層を経由しないため、
 * 「誰がこのマシン上でこのコマンドを打てるか」という運用上の境界が
 * 実質的な認可境界になる。
 *
 * [PURGE-EXECUTION-02D・dry-runとexecuteの結び付け] HTTP版が抱えていた
 * 「dry-run表示後、実行までの間に対象集合が変わりうる」問題を、同一
 * プロセス内で findEligibleUsersForPurge() を1度だけ呼び出し、その
 * スナップショットに対してdry-run表示→確認→実行を連続実行することで
 * 解消する(2回目の問い合わせをしない)。
 *
 * [安全策]
 *   - 既定は dry-run のみ(何も削除しない)。実削除には明示的に
 *     `--execute` フラグが必要。
 *   - `--execute` 指定時は、対象が1件以上ある限り必ず対話的に確認文字列
 *     「完全削除」の入力を要求する(既存account/delete/route.tsの「削除」
 *     確認・旧execute/route.tsのconfirmTextと同じ方針)。
 *   - `--execute` には `--operator=<名前>` の指定も必須とする(このCLIには
 *     認証ユーザーが存在しないため、AuditLogのreasonへ運用者名を記録し
 *     行為者追跡性を確保する)。
 *   - 既定では最初の対象1件のみを処理する(誤操作時の被害を最小化する)。
 *     全対象を一括処理するには明示的に `--all` を追加すること。
 *   - `--email=<address>` で特定の1ユーザーのみを対象にできる(通常の
 *     運用ではこちらを推奨する)。
 *
 * 実行方法(dry-runのみ、既定):
 *   cd ~/projects/ismay/app
 *   npx tsx ../scripts/run_account_purge.ts
 *
 * 実行方法(特定の1ユーザーを実削除):
 *   npx tsx ../scripts/run_account_purge.ts --execute --operator=karkyon --email=user@example.com
 *
 * 実行方法(対象全員を実削除・通常は非推奨、緊急時のみ):
 *   npx tsx ../scripts/run_account_purge.ts --execute --operator=karkyon --all
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
  return args;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

  if (args.execute && !args.operator) {
    throw new Error("--execute には --operator=<名前> の指定が必須です(AuditLogへの行為者記録のため)。");
  }
  if (!args.all && !args.email && args.execute) {
    console.log(
      "[注意] --email を指定していないため、対象は最初の1件のみに限定します(--allで全件対象にできます)。",
    );
  }

  const { db } = await import("../app/src/lib/db");
  const { findEligibleUsersForPurge, dryRunPurgeForUser, executePurgeForUser } = await import(
    "../app/src/lib/admin/purgeJob"
  );

  console.log("=== PATTERN-PURGE-01 運用者CLI ===");
  console.log(`モード: ${args.execute ? "EXECUTE(実削除)" : "DRY-RUN(何も削除しません)"}`);

  let eligible = await findEligibleUsersForPurge();
  console.log(`\n対象(deletedAtから30日以上経過)ユーザー: ${eligible.length}件`);

  if (args.email) {
    eligible = eligible.filter((e) => e.email === args.email);
    if (eligible.length === 0) {
      console.log(`[終了] --email=${args.email} に一致する対象ユーザーが見つかりません(30日未満、または既にPurge済みの可能性があります)。`);
      await db.$disconnect();
      return;
    }
  } else if (!args.all) {
    eligible = eligible.slice(0, 1);
  }

  if (eligible.length === 0) {
    console.log("[終了] 対象ユーザーがいません。");
    await db.$disconnect();
    return;
  }

  console.log(`\n--- dry-run: これから${eligible.length}件を処理します ---`);
  const dryRuns: { target: (typeof eligible)[number]; perTable: Awaited<ReturnType<typeof dryRunPurgeForUser>>; totalRows: number }[] = [];
  for (const target of eligible) {
    const perTable = await dryRunPurgeForUser(target);
    const totalRows = perTable.reduce((sum, t) => sum + t.count, 0);
    dryRuns.push({ target, perTable, totalRows });
    console.log(`\n  userId=${target.userId} email=${target.email} deletedAt=${target.deletedAt.toISOString()}`);
    console.log(`    workspace数=${target.workspaceIds.length} 削除見込み合計行数=${totalRows}`);
    for (const t of perTable) {
      if (t.count > 0) console.log(`      ${t.tableName}: ${t.count}件`);
    }
  }

  if (!args.execute) {
    console.log("\n[終了] dry-runのみのため何も削除していません。実削除するには --execute --operator=<名前> を指定してください。");
    await db.$disconnect();
    return;
  }

  console.log(`\n⚠️ これは不可逆な物理削除です。上記${eligible.length}件を本当に削除しますか?`);
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const answer = await rl.question('続行するには "完全削除" と正確に入力してEnterを押してください: ');
  rl.close();
  if (answer !== "完全削除") {
    console.log("[中止] 確認文字列が一致しなかったため、何も削除せずに終了します。");
    await db.$disconnect();
    return;
  }

  console.log("\n--- 実行中 ---");
  let succeeded = 0;
  let failed = 0;
  for (const { target, totalRows } of dryRuns) {
    try {
      const result = await executePurgeForUser(target);
      succeeded++;
      console.log(`  ok - userId=${target.userId} email=${target.email} 削除行数=${result.totalRowsDeleted}(dry-run見込み=${totalRows})`);
      await db.auditLog.create({
        data: {
          actorUserId: null,
          actorType: "SYSTEM",
          action: "ACCOUNT_PURGE_EXECUTED",
          targetType: "User",
          targetId: target.userId,
          result: "SUCCESS",
          reason: `CLI実行(operator=${args.operator}) totalRowsDeleted=${result.totalRowsDeleted}`,
        },
      });
    } catch (err) {
      failed++;
      const message = err instanceof Error ? err.message : String(err);
      console.log(`  NG - userId=${target.userId} email=${target.email} エラー: ${message}`);
      await db.auditLog.create({
        data: {
          actorUserId: null,
          actorType: "SYSTEM",
          action: "ACCOUNT_PURGE_EXECUTED",
          targetType: "User",
          targetId: target.userId,
          result: "FAILURE",
          reason: `CLI実行(operator=${args.operator}) ${message.slice(0, 400)}`,
        },
      });
    }
  }

  console.log(`\n=== 結果: ${succeeded}件成功 / ${failed}件失敗 ===`);
  await db.$disconnect();
}

main().catch((err) => {
  console.error("[FATAL]", err instanceof Error ? err.message : String(err));
  process.exit(1);
});
