#!/usr/bin/env node
/**
 * scripts/verify_gate_m1b42_legacy_cutover_guard.ts
 *
 * Gate M1-B4.2(範囲: 監査「B4.1即時完了・B4.2連続実装指示」のうち、B4.2受入
 * 項目7・8「cutover flag ONかつ対応Sessionありの場合、旧directgenerationを
 * server側で拒否し二重生成を防止/FormationSessionが存在しないlegacy Capture
 * だけ旧route fallbackを許可」に対応するバックエンドguardのみ)の受入証跡。
 *
 * [スコープの明示的な境界・正直な申し送り] このGateでは、旧route
 * (`/inferences/[id]/decision`)のserver側guard(`findFormationSessionForCapture`
 * 経由)のみを実装・検証する。B4.2で要求されているSession Review UI・
 * InboxClientの切替表示・Bulk ACCEPT/REJECTのFormation状態機械統合は、
 * `app/AGENTS.md`とNext.jsドキュメントの精読、および実際のUI設計判断
 * (コンポーネント構成、状態管理方式)を要する別範囲の作業であり、想像で
 * 済ませず正しく設計してから実装するため、このGateには含めない
 * (別途「B4.2b」として引き続き着手する)。
 *
 * このGateの対象(guardロジック自体)はHTTPサーバにもNext.jsランタイムにも
 * 依存しない(`findFormationSessionForCapture`を直接呼ぶ)ため、Gate M1-B4.1と
 * 同じ理由でHTTPを介さず検証できる。
 *
 * 実行方法:
 *   cd ~/projects/ismay/app
 *   npx tsx ../scripts/verify_gate_m1b42_legacy_cutover_guard.ts
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { installAiNetworkDenyGuard, selfTestAiNetworkDenyGuard } from "./lib/aiNetworkDenyGuard";
import { cleanupFormationVerifyUser, assertNoLeftoverFormationVerifyUsers } from "./lib/formationVerifyCleanup";

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
const EMAIL_PREFIX = "gate-m1b42-verify-";

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
  const denyGuard = installAiNetworkDenyGuard();
  const guardSelfTestPassed = await selfTestAiNetworkDenyGuard(denyGuard);
  ok("[非課金guard] AI network deny guardのpure self-testが機能する", guardSelfTestPassed);
  const deniedBaseline = denyGuard.deniedCallAttempts.length;
  if (!guardSelfTestPassed) {
    denyGuard.restore();
    console.log(`\n合計: ${passed} passed, ${failed} failed`);
    process.exitCode = 1;
    return;
  }

  const { db } = await import("../app/src/lib/db");
  const { findFormationSessionForCapture } = await import("../app/src/lib/formation/legacyProjectionResolver");

  const userIds: string[] = [];
  const orphans = await db.user.findMany({
    where: { email: { startsWith: EMAIL_PREFIX, endsWith: "@example.invalid" } },
    select: { id: true },
  });
  if (orphans.length > 0) {
    console.log(`[SWEEP] 過去実行の孤立テストユーザー${orphans.length}件を削除します...`);
    for (const o of orphans) {
      const result = await cleanupFormationVerifyUser(db, o.id);
      if (result.errors.length > 0) {
        console.log(`  [SWEEP] userId=${o.id} cleanup中に例外: ${result.errors.map((e) => e.step).join(",")}`);
      }
    }
  }

  async function makeFixture(suffix: string) {
    const email = `${EMAIL_PREFIX}${RUN_ID}-${suffix}@example.invalid`;
    const user = await db.user.create({
      data: { email, passwordHash: "not-a-real-hash-for-db-only-test", displayName: `Gate M1B42 ${suffix}` },
    });
    const workspace = await db.workspace.create({ data: { name: `Gate M1B42 Workspace ${suffix}` } });
    await db.workspaceMember.create({ data: { workspaceId: workspace.id, userId: user.id, role: "OWNER" } });
    const domain = await db.domain.create({ data: { workspaceId: workspace.id, name: "個人", kind: "PERSONAL" } });
    userIds.push(user.id);
    return { userId: user.id, workspaceId: workspace.id, domainId: domain.id };
  }

  async function makeCapture(fx: { workspaceId: string; domainId: string; userId: string }, rawText: string) {
    return db.capture.create({
      data: {
        workspaceId: fx.workspaceId,
        domainId: fx.domainId,
        createdById: fx.userId,
        sourceType: "TEXT",
        rawText,
        processingStatus: "READY",
      },
    });
  }

  try {
    const fx1 = await makeFixture("s1sessionbacked");
    const cap1 = await makeCapture(fx1, "Session付きCapture");
    await db.formationSession.create({
      data: {
        workspaceId: fx1.workspaceId,
        domainId: fx1.domainId,
        subjectUserId: fx1.userId,
        captureId: cap1.id,
        clientSessionKey: "s1",
        state: "REVIEW_READY",
      },
    });
    const found1 = await findFormationSessionForCapture(db as any, { captureId: cap1.id, workspaceId: fx1.workspaceId });
    ok(
      "[B4.2.1] FormationSessionが存在するCaptureはfindFormationSessionForCaptureが非nullを返す(=旧routeがguardで拒否する対象)",
      found1 !== null,
      JSON.stringify(found1),
    );

    const fx2 = await makeFixture("s2legacyonly");
    const cap2 = await makeCapture(fx2, "旧経路のみのCapture");
    const found2 = await findFormationSessionForCapture(db as any, { captureId: cap2.id, workspaceId: fx2.workspaceId });
    ok(
      "[B4.2.2] FormationSessionが存在しないCaptureはnullを返す(=旧route fallbackが許可される、受入項目8)",
      found2 === null,
      JSON.stringify(found2),
    );

    const fx3 = await makeFixture("s3tenant");
    const found3 = await findFormationSessionForCapture(db as any, { captureId: cap1.id, workspaceId: fx3.workspaceId });
    ok(
      "[B4.2.3] workspaceを跨いだ照合は行われない(別workspaceIdでは同じcaptureIdでもnull)",
      found3 === null,
      JSON.stringify(found3),
    );

    ok(
      "[非課金guard] scenario実行中、AI provider hostへの通信試行は0件(self-test自身の既知の1件を除く)",
      denyGuard.deniedCallAttempts.length === deniedBaseline,
      `total=${denyGuard.deniedCallAttempts.length}`,
    );
  } finally {
    const { db: dbForCleanup } = await import("../app/src/lib/db");
    const cleanupErrors: { step: string; error: unknown }[] = [];
    for (const uid of userIds) {
      const result = await cleanupFormationVerifyUser(dbForCleanup, uid);
      cleanupErrors.push(...result.errors);
    }
    ok("[cleanup] cleanup処理中に例外が0件である", cleanupErrors.length === 0, cleanupErrors.map((e) => e.step).join(","));
    const leftover = await assertNoLeftoverFormationVerifyUsers(dbForCleanup, EMAIL_PREFIX);
    ok("[cleanup] cleanup後、test prefixのUserが0件である", leftover.clean, leftover.remainingUserIds.join(","));
  }

  denyGuard.restore();

  console.log(`\n合計: ${passed} passed, ${failed} failed`);
  if (failed > 0) {
    console.log("失敗一覧:");
    for (const f of failures) console.log(`  - ${f}`);
    process.exitCode = 1;
  }
}

main()
  .then(() => process.exit(process.exitCode ?? 0))
  .catch((err) => {
    console.error("予期しない例外:", err);
    process.exit(1);
  });
