#!/usr/bin/env node
/**
 * scripts/verify_gate_pattern_duration_01.ts
 *
 * PATTERN-DURATION-01(実ExecutionSessionデータからのduration distribution
 * 算出)実DB受入試験。
 * 出典: Claude向け_ISMAY_d68e9bf以降_ActionSlot正本準拠・CasePattern実分解
 * 完遂・残工程連続実装指示_2026-09-17.md P1「11. Pattern管理UI・duration・
 * docs」のduration部分。
 *
 * 検証内容:
 *   - materialize済み・CLOSED_CONFIRMED Sessionを持つslotはCOMPUTEDになり、
 *     medianSecondsが正しく算出される
 *   - materialize未実施のslotはNOT_ENOUGH_DATAのまま
 *   - 同一Responsibilityに複数CLOSED_CONFIRMED Sessionがある場合、
 *     合算される(中断・再開の合計所要時間)
 *   - サンプルが2件になった場合、中央値が正しく算出される
 *   - owner/workspace分離、cleanup、AI network遮断
 *
 * 実行方法:
 *   cd ~/projects/ismay/app
 *   npx tsx ../scripts/verify_gate_pattern_duration_01.ts
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
const EMAIL_PREFIX = "gate-pattern-duration-01-verify-";

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
  const { cleanupFormationVerifyUser } = await import("./lib/formationVerifyCleanup");
  const { createCasePatternIdentity } = await import("../app/src/lib/patterns/casePatternRevisionService");
  const { splitFormationCandidate } = await import("../app/src/lib/formation/splitCorrection");
  const { runActionSlotLearningForPattern } = await import("../app/src/lib/patterns/casePatternActionSlotLearnService");
  const { PEM_CONSENT_POLICY_VERSION } = await import("../app/src/lib/pem/consent");

  const createdFixtures: { userId: string; workspaceId: string }[] = [];

  async function cleanupCasePatternRowsByWorkspace(workspaceId: string): Promise<void> {
    await db.formationCandidateDecisionEvent.updateMany({ where: { workspaceId, attributedCasePatternId: { not: null } }, data: { attributedCasePatternId: null } }).catch(() => null);
    await db.executionSessionRevision.deleteMany({ where: { sessionIdentity: { workspaceId } } }).catch(() => null);
    await db.executionSessionIdentity.deleteMany({ where: { workspaceId } }).catch(() => null);
    await db.materializationReceiptItem.deleteMany({ where: { workspaceId } }).catch(() => null);
    await db.materializationReceipt.deleteMany({ where: { workspaceId } }).catch(() => null);
    await db.responsibility.deleteMany({ where: { workspaceId } }).catch(() => null);
    await db.casePatternSuggestJob.deleteMany({ where: { workspaceId } }).catch(() => null);
    await db.casePatternActionSlotSourceInstance.deleteMany({ where: { workspaceId } }).catch(() => null);
    await db.casePatternActionSlotRevision.deleteMany({ where: { workspaceId } }).catch(() => null);
    await db.casePatternActionSlot.deleteMany({ where: { workspaceId } }).catch(() => null);
    await db.casePatternActionSlotLearnJob.deleteMany({ where: { workspaceId } }).catch(() => null);
    await db.casePatternDetectionReceipt.deleteMany({ where: { workspaceId } }).catch(() => null);
    await db.casePatternDetectJob.deleteMany({ where: { workspaceId } }).catch(() => null);
    await db.casePatternSourceLink.deleteMany({ where: { workspaceId } }).catch(() => null);
    await db.casePatternEvidenceAggregate.deleteMany({ where: { workspaceId } }).catch(() => null);
    await db.casePatternEmbedding.deleteMany({ where: { workspaceId } }).catch(() => null);
    await db.casePatternRevision.deleteMany({ where: { workspaceId } }).catch(() => null);
    await db.casePattern.deleteMany({ where: { workspaceId } }).catch(() => null);
  }

  async function cleanupTestUser(userId: string, knownWorkspaceId: string | null): Promise<void> {
    let workspaceId = knownWorkspaceId;
    if (!workspaceId) {
      const membership = await db.workspaceMember.findFirst({ where: { userId }, select: { workspaceId: true } }).catch(() => null);
      workspaceId = membership?.workspaceId ?? null;
    }
    if (!workspaceId) {
      const capture = await db.capture.findFirst({ where: { createdById: userId }, select: { workspaceId: true } }).catch(() => null);
      workspaceId = capture?.workspaceId ?? null;
    }
    if (workspaceId) await cleanupCasePatternRowsByWorkspace(workspaceId);
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
      data: { email, passwordHash: "not-a-real-hash-for-db-only-test", displayName: `PATTERN-DURATION-01 ${suffix}` },
    });
    const workspace = await db.workspace.create({ data: { name: `PATTERN-DURATION-01 Workspace ${suffix}` } });
    await db.workspaceMember.create({ data: { workspaceId: workspace.id, userId: user.id, role: "OWNER" } });
    const domain = await db.domain.create({ data: { workspaceId: workspace.id, name: "個人", kind: "PERSONAL" } });
    await db.pemConsentEvent.create({
      data: {
        userId: user.id,
        workspaceId: workspace.id,
        consentType: "CASE_PATTERN_LEARNING",
        action: "GRANTED",
        policyVersion: PEM_CONSENT_POLICY_VERSION,
        source: "SETTINGS",
      },
    });
    createdFixtures.push({ userId: user.id, workspaceId: workspace.id });
    return { userId: user.id, workspaceId: workspace.id, domainId: domain.id };
  }

  let seq = 0;
  async function makeSplittableCandidate(fx: { workspaceId: string; domainId: string; userId: string }, title: string) {
    seq++;
    const key = `c${seq}`;
    const capture = await db.capture.create({
      data: { workspaceId: fx.workspaceId, domainId: fx.domainId, createdById: fx.userId, sourceType: "TEXT", rawText: `[PATTERN-DURATION-01 verify ${key}] ${title}`, processingStatus: "READY" },
    });
    const session = await db.formationSession.create({
      data: { workspaceId: fx.workspaceId, domainId: fx.domainId, subjectUserId: fx.userId, captureId: capture.id, clientSessionKey: `pattern-duration-01:${RUN_ID}:${key}`, state: "REVIEW_READY" },
    });
    const identity = await db.formationCandidateIdentity.create({
      data: { workspaceId: fx.workspaceId, sessionId: session.id, candidateKey: "c1", currentRevision: 1 },
    });
    await db.formationCandidateRevision.create({
      data: {
        workspaceId: fx.workspaceId, candidateId: identity.id, revision: 1, type: "TASK", title, description: null,
        proposedFields: {
          candidateId: "c1", type: "TASK", title, completionCondition: "検証用の完了条件",
          evidenceSpans: [{ start: 0, end: 4 }], confidence: 0.9, dateMentions: [], unknowns: [], blockedByCandidateIds: [], suggestedTags: [],
        },
        confidence: 0.9, schemaVersion: "1.0",
      },
    });
    return { sessionId: session.id, candidateId: identity.id };
  }

  async function doSplit(
    fx: { workspaceId: string; userId: string },
    sessionId: string,
    candidateId: string,
    parts: { type: string; title: string }[],
    attributedCasePatternId: string,
  ) {
    const result = await splitFormationCandidate({
      sessionId,
      workspaceId: fx.workspaceId,
      candidateId,
      expectedRevision: 1,
      parts,
      actorUserId: fx.userId,
      attributedCasePatternId,
    });
    if (!result.ok) throw new Error(`[fixture setup] splitFormationCandidate failed: ${JSON.stringify(result)}`);
    // 分解後の子candidateId一覧をcandidateKey昇順で返す(確認する→提出するの順)。
    const children = await db.formationCandidateIdentity.findMany({
      where: { workspaceId: fx.workspaceId, sessionId },
      orderBy: { candidateKey: "asc" },
      select: { id: true, candidateKey: true },
    });
    return children.filter((c: { candidateKey: string }) => c.candidateKey !== "c1");
  }

  /** child(1件)をmaterialize済みとし、CLOSED_CONFIRMED Session群(合計秒指定)を持つResponsibilityへ結びつける。 */
  async function materializeChildWithSessions(
    fx: { workspaceId: string; domainId: string; userId: string },
    childCandidateId: string,
    childRevisionId: string,
    sessionSecondsList: number[],
  ) {
    const responsibility = await db.responsibility.create({
      data: {
        workspaceId: fx.workspaceId, domainId: fx.domainId, type: "TASK", title: "検証用Responsibility",
        status: "DONE", sourceKind: "USER", createdById: fx.userId, updatedById: fx.userId,
      },
    });
    const session = await db.formationSession.findFirstOrThrow({
      where: { workspaceId: fx.workspaceId, candidates: { some: { id: childCandidateId } } },
      select: { id: true },
    });
    const receipt = await db.materializationReceipt.create({
      data: { workspaceId: fx.workspaceId, sessionId: session.id, operationId: `op-${RUN_ID}-${childCandidateId}`, requestHash: `hash-${RUN_ID}-${childCandidateId}` },
    });
    await db.materializationReceiptItem.create({
      data: { workspaceId: fx.workspaceId, receiptId: receipt.id, candidateId: childCandidateId, candidateRevisionId: childRevisionId, responsibilityId: responsibility.id },
    });
    for (const [i, seconds] of sessionSecondsList.entries()) {
      const startedAt = new Date(Date.UTC(2026, 0, 1, 9, 0, 0) + i * 3600 * 1000);
      const identity = await db.executionSessionIdentity.create({
        data: { workspaceId: fx.workspaceId, subjectUserId: fx.userId, responsibilityId: responsibility.id, startEventId: `dummy-start-${RUN_ID}-${childCandidateId}-${i}` },
      });
      await db.executionSessionRevision.create({
        data: {
          sessionIdentityId: identity.id, revision: 1, derivationVersion: "v1", status: "CLOSED_CONFIRMED",
          startedAt, endedAt: new Date(startedAt.getTime() + seconds * 1000), endReason: "COMPLETE",
          rawElapsedSeconds: seconds, correctedActiveSeconds: null, measurementMode: "EXECUTION_LEDGER_ONLY",
          measurementQuality: "HIGH", qualityReasonCodes: [], timeZoneId: null, utcOffsetMinutes: null, supersedesRevisionId: null,
        },
      });
    }
    return responsibility.id;
  }

  try {
    console.log("=== PATTERN-DURATION-01 実DB受入試験 ===");

    const fx = await makeFixture("main");
    const pattern = await createCasePatternIdentity({
      workspaceId: fx.workspaceId,
      ownerSubjectUserId: fx.userId,
      title: "検証用Pattern",
      representativeText: "検証用Pattern",
      decompositionTemplate: null,
      thresholds: { windowCycles: 12 },
      schemaVersion: "1.0",
    });

    // ================================================================
    // [対照group] owner/workspace分離。
    // ================================================================
    const fxOther = await makeFixture("isolation-control");
    const patternOther = await createCasePatternIdentity({
      workspaceId: fxOther.workspaceId,
      ownerSubjectUserId: fxOther.userId,
      title: "対照Pattern",
      representativeText: "対照Pattern",
      decompositionTemplate: null,
      thresholds: { windowCycles: 12 },
      schemaVersion: "1.0",
    });
    const parentOther = await makeSplittableCandidate(fxOther, "対照親");
    const childrenOther = await doSplit(fxOther, parentOther.sessionId, parentOther.candidateId, [
      { type: "TASK", title: "確認する" },
      { type: "TASK", title: "提出する" },
    ], patternOther.patternId);
    const childOtherRevision = await db.formationCandidateRevision.findFirstOrThrow({ where: { workspaceId: fxOther.workspaceId, candidateId: childrenOther[0]!.id } });
    await materializeChildWithSessions(fxOther, childrenOther[0]!.id, childOtherRevision.id, [1200]);
    await runActionSlotLearningForPattern(fxOther.workspaceId, patternOther.patternId);

    // ================================================================
    // [1] 1件目のSplit: 「確認する」のみmaterialize+1セッション(1800秒)。
    // 「提出する」は未materializeのまま。
    // ================================================================
    const parent1 = await makeSplittableCandidate(fx, "親1");
    const children1 = await doSplit(fx, parent1.sessionId, parent1.candidateId, [
      { type: "TASK", title: "確認する" },
      { type: "TASK", title: "提出する" },
    ], pattern.patternId);
    const kakuninChild1 = children1[0]!;
    const kakuninRevision1 = await db.formationCandidateRevision.findFirstOrThrow({ where: { workspaceId: fx.workspaceId, candidateId: kakuninChild1.id } });
    await materializeChildWithSessions(fx, kakuninChild1.id, kakuninRevision1.id, [1800]);

    const parent2 = await makeSplittableCandidate(fx, "親2");
    await doSplit(fx, parent2.sessionId, parent2.candidateId, [
      { type: "TASK", title: "確認する" },
      { type: "TASK", title: "提出する" },
    ], pattern.patternId);

    await runActionSlotLearningForPattern(fx.workspaceId, pattern.patternId);

    const slots = await db.casePatternActionSlot.findMany({ where: { workspaceId: fx.workspaceId, patternId: pattern.patternId } });

    const { computeActionSlotGroupingKey } = await import("../app/src/lib/patterns/casePatternActionSlotLearnService");
    const groupingKeyKakunin = computeActionSlotGroupingKey("TASK", "確認する");
    const groupingKeyTeishutsu = computeActionSlotGroupingKey("TASK", "提出する");
    const slotKakunin = slots.find((s: { groupingKey: string }) => s.groupingKey === groupingKeyKakunin)!;
    const slotTeishutsu = slots.find((s: { groupingKey: string }) => s.groupingKey === groupingKeyTeishutsu)!;

    const revKakunin1 = await db.casePatternActionSlotRevision.findFirstOrThrow({ where: { workspaceId: fx.workspaceId, slotId: slotKakunin.id }, orderBy: { revision: "desc" } });
    const revTeishutsu1 = await db.casePatternActionSlotRevision.findFirstOrThrow({ where: { workspaceId: fx.workspaceId, slotId: slotTeishutsu.id }, orderBy: { revision: "desc" } });

    const durationKakunin1 = revKakunin1.durationDistribution as { status: string; sampleSize: number; medianSeconds?: number };
    ok("[1] materialize済みslot(確認する)はstatus=COMPUTED", durationKakunin1.status === "COMPUTED", JSON.stringify(durationKakunin1));
    ok("[1] sampleSize=1", durationKakunin1.sampleSize === 1, JSON.stringify(durationKakunin1));
    ok("[1] medianSeconds=1800", durationKakunin1.medianSeconds === 1800, JSON.stringify(durationKakunin1));

    const durationTeishutsu1 = revTeishutsu1.durationDistribution as { status: string; sampleSize: number };
    ok("[1] 未materializeのslot(提出する)はNOT_ENOUGH_DATAのまま", durationTeishutsu1.status === "NOT_ENOUGH_DATA" && durationTeishutsu1.sampleSize === 0, JSON.stringify(durationTeishutsu1));

    // ================================================================
    // [2] 2件目のmaterialize(3600秒)を追加し、中央値が再計算される。
    // ================================================================
    const parent3 = await makeSplittableCandidate(fx, "親3");
    const children3 = await doSplit(fx, parent3.sessionId, parent3.candidateId, [
      { type: "TASK", title: "確認する" },
      { type: "TASK", title: "提出する" },
    ], pattern.patternId);
    const kakuninChild3 = children3[0]!;
    const kakuninRevision3 = await db.formationCandidateRevision.findFirstOrThrow({ where: { workspaceId: fx.workspaceId, candidateId: kakuninChild3.id } });
    await materializeChildWithSessions(fx, kakuninChild3.id, kakuninRevision3.id, [3600]);

    await runActionSlotLearningForPattern(fx.workspaceId, pattern.patternId);
    const revKakunin2 = await db.casePatternActionSlotRevision.findFirstOrThrow({ where: { workspaceId: fx.workspaceId, slotId: slotKakunin.id }, orderBy: { revision: "desc" } });
    const durationKakunin2 = revKakunin2.durationDistribution as { status: string; sampleSize: number; medianSeconds?: number };
    ok("[2] sampleSize=2へ増える", durationKakunin2.sampleSize === 2, JSON.stringify(durationKakunin2));
    ok("[2] medianSeconds=中央値(1800,3600)=2700", durationKakunin2.medianSeconds === 2700, JSON.stringify(durationKakunin2));

    // ================================================================
    // [3] 中断・再開: 同一Responsibilityに複数CLOSED_CONFIRMED Sessionが
    // ある場合、合算される。
    // ================================================================
    const parent4 = await makeSplittableCandidate(fx, "親4");
    const children4 = await doSplit(fx, parent4.sessionId, parent4.candidateId, [
      { type: "TASK", title: "確認する" },
      { type: "TASK", title: "提出する" },
    ], pattern.patternId);
    const kakuninChild4 = children4[0]!;
    const kakuninRevision4 = await db.formationCandidateRevision.findFirstOrThrow({ where: { workspaceId: fx.workspaceId, candidateId: kakuninChild4.id } });
    // 600秒+900秒の中断・再開 = 合計1500秒。
    await materializeChildWithSessions(fx, kakuninChild4.id, kakuninRevision4.id, [600, 900]);

    await runActionSlotLearningForPattern(fx.workspaceId, pattern.patternId);
    const revKakunin3 = await db.casePatternActionSlotRevision.findFirstOrThrow({ where: { workspaceId: fx.workspaceId, slotId: slotKakunin.id }, orderBy: { revision: "desc" } });
    const durationKakunin3 = revKakunin3.durationDistribution as { status: string; sampleSize: number; medianSeconds?: number };
    ok("[3] 中断・再開の複数Sessionが合算され、sampleSize=3(1800,3600,1500)", durationKakunin3.sampleSize === 3, JSON.stringify(durationKakunin3));
    ok("[3] medianSeconds=中央値(1800,3600,1500)=1800", durationKakunin3.medianSeconds === 1800, JSON.stringify(durationKakunin3));

    // ================================================================
    // [4] owner/workspace分離。
    // ================================================================
    const slotsOtherFinal = await db.casePatternActionSlot.findMany({ where: { workspaceId: fxOther.workspaceId, patternId: patternOther.patternId } });
    const slotKakuninOther = slotsOtherFinal.find((s: { groupingKey: string }) => s.groupingKey === groupingKeyKakunin)!;
    const revKakuninOtherFinal = await db.casePatternActionSlotRevision.findFirstOrThrow({ where: { workspaceId: fxOther.workspaceId, slotId: slotKakuninOther.id }, orderBy: { revision: "desc" } });
    const durationOtherFinal = revKakuninOtherFinal.durationDistribution as { status: string; sampleSize: number; medianSeconds?: number };
    ok("[4] 対照group(fxOther)はsampleSize=1・medianSeconds=1200のまま(fx側の操作で影響されない)", durationOtherFinal.sampleSize === 1 && durationOtherFinal.medianSeconds === 1200, JSON.stringify(durationOtherFinal));
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
