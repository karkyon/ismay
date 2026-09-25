#!/usr/bin/env node
/**
 * scripts/verify_gate_purge_scope_03a.ts
 *
 * PURGE-SCOPE-03A(明示的scope列)実DB受入試験。
 * 出典: DEC-PURGE-02B(2026-09-25利用者決定「FKが無いから保持、という設計を終わらせ、
 * 明示的なscope列でPurge対象を特定する」)、migration 20260925010000_purge_scope_03a。
 *
 * 検証内容:
 *   [S1] event_logs/outbox_events/jobs/consents/ai_runs(captureなし)がFKグラフ経由で
 *        workspace scopeの削除対象になり、dry-runと実行の件数・digestが一致し、実際に消える。
 *   [S2] audit_logsは行を保持し、本人が行為者/対象の行のip_addressを墨消し、
 *        actor_user_idをNULL化する。他人のaudit行は無傷。
 *   [S3] 新規行はworkspace_id必須(DB trigger)。非NULL→NULLへの更新も拒否。
 *   [S4] scope未解決の旧行件数(countLegacyUnscopedRows)は5表すべてについて取得できる。
 *   [S5] 別workspace(有効ユーザー)の同種の行は無傷。
 *   cleanup後の残存0、AI network実通信0。
 *
 * 実行方法:
 *   cd ~/projects/ismay/app
 *   npx tsx ../scripts/verify_gate_purge_scope_03a.ts
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

const RUN_ID = Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
const EMAIL_PREFIX = "gate-purge-scope-03a-verify-";
const DAY_MS = 24 * 60 * 60 * 1000;
const EXPLICIT_TABLES = ["event_logs", "outbox_events", "jobs", "consents", "ai_runs"];

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

async function main(): Promise<void> {
  const { installAiNetworkDenyGuard } = await import("./lib/aiNetworkDenyGuard");
  const guard = installAiNetworkDenyGuard();

  const { db } = await import("../app/src/lib/db");
  const { cleanupFormationVerifyUser, assertNoLeftoverFormationVerifyUsers } = await import("./lib/formationVerifyCleanup");
  const { dryRunPurgeForUser, executePurgeForUser, countLegacyUnscopedRows } = await import("../app/src/lib/admin/purgeJob");

  const count = async (sql: string, ...values: unknown[]): Promise<number> =>
    Number((await db.$queryRawUnsafe<{ c: bigint }[]>(sql, ...values))[0]?.c ?? 0);

  const createdUserIds: string[] = [];

  /** FKグラフから順序を算出するPurge本体で片付け、拒否時のみ共有cleanupへフォールバック(hardening_02と同じ方針)。 */
  async function cleanupUsers(userIds: string[]): Promise<string[]> {
    const errors: string[] = [];
    for (const userId of userIds) {
      if (!(await db.user.findUnique({ where: { id: userId }, select: { id: true } }))) continue;
      await db.workspaceMember.deleteMany({ where: { userId: { not: userId }, workspace: { members: { some: { userId } } } } });
      await db.user.update({ where: { id: userId }, data: { deletedAt: new Date(Date.now() - 60 * DAY_MS) } });
      const purge = await executePurgeForUser({ userId });
      if (purge.status === "PURGED") continue;
      const r = await cleanupFormationVerifyUser(db, userId);
      if ((await db.user.findUnique({ where: { id: userId }, select: { id: true } })) || r.errors.length > 0) {
        errors.push(`${userId}: purge=${purge.status}(${purge.detail}) fallbackErrors=${r.errors.map((x) => x.step).join(",")}`);
      }
    }
    await db.auditLog.deleteMany({ where: { targetId: { in: userIds } } });
    return errors;
  }

  const orphans = await db.user.findMany({ where: { email: { startsWith: EMAIL_PREFIX, endsWith: "@example.invalid" } }, select: { id: true } });
  if (orphans.length > 0) {
    console.log(`[SWEEP] 過去実行の孤立テストユーザー${orphans.length}件を削除します...`);
    await cleanupUsers(orphans.map((o) => o.id));
  }

  async function makeUser(suffix: string, deletedAt: Date | null) {
    const email = `${EMAIL_PREFIX}${RUN_ID}-${suffix}@example.invalid`;
    const user = await db.user.create({ data: { email, passwordHash: "not-a-real-hash-for-db-only-test", displayName: `PURGE-03A ${suffix}`, deletedAt } });
    createdUserIds.push(user.id);
    const workspace = await db.workspace.create({ data: { name: `PURGE-03A ${suffix}`, deletedAt } });
    await db.workspaceMember.create({ data: { workspaceId: workspace.id, userId: user.id, role: "OWNER" } });
    const domain = await db.domain.create({ data: { workspaceId: workspace.id, name: "個人", kind: "PERSONAL" } });
    const consent = await db.consent.create({ data: { workspaceId: workspace.id, subjectId: user.id, purpose: "MEETING_RECORDING", scope: { participantsNotified: true } } });
    const capture = await db.capture.create({
      data: { workspaceId: workspace.id, domainId: domain.id, createdById: user.id, sourceType: "TEXT", rawText: `検証用本文(${suffix})`, consentId: consent.id },
    });
    const responsibility = await db.responsibility.create({
      data: { workspaceId: workspace.id, domainId: domain.id, type: "TASK", title: `検証用タイトル(${suffix})`, status: "PLANNED", sourceKind: "USER", createdById: user.id, updatedById: user.id, originCaptureId: capture.id },
    });
    await db.eventLog.create({
      data: { workspaceId: workspace.id, aggregateType: "Responsibility", aggregateId: responsibility.id, eventType: "RESPONSIBILITY_CHANGED", beforeJson: { title: "旧タイトル本文" }, afterJson: { title: "新タイトル本文" }, actorType: "USER", actorId: user.id },
    });
    await db.outboxEvent.create({
      data: { workspaceId: workspace.id, eventName: "CaptureSaved.v1", eventVersion: "1", aggregateId: capture.id, aggregateVersion: 0, payload: { captureId: capture.id, workspaceId: workspace.id } },
    });
    await db.job.create({
      data: { workspaceId: workspace.id, jobType: "AI_EXTRACT", aggregateId: capture.id, sourceVersion: 0, status: "FAILED", lastError: "検証用エラー本文", payload: { captureId: capture.id } },
    });
    const pemRun = await db.aiRun.create({ data: { workspaceId: workspace.id, provider: "verify", model: "verify", promptVersion: "1", schemaVersion: "1", status: "SUCCEEDED" } });
    await db.auditLog.create({ data: { actorUserId: user.id, actorType: "USER", action: "LOGIN", targetType: "User", targetId: user.id, result: "SUCCESS", ipAddress: "203.0.113.10" } });
    await db.auditLog.create({ data: { actorUserId: null, actorType: "SYSTEM", action: "ACCOUNT_LOCKED", targetType: "User", targetId: user.id, result: "SUCCESS", ipAddress: "203.0.113.11" } });
    return { userId: user.id, email, workspaceId: workspace.id, captureId: capture.id, consentId: consent.id, pemRunId: pemRun.id };
  }

  const cleanupErrors: string[] = [];
  try {
    console.log("=== PURGE-SCOPE-03A 実DB受入試験 ===");
    const active = await makeUser("active", null);
    const target = await makeUser("target", new Date(Date.now() - 45 * DAY_MS));

    // ------------------------------------------------------------ [S1]
    const plan = await dryRunPurgeForUser({ userId: target.userId });
    ok("[S1] dry-runはELIGIBLE", plan.status === "ELIGIBLE", JSON.stringify(plan).slice(0, 300));
    const per = (m: { perTable: { tableName: string; count: number }[] }, t: string): number => m.perTable.find((x) => x.tableName === t)?.count ?? -1;
    if (plan.status === "ELIGIBLE") {
      for (const t of EXPLICIT_TABLES) ok(`[S1] dry-runの削除対象に${t}が1件含まれる`, per(plan.manifest, t) === 1, String(per(plan.manifest, t)));
      ok("[S1] 保持表はaudit_logsのみ", plan.manifest.retainedUnscopedTables.join(",") === "audit_logs", plan.manifest.retainedUnscopedTables.join(","));
    }
    const exec = await executePurgeForUser({ userId: target.userId }, { expected: plan.status === "ELIGIBLE" ? plan.manifest : null });
    ok("[S1] 実行はPURGED", exec.status === "PURGED", JSON.stringify(exec).slice(0, 300));
    if (exec.status === "PURGED" && plan.status === "ELIGIBLE") {
      ok("[S1] dry-runと実行のdigestが一致しdrift 0件", exec.manifest.digest === plan.manifest.digest && (exec.drift ?? []).length === 0, JSON.stringify(exec.drift));
      for (const t of EXPLICIT_TABLES) ok(`[S1] 実行で${t}を1件削除`, per(exec.manifest, t) === 1, String(per(exec.manifest, t)));
    }
    for (const t of ["event_logs", "outbox_events", "jobs", "consents", "ai_runs"]) {
      ok(`[S1] 対象workspaceの${t}残存0`, (await count(`SELECT COUNT(*)::bigint AS c FROM ${t} WHERE workspace_id = $1`, target.workspaceId)) === 0);
    }
    ok("[S1] captureの無いai_runs(PEM系)も削除される", (await count(`SELECT COUNT(*)::bigint AS c FROM ai_runs WHERE id = $1`, target.pemRunId)) === 0);
    ok("[S1] consent行(本人のsubject_id・scope)も削除される", (await count(`SELECT COUNT(*)::bigint AS c FROM consents WHERE id = $1`, target.consentId)) === 0);

    // ------------------------------------------------------------ [S2]
    if (exec.status === "PURGED") {
      const red = exec.manifest.redactedRetainedRows.find((u) => u.tableName === "audit_logs");
      ok("[S2] audit_logsの墨消し(ip_address)が2件として別計上される", red?.count === 2 && red.columnNames.join(",") === "ip_address", JSON.stringify(exec.manifest.redactedRetainedRows));
      ok("[S2] 行為者参照の匿名化(actor_user_id)が1件", exec.manifest.anonymizedReferences.find((u) => u.tableName === "audit_logs")?.count === 1, JSON.stringify(exec.manifest.anonymizedReferences));
    }
    ok("[S2] 本人関係のaudit行は2件とも保持される", (await count(`SELECT COUNT(*)::bigint AS c FROM audit_logs WHERE target_id = $1`, target.userId)) === 2);
    ok("[S2] 本人関係のaudit行のip_addressは全てNULL", (await count(`SELECT COUNT(*)::bigint AS c FROM audit_logs WHERE target_id = $1 AND ip_address IS NOT NULL`, target.userId)) === 0);
    ok("[S2] 本人関係のaudit行のactor_user_idは全てNULL", (await count(`SELECT COUNT(*)::bigint AS c FROM audit_logs WHERE target_id = $1 AND actor_user_id IS NOT NULL`, target.userId)) === 0);
    ok("[S2] 他人(有効ユーザー)のaudit行のip_addressは無傷", (await count(`SELECT COUNT(*)::bigint AS c FROM audit_logs WHERE target_id = $1 AND ip_address IS NOT NULL`, active.userId)) === 2);

    // ------------------------------------------------------------ [S3]
    for (const t of EXPLICIT_TABLES) {
      let rejected = false;
      try {
        await db.$transaction(async (tx): Promise<void> => {
          if (t === "event_logs") await tx.$executeRawUnsafe(`INSERT INTO event_logs (id, aggregate_type, aggregate_id, event_type, actor_type) VALUES ($1, 'Capture', $2, 'X', 'SYSTEM')`, `verify-03a-${RUN_ID}`, active.captureId);
          else if (t === "outbox_events") await tx.$executeRawUnsafe(`INSERT INTO outbox_events (id, event_name, event_version, aggregate_id, aggregate_version, payload) VALUES ($1, 'X', '1', $2, 0, '{}')`, `verify-03a-${RUN_ID}`, active.captureId);
          else if (t === "jobs") await tx.$executeRawUnsafe(`INSERT INTO jobs (id, job_type, aggregate_id, source_version, updated_at) VALUES ($1, 'VERIFY', $2, 0, now())`, `verify-03a-${RUN_ID}`, active.captureId);
          else if (t === "consents") await tx.$executeRawUnsafe(`INSERT INTO consents (id, subject_id, purpose, scope) VALUES ($1, $2, 'X', '{}')`, `verify-03a-${RUN_ID}`, active.userId);
          else await tx.$executeRawUnsafe(`INSERT INTO ai_runs (id, provider, model, prompt_version, schema_version) VALUES ($1, 'v', 'v', '1', '1')`, `verify-03a-${RUN_ID}`);
        });
      } catch (e) {
        rejected = String(e).includes("PURGE-SCOPE-03A");
      }
      ok(`[S3] ${t}へworkspace_id無しのINSERTはDB triggerで拒否される`, rejected);
    }
    let nullUpdateRejected = false;
    try {
      await db.$executeRawUnsafe(`UPDATE event_logs SET workspace_id = NULL WHERE workspace_id = $1`, active.workspaceId);
    } catch (e) {
      nullUpdateRejected = String(e).includes("PURGE-SCOPE-03A");
    }
    ok("[S3] 設定済みworkspace_idをNULLへ戻す更新は拒否される", nullUpdateRejected);

    // ------------------------------------------------------------ [S4]
    const legacy = await countLegacyUnscopedRows();
    ok("[S4] scope未解決の旧行件数は明示的scope列の5表について取得できる", EXPLICIT_TABLES.every((t) => legacy.some((l) => l.tableName === t && l.columnName === "workspace_id" && l.count >= 0)), JSON.stringify(legacy));

    // ------------------------------------------------------------ [S5]
    for (const t of EXPLICIT_TABLES) {
      ok(`[S5] 有効ユーザーのworkspaceの${t}は無傷(1件)`, (await count(`SELECT COUNT(*)::bigint AS c FROM ${t} WHERE workspace_id = $1`, active.workspaceId)) === 1);
    }
  } finally {
    console.log("--- cleanup ---");
    cleanupErrors.push(...(await cleanupUsers(createdUserIds)));
    const leftovers = await assertNoLeftoverFormationVerifyUsers(db, EMAIL_PREFIX);
    ok("[cleanup] 専用fixtureユーザーの残存0件", leftovers.clean, JSON.stringify(leftovers.remainingUserIds));
    ok("[cleanup] cleanup中のエラー0件", cleanupErrors.length === 0, cleanupErrors.join(" / "));
    guard.restore();
    ok("[AI network] AI networkへの実通信試行は0回", guard.deniedCallAttempts.length === 0, `attempts=${JSON.stringify(guard.deniedCallAttempts)}`);
    await db.$disconnect();
  }

  console.log(`\n=== 結果: ${passed} passed / ${failed} failed ===`);
  if (failed > 0) {
    console.log("失敗一覧:");
    for (const f of failures) console.log(`  - ${f}`);
    process.exit(1);
  }
}

main().catch((err) => {
  console.error("[verify script fatal error]", err);
  process.exit(1);
});
