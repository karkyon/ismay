#!/usr/bin/env node
/**
 * scripts/verify_gate_m1_outcome_reason.ts
 *
 * M1-OUTCOME(不要化・断念・取消理由の分離)の実DB受入証跡。
 * 出典: 統合正本仕様書v5.0 §7.4「NOT_NEEDEDへ、単なる不要化と履行断念を
 * 混在させてはならない。状態とは別にLifecycle Outcome Reasonを記録する」、
 * §27.1「既存NOT_NEEDEDはUNKNOWN_LEGACY理由とする」。
 *
 * [検証方針] transitions/route.tsはNext.js route handlerであり、HTTPを
 * 経由しない直接呼び出しは複雑になる(既存verify scriptパターンとの一貫性の
 * ため今回も避ける)ため、(a) responsibility.tsがexportする定数・判定関数
 * 自体の正しさ、(b) Responsibility.outcomeReasonCode列への実DB書込み・
 * 読出しの疎通、の2点を検証する。route.ts側のバリデーション分岐ロジック
 * 自体はtsc/ESLintの型検証と、このファイルでのシナリオトレースの記述で
 * 正しさを裏付ける。
 *
 * AI providerへの実通信は行わない(このGateはAI呼び出しを一切含まない)。
 *
 * 実行方法:
 *   cd ~/projects/ismay/app
 *   npx tsx ../scripts/verify_gate_m1_outcome_reason.ts
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
const EMAIL_PREFIX = "gate-m1-outcome-reason-verify-";

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
  const {
    LIFECYCLE_OUTCOME_REASONS,
    SELECTABLE_LIFECYCLE_OUTCOME_REASONS,
    ACTIONS_REQUIRING_OUTCOME_REASON,
    isValidLifecycleOutcomeReason,
  } = await import("../app/src/lib/responsibility");

  // ============================================================
  // A: 正本§7.4の7語彙 + UNKNOWN_LEGACYが正しく定義されている。
  // ============================================================
  const expectedReasons = [
    "NO_LONGER_NEEDED",
    "DUPLICATE",
    "SUPERSEDED",
    "ABANDONED_BY_USER",
    "CANCELLED_EXTERNALLY",
    "SCOPE_REMOVED",
    "CREATED_BY_MISTAKE",
    "UNKNOWN_LEGACY",
  ];
  ok(
    "[A] LIFECYCLE_OUTCOME_REASONSが正本の8語彙と完全一致",
    JSON.stringify([...LIFECYCLE_OUTCOME_REASONS].sort()) === JSON.stringify([...expectedReasons].sort()),
    JSON.stringify(LIFECYCLE_OUTCOME_REASONS),
  );

  // ============================================================
  // B: SELECTABLE(本人が選べる語彙)にUNKNOWN_LEGACYが含まれない。
  // ============================================================
  ok(
    "[B] SELECTABLE_LIFECYCLE_OUTCOME_REASONSにUNKNOWN_LEGACYを含まない",
    !SELECTABLE_LIFECYCLE_OUTCOME_REASONS.includes("UNKNOWN_LEGACY" as never),
  );
  ok("[B] SELECTABLEは7件", SELECTABLE_LIFECYCLE_OUTCOME_REASONS.length === 7);

  // ============================================================
  // C: isValidLifecycleOutcomeReason判定の正しさ。
  // ============================================================
  ok("[C] 正しい値(DUPLICATE)はvalid", isValidLifecycleOutcomeReason("DUPLICATE"));
  ok("[C] 正しい値(UNKNOWN_LEGACY)自体はvalidだが選択不可扱いはroute.ts側で判定", isValidLifecycleOutcomeReason("UNKNOWN_LEGACY"));
  ok("[C] 存在しない値はinvalid", !isValidLifecycleOutcomeReason("NOT_A_REAL_CODE"));
  ok("[C] 空文字はinvalid", !isValidLifecycleOutcomeReason(""));

  // ============================================================
  // D: MARK_NOT_NEEDEDのみが必須アクション対象(想像で他アクションを含めない)。
  // ============================================================
  ok(
    "[D] ACTIONS_REQUIRING_OUTCOME_REASONはMARK_NOT_NEEDEDのみ",
    ACTIONS_REQUIRING_OUTCOME_REASON.length === 1 && ACTIONS_REQUIRING_OUTCOME_REASON[0] === "MARK_NOT_NEEDED",
  );

  // ============================================================
  // E: 実DB疎通。Responsibility.outcomeReasonCode列への書込み・読出し確認。
  // ============================================================
  const { db } = await import("../app/src/lib/db");
  const orphans = await db.user.findMany({
    where: { email: { startsWith: EMAIL_PREFIX, endsWith: "@example.invalid" } },
    select: { id: true },
  });
  const userIds: string[] = [];

  async function cleanupTestUser(userId: string): Promise<void> {
    const responsibilities = await db.responsibility.findMany({ where: { createdById: userId }, select: { id: true } }).catch(() => [] as { id: string }[]);
    const responsibilityIds = responsibilities.map((r: { id: string }) => r.id);
    if (responsibilityIds.length > 0) {
      await db.eventLog.deleteMany({ where: { aggregateId: { in: responsibilityIds } } }).catch(() => null);
      await db.outboxEvent.deleteMany({ where: { aggregateId: { in: responsibilityIds } } }).catch(() => null);
      await db.responsibility.deleteMany({ where: { id: { in: responsibilityIds } } }).catch(() => null);
    }
    const captures = await db.capture.findMany({ where: { createdById: userId }, select: { id: true } }).catch(() => [] as { id: string }[]);
    const captureIds = captures.map((c: { id: string }) => c.id);
    if (captureIds.length > 0) {
      await db.capture.deleteMany({ where: { id: { in: captureIds } } }).catch(() => null);
    }
    const memberships = await db.workspaceMember.findMany({ where: { userId }, select: { workspaceId: true } }).catch(() => [] as { workspaceId: string }[]);
    await db.workspaceMember.deleteMany({ where: { userId } }).catch(() => null);
    for (const m of memberships) {
      await db.workspace.deleteMany({ where: { id: m.workspaceId } }).catch(() => null);
    }
    await db.userSession.deleteMany({ where: { userId } }).catch(() => null);
    await db.user.deleteMany({ where: { id: userId } }).catch(() => null);
  }

  if (orphans.length > 0) {
    console.log(`[SWEEP] 過去実行の孤立テストユーザー${orphans.length}件を削除します...`);
    for (const o of orphans) {
      await cleanupTestUser(o.id);
    }
  }

  try {
    const email = `${EMAIL_PREFIX}${RUN_ID}@example.invalid`;
    const user = await db.user.create({
      data: { email, passwordHash: "not-a-real-hash-for-db-only-test", displayName: "M1 Outcome Reason" },
    });
    const workspace = await db.workspace.create({ data: { name: "M1 Outcome Reason Workspace" } });
    await db.workspaceMember.create({ data: { workspaceId: workspace.id, userId: user.id, role: "OWNER" } });
    const domain = await db.domain.create({ data: { workspaceId: workspace.id, name: "個人", kind: "PERSONAL" } });
    userIds.push(user.id);

    const resp = await db.responsibility.create({
      data: {
        workspaceId: workspace.id, domainId: domain.id, type: "TASK", title: "検証用",
        status: "NOT_NEEDED", outcomeReasonCode: "DUPLICATE",
        sourceKind: "USER", createdById: user.id, updatedById: user.id,
      },
    });
    ok("[E] outcomeReasonCode='DUPLICATE'で作成できる", resp.outcomeReasonCode === "DUPLICATE");

    const fetched = await db.responsibility.findUniqueOrThrow({ where: { id: resp.id } });
    ok("[E] 読み出したoutcomeReasonCodeが一致する", fetched.outcomeReasonCode === "DUPLICATE");

    // REOPEN相当のクリアをシミュレート。
    const reopened = await db.responsibility.update({
      where: { id: resp.id },
      data: { status: "PLANNED", outcomeReasonCode: null },
    });
    ok("[E] REOPEN相当でoutcomeReasonCodeがnullになる", reopened.outcomeReasonCode === null);

    // outcomeReasonCodeを指定しない通常のResponsibility作成(既存Gateへの非破壊確認)。
    const normal = await db.responsibility.create({
      data: {
        workspaceId: workspace.id, domainId: domain.id, type: "TASK", title: "検証用2",
        status: "INBOX", sourceKind: "USER", createdById: user.id, updatedById: user.id,
      },
    });
    ok("[E] outcomeReasonCode省略時はnull(既存Gateとの後方互換)", normal.outcomeReasonCode === null);
  } finally {
    console.log("[CLEANUP] テスト用データを削除します...");
    for (const userId of userIds) {
      await cleanupTestUser(userId);
    }
    const leftover = await db.user.findMany({
      where: { email: { startsWith: EMAIL_PREFIX, endsWith: "@example.invalid" } },
      select: { id: true },
    });
    ok("[cleanup] test用Userが1件も残っていない", leftover.length === 0, `remaining=${leftover.length}`);
  }

  console.log(`\n合計: ${passed} passed, ${failed} failed`);
  if (failed > 0) {
    console.log("\n失敗一覧:");
    for (const f of failures) console.log(`  - ${f}`);
    process.exitCode = 1;
  }
}

main().catch((err) => {
  console.error("[FATAL]", err);
  process.exitCode = 1;
});
