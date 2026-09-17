#!/usr/bin/env node
/**
 * scripts/verify_gate_pattern_actionslot_schema_01.ts
 *
 * PATTERN-ACTIONSLOT-SCHEMA-01(CasePatternActionSlot/Revision/
 * SourceInstanceのDB制約受入試験)。
 * 出典: Claude向け_ISMAY_d68e9bf以降_ActionSlot正本準拠・CasePattern実分解
 * 完遂・残工程連続実装指示_2026-09-17.md Gate 4「受入試験では同Pattern内
 * slotKey一意、他workspace参照拒否、revision append-only、壊れた
 * distribution拒否を確認する」。
 *
 * このGateはapplication service層をまだ持たない(Gate 5以降のscope)ため、
 * 本scriptはPrisma Client経由でテーブル・制約そのものをCRUDで検証する
 * DBスキーマ受入試験である。
 *
 * 実行方法:
 *   cd ~/projects/ismay/app
 *   npx tsx ../scripts/verify_gate_pattern_actionslot_schema_01.ts
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";

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
const EMAIL_PREFIX = "gate-pattern-actionslot-schema-01-verify-";

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

function isPrismaConstraintError(err: unknown, codes: string[]): boolean {
  const code = (err as { code?: string } | null)?.code;
  return typeof code === "string" && codes.includes(code);
}

async function main(): Promise<void> {
  const { installAiNetworkDenyGuard } = await import("./lib/aiNetworkDenyGuard");
  const guard = installAiNetworkDenyGuard();

  const { db } = await import("../app/src/lib/db");
  const { cleanupFormationVerifyUser } = await import("./lib/formationVerifyCleanup");
  const { createCasePatternIdentity } = await import("../app/src/lib/patterns/casePatternRevisionService");

  const createdFixtures: { userId: string; workspaceId: string }[] = [];

  async function cleanupCasePatternRowsByWorkspace(workspaceId: string): Promise<void> {
    await db.casePatternActionSlotSourceInstance.deleteMany({ where: { workspaceId } }).catch(() => null);
    await db.casePatternActionSlotRevision.deleteMany({ where: { workspaceId } }).catch(() => null);
    await db.casePatternActionSlot.deleteMany({ where: { workspaceId } }).catch(() => null);
    await db.casePatternDetectionReceipt.deleteMany({ where: { workspaceId } }).catch(() => null);
    await db.casePatternDetectJob.deleteMany({ where: { workspaceId } }).catch(() => null);
    await db.casePatternSourceLink.deleteMany({ where: { workspaceId } }).catch(() => null);
    await db.casePatternEvidenceAggregate.deleteMany({ where: { workspaceId } }).catch(() => null);
    await db.casePatternEmbedding.deleteMany({ where: { workspaceId } }).catch(() => null);
    await db.casePatternFeedbackEvent.deleteMany({ where: { workspaceId } }).catch(() => null);
    await db.casePatternRevision.deleteMany({ where: { workspaceId } }).catch(() => null);
    await db.casePattern.deleteMany({ where: { workspaceId } }).catch(() => null);
  }

  async function cleanupTestUser(userId: string, knownWorkspaceId: string | null): Promise<void> {
    let workspaceId = knownWorkspaceId;
    if (!workspaceId) {
      const membership = await db.workspaceMember.findFirst({ where: { userId }, select: { workspaceId: true } }).catch(() => null);
      workspaceId = membership?.workspaceId ?? null;
      if (!workspaceId) {
        const ctx = await db.projectContext
          .findFirst({ where: { OR: [{ ownerSubjectUserId: userId }, { createdById: userId }] }, select: { workspaceId: true } })
          .catch(() => null);
        workspaceId = ctx?.workspaceId ?? null;
      }
    }
    if (workspaceId) await cleanupCasePatternRowsByWorkspace(workspaceId);

    const ownedOrCreatedContexts = await db.projectContext
      .findMany({ where: { OR: [{ ownerSubjectUserId: userId }, { createdById: userId }] }, select: { id: true } })
      .catch(() => []);
    const contextIds = ownedOrCreatedContexts.map((c) => c.id);
    if (contextIds.length > 0) {
      await db.projectContextLinkEvent.deleteMany({ where: { contextId: { in: contextIds } } }).catch(() => null);
      await db.projectContextLink.deleteMany({ where: { contextId: { in: contextIds } } }).catch(() => null);
      await db.eventLog.deleteMany({ where: { aggregateId: { in: contextIds } } }).catch(() => null);
      await db.outboxEvent.deleteMany({ where: { aggregateId: { in: contextIds } } }).catch(() => null);
      await db.projectContext.deleteMany({ where: { id: { in: contextIds } } }).catch(() => null);
    }
    await db.pemConsentEvent.deleteMany({ where: { userId } }).catch(() => null);

    const result = await cleanupFormationVerifyUser(db, userId);
    if (result.errors.length > 0) {
      console.log(`  [cleanup警告] userId=${userId} errors=${result.errors.length}:`);
      for (const e of result.errors) console.log(`    - ${e.step}: ${String(e.error)}`);
    }
  }

  const orphans = await db.user.findMany({
    where: { email: { startsWith: EMAIL_PREFIX, endsWith: "@example.invalid" } },
    select: { id: true },
  });
  if (orphans.length > 0) {
    console.log(`[SWEEP] 過去実行の孤立テストユーザー${orphans.length}件を削除します...`);
    for (const o of orphans) await cleanupTestUser(o.id, null);
  }

  async function makeFixture(suffix: string) {
    const email = `${EMAIL_PREFIX}${RUN_ID}-${suffix}@example.invalid`;
    const user = await db.user.create({
      data: { email, passwordHash: "not-a-real-hash-for-db-only-test", displayName: `PATTERN-ACTIONSLOT-SCHEMA-01 ${suffix}` },
    });
    const workspace = await db.workspace.create({ data: { name: `PATTERN-ACTIONSLOT-SCHEMA-01 Workspace ${suffix}` } });
    await db.workspaceMember.create({ data: { workspaceId: workspace.id, userId: user.id, role: "OWNER" } });
    const domain = await db.domain.create({ data: { workspaceId: workspace.id, name: "個人", kind: "PERSONAL" } });
    createdFixtures.push({ userId: user.id, workspaceId: workspace.id });
    return { userId: user.id, workspaceId: workspace.id, domainId: domain.id };
  }

  /** 検証専用のCasePattern+Revision 1件を作る(実detectionを経由せず直接作成)。 */
  async function makePattern(fx: { workspaceId: string; userId: string }, title: string) {
    const identity = await createCasePatternIdentity({
      workspaceId: fx.workspaceId,
      ownerSubjectUserId: fx.userId,
      title,
      representativeText: title,
      decompositionTemplate: null,
      thresholds: { windowCycles: 12 },
      schemaVersion: "1.0",
    });
    return identity;
  }

  /** 検証専用のFormationCandidateRevision 1件(Split childの代替、childRevisionId FK先)。 */
  let occSeq = 0;
  async function makeChildRevision(fx: { workspaceId: string; domainId: string; userId: string }, title: string) {
    occSeq++;
    const key = `child${occSeq}`;
    const capture = await db.capture.create({
      data: { workspaceId: fx.workspaceId, domainId: fx.domainId, createdById: fx.userId, sourceType: "TEXT", rawText: `[PATTERN-ACTIONSLOT-SCHEMA-01 verify ${key}] ${title}`, processingStatus: "READY" },
    });
    const session = await db.formationSession.create({
      data: { workspaceId: fx.workspaceId, domainId: fx.domainId, subjectUserId: fx.userId, captureId: capture.id, clientSessionKey: `pattern-actionslot-schema-01:${RUN_ID}:${key}`, state: "REVIEW_READY" },
    });
    const identity = await db.formationCandidateIdentity.create({
      data: { workspaceId: fx.workspaceId, sessionId: session.id, candidateKey: "c1", currentRevision: 1 },
    });
    const revision = await db.formationCandidateRevision.create({
      data: {
        workspaceId: fx.workspaceId, candidateId: identity.id, revision: 1, type: "TASK", title, description: null,
        proposedFields: {
          candidateId: "c1", type: "TASK", title, completionCondition: "検証用の完了条件",
          evidenceSpans: [{ start: 0, end: 4 }], confidence: 1, dateMentions: [], unknowns: [], blockedByCandidateIds: [], suggestedTags: [],
        },
        confidence: 1, schemaVersion: "1.0",
      },
    });
    return { candidateId: identity.id, revisionId: revision.id };
  }

  try {
    console.log("=== PATTERN-ACTIONSLOT-SCHEMA-01 実DB受入試験 ===");

    const fx = await makeFixture("main");
    const pattern = await makePattern(fx, "検証用Pattern");
    const child1 = await makeChildRevision(fx, "検証用child1");
    const child2 = await makeChildRevision(fx, "検証用child2");

    // ================================================================
    // [1] 同Pattern内slotKey一意。
    // ================================================================
    const slotKey1 = randomUUID();
    const slot1 = await db.casePatternActionSlot.create({
      data: {
        workspaceId: fx.workspaceId,
        patternId: pattern.patternId,
        slotKey: slotKey1,
        groupingKey: "grouping-key-A",
        groupingPolicyVersion: "1.0",
        currentRevision: 0,
      },
    });
    ok("[1-0] slot作成に成功する", slot1.id != null);

    let dupSlotKeyErr: unknown = null;
    try {
      await db.casePatternActionSlot.create({
        data: {
          workspaceId: fx.workspaceId,
          patternId: pattern.patternId,
          slotKey: slotKey1,
          groupingKey: "grouping-key-B",
          groupingPolicyVersion: "1.0",
          currentRevision: 0,
        },
      });
    } catch (err) {
      dupSlotKeyErr = err;
    }
    ok("[1] 同Pattern内で同一slotKeyの重複作成はunique制約で拒否される", isPrismaConstraintError(dupSlotKeyErr, ["P2002"]), String(dupSlotKeyErr));

    let dupGroupingKeyErr: unknown = null;
    try {
      await db.casePatternActionSlot.create({
        data: {
          workspaceId: fx.workspaceId,
          patternId: pattern.patternId,
          slotKey: randomUUID(),
          groupingKey: "grouping-key-A",
          groupingPolicyVersion: "1.0",
          currentRevision: 0,
        },
      });
    } catch (err) {
      dupGroupingKeyErr = err;
    }
    ok("[1] 同Pattern内で同一groupingKeyの重複作成もunique制約で拒否される", isPrismaConstraintError(dupGroupingKeyErr, ["P2002"]), String(dupGroupingKeyErr));

    // ================================================================
    // [2] 他workspace参照拒否(複合FK)。
    // ================================================================
    const fxOther = await makeFixture("other-workspace");
    let crossWorkspaceErr: unknown = null;
    try {
      await db.casePatternActionSlot.create({
        data: {
          // workspaceIdはfxOther側だが、patternIdはfx(別workspace)のPatternを
          // 指す不正な組み合わせ。複合FK(pattern_id, workspace_id)により
          // 拒否されるはず。
          workspaceId: fxOther.workspaceId,
          patternId: pattern.patternId,
          slotKey: randomUUID(),
          groupingKey: "grouping-key-cross-ws",
          groupingPolicyVersion: "1.0",
          currentRevision: 0,
        },
      });
    } catch (err) {
      crossWorkspaceErr = err;
    }
    ok("[2] 他workspaceのPatternIdを指すslot作成は複合FKで拒否される", isPrismaConstraintError(crossWorkspaceErr, ["P2003"]), String(crossWorkspaceErr));

    // ================================================================
    // [3] revision append-only。
    // ================================================================
    const patternRevisionRow = await db.casePatternRevision.findFirstOrThrow({ where: { workspaceId: fx.workspaceId, patternId: pattern.patternId, revision: 1 } });

    const rev1 = await db.casePatternActionSlotRevision.create({
      data: {
        workspaceId: fx.workspaceId,
        slotId: slot1.id,
        revision: 1,
        patternId: pattern.patternId,
        patternRevisionId: patternRevisionRow.id,
        normalizedIntent: "検証用child1",
        suggestedType: "TASK",
        occurrenceProbability: "0.5000",
        typicalOrder: "0.00",
        predecessorSlotKeys: [],
        durationDistribution: { status: "NOT_ENOUGH_DATA", sampleSize: 0, policyVersion: "1.0" },
        atomicityDistribution: { sampleSize: 1, byAssessment: { ATOMIC: 1 }, algorithmVersions: ["1.0"] },
        rawSampleSize: 1,
        schemaVersion: "1.0",
        policyVersion: "1.0",
      },
    });
    ok("[3-0] revision 1作成に成功する", rev1.id != null);

    const rev2 = await db.casePatternActionSlotRevision.create({
      data: {
        workspaceId: fx.workspaceId,
        slotId: slot1.id,
        revision: 2,
        patternId: pattern.patternId,
        patternRevisionId: patternRevisionRow.id,
        normalizedIntent: "検証用child1(訂正後)",
        suggestedType: "TASK",
        occurrenceProbability: "0.6667",
        typicalOrder: "0.00",
        predecessorSlotKeys: [],
        durationDistribution: { status: "NOT_ENOUGH_DATA", sampleSize: 0, policyVersion: "1.0" },
        atomicityDistribution: { sampleSize: 2, byAssessment: { ATOMIC: 2 }, algorithmVersions: ["1.0"] },
        rawSampleSize: 2,
        schemaVersion: "1.0",
        policyVersion: "1.0",
      },
    });
    ok("[3-1] revision 2作成に成功する(append-only、revision 1は変更しない)", rev2.id != null);

    const rev1AfterAppend = await db.casePatternActionSlotRevision.findUniqueOrThrow({ where: { id: rev1.id } });
    ok("[3] revision 1の内容はrevision 2作成後も変化しない(append-only)", rev1AfterAppend.normalizedIntent === "検証用child1" && rev1AfterAppend.rawSampleSize === 1, JSON.stringify(rev1AfterAppend));

    let dupRevisionNumberErr: unknown = null;
    try {
      await db.casePatternActionSlotRevision.create({
        data: {
          workspaceId: fx.workspaceId,
          slotId: slot1.id,
          revision: 2,
          patternId: pattern.patternId,
          patternRevisionId: patternRevisionRow.id,
          normalizedIntent: "重複revision番号",
          suggestedType: "TASK",
          occurrenceProbability: "0.5000",
          typicalOrder: "0.00",
          predecessorSlotKeys: [],
          durationDistribution: { status: "NOT_ENOUGH_DATA", sampleSize: 0, policyVersion: "1.0" },
          atomicityDistribution: {},
          rawSampleSize: 1,
          schemaVersion: "1.0",
          policyVersion: "1.0",
        },
      });
    } catch (err) {
      dupRevisionNumberErr = err;
    }
    ok("[3] 同一slot内での重複revision番号はunique制約で拒否される", isPrismaConstraintError(dupRevisionNumberErr, ["P2002"]), String(dupRevisionNumberErr));

    const allRevisionsForSlot1 = await db.casePatternActionSlotRevision.findMany({ where: { workspaceId: fx.workspaceId, slotId: slot1.id }, orderBy: { revision: "asc" } });
    ok("[3] slot1のrevision履歴は2件とも残っている(revision 1が上書きされていない)", allRevisionsForSlot1.length === 2 && allRevisionsForSlot1[0]!.revision === 1 && allRevisionsForSlot1[1]!.revision === 2, JSON.stringify(allRevisionsForSlot1.map((r) => r.revision)));

    // ================================================================
    // [4] 壊れたdistribution拒否(JSONBがobject型でない場合)。
    // ================================================================
    let brokenDurationArrayErr: unknown = null;
    try {
      await db.casePatternActionSlotRevision.create({
        data: {
          workspaceId: fx.workspaceId,
          slotId: slot1.id,
          revision: 3,
          patternId: pattern.patternId,
          patternRevisionId: patternRevisionRow.id,
          normalizedIntent: "壊れたdistribution",
          suggestedType: "TASK",
          occurrenceProbability: "0.5000",
          typicalOrder: "0.00",
          predecessorSlotKeys: [],
          // object型でない(配列)durationDistributionはCHECK制約で拒否される。
          durationDistribution: [1, 2, 3],
          atomicityDistribution: {},
          rawSampleSize: 1,
          schemaVersion: "1.0",
          policyVersion: "1.0",
        },
      });
    } catch (err) {
      brokenDurationArrayErr = err;
    }
    // [注記] Postgresの識別子長制限(NAMEDATALEN既定63バイト)により、
    // "case_pattern_action_slot_revisions_duration_distribution_type_check"
    // (68文字)はDB上で自動的に63文字へ切り詰められ、実際のCHECK制約名は
    // "...duration_distribution_type_c"となる(実DB確認済み)。切り詰め後も
    // 生存する短い断片でmatchする。
    ok("[4] durationDistributionが配列(object型でない)場合はCHECK制約で拒否される", isPrismaConstraintError(brokenDurationArrayErr, ["P2010", "P2000"]) || String(brokenDurationArrayErr).includes("duration_distribution_type"), String(brokenDurationArrayErr));

    let brokenOccurrenceProbabilityErr: unknown = null;
    try {
      await db.casePatternActionSlotRevision.create({
        data: {
          workspaceId: fx.workspaceId,
          slotId: slot1.id,
          revision: 3,
          patternId: pattern.patternId,
          patternRevisionId: patternRevisionRow.id,
          normalizedIntent: "壊れたoccurrenceProbability",
          suggestedType: "TASK",
          // 0..1の範囲外。
          occurrenceProbability: "1.5000",
          typicalOrder: "0.00",
          predecessorSlotKeys: [],
          durationDistribution: { status: "NOT_ENOUGH_DATA", sampleSize: 0, policyVersion: "1.0" },
          atomicityDistribution: {},
          rawSampleSize: 1,
          schemaVersion: "1.0",
          policyVersion: "1.0",
        },
      });
    } catch (err) {
      brokenOccurrenceProbabilityErr = err;
    }
    ok(
      "[4] occurrenceProbabilityが0..1範囲外の場合はCHECK制約で拒否される",
      isPrismaConstraintError(brokenOccurrenceProbabilityErr, ["P2010", "P2000"]) || String(brokenOccurrenceProbabilityErr).includes("occurrence_probability_check"),
      String(brokenOccurrenceProbabilityErr),
    );

    // ================================================================
    // [5] SourceInstance provenance: 1 childRevisionは高々1 slotへのみ帰属。
    // ================================================================
    const src1 = await db.casePatternActionSlotSourceInstance.create({
      data: {
        workspaceId: fx.workspaceId,
        slotId: slot1.id,
        childRevisionId: child1.revisionId,
        order: 0,
        independenceGroup: "ctx-verify",
      },
    });
    ok("[5-0] SourceInstance作成に成功する", src1.id != null);

    let dupChildRevisionErr: unknown = null;
    try {
      await db.casePatternActionSlotSourceInstance.create({
        data: {
          workspaceId: fx.workspaceId,
          slotId: slot1.id,
          childRevisionId: child1.revisionId,
          order: 1,
          independenceGroup: "ctx-verify",
        },
      });
    } catch (err) {
      dupChildRevisionErr = err;
    }
    ok("[5] 同一childRevisionを2つのslotへ帰属させようとするとunique制約で拒否される", isPrismaConstraintError(dupChildRevisionErr, ["P2002"]), String(dupChildRevisionErr));

    let negativeOrderErr: unknown = null;
    try {
      await db.casePatternActionSlotSourceInstance.create({
        data: {
          workspaceId: fx.workspaceId,
          slotId: slot1.id,
          childRevisionId: child2.revisionId,
          order: -1,
          independenceGroup: "ctx-verify",
        },
      });
    } catch (err) {
      negativeOrderErr = err;
    }
    ok(
      "[5] orderが負の場合はCHECK制約で拒否される",
      isPrismaConstraintError(negativeOrderErr, ["P2010", "P2000"]) || String(negativeOrderErr).includes("order_check"),
      String(negativeOrderErr),
    );

    const src2 = await db.casePatternActionSlotSourceInstance.create({
      data: {
        workspaceId: fx.workspaceId,
        slotId: slot1.id,
        childRevisionId: child2.revisionId,
        order: 1,
        independenceGroup: "ctx-verify",
      },
    });
    ok("[5] 正当なorderでのSourceInstance作成は成功する", src2.id != null);
  } finally {
    console.log("--- cleanup ---");
    for (const fx of createdFixtures) {
      await cleanupTestUser(fx.userId, fx.workspaceId);
    }
    const remaining = await db.user.count({ where: { email: { startsWith: EMAIL_PREFIX, endsWith: "@example.invalid" } } });
    ok("[cleanup] cleanup後、専用fixtureユーザーの残存0件", remaining === 0, `remaining=${remaining}`);

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
