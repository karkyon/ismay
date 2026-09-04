#!/usr/bin/env node
/**
 * scripts/inspect_and_clean_orphan_pattern_detect_01c_users.ts
 *
 * verify_gate_pattern_detect_01c.ts (v2/v3) が"16 passed, 1 failed,
 * remaining=1"で終わった際の残存原因調査・除去専用ツール。
 *
 * [v3・根本原因判明] v2実行時、意図していた「ファイル書き出し」設計が
 * (冪等スキップにより)反映されず旧v1内容がそのまま実行され、結果として
 * 直接標準出力に診断内容が出た。そこから実際の原因が判明した:
 *
 *   Foreign key constraint violated: project_contexts_owner_subject_user_id_fkey
 *   project_contexts.owner_subject_user_id = 1件がこのuserIdを参照中
 *   project_contexts.created_by = 1件がこのuserIdを参照中
 *
 * このorphanユーザーは、過去複数回のcleanup試行を経て workspaceMember・
 * capture・responsibility・formationSession等はすでに削除済みだったが、
 * ProjectContext行だけが取り残されていた。
 * scripts/lib/formationVerifyCleanup.ts の cleanupFormationVerifyUser は、
 * workspaceIdの解決を「workspaceMember経由」または「capture経由」でしか
 * 行っておらず、このケース(両方とも既に無い)では内部の
 * resolvedWorkspaceIdOuter が null のままとなり、ProjectContext削除
 * ブロック自体が丸ごとスキップされていた。
 * このv3は、ProjectContext(owner_subject_user_id・created_by両方)を
 * userId直接指定で削除する処理を、cleanupFormationVerifyUser呼び出しより
 * 前に追加する(想像で他の未知の原因を探し続けるのではなく、実際に判明した
 * 参照元を直接断ち切る)。
 *
 * 実行方法:
 *   cd ~/projects/ismay/app
 *   npx tsx ../scripts/inspect_and_clean_orphan_pattern_detect_01c_users.ts
 *
 * 診断レポートは ~/projects/ismay/orphan_diagnosis_report.txt に書き出される。
 * このスクリプトは「gate-pattern-detect-01c-verify-」prefixのUserだけを
 * 対象とし、それ以外のデータには一切触れない。
 */
import { readFileSync, writeFileSync } from "node:fs";
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
const REPORT_PATH = join(__dirname, "..", "orphan_diagnosis_report.txt");

const reportLines: string[] = [];
function report(line: string): void {
  reportLines.push(line);
}

