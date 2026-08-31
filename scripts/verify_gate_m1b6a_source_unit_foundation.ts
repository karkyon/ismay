#!/usr/bin/env node
/**
 * scripts/verify_gate_m1b6a_source_unit_foundation.ts
 *
 * Gate M1-B6A §3.2.1(正規化Source Unit)の非課金DB受入証跡。
 * 出典: Claude向け ISMAY 69b5a87以降 監査是正・M1-B6完遂・PEM-0連続実装指示
 *       (2026-08-31) Gate M1-B6A §3.2.1。
 *
 * このscriptが検証するのはDB/domain層(schema・CHECK制約・Split/Merge継承)
 * のみ。§3.2.2(Provider Adapter expand)・§3.2.3(Candidate Evidence接続、
 * confidence上限0.49強制)は別Patchで扱う。
 *
 * AI providerへの実通信は一切行わない(aiNetworkDenyGuard必須)。
 *
 * 実行方法:
 *   cd ~/projects/ismay/app
 *   npx tsx ../scripts/verify_gate_m1b6a_source_unit_foundation.ts
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
const EMAIL_PREFIX = "gate-m1b6a-verify-";

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
  const { mergeFormationCandidates } = await import("../app/src/lib/formation/mergeCorrection");
  const { splitFormationCandidate } = await import("../app/src/lib/formation/splitCorrection");

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
      data: { email, passwordHash: "not-a-real-hash-for-db-only-test", displayName: `Gate M1-B6A ${suffix}` },
    });
    const workspace = await db.workspace.create({ data: { name: `Gate M1-B6A Workspace ${suffix}` } });
    await db.workspaceMember.create({ data: { workspaceId: workspace.id, userId: user.id, role: "OWNER" } });
    const domain = await db.domain.create({ data: { workspaceId: workspace.id, name: "個人", kind: "PERSONAL" } });
    userIds.push(user.id);
    return { userId: user.id, workspaceId: workspace.id, domainId: domain.id };
  }

  async function seedValidCandidate(fx: { workspaceId: string }, sessionId: string, key: string, title: string) {
    const identity = await db.formationCandidateIdentity.create({
      data: { workspaceId: fx.workspaceId, sessionId, candidateKey: key, currentRevision: 1 },
    });
    const revision = await db.formationCandidateRevision.create({
      data: {
        workspaceId: fx.workspaceId,
        candidateId: identity.id,
        revision: 1,
        type: "TASK",
        title,
        proposedFields: {
          candidateId: key,
          type: "TASK",
          title,
          evidenceSpans: [{ start: 0, end: 8 }],
          confidence: 0.9,
          dateMentions: [],
          unknowns: [],
          blockedByCandidateIds: [],
          suggestedTags: [],
        },
        confidence: 0.9,
        schemaVersion: "1.0",
      },
    });
    return { identity, revision };
  }

  try {
    // ============================================================
    // A: shadowWrite.ts経由でTEXT_OFFSET anchorがquality/anchorSchemaVersionを
    //    正しく持つ(正常range=AVAILABLE、不正range=UNAVAILABLE)。
    // ============================================================
    {
      const fx = await makeFixture("a");
      const rawText = "AAベンダの担当者へ見積を送付する";
      const capture = await db.capture.create({
        data: { workspaceId: fx.workspaceId, domainId: fx.domainId, createdById: fx.userId, sourceType: "TEXT", rawText, processingStatus: "READY" },
      });
      await writeShadowFormationSession({
        capture: { id: capture.id, workspaceId: fx.workspaceId, domainId: fx.domainId, createdById: fx.userId, rawText },
        aiRunId: `airun-${RUN_ID}-a`,
        schemaVersion: "1.0",
        candidates: [
          {
            candidateId: "c1",
            type: "TASK",
            title: "見積を送付する",
            completionCondition: "送付が完了する",
            evidenceSpans: [{ start: 0, end: 6 }],
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

      ok("[A.2・是正の核心] 正常rangeのTEXT_OFFSET anchorはquality=AVAILABLE", anchors[0]?.quality === "AVAILABLE", anchors[0]?.quality);
      ok("[A.3] anchorSchemaVersionが1.0", anchors[0]?.anchorSchemaVersion === "1.0", anchors[0]?.anchorSchemaVersion);
      ok("[A.4] unavailableReasonはnull(AVAILABLE時)", anchors[0]?.unavailableReason === null, String(anchors[0]?.unavailableReason));
    }

    {
      const fx = await makeFixture("a2");
      const rawText = "短い";
      const capture = await db.capture.create({
        data: { workspaceId: fx.workspaceId, domainId: fx.domainId, createdById: fx.userId, sourceType: "TEXT", rawText, processingStatus: "READY" },
      });
      await writeShadowFormationSession({
        capture: { id: capture.id, workspaceId: fx.workspaceId, domainId: fx.domainId, createdById: fx.userId, rawText },
        aiRunId: `airun-${RUN_ID}-a2`,
        schemaVersion: "1.0",
        candidates: [
          {
            candidateId: "c1",
            type: "TASK",
            title: "AIが範囲外を指した候補",
            completionCondition: "完了する",
            // [意図的] Capture本文(2文字)の範囲外を指すevidenceSpan。
            evidenceSpans: [{ start: 0, end: 999 }],
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
        "[A.6・是正の核心] 範囲外(不正range)のTEXT_OFFSET anchorはquality=UNAVAILABLE(捏造せず明示)",
        anchors[0]?.quality === "UNAVAILABLE",
        anchors[0]?.quality,
      );
      ok("[A.7] unavailableReasonが記録される", anchors[0]?.unavailableReason === "TEXT_OFFSET_OUT_OF_RANGE", String(anchors[0]?.unavailableReason));
    }

    // ============================================================
    // B: DB CHECK制約が正規化Source Unitの粗い不変条件を実際に拒否する。
    // ============================================================
    {
      const fx = await makeFixture("b");
      const rawText = "検証用テキスト";
      const capture = await db.capture.create({
        data: { workspaceId: fx.workspaceId, domainId: fx.domainId, createdById: fx.userId, sourceType: "TEXT", rawText, processingStatus: "READY" },
      });
      const session = await db.formationSession.create({
        data: { workspaceId: fx.workspaceId, domainId: fx.domainId, subjectUserId: fx.userId, captureId: capture.id, clientSessionKey: "b", state: "REVIEW_READY" },
      });
      const { revision } = await seedValidCandidate(fx, session.id, "c1", "検証用候補");

      async function expectRejected(label: string, data: Record<string, unknown>): Promise<void> {
        let rejected = false;
        try {
          await db.formationSourceAnchor.create({
            data: {
              workspaceId: fx.workspaceId,
              revisionId: revision.id,
              sourceKind: "AUDIO_TIMECODE",
              captureId: capture.id,
              excerptHash: `hash-${label}`,
              piiClassification: "UNCLASSIFIED",
              quality: "AVAILABLE",
              ...data,
            } as never,
          });
        } catch {
          rejected = true;
        }
        ok(`[B・${label}] DB CHECK制約が拒否する`, rejected);
      }

      await expectRejected("quality_invalid", { quality: "PARTIAL" });
      await expectRejected("unavailable_without_reason", { quality: "UNAVAILABLE" });
      await expectRejected("audio_start_ge_end", { audioStartMs: 5000, audioEndMs: 1000 });
      await expectRejected("ocr_confidence_out_of_range", { ocrConfidence: 1.5 });

      const validAudio = await db.formationSourceAnchor.create({
        data: {
          workspaceId: fx.workspaceId,
          revisionId: revision.id,
          sourceKind: "AUDIO_TIMECODE",
          captureId: capture.id,
          excerptHash: "hash-valid-audio",
          piiClassification: "UNCLASSIFIED",
          quality: "AVAILABLE",
          audioStartMs: 1000,
          audioEndMs: 2000,
          segmentIndex: 0,
        },
      });
      ok("[B・valid_audio] 正しいAUDIO_TIMECODE anchorは作成できる", validAudio.audioStartMs === 1000 && validAudio.audioEndMs === 2000);
    }

    // ============================================================
    // C: Merge/SplitがAUDIO_TIMECODE/MEETING_SPEAKER等のkind固有fieldを
    //    正確に継承する(捏造もdedupe誤爆も無い)。
    // ============================================================
    {
      const fx = await makeFixture("c");
      const rawText = "会議の議事メモ";
      const capture = await db.capture.create({
        data: { workspaceId: fx.workspaceId, domainId: fx.domainId, createdById: fx.userId, sourceType: "TEXT", rawText, processingStatus: "READY" },
      });
      const session = await db.formationSession.create({
        data: { workspaceId: fx.workspaceId, domainId: fx.domainId, subjectUserId: fx.userId, captureId: capture.id, clientSessionKey: "c", state: "REVIEW_READY" },
      });
      const a = await seedValidCandidate(fx, session.id, "a", "Aを実施する");
      const b = await seedValidCandidate(fx, session.id, "b", "Bを実施する");

      await db.formationSourceAnchor.create({
        data: {
          workspaceId: fx.workspaceId,
          revisionId: a.revision.id,
          sourceKind: "MEETING_SPEAKER",
          captureId: capture.id,
          excerptHash: "hash-a-speaker",
          piiClassification: "UNCLASSIFIED",
          quality: "AVAILABLE",
          speakerLabel: "Speaker A",
          speakerConfirmed: false,
          audioStartMs: 0,
          audioEndMs: 5000,
        },
      });
      await db.formationSourceAnchor.create({
        data: {
          workspaceId: fx.workspaceId,
          revisionId: b.revision.id,
          sourceKind: "MEETING_SPEAKER",
          captureId: capture.id,
          excerptHash: "hash-b-speaker",
          piiClassification: "UNCLASSIFIED",
          quality: "AVAILABLE",
          speakerLabel: "Speaker B",
          speakerConfirmed: false,
          audioStartMs: 5000,
          audioEndMs: 9000,
        },
      });

      const mergeResult = await mergeFormationCandidates({
        sessionId: session.id,
        workspaceId: fx.workspaceId,
        clientEventId: `client-${RUN_ID}-c`,
        parents: [
          { candidateId: a.identity.id, expectedRevision: 1 },
          { candidateId: b.identity.id, expectedRevision: 1 },
        ],
        merged: { type: "TASK", title: "統合後" },
        actorUserId: fx.userId,
      });
      ok("[C.1前提] Mergeが成功する", mergeResult.ok === true, JSON.stringify(mergeResult));
      if (mergeResult.ok) {
        const mergedAnchors = await db.formationSourceAnchor.findMany({
          where: { revisionId: mergeResult.newRevisionId, workspaceId: fx.workspaceId, sourceKind: "MEETING_SPEAKER" },
        });
        ok("[C.2・是正の核心] Merge後、MEETING_SPEAKER anchorが親2件分(重複無し)継承される", mergedAnchors.length === 2, String(mergedAnchors.length));
        const labels = mergedAnchors.map((x) => x.speakerLabel).sort();
        ok("[C.3] speakerLabelが両方とも正確に継承される(捏造・欠落なし)", JSON.stringify(labels) === JSON.stringify(["Speaker A", "Speaker B"]), JSON.stringify(labels));
      }

      const c = await seedValidCandidate(fx, session.id, "c", "Cを実施する");
      await db.formationSourceAnchor.create({
        data: {
          workspaceId: fx.workspaceId,
          revisionId: c.revision.id,
          sourceKind: "MEETING_SPEAKER",
          captureId: capture.id,
          excerptHash: "hash-c-speaker",
          piiClassification: "UNCLASSIFIED",
          quality: "AVAILABLE",
          speakerLabel: "Speaker C",
          speakerConfirmed: false,
          audioStartMs: 9000,
          audioEndMs: 12000,
        },
      });

      const splitResult = await splitFormationCandidate({
        sessionId: session.id,
        workspaceId: fx.workspaceId,
        candidateId: c.identity.id,
        expectedRevision: 1,
        parts: [
          { type: "TASK", title: "部分1" },
          { type: "TASK", title: "部分2" },
        ],
        actorUserId: fx.userId,
      });
      ok("[C.4前提] Splitが成功する", splitResult.ok === true, JSON.stringify(splitResult));
      if (splitResult.ok) {
        for (const child of splitResult.newCandidates) {
          const childAnchors = await db.formationSourceAnchor.findMany({
            where: { revisionId: child.revisionId, workspaceId: fx.workspaceId, sourceKind: "MEETING_SPEAKER" },
          });
          ok(
            `[C.5・${child.candidateKey}] Split後、子候補がspeakerLabel/audioStartMs/audioEndMsを正確に継承する`,
            childAnchors.length === 1 && childAnchors[0].speakerLabel === "Speaker C" && childAnchors[0].audioStartMs === 9000 && childAnchors[0].audioEndMs === 12000,
            JSON.stringify(childAnchors[0]),
          );
        }
      }
    }

    // ============================================================
    // D: §3.2.3 Source Anchorのない断定候補はconfidence上限0.49が
    //    保存前に強制される。
    // ============================================================
    {
      const fx = await makeFixture("d1");
      const rawText = "短いメモ";
      const capture = await db.capture.create({
        data: { workspaceId: fx.workspaceId, domainId: fx.domainId, createdById: fx.userId, sourceType: "TEXT", rawText, processingStatus: "READY" },
      });
      await writeShadowFormationSession({
        capture: { id: capture.id, workspaceId: fx.workspaceId, domainId: fx.domainId, createdById: fx.userId, rawText },
        aiRunId: `airun-${RUN_ID}-d1`,
        schemaVersion: "1.0",
        candidates: [
          {
            candidateId: "c1",
            type: "TASK",
            title: "根拠が原文範囲外を指す断定候補",
            completionCondition: "完了する",
            // [意図的] Capture本文(4文字)の範囲外を指す唯一のevidenceSpan。
            // 有効な根拠が1件も無い状態を再現する。
            evidenceSpans: [{ start: 0, end: 999 }],
            confidence: 0.95,
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

      ok(
        "[D.1・是正の核心] 根拠(AVAILABLE Anchor)が無い候補は、AI自己申告confidence(0.95)ではなく0.49以下で保存される",
        Number(revision.confidence) <= 0.49,
        String(revision.confidence),
      );
      const proposed = revision.proposedFields as { confidence?: number };
      ok(
        "[D.2] proposedFields(AIの元申告値)自体は書き換えない(0.95のまま、監査証跡として保持)",
        proposed.confidence === 0.95,
        String(proposed.confidence),
      );
    }

    {
      const fx = await makeFixture("d2");
      const rawText = "見積書を明日までに送付する";
      const capture = await db.capture.create({
        data: { workspaceId: fx.workspaceId, domainId: fx.domainId, createdById: fx.userId, sourceType: "TEXT", rawText, processingStatus: "READY" },
      });
      await writeShadowFormationSession({
        capture: { id: capture.id, workspaceId: fx.workspaceId, domainId: fx.domainId, createdById: fx.userId, rawText },
        aiRunId: `airun-${RUN_ID}-d2`,
        schemaVersion: "1.0",
        candidates: [
          {
            candidateId: "c1",
            type: "TASK",
            title: "見積書を送付する",
            completionCondition: "送付が完了する",
            evidenceSpans: [{ start: 0, end: 6 }],
            confidence: 0.95,
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

      ok(
        "[D.3・回帰確認] 有効な根拠がある候補のconfidenceは変更されない(0.95のまま)",
        Number(revision.confidence) === 0.95,
        String(revision.confidence),
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
