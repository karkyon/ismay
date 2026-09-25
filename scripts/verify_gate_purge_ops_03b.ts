#!/usr/bin/env node
/**
 * scripts/verify_gate_purge_ops_03b.ts
 *
 * PURGE-OPS-03B(運用台帳・Object Storage段)実DB+実Object Storage受入試験。
 * 出典: DEC-PURGE-02B §7.1(2026-09-25利用者決定)の順序
 *   1) 台帳snapshot 2) MinIO object削除 3) object不存在を確認 4) DB物理削除
 *   5) 匿名化・監査記録 6) PurgeRun完了
 *
 * 検証内容:
 *   [O1] 順序: object削除時点でuser行・DBデータがまだ存在し、DB削除時点でobjectは不存在。
 *        DB参照(音声・画像)と接頭辞のみの孤立objectの両方を回収。台帳はCOMPLETED、
 *        object_keyは墨消し(hashのみ)、planned/actual digest一致、監査SUCCESS、exit 0。
 *   [O2] object削除の障害注入: DBは無変更・objectも残存・RETRY_WAIT。障害解消後の再開で完了。
 *   [O3] 不存在を確認できない(削除が効かない)場合: DBへ進まずretry→max_attemptsでDEAD_LETTER、FAILURE監査。
 *   [O4] 実行前に復元された対象: SKIPPED(NOT_DELETED)。objectは一切削除されない。
 *   [O5] lease: 有効leaseのitemは他ownerが取得できない。期限切れは再取得できる。並行runnerでも各item1回。
 *   [O6] 監査記録の障害注入: DB_PURGEDのままRETRY_WAIT(exit bit 4)。再開時はDB段を再実行せず監査のみ。
 *   [O7] commit後に現れた遅延objectを工程6で回収(LATE_PREFIX_LISTING)。
 *   [O8] run plan digestが各itemのdry-run digestから再計算した値と一致。
 *   [O9] 保持理由未登録の非scope表が存在するとPurgeは実行を拒否する(FKが無いから保持、を認めない)。
 *   [O10] 台帳にemailが残らない。cleanup後の残存0、AI network実通信0。
 *
 * 前提: Object Storage(MinIO、lib/storage.tsと同じMINIO_*環境変数)に接続できること。
 *
 * 実行方法:
 *   cd ~/projects/ismay/app
 *   npx tsx ../scripts/verify_gate_purge_ops_03b.ts
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
const EMAIL_PREFIX = "gate-purge-ops-03b-verify-";
const UNSCOPED_TABLE_PREFIX = "_verify_purge_unscoped_";
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
  const { executePurgeForUser, computePurgeScope } = await import("../app/src/lib/admin/purgeJob");
  const { createPurgeRun, processPurgeRun, claimNextPurgeItem, getPurgeRunSummary, computePlanDigest } = await import("../app/src/lib/admin/purgeLedger");
  const { collectPurgeRunContext } = await import("../app/src/lib/admin/purgeRunner");
  const { PURGE_EXIT } = await import("../app/src/lib/admin/purgeReporting");
  const { workspaceObjectPrefix } = await import("../app/src/lib/admin/purgeObjects");
  const storage = await import("../app/src/lib/storage");
  type Store = ReturnType<typeof storage.createMinioPurgeObjectStore>;
  const base: Store = storage.createMinioPurgeObjectStore();

  const count = async (sql: string, ...values: unknown[]): Promise<number> =>
    Number((await db.$queryRawUnsafe<{ c: bigint }[]>(sql, ...values))[0]?.c ?? 0);

  // 前提: Object Storageへ接続できること(できなければ受入不能としてfatal)。
  await storage.uploadAudioObject({ objectKey: `verify-03b-probe/${RUN_ID}`, buffer: Buffer.from("probe"), contentType: "text/plain" });
  await base.remove([`verify-03b-probe/${RUN_ID}`]);

  const createdUserIds: string[] = [];
  const createdWorkspaceIds: string[] = [];
  const createdRunIds: string[] = [];

  /** 障害注入・順序記録用のstore wrapper。 */
  function instrument(opts: {
    failRemoveTimes?: number;
    removeNoop?: boolean;
    onRemove?: (keys: string[]) => Promise<void>;
    onList?: (prefix: string) => Promise<void>;
  }): Store {
    let failures = opts.failRemoveTimes ?? 0;
    return {
      bucket: base.bucket,
      async list(prefix: string) {
        if (opts.onList) await opts.onList(prefix);
        return base.list(prefix);
      },
      async remove(keys: string[]) {
        if (opts.onRemove) await opts.onRemove(keys);
        if (failures > 0) {
          failures--;
          throw new Error("injected remove failure");
        }
        if (opts.removeNoop) return;
        return base.remove(keys);
      },
      exists: (key: string) => base.exists(key),
    };
  }

  async function makeUser(suffix: string, deletedAt: Date | null) {
    const email = `${EMAIL_PREFIX}${RUN_ID}-${suffix}@example.invalid`;
    const user = await db.user.create({ data: { email, passwordHash: "not-a-real-hash-for-db-only-test", displayName: `PURGE-03B ${suffix}`, deletedAt } });
    createdUserIds.push(user.id);
    const ws = await db.workspace.create({ data: { name: `PURGE-03B ${suffix}`, deletedAt } });
    createdWorkspaceIds.push(ws.id);
    await db.workspaceMember.create({ data: { workspaceId: ws.id, userId: user.id, role: "OWNER" } });
    const voice = await db.capture.create({ data: { workspaceId: ws.id, createdById: user.id, sourceType: "VOICE" } });
    const audioKey = storage.buildAudioObjectKey(ws.id, voice.id, "meeting.m4a");
    await storage.uploadAudioObject({ objectKey: audioKey, buffer: Buffer.from(`audio-${suffix}`), contentType: "audio/mp4" });
    await db.capture.update({ where: { id: voice.id }, data: { audioObjectKey: audioKey } });
    const image = await db.capture.create({ data: { workspaceId: ws.id, createdById: user.id, sourceType: "IMAGE" } });
    const imageKey = storage.buildImageObjectKey(ws.id, image.id, 0, "page.jpg");
    await storage.uploadImageObject({ objectKey: imageKey, buffer: Buffer.from(`image-${suffix}`), contentType: "image/jpeg" });
    await db.captureImage.create({ data: { captureId: image.id, objectKey: imageKey, pageIndex: 0 } });
    // DBから参照されない孤立object(upload後のDB更新失敗を模擬)。
    const orphanKey = `${ws.id}/orphan-${suffix}/leftover.bin`;
    await storage.uploadAudioObject({ objectKey: orphanKey, buffer: Buffer.from("orphan"), contentType: "application/octet-stream" });
    return { userId: user.id, email, workspaceId: ws.id, keys: [audioKey, imageKey, orphanKey] };
  }

  async function objectsExist(keys: string[]): Promise<number> {
    let n = 0;
    for (const k of keys) if (await base.exists(k)) n++;
    return n;
  }
  async function forceDue(runId: string): Promise<void> {
    await db.purgeItem.updateMany({ where: { runId, status: "RETRY_WAIT" }, data: { nextAttemptAt: new Date(Date.now() - 1000) } });
  }
  const newContext = (label: string) => collectPurgeRunContext(`verify-03b-${label}`);

  async function cleanupAll(): Promise<string[]> {
    const errors: string[] = [];
    for (const userId of createdUserIds) {
      if (!(await db.user.findUnique({ where: { id: userId }, select: { id: true } }))) continue;
      await db.workspaceMember.deleteMany({ where: { userId: { not: userId }, workspace: { members: { some: { userId } } } } });
      await db.user.update({ where: { id: userId }, data: { deletedAt: new Date(Date.now() - 60 * DAY_MS) } });
      const r = await executePurgeForUser({ userId });
      if (r.status !== "PURGED") errors.push(`${userId}: ${r.status} ${r.detail}`);
    }
    for (const ws of createdWorkspaceIds) {
      const left = await base.list(workspaceObjectPrefix(ws));
      if (left.length > 0) await base.remove(left);
      if ((await base.list(workspaceObjectPrefix(ws))).length > 0) errors.push(`object残存: ${ws}`);
    }
    await db.purgeItemObject.deleteMany({ where: { item: { runId: { in: createdRunIds } } } });
    await db.purgeItem.deleteMany({ where: { runId: { in: createdRunIds } } });
    await db.purgeRun.deleteMany({ where: { id: { in: createdRunIds } } });
    await db.auditLog.deleteMany({ where: { targetId: { in: createdUserIds } } });
    const tables = await db.$queryRawUnsafe<{ t: string }[]>(`SELECT tablename AS t FROM pg_tables WHERE schemaname = 'public' AND tablename LIKE '\\_verify\\_purge\\_unscoped\\_%'`);
    for (const { t } of tables) await db.$executeRawUnsafe(`DROP TABLE IF EXISTS "${t}"`);
    return errors;
  }

  // SWEEP: 過去実行の残骸
  const orphans = await db.user.findMany({ where: { email: { startsWith: EMAIL_PREFIX, endsWith: "@example.invalid" } }, select: { id: true } });
  const oldTables = await db.$queryRawUnsafe<{ t: string }[]>(`SELECT tablename AS t FROM pg_tables WHERE schemaname = 'public' AND tablename LIKE '\\_verify\\_purge\\_unscoped\\_%'`);
  for (const { t } of oldTables) await db.$executeRawUnsafe(`DROP TABLE IF EXISTS "${t}"`);
  if (orphans.length > 0) {
    console.log(`[SWEEP] 過去実行の孤立テストユーザー${orphans.length}件を削除します...`);
    for (const o of orphans) {
      await db.workspaceMember.deleteMany({ where: { userId: { not: o.id }, workspace: { members: { some: { userId: o.id } } } } });
      await db.user.update({ where: { id: o.id }, data: { deletedAt: new Date(Date.now() - 60 * DAY_MS) } });
      await executePurgeForUser({ userId: o.id });
    }
  }

  const cleanupErrors: string[] = [];
  try {
    console.log("=== PURGE-OPS-03B 実DB+Object Storage受入試験 ===");
    const active = await makeUser("active", null);

    // ------------------------------------------------------------ [O1]
    const u1 = await makeUser("order", new Date(Date.now() - 40 * DAY_MS));
    const removeObservations: { userRows: number; captures: number }[] = [];
    const store1 = instrument({
      onRemove: async () => {
        removeObservations.push({
          userRows: await count(`SELECT COUNT(*)::bigint AS c FROM users WHERE id = $1`, u1.userId),
          captures: await count(`SELECT COUNT(*)::bigint AS c FROM captures WHERE workspace_id = $1`, u1.workspaceId),
        });
      },
    });
    const ctx1 = newContext("o1");
    const run1 = await createPurgeRun({ userIds: [u1.userId], context: ctx1 });
    createdRunIds.push(run1);
    const summary1 = await processPurgeRun({ runId: run1, store: store1, context: ctx1 });
    ok("[O1] object削除はDB削除より前(削除時点でuser行とCaptureがまだ存在)", removeObservations.length > 0 && removeObservations.every((o) => o.userRows === 1 && o.captures === 2), JSON.stringify(removeObservations));
    ok("[O1] 全object(音声・画像・孤立)が不存在", (await objectsExist(u1.keys)) === 0 && (await base.list(workspaceObjectPrefix(u1.workspaceId))).length === 0);
    ok("[O1] DBも物理削除済み(user・workspace)", (await count(`SELECT COUNT(*)::bigint AS c FROM users WHERE id = $1`, u1.userId)) === 0 && (await count(`SELECT COUNT(*)::bigint AS c FROM workspaces WHERE id = $1`, u1.workspaceId)) === 0);
    const item1 = await db.purgeItem.findFirstOrThrow({ where: { runId: run1 }, include: { objects: true } });
    ok("[O1] itemはCOMPLETED/COMPLETEDで監査記録済み", item1.status === "COMPLETED" && item1.phase === "COMPLETED" && item1.auditRecorded, `${item1.status}/${item1.phase}`);
    ok("[O1] 台帳のobjectは3件ともVERIFIED_ABSENT", item1.objects.length === 3 && item1.objects.every((o) => o.status === "VERIFIED_ABSENT" && o.verifiedAt !== null));
    ok("[O1] DB参照(音声・画像)2件と接頭辞のみの孤立1件を区別して記録", item1.objects.filter((o) => o.source === "DB_REFERENCE").length === 2 && item1.objects.filter((o) => o.source === "PREFIX_LISTING").length === 1);
    ok("[O1] 完了後object_keyは墨消しされhashのみ残る", item1.objects.every((o) => o.objectKey === null && /^[0-9a-f]{64}$/.test(o.objectKeyHash)));
    ok("[O1] dry-run(planned)と実行(actual)のdigestが一致しdrift 0", !!item1.plannedDigest && item1.plannedDigest === item1.actualDigest && item1.driftCount === 0, `${item1.plannedDigest} / ${item1.actualDigest}`);
    ok("[O1] run COMPLETED・exit code 0", summary1.runStatus === "COMPLETED" && summary1.exitCode === PURGE_EXIT.OK, JSON.stringify(summary1));
    const audit1 = await db.auditLog.findFirst({ where: { targetId: u1.userId, action: "ACCOUNT_PURGE_EXECUTED" } });
    ok("[O1] 監査はSUCCESS・SYSTEM・run IDつき", audit1?.result === "SUCCESS" && audit1.actorType === "SYSTEM" && audit1.actorUserId === null && (audit1.reason ?? "").includes(`run=${run1}`), audit1?.reason ?? "");

    // ------------------------------------------------------------ [O2]
    const u2 = await makeUser("remove-fail", new Date(Date.now() - 40 * DAY_MS));
    const ctx2 = newContext("o2");
    const run2 = await createPurgeRun({ userIds: [u2.userId], context: ctx2 });
    createdRunIds.push(run2);
    const s2a = await processPurgeRun({ runId: run2, store: instrument({ failRemoveTimes: 1 }), context: ctx2 });
    const item2a = await db.purgeItem.findFirstOrThrow({ where: { runId: run2 }, include: { objects: true } });
    ok("[O2] object削除失敗でRETRY_WAIT(phaseは台帳snapshotまで)", item2a.status === "RETRY_WAIT" && item2a.phase === "OBJECTS_SNAPSHOTTED" && (item2a.lastError ?? "").includes("injected remove failure"), `${item2a.status}/${item2a.phase} ${item2a.lastError}`);
    ok("[O2] DBは無変更(user・Captureが残る)", (await count(`SELECT COUNT(*)::bigint AS c FROM users WHERE id = $1`, u2.userId)) === 1 && (await count(`SELECT COUNT(*)::bigint AS c FROM captures WHERE workspace_id = $1`, u2.workspaceId)) === 2);
    ok("[O2] objectも残る・台帳はPENDINGで3件記録済み", (await objectsExist(u2.keys)) === 3 && item2a.objects.length === 3 && item2a.objects.every((o) => o.status === "PENDING"));
    ok("[O2] 未完了があるためexit code bit 2・次回試行時刻が未来", (s2a.exitCode & PURGE_EXIT.NOT_PURGED) !== 0 && !!item2a.nextAttemptAt && item2a.nextAttemptAt.getTime() > Date.now());
    const s2b = await processPurgeRun({ runId: run2, store: base, context: ctx2 });
    ok("[O2] backoff期限前の再開では処理されない", (await db.purgeItem.findFirstOrThrow({ where: { runId: run2 } })).status === "RETRY_WAIT" && s2b.runStatus === "RUNNING");
    await forceDue(run2);
    const s2c = await processPurgeRun({ runId: run2, store: base, context: ctx2 });
    const item2c = await db.purgeItem.findFirstOrThrow({ where: { runId: run2 } });
    ok("[O2] 障害解消後の再開で完了(attempts=2)", item2c.status === "COMPLETED" && item2c.attempts === 2 && s2c.exitCode === PURGE_EXIT.OK, `${item2c.status} attempts=${item2c.attempts}`);
    ok("[O2] 再開後はobjectもDBも消える", (await objectsExist(u2.keys)) === 0 && (await count(`SELECT COUNT(*)::bigint AS c FROM users WHERE id = $1`, u2.userId)) === 0);

    // ------------------------------------------------------------ [O3]
    const u3 = await makeUser("verify-fail", new Date(Date.now() - 40 * DAY_MS));
    const ctx3 = newContext("o3");
    const run3 = await createPurgeRun({ userIds: [u3.userId], context: ctx3, maxAttempts: 2 });
    createdRunIds.push(run3);
    const noop = instrument({ removeNoop: true });
    await processPurgeRun({ runId: run3, store: noop, context: ctx3 });
    const item3a = await db.purgeItem.findFirstOrThrow({ where: { runId: run3 } });
    ok("[O3] 不存在を確認できなければDBへ進まずRETRY_WAIT", item3a.status === "RETRY_WAIT" && item3a.phase === "OBJECTS_DELETED" && (item3a.lastError ?? "").includes("残っています"), `${item3a.status}/${item3a.phase} ${item3a.lastError}`);
    ok("[O3] DBは無変更", (await count(`SELECT COUNT(*)::bigint AS c FROM users WHERE id = $1`, u3.userId)) === 1);
    await forceDue(run3);
    const s3 = await processPurgeRun({ runId: run3, store: noop, context: ctx3 });
    const item3b = await db.purgeItem.findFirstOrThrow({ where: { runId: run3 } });
    ok("[O3] max_attempts到達でDEAD_LETTER", item3b.status === "DEAD_LETTER" && item3b.attempts === 2, `${item3b.status} attempts=${item3b.attempts}`);
    ok("[O3] DEAD_LETTERでもDBは無変更・FAILURE監査を記録", (await count(`SELECT COUNT(*)::bigint AS c FROM users WHERE id = $1`, u3.userId)) === 1 && (await db.auditLog.count({ where: { targetId: u3.userId, action: "ACCOUNT_PURGE_EXECUTED", result: "FAILURE" } })) === 1);
    ok("[O3] runはCOMPLETED_WITH_EXCEPTIONS・exit bit 2", s3.runStatus === "COMPLETED_WITH_EXCEPTIONS" && (s3.exitCode & PURGE_EXIT.NOT_PURGED) !== 0, JSON.stringify(s3));

    // ------------------------------------------------------------ [O4]
    const u4 = await makeUser("restored", new Date(Date.now() - 40 * DAY_MS));
    const ctx4 = newContext("o4");
    const run4 = await createPurgeRun({ userIds: [u4.userId], context: ctx4 });
    createdRunIds.push(run4);
    await db.user.update({ where: { id: u4.userId }, data: { deletedAt: null } });
    let removeCalledFor4 = false;
    await processPurgeRun({ runId: run4, store: instrument({ onRemove: async () => { removeCalledFor4 = true; } }), context: ctx4 });
    const item4 = await db.purgeItem.findFirstOrThrow({ where: { runId: run4 }, include: { objects: true } });
    ok("[O4] 実行前に復元された対象はSKIPPED(NOT_DELETED)", item4.status === "SKIPPED" && item4.refusalStatus === "NOT_DELETED", `${item4.status} ${item4.refusalStatus}`);
    ok("[O4] 復元された対象のobjectは一切削除されない(remove未呼出・3件とも存在・台帳0件)", !removeCalledFor4 && (await objectsExist(u4.keys)) === 3 && item4.objects.length === 0);

    // ------------------------------------------------------------ [O5]
    const u5a = await makeUser("lease-a", new Date(Date.now() - 40 * DAY_MS));
    const u5b = await makeUser("lease-b", new Date(Date.now() - 40 * DAY_MS));
    const ctx5 = newContext("o5");
    const run5 = await createPurgeRun({ userIds: [u5a.userId, u5b.userId], context: ctx5 });
    createdRunIds.push(run5);
    const claimA = await claimNextPurgeItem(run5, "owner-A", 60_000);
    const claimB = await claimNextPurgeItem(run5, "owner-B", 60_000);
    const claimC = await claimNextPurgeItem(run5, "owner-C", 60_000);
    ok("[O5] 2件のitemは別々のownerが1件ずつ取得し、3人目は取得できない", !!claimA && !!claimB && claimA.id !== claimB.id && claimC === null);
    await db.purgeItem.update({ where: { id: claimA!.id }, data: { leaseExpiresAt: new Date(Date.now() - 1000) } });
    const reclaim = await claimNextPurgeItem(run5, "owner-D", 60_000);
    ok("[O5] lease期限切れのitemは別ownerが再取得できる(attempts増加)", reclaim?.id === claimA!.id && reclaim.attempts === 2, JSON.stringify(reclaim));
    await db.purgeItem.updateMany({ where: { runId: run5 }, data: { status: "PENDING", leaseOwner: null, leaseExpiresAt: null, attempts: 0 } });
    const [r5x, r5y] = await Promise.all([
      processPurgeRun({ runId: run5, store: base, context: ctx5 }),
      processPurgeRun({ runId: run5, store: base, context: ctx5 }),
    ]);
    const items5 = await db.purgeItem.findMany({ where: { runId: run5 } });
    ok("[O5] 並行runnerでも各itemは1回だけ処理されて完了", items5.every((i) => i.status === "COMPLETED" && i.attempts === 1), JSON.stringify(items5.map((i) => [i.status, i.attempts])));
    ok("[O5] 並行runnerの最終集計はCOMPLETED", [r5x.runStatus, r5y.runStatus].includes("COMPLETED") && (await getPurgeRunSummary(run5)).runStatus === "COMPLETED");

    // ------------------------------------------------------------ [O6]
    const u6 = await makeUser("audit-fail", new Date(Date.now() - 40 * DAY_MS));
    const ctx6 = newContext("o6");
    const run6 = await createPurgeRun({ userIds: [u6.userId], context: ctx6 });
    createdRunIds.push(run6);
    let auditCalls = 0;
    const s6a = await processPurgeRun({
      runId: run6,
      store: base,
      context: ctx6,
      auditWriter: async () => {
        auditCalls++;
        throw new Error("injected audit failure");
      },
    });
    const item6a = await db.purgeItem.findFirstOrThrow({ where: { runId: run6 } });
    ok("[O6] 監査失敗: DBは削除済みでphase=DB_PURGED、status=RETRY_WAIT", item6a.phase === "DB_PURGED" && item6a.status === "RETRY_WAIT" && !item6a.auditRecorded && (await count(`SELECT COUNT(*)::bigint AS c FROM users WHERE id = $1`, u6.userId)) === 0, `${item6a.status}/${item6a.phase}`);
    ok("[O6] exit codeに監査失敗bit(4)が立つ", (s6a.exitCode & PURGE_EXIT.AUDIT_FAILED) !== 0 && s6a.auditPending === 1, JSON.stringify(s6a));
    await forceDue(run6);
    let writerCallsOk = 0;
    const s6b = await processPurgeRun({
      runId: run6,
      store: base,
      context: ctx6,
      auditWriter: async (entry) => {
        writerCallsOk++;
        await db.auditLog.create({ data: { actorUserId: null, actorType: "SYSTEM", action: "ACCOUNT_PURGE_EXECUTED", targetType: "User", targetId: entry.targetUserId, result: entry.result, reason: entry.reason } });
      },
    });
    const item6b = await db.purgeItem.findFirstOrThrow({ where: { runId: run6 } });
    ok("[O6] 再開では監査だけが実行されCOMPLETED(DB段は再実行しない=actual digest不変)", item6b.status === "COMPLETED" && item6b.auditRecorded && item6b.actualDigest === item6a.actualDigest && writerCallsOk === 1 && auditCalls === 1, `${item6b.status} calls=${writerCallsOk}`);
    ok("[O6] 再開後はexit code 0", s6b.exitCode === PURGE_EXIT.OK);

    // ------------------------------------------------------------ [O7]
    const u7 = await makeUser("late", new Date(Date.now() - 40 * DAY_MS));
    const ctx7 = newContext("o7");
    const run7 = await createPurgeRun({ userIds: [u7.userId], context: ctx7 });
    createdRunIds.push(run7);
    const lateKey = `${u7.workspaceId}/late-upload/after-commit.bin`;
    let injected = false;
    const store7 = instrument({
      onList: async () => {
        if (injected) return;
        const userGone = (await count(`SELECT COUNT(*)::bigint AS c FROM users WHERE id = $1`, u7.userId)) === 0;
        if (userGone) {
          injected = true;
          await storage.uploadAudioObject({ objectKey: lateKey, buffer: Buffer.from("late"), contentType: "application/octet-stream" });
        }
      },
    });
    await processPurgeRun({ runId: run7, store: store7, context: ctx7 });
    const item7 = await db.purgeItem.findFirstOrThrow({ where: { runId: run7 }, include: { objects: true } });
    ok("[O7] commit後に現れたobjectを工程6で回収(lateObjectsDeleted=1・LATE_PREFIX_LISTING)", injected && item7.status === "COMPLETED" && item7.lateObjectsDeleted === 1 && item7.objects.some((o) => o.source === "LATE_PREFIX_LISTING"), `${item7.status} late=${item7.lateObjectsDeleted}`);
    ok("[O7] 遅延objectも不存在", !(await base.exists(lateKey)));

    // ------------------------------------------------------------ [O8]
    for (const runId of [run1, run5]) {
      const run = await db.purgeRun.findUniqueOrThrow({ where: { id: runId }, include: { items: true } });
      const recomputed = computePlanDigest(run.items.map((i) => ({ userId: i.userId, plannedDigest: i.plannedDigest, refusalStatus: i.plannedDigest ? null : i.refusalStatus })));
      ok(`[O8] run plan digestは各itemのdry-run digestから再計算した値と一致(${runId.slice(0, 8)})`, run.planDigest === recomputed);
    }

    // ------------------------------------------------------------ [O9]
    const unscopedTable = `${UNSCOPED_TABLE_PREFIX}${RUN_ID}`;
    await db.$executeRawUnsafe(`CREATE TABLE "${unscopedTable}" ("id" TEXT PRIMARY KEY, "note" TEXT)`);
    let refusedMessage = "";
    try {
      await computePurgeScope();
    } catch (e) {
      refusedMessage = e instanceof Error ? e.message : String(e);
    } finally {
      await db.$executeRawUnsafe(`DROP TABLE IF EXISTS "${unscopedTable}"`);
    }
    ok("[O9] 保持理由未登録の非scope表があるとPurgeは実行を拒否する", refusedMessage.includes(unscopedTable) && refusedMessage.includes("PURGE_RETENTION_POLICY"), refusedMessage.slice(0, 200));
    ok("[O9] 表を除去すれば再び実行可能", (await computePurgeScope()).retainedUnscopedTables.length > 0);

    // ------------------------------------------------------------ [O10]
    const ledgerText = JSON.stringify(await db.purgeItem.findMany({ where: { runId: { in: createdRunIds } } })) + JSON.stringify(await db.purgeRun.findMany({ where: { id: { in: createdRunIds } } }));
    ok("[O10] 台帳(purge_runs/purge_items)にfixtureのemailが残らない", !ledgerText.includes(EMAIL_PREFIX) && !ledgerText.includes("@example.invalid"));
    ok("[O10] 有効ユーザーのobjectとDBは無傷", (await objectsExist(active.keys)) === 3 && (await count(`SELECT COUNT(*)::bigint AS c FROM captures WHERE workspace_id = $1`, active.workspaceId)) === 2);
  } finally {
    console.log("--- cleanup ---");
    cleanupErrors.push(...(await cleanupAll()));
    const remaining = await db.user.count({ where: { email: { startsWith: EMAIL_PREFIX, endsWith: "@example.invalid" } } });
    ok("[cleanup] 専用fixtureユーザーの残存0件", remaining === 0, `remaining=${remaining}`);
    ok("[cleanup] cleanup中のエラー0件(object残存含む)", cleanupErrors.length === 0, cleanupErrors.join(" / "));
    ok("[cleanup] fixture runの台帳行の残存0件", (await db.purgeItem.count({ where: { runId: { in: createdRunIds } } })) === 0);
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