async function main(): Promise<void> {
  const { db } = await import("../app/src/lib/db");
  const { cleanupFormationVerifyUser } = await import("./lib/formationVerifyCleanup");

  report(`=== 診断レポート ${new Date().toISOString()} ===`);

  const orphans = await db.user.findMany({
    where: { email: { startsWith: EMAIL_PREFIX, endsWith: "@example.invalid" } },
    select: { id: true, email: true, createdAt: true },
  });

  report(`対象prefix (${EMAIL_PREFIX}) のUser: ${orphans.length}件`);
  for (const o of orphans) {
    report(`  - ${o.id} : ${o.email} (createdAt=${o.createdAt.toISOString()})`);
  }

  for (const o of orphans) {
    const userId = o.id;
    report(`\n--- userId=${userId} (${o.email}) の全面診断 ---`);

    const membership = await db.workspaceMember.findFirst({ where: { userId }, select: { workspaceId: true } }).catch((e) => {
      report(`  workspaceMember.findFirst 例外: ${String(e)}`);
      return null;
    });
    report(`  workspaceMember経由: ${membership?.workspaceId ?? "(見つからず)"}`);

    const ctxOwned = await db.projectContext.findFirst({ where: { ownerSubjectUserId: userId }, select: { workspaceId: true } }).catch((e) => {
      report(`  projectContext.findFirst(owner) 例外: ${String(e)}`);
      return null;
    });
    report(`  projectContext(owner)経由: ${ctxOwned?.workspaceId ?? "(見つからず)"}`);

    const ctxCreated = await db.projectContext.findFirst({ where: { createdById: userId }, select: { workspaceId: true } }).catch((e) => {
      report(`  projectContext.findFirst(createdBy) 例外: ${String(e)}`);
      return null;
    });
    report(`  projectContext(createdBy)経由: ${ctxCreated?.workspaceId ?? "(見つからず)"}`);

    const patOwned = await db.casePattern.findFirst({ where: { ownerSubjectUserId: userId }, select: { workspaceId: true } }).catch((e) => {
      report(`  casePattern.findFirst 例外: ${String(e)}`);
      return null;
    });
    report(`  casePattern(owner)経由: ${patOwned?.workspaceId ?? "(見つからず)"}`);

    const capByCreator = await db.capture.findFirst({ where: { createdById: userId }, select: { workspaceId: true } }).catch((e) => {
      report(`  capture.findFirst 例外: ${String(e)}`);
      return null;
    });
    report(`  capture(createdBy)経由: ${capByCreator?.workspaceId ?? "(見つからず)"}`);

    const workspaceId =
      membership?.workspaceId ?? ctxOwned?.workspaceId ?? ctxCreated?.workspaceId ?? patOwned?.workspaceId ?? capByCreator?.workspaceId ?? null;
    report(`  => 最終的に解決したworkspaceId: ${workspaceId ?? "(全経路で見つからず)"}`);

    const counts: Record<string, number> = {
      "projectContext(byOwner)": await db.projectContext.count({ where: { ownerSubjectUserId: userId } }).catch(() => -1),
      "projectContext(byCreatedBy)": await db.projectContext.count({ where: { createdById: userId } }).catch(() => -1),
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
    report(`  残存件数: ${JSON.stringify(counts)}`);

    // --- CasePattern関連(workspaceId経由)を先に削除 ---
    if (workspaceId) {
      await db.casePatternSourceLink.deleteMany({ where: { workspaceId } }).catch((e) => report(`  [削除失敗] casePatternSourceLink(byWorkspace): ${String(e)}`));
      await db.casePatternEvidenceAggregate.deleteMany({ where: { workspaceId } }).catch((e) => report(`  [削除失敗] casePatternEvidenceAggregate: ${String(e)}`));
      await db.casePatternEmbedding.deleteMany({ where: { workspaceId } }).catch((e) => report(`  [削除失敗] casePatternEmbedding: ${String(e)}`));
      await db.casePatternFeedbackEvent.deleteMany({ where: { workspaceId } }).catch((e) => report(`  [削除失敗] casePatternFeedbackEvent: ${String(e)}`));
      await db.casePatternRevision.deleteMany({ where: { workspaceId } }).catch((e) => report(`  [削除失敗] casePatternRevision: ${String(e)}`));
      await db.casePattern.deleteMany({ where: { workspaceId } }).catch((e) => report(`  [削除失敗] casePattern: ${String(e)}`));
    }

    // --- [v3新設・根本原因への対処] userId直接所有/作成のProjectContextを
    // workspaceId解決の成否によらず特定し、従属行ごと削除する。
    // cleanupFormationVerifyUserはworkspaceMember/captureからしかworkspaceId
    // を解決できず、両方が既に無い場合はProjectContext削除ブロックを
    // 丸ごとスキップしてしまう(実際にこのGateで判明した不具合)。 ---
    const ownedOrCreatedContexts = await db.projectContext
      .findMany({ where: { OR: [{ ownerSubjectUserId: userId }, { createdById: userId }] }, select: { id: true } })
      .catch((e) => {
        report(`  [検索失敗] projectContext(owner/createdBy): ${String(e)}`);
        return [];
      });
    const contextIds = ownedOrCreatedContexts.map((c) => c.id);
    report(`  userId直接所有/作成のProjectContext: ${contextIds.length}件`);
    if (contextIds.length > 0) {
      await db.casePatternSourceLink.deleteMany({ where: { contextId: { in: contextIds } } }).catch((e) => report(`  [削除失敗] casePatternSourceLink(byContext): ${String(e)}`));
      const refs = await db.externalContextReference.findMany({ where: { contextId: { in: contextIds } }, select: { id: true } }).catch((e) => {
        report(`  [検索失敗] externalContextReference: ${String(e)}`);
        return [];
      });
      const refIds = refs.map((r) => r.id);
      if (refIds.length > 0) {
        await db.projectContextSnapshotRevision.deleteMany({ where: { referenceId: { in: refIds } } }).catch((e) => report(`  [削除失敗] projectContextSnapshotRevision: ${String(e)}`));
      }
      await db.externalContextReference.deleteMany({ where: { contextId: { in: contextIds } } }).catch((e) => report(`  [削除失敗] externalContextReference: ${String(e)}`));
      await db.projectContextEmbedding.deleteMany({ where: { contextId: { in: contextIds } } }).catch((e) => report(`  [削除失敗] projectContextEmbedding: ${String(e)}`));
      await db.projectContextLinkEvent.deleteMany({ where: { contextId: { in: contextIds } } }).catch((e) => report(`  [削除失敗] projectContextLinkEvent: ${String(e)}`));
      await db.projectContextLink.deleteMany({ where: { contextId: { in: contextIds } } }).catch((e) => report(`  [削除失敗] projectContextLink: ${String(e)}`));
      await db.eventLog.deleteMany({ where: { aggregateId: { in: contextIds } } }).catch((e) => report(`  [削除失敗] eventLog(ProjectContext): ${String(e)}`));
      await db.outboxEvent.deleteMany({ where: { aggregateId: { in: contextIds } } }).catch((e) => report(`  [削除失敗] outboxEvent(ProjectContext): ${String(e)}`));
      const delResult = await db.projectContext.deleteMany({ where: { id: { in: contextIds } } }).catch((e) => {
        report(`  [削除失敗] projectContext本体: ${String(e)}`);
        return { count: 0 };
      });
      report(`  projectContext本体を${delResult.count}件削除`);
    }

    report("  cleanupFormationVerifyUser 呼び出し中...");
    const result = await cleanupFormationVerifyUser(db, userId);
    report(`  cleanupFormationVerifyUser errors=${result.errors.length}`);
    for (const e of result.errors) {
      report(`    [step失敗] ${e.step}`);
      report(`      ${String(e.error)}`);
      if (e.error instanceof Error && e.error.stack) {
        report(`      stack: ${e.error.stack.split("\n").slice(0, 5).join(" | ")}`);
      }
    }

    const stillExists = await db.user.findUnique({ where: { id: userId }, select: { id: true } }).catch(() => null);
    report(`  最終結果: ${stillExists ? "まだ残存している" : "削除成功"}`);

    if (stillExists) {
      report("  [深掘り] このuserIdを直接参照している全テーブルを生SQLで確認します...");
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
            report(`    ${r.table_name}.${r.column_name} = ${n}件がこのuserIdを参照中`);
          }
        }
      } catch (e) {
        report(`  [深掘り失敗] ${String(e)}`);
      }
    }
  }

  const finalRemaining = await db.user.findMany({
    where: { email: { startsWith: EMAIL_PREFIX, endsWith: "@example.invalid" } },
    select: { id: true },
  });
  report(`\n=== 最終確認: 残存${finalRemaining.length}件 ===`);

  writeFileSync(REPORT_PATH, reportLines.join("\n") + "\n", "utf-8");

  console.log(`診断対象: ${orphans.length}件`);
  console.log(`最終残存: ${finalRemaining.length}件`);
  console.log(`詳細レポート: ${REPORT_PATH}`);
  console.log(`このファイルの内容を共有してください: cat ${REPORT_PATH}`);
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error("FATAL:", err instanceof Error ? err.message : String(err));
    process.exit(1);
  });
