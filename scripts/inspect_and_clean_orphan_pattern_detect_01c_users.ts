#!/usr/bin/env node
/**
 * scripts/inspect_and_clean_orphan_pattern_detect_01c_users.ts
 *
 * verify_gate_pattern_detect_01c.ts (v2/v3) が"16 passed, 1 failed,
 * remaining=1"で終わった際の残存原因調査・除去専用ツール。
 *
 * [背景] v4のverify scriptで全てのcleanup呼び出しに無条件診断ログを
 * 追加したところ、v4自身が今回新規作成した6件のfixtureは全て
 * 「解決したworkspaceId: あり」「cleanupFormationVerifyUser errors=0」
 * 「1回目試行後の残存: なし」と完全に正常終了していたにも関わらず、
 * 最終チェックで remaining=1 が報告された。これは残存の原因が今回作成した
 * fixtureではなく、それ以前の失敗run(v2またはv3)で作成されたまま残った
 * 孤立ユーザーである可能性が高い。verify script全体(100件のFormation
 * materializeを含む重いテスト)を再実行せずに、この孤立ユーザーだけを
 * 特定・診断・除去するための専用スクリプト。
 *
 * 実行方法:
 *   cd ~/projects/ismay/app
 *   npx tsx ../scripts/inspect_and_clean_orphan_pattern_detect_01c_users.ts
 *
 * このスクリプトは「gate-pattern-detect-01c-verify-」prefixのUserだけを
 * 対象とし、それ以外のデータには一切触れない。
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

const EMAIL_PREFIX = "gate-pattern-detect-01c-verify-";

async function main(): Promise<void> {
  const { db } = await import("../app/src/lib/db");
  const { cleanupFormationVerifyUser } = await import("./lib/formationVerifyCleanup");

  const orphans = await db.user.findMany({
    where: { email: { startsWith: EMAIL_PREFIX, endsWith: "@example.invalid" } },
    select: { id: true, email: true, createdAt: true },
  });

  console.log(`=== 対象prefix (${EMAIL_PREFIX}) のUser: ${orphans.length}件 ===`);
  for (const o of orphans) {
    console.log(`  - ${o.id} : ${o.email} (createdAt=${o.createdAt.toISOString()})`);
  }
  if (orphans.length === 0) {
    console.log("対象なし。既にクリーンです。");
    return;
  }

  for (const o of orphans) {
    const userId = o.id;
    console.log(`\n--- userId=${userId} (${o.email}) の全面診断 ---`);

    // ステップ1: workspaceId解決を全経路で試す(どこで見つかるか/見つからないかを個別に出す)。
    const membership = await db.workspaceMember.findFirst({ where: { userId }, select: { workspaceId: true } }).catch((e) => {
      console.log(`  workspaceMember.findFirst 例外: ${String(e)}`);
      return null;
    });
    console.log(`  workspaceMember経由: ${membership?.workspaceId ?? "(見つからず)"}`);

    const ctxOwned = await db.projectContext.findFirst({ where: { ownerSubjectUserId: userId }, select: { workspaceId: true } }).catch((e) => {
      console.log(`  projectContext.findFirst 例外: ${String(e)}`);
      return null;
    });
    console.log(`  projectContext(owner)経由: ${ctxOwned?.workspaceId ?? "(見つからず)"}`);

    const patOwned = await db.casePattern.findFirst({ where: { ownerSubjectUserId: userId }, select: { workspaceId: true } }).catch((e) => {
      console.log(`  casePattern.findFirst 例外: ${String(e)}`);
      return null;
    });
    console.log(`  casePattern(owner)経由: ${patOwned?.workspaceId ?? "(見つからず)"}`);

    const capByCreator = await db.capture.findFirst({ where: { createdById: userId }, select: { workspaceId: true } }).catch((e) => {
      console.log(`  capture.findFirst 例外: ${String(e)}`);
      return null;
    });
    console.log(`  capture(createdBy)経由: ${capByCreator?.workspaceId ?? "(見つからず)"}`);

    const workspaceId = membership?.workspaceId ?? ctxOwned?.workspaceId ?? patOwned?.workspaceId ?? capByCreator?.workspaceId ?? null;
    console.log(`  => 最終的に解決したworkspaceId: ${workspaceId ?? "(全経路で見つからず)"}`);

    // ステップ2: 実際に何件残っているかを、workspaceId有無それぞれの角度で数える。
    const counts: Record<string, number> = {
      "projectContext(byOwner)": await db.projectContext.count({ where: { ownerSubjectUserId: userId } }).catch(() => -1),
      "casePattern(byOwner)": await db.casePattern.count({ where: { ownerSubjectUserId: userId } }).catch(() => -1),
      "capture(byCreator)": await db.capture.count({ where: { createdById: userId } }).catch(() => -1),
      "workspaceMember(byUser)": await db.workspaceMember.count({ where: { userId } }).catch(() => -1),
    };
    if (workspaceId) {
      counts["projectContext(byWorkspace)"] = await db.projectContext.count({ where: { workspaceId } }).catch(() => -1);
      counts["casePattern(byWorkspace)"] = await db.casePattern.count({ where: { workspaceId } }).catch(() => -1);
      counts["casePatternSourceLink(byWorkspace)"] = await db.casePatternSourceLink.count({ where: { workspaceId } }).catch(() => -1);
      counts["responsibility(byWorkspace)"] = await db.responsibility.count({ where: { workspaceId } }).catch(() => -1);
      counts["formationSession(byWorkspace)"] = await db.formationSession.count({ where: { workspaceId } }).catch(() => -1);
      counts["workspace exists"] = (await db.workspace.findUnique({ where: { id: workspaceId }, select: { id: true } }).catch(() => null)) ? 1 : 0;
    }
    console.log(`  残存件数: ${JSON.stringify(counts)}`);

    // ステップ3: 実際にcleanupを試み、cleanupFormationVerifyUserが返す個別errorsを
    // 一切握りつぶさずすべて表示する(これが今まで一度も表示されていなかった核心)。
    if (workspaceId) {
      await db.casePatternSourceLink.deleteMany({ where: { workspaceId } }).catch((e) => console.log(`  [削除失敗] casePatternSourceLink(byWorkspace): ${String(e)}`));
      await db.casePatternEvidenceAggregate.deleteMany({ where: { workspaceId } }).catch((e) => console.log(`  [削除失敗] casePatternEvidenceAggregate: ${String(e)}`));
      await db.casePatternEmbedding.deleteMany({ where: { workspaceId } }).catch((e) => console.log(`  [削除失敗] casePatternEmbedding: ${String(e)}`));
      await db.casePatternFeedbackEvent.deleteMany({ where: { workspaceId } }).catch((e) => console.log(`  [削除失敗] casePatternFeedbackEvent: ${String(e)}`));
      await db.casePatternRevision.deleteMany({ where: { workspaceId } }).catch((e) => console.log(`  [削除失敗] casePatternRevision: ${String(e)}`));
      await db.casePattern.deleteMany({ where: { workspaceId } }).catch((e) => console.log(`  [削除失敗] casePattern: ${String(e)}`));
    }
    const ownedContexts = await db.projectContext.findMany({ where: { ownerSubjectUserId: userId }, select: { id: true } }).catch(() => []);
    const contextIds = ownedContexts.map((c) => c.id);
    if (contextIds.length > 0) {
      await db.casePatternSourceLink.deleteMany({ where: { contextId: { in: contextIds } } }).catch((e) => console.log(`  [削除失敗] casePatternSourceLink(byContext): ${String(e)}`));
    }

    console.log("  cleanupFormationVerifyUser 呼び出し中...");
    const result = await cleanupFormationVerifyUser(db, userId);
    console.log(`  cleanupFormationVerifyUser errors=${result.errors.length}`);
    for (const e of result.errors) {
      console.log(`    [step失敗] ${e.step}`);
      console.log(`      ${String(e.error)}`);
      if (e.error instanceof Error && e.error.stack) {
        console.log(`      stack: ${e.error.stack.split("\n").slice(0, 3).join(" | ")}`);
      }
    }

    const stillExists = await db.user.findUnique({ where: { id: userId }, select: { id: true } }).catch(() => null);
    console.log(`  最終結果: ${stillExists ? "まだ残存している" : "削除成功"}`);

    if (stillExists) {
      // ここまでで消せなかった場合、参照制約の全体像を生SQLで直接調べる
      // (どのテーブルのどの列がこのuserId/workspaceIdをまだ指しているか)。
      console.log("  [深掘り] このuserIdを直接参照している全テーブルを生SQLで確認します...");
      try {
        const rows = await db.$queryRawUnsafe<{ table_name: string; column_name: string }[]>(`
          SELECT tc.table_name, kcu.column_name
          FROM information_schema.table_constraints tc
          JOIN information_schema.key_column_usage kcu
            ON tc.constraint_name = kcu.constraint_name
          JOIN information_schema.constraint_column_usage ccu
            ON tc.constraint_name = ccu.constraint_name
          WHERE tc.constraint_type = 'FOREIGN KEY'
            AND ccu.table_name = 'users'
        `);
        for (const r of rows) {
          const cnt = await db.$queryRawUnsafe<{ count: string }[]>(
            `SELECT count(*)::text as count FROM "${r.table_name}" WHERE "${r.column_name}" = $1`,
            userId,
          );
          const n = Number(cnt[0]?.count ?? "0");
          if (n > 0) {
            console.log(`    ${r.table_name}.${r.column_name} = ${n}件がこのuserIdを参照中`);
          }
        }
      } catch (e) {
        console.log(`  [深掘り失敗] ${String(e)}`);
      }
    }
  }

  const finalRemaining = await db.user.findMany({
    where: { email: { startsWith: EMAIL_PREFIX, endsWith: "@example.invalid" } },
    select: { id: true },
  });
  console.log(`\n=== 最終確認: 残存${finalRemaining.length}件 ===`);
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error("FATAL:", err);
    process.exit(1);
  });
