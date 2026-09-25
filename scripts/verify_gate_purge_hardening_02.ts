#!/usr/bin/env node
/**
 * scripts/verify_gate_purge_hardening_02.ts
 *
 * 30日Purge hardening(PURGE-SCOPE-02F / ELIGIBILITY-02C / AUDIT-02D /
 * REPORT-02E)実DB受入試験。
 *
 * 検証内容:
 *   [A] P0回帰: Formation(USER actorのformation_session_events)と
 *       ProjectContextLinkEvent(actor排他CHECK)を持つユーザーがPurgeできる。
 *       ai_runs/evidences(NULL可能な所有FK)も残らない。dry-runとexecuteの
 *       件数・digestが一致する。audit_logsは行為者参照の匿名化として別計上。
 *   [B] dry-run後にdeletedAt=nullへ戻した(復元)対象は削除されない(副作用0)。
 *   [C] dry-run後にdeletedAtを30日未満へ変更した対象は削除されない。
 *   [D] 30日境界(DB時刻基準): 30日+5秒前は対象、30日-60秒前は対象外。
 *   [E] 偽造target: 有効ユーザーのuserIdや他人のworkspaceIdsを渡しても削除できない。
 *   [F] 一覧取得後のmembership追加は、古い配列ではなくtransaction内の実値で処理される。
 *   [G] 本人以外のmemberが居るworkspaceは削除しない(SHARED_WORKSPACE)。
 *   [H] users行のlock競合時はLOCK_CONFLICTで中止し、部分削除を残さない。解放後は成功する。
 *   [I] AuditLog障害注入: 削除成功後の監査失敗で削除成功を誤報しない(exit bit 4)。
 *       FAILURE監査の失敗も元の結果を上書きしない。既定writerは
 *       actorUserId=null/actorType=SYSTEMでemailを含めずに記録する。
 *   [K] 対象外の行がNOT NULL FKで参照している場合はEXTERNAL_REFERENCEで拒否(副作用0)。
 *   [J] 対照ユーザー(有効・30日未満)の非干渉、AI network実通信0、cleanup後残存0。
 *
 * 実行方法:
 *   cd ~/projects/ismay/app
 *   npx tsx ../scripts/verify_gate_purge_hardening_02.ts
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
const EMAIL_PREFIX = "gate-purge-hardening-02-verify-";
const DAY_MS = 24 * 60 * 60 * 1000;

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
  const { findEligibleUsersForPurge, dryRunPurgeForUser, executePurgeForUser } = await import("../app/src/lib/admin/purgeJob");
  const { collectPurgeRunContext, runPurgeItem } = await import("../app/src/lib/admin/purgeRunner");
  const { summarizePurgeOutcomes, PURGE_EXIT } = await import("../app/src/lib/admin/purgeReporting");

  const count = async (sql: string, ...values: unknown[]): Promise<number> =>
    Number((await db.$queryRawUnsafe<{ c: bigint }[]>(sql, ...values))[0]?.c ?? 0);
  const dbNow = async (): Promise<Date> => {
    const rows = await db.$queryRawUnsafe<{ now: string }[]>(`SELECT to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS now`);
    return new Date(rows[0].now);
  };

  const createdUserIds: string[] = [];
  const createdWorkspaceIds: string[] = [];

  /**
   * cleanup: このGateのfixtureはevidences(responsibilities削除時にSET NULLで
   * 孤立する)・domains・ProjectContext・origin無しResponsibility等、共有cleanup
   * (formationVerifyCleanup、Capture起点のFormation系を対象)の範囲外を含む。
   * 手書きの削除順序は持たず、FKグラフから削除順序を動的に算出するPurge本体で
   * 片付け、Purgeが拒否した場合だけ共有cleanupへフォールバックする。
   * fixture同士の共有membership(本人以外のmember)は先に外す。
   */
  async function cleanupUsers(userIds: string[]): Promise<string[]> {
    const errors: string[] = [];
    for (const userId of userIds) {
      const exists = await db.user.findUnique({ where: { id: userId }, select: { id: true } });
      if (!exists) continue;
      await db.workspaceMember.deleteMany({ where: { userId: { not: userId }, workspace: { members: { some: { userId } } } } });
      await db.user.update({ where: { id: userId }, data: { deletedAt: new Date(Date.now() - 60 * DAY_MS) } });
      const purge = await executePurgeForUser({ userId });
      if (purge.status === "PURGED") continue;
      const r = await cleanupFormationVerifyUser(db, userId);
      const stillExists = await db.user.findUnique({ where: { id: userId }, select: { id: true } });
      if (stillExists || r.errors.length > 0) {
        errors.push(`${userId}: purge=${purge.status}(${purge.detail}) fallbackErrors=${r.errors.map((x) => x.step).join(",")}`);
      }
    }
    await db.auditLog.deleteMany({ where: { targetId: { in: userIds } } });
    await db.evidence.deleteMany({ where: { sourceRef: { startsWith: "purge02-verify-evidence-" }, responsibilityId: null, pemEvidenceLinks: { none: {} } } });
    return errors;
  }

  const orphans = await db.user.findMany({ where: { email: { startsWith: EMAIL_PREFIX, endsWith: "@example.invalid" } }, select: { id: true } });
  if (orphans.length > 0) {
    console.log(`[SWEEP] 過去実行の孤立テストユーザー${orphans.length}件を削除します...`);
    const sweepErrors = await cleanupUsers(orphans.map((o) => o.id));
    if (sweepErrors.length > 0) console.log(`[SWEEP] 残存: ${sweepErrors.join(" / ")}`);
  }

  /** soft-delete済み(daysAgo=null なら有効)ユーザー+workspace+業務データ一式。 */
  async function makeUser(suffix: string, deletedAt: Date | null, opts: { formation?: boolean } = {}) {
    const email = `${EMAIL_PREFIX}${RUN_ID}-${suffix}@example.invalid`;
    const user = await db.user.create({ data: { email, passwordHash: "not-a-real-hash-for-db-only-test", displayName: `PURGE-02 ${suffix}`, deletedAt } });
    createdUserIds.push(user.id);
    const workspace = await db.workspace.create({ data: { name: `PURGE-02 ${suffix}`, deletedAt } });
    createdWorkspaceIds.push(workspace.id);
    await db.workspaceMember.create({ data: { workspaceId: workspace.id, userId: user.id, role: "OWNER" } });
    const domain = await db.domain.create({ data: { workspaceId: workspace.id, name: "個人", kind: "PERSONAL", deletedAt } });
    const capture = await db.capture.create({ data: { workspaceId: workspace.id, domainId: domain.id, createdById: user.id, sourceType: "TEXT", rawText: `検証用メモ(${suffix})`, deletedAt } });
    const responsibility = await db.responsibility.create({
      data: {
        workspaceId: workspace.id, domainId: domain.id, type: "TASK", title: `検証用Responsibility(${suffix})`, status: "PLANNED",
        sourceKind: "USER", createdById: user.id, updatedById: user.id, originCaptureId: capture.id, deletedAt,
      },
    });
    const aiRun = await db.aiRun.create({ data: { captureId: capture.id, workspaceId: workspace.id, provider: "verify", model: "verify", promptVersion: "1", schemaVersion: "1" } });
    const evidence = await db.evidence.create({ data: { responsibilityId: responsibility.id, sourceType: "NOTE", sourceRef: `purge02-verify-evidence-${RUN_ID}-${suffix}` } });
    if (opts.formation) {
      const session = await db.formationSession.create({ data: { workspaceId: workspace.id, domainId: domain.id, subjectUserId: user.id, captureId: capture.id, clientSessionKey: `verify-${RUN_ID}` } });
      await db.formationSessionEvent.create({ data: { workspaceId: workspace.id, sessionId: session.id, sequence: 1, eventType: "FORMATION_CREATED", actorType: "USER", actorUserId: user.id, payload: {} } });
      await db.formationSessionEvent.create({ data: { workspaceId: workspace.id, sessionId: session.id, sequence: 2, eventType: "ANALYSIS_REQUESTED", actorType: "SYSTEM", payload: {} } });
      const context = await db.projectContext.create({ data: { workspaceId: workspace.id, domainId: domain.id, ownerSubjectUserId: user.id, createdById: user.id, name: `検証用Context(${suffix})` } });
      await db.projectContextLinkEvent.create({
        data: {
          workspaceId: workspace.id, contextId: context.id, responsibilityId: responsibility.id, eventType: "LINK", role: "PRIMARY",
          actorUserId: user.id, actorType: "USER", idempotencyKey: `verify-${RUN_ID}-${suffix}`, requestPayloadHash: "verify",
        },
      });
    }
    await db.auditLog.create({ data: { actorUserId: user.id, actorType: "USER", action: "ACCOUNT_DELETE_REQUESTED", targetType: "User", targetId: user.id, result: "SUCCESS" } });
    return { userId: user.id, email, workspaceId: workspace.id, domainId: domain.id, captureId: capture.id, responsibilityId: responsibility.id, aiRunId: aiRun.id, evidenceId: evidence.id };
  }

  const daysAgo = (d: number): Date => new Date(Date.now() - d * DAY_MS);
  const cleanupErrors: string[] = [];

  try {
    console.log("=== PURGE hardening 02 実DB受入試験 ===");
    const active = await makeUser("active", null);
    const recent = await makeUser("recent29", daysAgo(29));

    // ---------------------------------------------------------------- [A]
    const a = await makeUser("formation", daysAgo(45), { formation: true });
    const planA = await dryRunPurgeForUser({ userId: a.userId });
    ok("[A] Formation/ProjectContext利用ユーザーのdry-runはELIGIBLE", planA.status === "ELIGIBLE", JSON.stringify(planA).slice(0, 300));
    const execA = await executePurgeForUser({ userId: a.userId }, { expected: planA.status === "ELIGIBLE" ? planA.manifest : null });
    ok("[A] Formation/ProjectContext利用ユーザーをPurgeできる(旧実装は23514でrollback)", execA.status === "PURGED", JSON.stringify(execA).slice(0, 400));
    if (execA.status === "PURGED" && planA.status === "ELIGIBLE") {
      const m = execA.manifest;
      ok("[A] dry-runと実行のdigestが一致し、driftは0件", m.digest === planA.manifest.digest && (execA.drift?.length ?? -1) === 0, JSON.stringify(execA.drift));
      ok("[A] 削除行数(rowsDeleted)がdry-runと一致", m.totals.rowsDeleted === planA.manifest.totals.rowsDeleted, `${m.totals.rowsDeleted} vs ${planA.manifest.totals.rowsDeleted}`);
      const per = (t: string): number => m.perTable.find((x) => x.tableName === t)?.count ?? -1;
      ok("[A] formation_session_eventsはUSER/SYSTEMの2件とも削除", per("formation_session_events") === 2, String(per("formation_session_events")));
      ok("[A] project_context_link_eventsは1件削除", per("project_context_link_events") === 1, String(per("project_context_link_events")));
      ok("[A] ai_runs(NULL可能なcapture_id経由)は1件削除", per("ai_runs") === 1, String(per("ai_runs")));
      ok("[A] evidences(NULL可能なresponsibility_id経由)は1件削除", per("evidences") === 1, String(per("evidences")));
      ok("[A] workspace行とuser行は別フィールドで各1件", m.workspaceRowsDeleted === 1 && m.userRowsDeleted === 1, `${m.workspaceRowsDeleted}/${m.userRowsDeleted}`);
      const tableSum = m.perTable.reduce((s, t) => s + t.count, 0);
      ok("[A] rowsDeletedは表+workspace+userの合計", m.totals.rowsDeleted === tableSum + 2, `${m.totals.rowsDeleted} vs ${tableSum}+2`);
      const anon = m.anonymizedReferences.find((u) => u.tableName === "audit_logs");
      ok("[A] audit_logsの行為者参照は匿名化(更新)として別計上される", anon?.count === 1 && anon.columnNames.join(",") === "actor_user_id", JSON.stringify(m.anonymizedReferences));
      ok("[A] rowsUpdatedは匿名化+循環遮断の合計", m.totals.rowsUpdated === m.anonymizedReferences.reduce((s, u) => s + u.count, 0) + m.cycleBreakUpdates.reduce((s, u) => s + u.count, 0));
      ok(
        "[A] FKで到達できない保持表(DEC-PURGE-02B未決)が明示される",
        ["audit_logs", "consents", "event_logs", "jobs", "outbox_events"].every((t) => m.retainedUnscopedTables.includes(t)),
        m.retainedUnscopedTables.join(","),
      );
    }
    ok("[A] ai_runs残存0", (await count(`SELECT COUNT(*)::bigint AS c FROM ai_runs WHERE id = $1`, a.aiRunId)) === 0);
    ok("[A] evidences残存0", (await count(`SELECT COUNT(*)::bigint AS c FROM evidences WHERE id = $1`, a.evidenceId)) === 0);
    ok("[A] formation_session_events残存0", (await count(`SELECT COUNT(*)::bigint AS c FROM formation_session_events WHERE workspace_id = $1`, a.workspaceId)) === 0);
    ok("[A] project_context_link_events残存0", (await count(`SELECT COUNT(*)::bigint AS c FROM project_context_link_events WHERE workspace_id = $1`, a.workspaceId)) === 0);
    ok("[A] user行・workspace行とも消える", (await count(`SELECT COUNT(*)::bigint AS c FROM users WHERE id = $1`, a.userId)) === 0 && (await count(`SELECT COUNT(*)::bigint AS c FROM workspaces WHERE id = $1`, a.workspaceId)) === 0);
    ok(
      "[A] audit_logsの行は保持され、actor_user_idだけがNULLになる(DEC-PURGE-02B未決の現行動作)",
      (await count(`SELECT COUNT(*)::bigint AS c FROM audit_logs WHERE target_id = $1 AND actor_user_id IS NULL`, a.userId)) === 1,
    );

    // ---------------------------------------------------------------- [B]
    const b = await makeUser("restored", daysAgo(40));
    const planB = await dryRunPurgeForUser({ userId: b.userId });
    ok("[B] 復元前のdry-runはELIGIBLE", planB.status === "ELIGIBLE");
    await db.user.update({ where: { id: b.userId }, data: { deletedAt: null } });
    const execB = await executePurgeForUser({ userId: b.userId }, { expected: planB.status === "ELIGIBLE" ? planB.manifest : null });
    ok("[B] dry-run後に復元(deletedAt=null)された対象はNOT_DELETEDで削除されない", execB.status === "NOT_DELETED", JSON.stringify(execB));
    ok("[B] 副作用0(user・Responsibility・audit actorとも残る)",
      (await count(`SELECT COUNT(*)::bigint AS c FROM users WHERE id = $1`, b.userId)) === 1 &&
      (await count(`SELECT COUNT(*)::bigint AS c FROM responsibilities WHERE id = $1`, b.responsibilityId)) === 1 &&
      (await count(`SELECT COUNT(*)::bigint AS c FROM audit_logs WHERE target_id = $1 AND actor_user_id = $1`, b.userId)) === 1);

    // ---------------------------------------------------------------- [C]
    const c = await makeUser("rewound", daysAgo(40));
    const planC = await dryRunPurgeForUser({ userId: c.userId });
    ok("[C] 変更前のdry-runはELIGIBLE", planC.status === "ELIGIBLE");
    await db.user.update({ where: { id: c.userId }, data: { deletedAt: daysAgo(29) } });
    const execC = await executePurgeForUser({ userId: c.userId });
    ok("[C] dry-run後にdeletedAtが30日未満へ変わった対象はRETENTION_NOT_ELAPSED", execC.status === "RETENTION_NOT_ELAPSED", JSON.stringify(execC));
    ok("[C] 副作用0", (await count(`SELECT COUNT(*)::bigint AS c FROM responsibilities WHERE id = $1`, c.responsibilityId)) === 1);

    // ---------------------------------------------------------------- [D]
    const now = await dbNow();
    const dJust = await makeUser("boundary-past", new Date(now.getTime() - 30 * DAY_MS - 5_000));
    const dNot = await makeUser("boundary-future", new Date(now.getTime() - 30 * DAY_MS + 60_000));
    const planDJust = await dryRunPurgeForUser({ userId: dJust.userId });
    const planDNot = await dryRunPurgeForUser({ userId: dNot.userId });
    ok("[D] DB時刻基準で30日+5秒前の削除は対象(ELIGIBLE)", planDJust.status === "ELIGIBLE", JSON.stringify(planDJust).slice(0, 200));
    ok("[D] DB時刻基準で30日-60秒前の削除は対象外(RETENTION_NOT_ELAPSED)", planDNot.status === "RETENTION_NOT_ELAPSED", JSON.stringify(planDNot).slice(0, 200));
    const execDNot = await executePurgeForUser({ userId: dNot.userId });
    ok("[D] 30日未満はserviceを直接呼んでも削除できない", execDNot.status === "RETENTION_NOT_ELAPSED" && (await count(`SELECT COUNT(*)::bigint AS c FROM users WHERE id = $1`, dNot.userId)) === 1);
    const execRecent = await executePurgeForUser({ userId: recent.userId });
    ok("[D] 29日前の削除ユーザーをserviceへ直接渡しても削除できない", execRecent.status === "RETENTION_NOT_ELAPSED", JSON.stringify(execRecent));

    // ---------------------------------------------------------------- [E]
    const forgedActive = await executePurgeForUser({ userId: active.userId, workspaceIds: [active.workspaceId], deletedAt: daysAgo(100), email: active.email } as unknown as { userId: string });
    ok("[E] 有効ユーザーのuserIdに偽のdeletedAtを添えて渡してもNOT_DELETED", forgedActive.status === "NOT_DELETED", JSON.stringify(forgedActive));
    const e = await makeUser("forged-ws", daysAgo(40));
    const execE = await executePurgeForUser({ userId: e.userId, workspaceIds: [active.workspaceId] } as unknown as { userId: string });
    ok("[E] 他人のworkspaceIdsを添えても、transaction内で再取得した本人のworkspaceだけを削除", execE.status === "PURGED" && execE.manifest.workspaceIds.join(",") === e.workspaceId, JSON.stringify(execE).slice(0, 300));
    ok("[E] 添えられた他人のworkspaceは無傷", (await count(`SELECT COUNT(*)::bigint AS c FROM workspaces WHERE id = $1`, active.workspaceId)) === 1 && (await count(`SELECT COUNT(*)::bigint AS c FROM responsibilities WHERE workspace_id = $1`, active.workspaceId)) === 1);
    const unknown = await executePurgeForUser({ userId: `00000000-0000-0000-0000-${RUN_ID.padEnd(12, "0").slice(0, 12)}` });
    ok("[E] 存在しないuserIdはNOT_FOUND", unknown.status === "NOT_FOUND", JSON.stringify(unknown));

    // ---------------------------------------------------------------- [F]
    const f = await makeUser("membership", daysAgo(40));
    const listed = (await findEligibleUsersForPurge()).find((x) => x.userId === f.userId);
    ok("[F] 一覧時点のworkspaceIdsは1件", listed?.workspaceIds.length === 1, JSON.stringify(listed?.workspaceIds));
    const planF = await dryRunPurgeForUser({ userId: f.userId });
    const ws2 = await db.workspace.create({ data: { name: "PURGE-02 membership-ws2", deletedAt: daysAgo(40) } });
    createdWorkspaceIds.push(ws2.id);
    await db.workspaceMember.create({ data: { workspaceId: ws2.id, userId: f.userId, role: "OWNER" } });
    const ws2Domain = await db.domain.create({ data: { workspaceId: ws2.id, name: "個人", kind: "PERSONAL" } });
    const ws2Resp = await db.responsibility.create({
      data: { workspaceId: ws2.id, domainId: ws2Domain.id, type: "TASK", title: "検証用(ws2)", status: "PLANNED", sourceKind: "USER", createdById: f.userId, updatedById: f.userId },
    });
    const execF = await executePurgeForUser({ userId: f.userId }, { expected: planF.status === "ELIGIBLE" ? planF.manifest : null });
    ok("[F] 一覧・dry-run後に追加されたmembershipもtransaction内の実値として削除対象になる", execF.status === "PURGED" && execF.manifest.workspaceIds.length === 2 && execF.manifest.workspaceIds.includes(ws2.id), JSON.stringify(execF).slice(0, 300));
    ok("[F] 追加workspaceの業務データも削除される", (await count(`SELECT COUNT(*)::bigint AS c FROM responsibilities WHERE id = $1`, ws2Resp.id)) === 0 && (await count(`SELECT COUNT(*)::bigint AS c FROM workspaces WHERE id = $1`, ws2.id)) === 0);
    ok("[F] dry-run(参考値)との差分がdriftとして記録される", execF.status === "PURGED" && (execF.drift ?? []).some((d) => d.key === "workspaceIds"), execF.status === "PURGED" ? JSON.stringify(execF.drift) : "");

    // ---------------------------------------------------------------- [G]
    const g = await makeUser("shared", daysAgo(40));
    const sharedMember = await db.workspaceMember.create({ data: { workspaceId: g.workspaceId, userId: active.userId, role: "MEMBER" } });
    const execG = await executePurgeForUser({ userId: g.userId });
    ok("[G] 本人以外のmemberが居るworkspaceはSHARED_WORKSPACEで削除しない", execG.status === "SHARED_WORKSPACE", JSON.stringify(execG));
    ok("[G] 副作用0", (await count(`SELECT COUNT(*)::bigint AS c FROM users WHERE id = $1`, g.userId)) === 1 && (await count(`SELECT COUNT(*)::bigint AS c FROM responsibilities WHERE id = $1`, g.responsibilityId)) === 1);
    await db.workspaceMember.delete({ where: { id: sharedMember.id } });

    // ---------------------------------------------------------------- [H]
    const h = await makeUser("locked", daysAgo(40));
    let releaseLock: () => void = () => undefined;
    const holdUntil = new Promise<void>((resolve) => {
      releaseLock = resolve;
    });
    let signalLocked: () => void = () => undefined;
    const lockedSignal = new Promise<void>((resolve) => {
      signalLocked = resolve;
    });
    const holder = db.$transaction(
      async (tx): Promise<void> => {
        await tx.$queryRawUnsafe(`SELECT "id" FROM "users" WHERE "id" = $1 FOR UPDATE`, h.userId);
        signalLocked();
        await holdUntil;
      },
      { timeout: 60_000, maxWait: 10_000 },
    );
    await lockedSignal;
    const execHLocked = await executePurgeForUser({ userId: h.userId }, { lockTimeoutMs: 500 });
    releaseLock();
    await holder;
    ok("[H] users行が他transactionにlockされている間はLOCK_CONFLICTで中止", execHLocked.status === "LOCK_CONFLICT", JSON.stringify(execHLocked));
    ok("[H] lock競合時に部分削除が残らない", (await count(`SELECT COUNT(*)::bigint AS c FROM ai_runs WHERE id = $1`, h.aiRunId)) === 1 && (await count(`SELECT COUNT(*)::bigint AS c FROM responsibilities WHERE id = $1`, h.responsibilityId)) === 1 && (await count(`SELECT COUNT(*)::bigint AS c FROM audit_logs WHERE target_id = $1 AND actor_user_id = $1`, h.userId)) === 1);
    const execHAfter = await executePurgeForUser({ userId: h.userId }, { lockTimeoutMs: 5_000 });
    ok("[H] lock解放後は同じ対象を削除できる", execHAfter.status === "PURGED", JSON.stringify(execHAfter).slice(0, 200));

    // ---------------------------------------------------------------- [I]
    const context = collectPurgeRunContext("verify-operator");
    const failingWriter = async (): Promise<void> => {
      throw new Error("injected audit failure");
    };
    const i = await makeUser("audit-fail", daysAgo(40));
    const outcomeI = await runPurgeItem({ userId: i.userId, context, auditWriter: failingWriter });
    ok("[I] 削除成功後の監査失敗でもpurgeSucceeded=trueのまま", outcomeI.purgeSucceeded && outcomeI.purgeStatus === "PURGED", JSON.stringify(outcomeI).slice(0, 300));
    ok("[I] 監査失敗はauditRecorded=false/auditErrorとして分離記録", !outcomeI.auditRecorded && (outcomeI.auditError ?? "").includes("injected audit failure"));
    ok("[I] 実際に物理削除は完了している", (await count(`SELECT COUNT(*)::bigint AS c FROM users WHERE id = $1`, i.userId)) === 0);
    const outcomeRefusedAuditFail = await runPurgeItem({ userId: active.userId, context, auditWriter: failingWriter });
    ok("[I] FAILURE監査の書込み失敗でも元の結果(NOT_DELETED)を上書きしない", outcomeRefusedAuditFail.purgeStatus === "NOT_DELETED" && !outcomeRefusedAuditFail.purgeSucceeded && !outcomeRefusedAuditFail.auditRecorded);
    const summaryAuditOnly = summarizePurgeOutcomes([outcomeI]);
    ok("[I] 削除成功+監査失敗はexit code 4(削除失敗には数えない)", summaryAuditOnly.exitCode === PURGE_EXIT.AUDIT_FAILED && summaryAuditOnly.purged === 1 && summaryAuditOnly.notPurged === 0, JSON.stringify(summaryAuditOnly));
    ok("[I] 未削除と監査失敗の両方でexit code 6", summarizePurgeOutcomes([outcomeI, outcomeRefusedAuditFail]).exitCode === (PURGE_EXIT.AUDIT_FAILED | PURGE_EXIT.NOT_PURGED));
    const j = await makeUser("audit-ok", daysAgo(40));
    const outcomeJ = await runPurgeItem({ userId: j.userId, context });
    ok("[I] 既定writerで削除成功と監査記録の両方が成功", outcomeJ.purgeSucceeded && outcomeJ.auditRecorded, JSON.stringify(outcomeJ).slice(0, 300));
    const auditJ = await db.auditLog.findFirst({ where: { targetId: j.userId, action: "ACCOUNT_PURGE_EXECUTED" } });
    ok("[I] AuditLogはactorUserId=null/actorType=SYSTEM/result=SUCCESS", auditJ?.actorUserId === null && auditJ?.actorType === "SYSTEM" && auditJ?.result === "SUCCESS", JSON.stringify(auditJ));
    ok(
      "[I] AuditLog.reasonにrun ID・OS user・host・自己申告operatorが入り、emailは入らない",
      !!auditJ?.reason && auditJ.reason.includes(`run=${context.runId}`) && auditJ.reason.includes(`osUser=${context.osUser}`) && auditJ.reason.includes("operator(self-declared)=verify-operator") && !auditJ.reason.includes(j.email) && !auditJ.reason.includes("@"),
      auditJ?.reason ?? "",
    );

    // ---------------------------------------------------------------- [K]
    const k = await makeUser("external-ref", daysAgo(40));
    const activeDomain = await db.domain.findFirstOrThrow({ where: { workspaceId: active.workspaceId } });
    const foreignResp = await db.responsibility.create({
      data: { workspaceId: active.workspaceId, domainId: activeDomain.id, type: "TASK", title: "他人workspace内でkが作成", status: "PLANNED", sourceKind: "USER", createdById: k.userId, updatedById: active.userId },
    });
    const planK = await dryRunPurgeForUser({ userId: k.userId });
    const execK = await executePurgeForUser({ userId: k.userId });
    ok("[K] dry-runでも外部NOT NULL参照を検出して拒否", planK.status === "EXTERNAL_REFERENCE", JSON.stringify(planK).slice(0, 300));
    ok("[K] 他人のworkspaceの行がNOT NULLで参照していればEXTERNAL_REFERENCEで削除しない", execK.status === "EXTERNAL_REFERENCE" && execK.detail.includes("responsibilities"), JSON.stringify(execK).slice(0, 300));
    ok("[K] 副作用0(本人・他人の行とも残る)", (await count(`SELECT COUNT(*)::bigint AS c FROM users WHERE id = $1`, k.userId)) === 1 && (await count(`SELECT COUNT(*)::bigint AS c FROM responsibilities WHERE id = $1`, foreignResp.id)) === 1);
    await db.responsibility.delete({ where: { id: foreignResp.id } });

    // ---------------------------------------------------------------- [J]
    ok("[J] 有効ユーザーは無傷(user・Responsibility・workspace)", (await count(`SELECT COUNT(*)::bigint AS c FROM users WHERE id = $1 AND deleted_at IS NULL`, active.userId)) === 1 && (await count(`SELECT COUNT(*)::bigint AS c FROM responsibilities WHERE workspace_id = $1`, active.workspaceId)) === 1);
    ok("[J] 30日未満の削除ユーザーは無傷", (await count(`SELECT COUNT(*)::bigint AS c FROM responsibilities WHERE id = $1`, recent.responsibilityId)) === 1);
  } finally {
    console.log("--- cleanup ---");
    cleanupErrors.push(...(await cleanupUsers(createdUserIds)));
    for (const workspaceId of createdWorkspaceIds) {
      const remainingWs = await db.workspace.findUnique({ where: { id: workspaceId }, select: { id: true } });
      if (remainingWs) cleanupErrors.push(`workspace残存: ${workspaceId}`);
    }
    const leftovers = await assertNoLeftoverFormationVerifyUsers(db, EMAIL_PREFIX);
    ok("[cleanup] cleanup後、専用fixtureユーザーの残存0件", leftovers.clean, JSON.stringify(leftovers.remainingUserIds));
    ok("[cleanup] cleanup中のエラー0件(workspace残存含む)", cleanupErrors.length === 0, cleanupErrors.join(" / "));
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
