#!/usr/bin/env node
/**
 * scripts/verify_gate_m1b6_pii_classification_acceptance.ts
 *
 * Gate M1-B6(PII分類、統合正本§3/§19.5)の受入証跡。
 * AI providerへの実通信は一切行わない(aiNetworkDenyGuard必須)。
 *
 * 検証内容:
 *   1. writeShadowFormationSession経由で作られたSource Anchorが、
 *      evidenceSpansが指す原文抜粋にメールアドレス/電話番号を含む場合HIGH、
 *      含まない場合UNCLASSIFIED(NONEではない。R1-05是正)に分類されること
 *      (shadowWrite.tsへの実配線確認)。
 *   2. classifyPii()の直接呼び出しでのHIGH/UNCLASSIFIED判定(pure相当の追加DB外検証)。
 *
 * 実行方法:
 *   cd ~/projects/ismay/app
 *   npx tsx ../scripts/verify_gate_m1b6_pii_classification_acceptance.ts
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
const EMAIL_PREFIX = "gate-m1b6-pii-verify-";

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
  const { writeShadowFormationSession } = await import("../app/src/lib/formation/shadowWrite");
  const { classifyPii } = await import("../app/src/lib/formation/piiClassifier");

  const orphans = await db.user.findMany({
    where: { email: { startsWith: EMAIL_PREFIX, endsWith: "@example.invalid" } },
    select: { id: true },
  });
  if (orphans.length > 0) {
    console.log(`[SWEEP] 過去実行の孤立テストユーザー${orphans.length}件を削除します...`);
    for (const o of orphans) {
      await cleanupFormationVerifyUser(db, o.id);
    }
  }

  const userIds: string[] = [];

  async function makeFixture(suffix: string) {
    const email = `${EMAIL_PREFIX}${RUN_ID}-${suffix}@example.invalid`;
    const user = await db.user.create({
      data: { email, passwordHash: "not-a-real-hash-for-db-only-test", displayName: `Gate M1B6 PII ${suffix}` },
    });
    const workspace = await db.workspace.create({ data: { name: `Gate M1B6 PII Workspace ${suffix}` } });
    await db.workspaceMember.create({ data: { workspaceId: workspace.id, userId: user.id, role: "OWNER" } });
    const domain = await db.domain.create({ data: { workspaceId: workspace.id, name: "個人", kind: "PERSONAL" } });
    userIds.push(user.id);
    return { userId: user.id, workspaceId: workspace.id, domainId: domain.id };
  }

  try {
    // ============================================================
    // 1. classifyPii()の直接呼び出し(実装確認・db外)
    // ============================================================
    ok("[M1B6.1] メールアドレスを含む文字列はHIGH", classifyPii("連絡先: taro@example.com") === "HIGH");
    ok("[M1B6.2] 電話番号を含む文字列はHIGH", classifyPii("090-1234-5678へ連絡") === "HIGH");
    ok(
      "[M1B6.3是正・監査是正指示書2026-08-31] PIIパターンを含まない通常文はUNCLASSIFIED(NONEではない。email/電話番号を検出できないだけでは「PII無しと確認した」ことにならない)",
      classifyPii("見積書を送付する") === "UNCLASSIFIED",
    );

    // ============================================================
    // 2. writeShadowFormationSession経由での実配線確認
    // ============================================================
    {
      const fx = await makeFixture("s1wired");
      const rawText = "AAベンダの担当者(taro.yamada@example.co.jp)へ見積を送付する";
      const capture = await db.capture.create({
        data: {
          workspaceId: fx.workspaceId,
          domainId: fx.domainId,
          createdById: fx.userId,
          sourceType: "TEXT",
          rawText,
          processingStatus: "READY",
        },
      });

      await writeShadowFormationSession({
        capture: { id: capture.id, workspaceId: fx.workspaceId, domainId: fx.domainId, createdById: fx.userId, rawText },
        aiRunId: `airun-${RUN_ID}-pii`,
        schemaVersion: "1.0",
        candidates: [
          {
            candidateId: "c1",
            type: "TASK",
            title: "見積を送付する",
            completionCondition: "見積を送付し終える",
            evidenceSpans: [{ start: 0, end: rawText.length }],
            confidence: 0.9,
            dateMentions: [],
            unknowns: [],
            blockedByCandidateIds: [],
            suggestedTags: [],
          },
        ],
      });

      const session = await db.formationSession.findFirstOrThrow({ where: { captureId: capture.id, workspaceId: fx.workspaceId } });
      const identity = await db.formationCandidateIdentity.findFirstOrThrow({ where: { sessionId: session.id, workspaceId: fx.workspaceId } });
      const revision = await db.formationCandidateRevision.findFirstOrThrow({ where: { candidateId: identity.id, workspaceId: fx.workspaceId, revision: 1 } });
      const anchors = await db.formationSourceAnchor.findMany({ where: { revisionId: revision.id, workspaceId: fx.workspaceId } });

      ok("[M1B6.4] shadowWrite経由でSource Anchorが1件作られる", anchors.length === 1, String(anchors.length));
      ok(
        "[M1B6.5・実配線の核心] evidenceSpansがメールアドレスを含む原文全体を指す場合、shadowWrite.ts経由でも実際にHIGHと分類される(旧: 常にNONE固定だった)",
        anchors[0]?.piiClassification === "HIGH",
        anchors[0]?.piiClassification,
      );
    }

    {
      const fx = await makeFixture("s2nopii");
      const rawText = "見積書を来週までに提出する";
      const capture = await db.capture.create({
        data: {
          workspaceId: fx.workspaceId,
          domainId: fx.domainId,
          createdById: fx.userId,
          sourceType: "TEXT",
          rawText,
          processingStatus: "READY",
        },
      });

      await writeShadowFormationSession({
        capture: { id: capture.id, workspaceId: fx.workspaceId, domainId: fx.domainId, createdById: fx.userId, rawText },
        aiRunId: `airun-${RUN_ID}-nopii`,
        schemaVersion: "1.0",
        candidates: [
          {
            candidateId: "c1",
            type: "TASK",
            title: "見積書を提出する",
            completionCondition: "見積書を提出し終える",
            evidenceSpans: [{ start: 0, end: rawText.length }],
            confidence: 0.9,
            dateMentions: [],
            unknowns: [],
            blockedByCandidateIds: [],
            suggestedTags: [],
          },
        ],
      });

      const session = await db.formationSession.findFirstOrThrow({ where: { captureId: capture.id, workspaceId: fx.workspaceId } });
      const identity = await db.formationCandidateIdentity.findFirstOrThrow({ where: { sessionId: session.id, workspaceId: fx.workspaceId } });
      const revision = await db.formationCandidateRevision.findFirstOrThrow({ where: { candidateId: identity.id, workspaceId: fx.workspaceId, revision: 1 } });
      const anchors = await db.formationSourceAnchor.findMany({ where: { revisionId: revision.id, workspaceId: fx.workspaceId } });

      ok(
        "[M1B6.6是正・監査是正指示書2026-08-31] PIIパターンを含まない原文の場合、shadowWrite.ts経由でUNCLASSIFIED(過検出していない・NONEを誤って確定しない)",
        anchors[0]?.piiClassification === "UNCLASSIFIED",
        anchors[0]?.piiClassification,
      );
    }

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
    ok("[cleanup] cleanup処理中に例外が0件である", cleanupErrors.length === 0, cleanupErrors.map((e) => `${e.step}:${String(e.error)}`).join(" | "));
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
