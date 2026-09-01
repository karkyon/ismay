#!/usr/bin/env node
/**
 * scripts/verify_gate_m1b6c2_source_anchor_live_wiring.ts
 *
 * Gate M1-B6C-2(Source Anchor live配線)の非課金DB受入証跡。
 * 出典: Claude向け ISMAY c503e72以降 M1-B6C・全残件連続実装指示(2026-08-31) §4。
 *
 * AI providerへの実通信は一切行わない(aiNetworkDenyGuard必須)。文字起こし
 * segmentsはDB fixtureとして決定論的にseedする(実Provider応答を待たない)。
 *
 * 実行方法:
 *   cd ~/projects/ismay/app
 *   npx tsx ../scripts/verify_gate_m1b6c2_source_anchor_live_wiring.ts
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { createHash } from "node:crypto";
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
const EMAIL_PREFIX = "gate-m1b6c2-anchor-verify-";

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
  if (!guardSelfTestPassed) {
    denyGuard.restore();
    console.log(`\n合計: ${passed} passed, ${failed} failed`);
    process.exitCode = 1;
    return;
  }

  const { db } = await import("../app/src/lib/db");
  const { createShadowCheckpoint, processShadowCheckpoint } = await import("../app/src/lib/formation/shadowCheckpoint");
  const { mergeFormationCandidates } = await import("../app/src/lib/formation/mergeCorrection");

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
      data: { email, passwordHash: "not-a-real-hash-for-db-only-test", displayName: `Gate M1-B6C-2 ${suffix}` },
    });
    const workspace = await db.workspace.create({ data: { name: `Gate M1-B6C-2 Workspace ${suffix}` } });
    await db.workspaceMember.create({ data: { workspaceId: workspace.id, userId: user.id, role: "OWNER" } });
    const domain = await db.domain.create({ data: { workspaceId: workspace.id, name: "個人", kind: "PERSONAL" } });
    userIds.push(user.id);
    return { userId: user.id, workspaceId: workspace.id, domainId: domain.id };
  }

  function candidatePayload(candidateId: string, span: { start: number; end: number }) {
    return {
      candidateId,
      type: "TASK",
      title: "資料を送付する",
      evidenceSpans: [span],
      confidence: 0.8,
      dateMentions: [],
      unknowns: [],
      blockedByCandidateIds: [],
      suggestedTags: [],
      clarificationSignals: [],
    };
  }

  /**
   * VOICE Capture + (任意で)transcriptSegments付き文字起こしAiRun + 抽出AiRun/
   * AiInference + shadow checkpointをseedし、processShadowCheckpointまで実行する。
   */
  async function runVoiceShadowWrite(
    fx: { workspaceId: string; domainId: string; userId: string },
    opts: {
      rawText: string;
      evidenceSpan: { start: number; end: number };
      transcriptSegments: Array<{ startMs: number; endMs: number; text: string }> | null;
      sourceType?: string;
    },
  ) {
    const capture = await db.capture.create({
      data: {
        workspaceId: fx.workspaceId,
        domainId: fx.domainId,
        createdById: fx.userId,
        sourceType: opts.sourceType ?? "VOICE",
        rawText: opts.rawText,
        processingStatus: "READY",
      },
    });
    if (opts.transcriptSegments) {
      await db.aiRun.create({
        data: {
          captureId: capture.id,
          workspaceId: fx.workspaceId,
          provider: "test-transcription-provider",
          model: "test-model",
          promptVersion: "voice-transcribe-v1",
          schemaVersion: "n/a",
          status: "SUCCEEDED",
          finishedAt: new Date(),
          transcriptSegments: opts.transcriptSegments,
        },
      });
    }
    const aiRun = await db.aiRun.create({
      data: {
        captureId: capture.id,
        workspaceId: fx.workspaceId,
        provider: "test-extraction-provider",
        model: "test-model",
        promptVersion: "v-test",
        schemaVersion: "v-test",
        status: "SUCCEEDED",
        finishedAt: new Date(),
      },
    });
    const candidateId = `cand-${RUN_ID}-${capture.id.slice(0, 8)}`;
    await db.aiInference.create({
      data: {
        captureId: capture.id,
        aiRunId: aiRun.id,
        inferenceType: "RESPONSIBILITY",
        payload: candidatePayload(candidateId, opts.evidenceSpan),
        evidenceSpans: [opts.evidenceSpan],
        confidence: 0.8,
        decision: "PENDING",
      },
    });
    const checkpoint = await db.$transaction((tx: any) =>
      createShadowCheckpoint(tx, {
        workspaceId: fx.workspaceId,
        captureId: capture.id,
        aiRunId: aiRun.id,
        schemaVersion: "v-test",
        candidateCount: 1,
      }),
    );
    const outcome = await processShadowCheckpoint(checkpoint.id);
    return { capture, outcome };
  }

  try {
    // ============================================================
    // A: 正常系。segmentがevidenceSpanを完全に内包する場合、AUDIO_TIMECODE
    //    AnchorがAVAILABLEで作られ、audioStartMs/audioEndMs/segmentIndexが
    //    正しく転記される。TEXT_OFFSET Anchorは従来どおり作られる(併記)。
    // ============================================================
    {
      const fx = await makeFixture("a");
      const rawText = "資料を金曜までに送付する。担当は田中さん。";
      const { capture, outcome } = await runVoiceShadowWrite(fx, {
        rawText,
        evidenceSpan: { start: 0, end: 5 },
        transcriptSegments: [
          { startMs: 0, endMs: 2000, text: "資料を金曜までに送付する。" },
          { startMs: 2000, endMs: 4000, text: "担当は田中さん。" },
        ],
      });
      ok("[A.1] shadow書込みはSUCCEEDEDになる", outcome === "SUCCEEDED", outcome);

      const anchors = await db.formationSourceAnchor.findMany({ where: { captureId: capture.id } });
      const textAnchor = anchors.find((a: any) => a.sourceKind === "TEXT_OFFSET");
      const audioAnchor = anchors.find((a: any) => a.sourceKind === "AUDIO_TIMECODE");
      ok("[A.2] TEXT_OFFSET Anchorが作られる(併記・置換されない)", !!textAnchor);
      ok("[A.3・非課金受入] AUDIO_TIMECODE Anchorが作られる", !!audioAnchor);
      ok("[A.4] AUDIO_TIMECODEはquality=AVAILABLE", audioAnchor?.quality === "AVAILABLE", audioAnchor?.quality);
      ok("[A.5] audioStartMs/audioEndMsがsegment1の値と一致する", audioAnchor?.audioStartMs === 0 && audioAnchor?.audioEndMs === 2000, JSON.stringify(audioAnchor));
      ok("[A.6] segmentIndex=0", audioAnchor?.segmentIndex === 0, String(audioAnchor?.segmentIndex));
    }

    // ============================================================
    // B: segmentが無い(Providerがsegmentsを返さなかった)場合、AUDIO_TIMECODE
    //    AnchorはUNAVAILABLEになる(捏造しない)。TEXT_OFFSETは通常どおり作られる。
    // ============================================================
    {
      const fx = await makeFixture("b");
      const rawText = "資料を送付する。";
      const { capture, outcome } = await runVoiceShadowWrite(fx, {
        rawText,
        evidenceSpan: { start: 0, end: 5 },
        transcriptSegments: null,
      });
      ok("[B.1] shadow書込みはSUCCEEDEDになる", outcome === "SUCCEEDED", outcome);
      const anchors = await db.formationSourceAnchor.findMany({ where: { captureId: capture.id } });
      const textAnchor = anchors.find((a: any) => a.sourceKind === "TEXT_OFFSET");
      const audioAnchor = anchors.find((a: any) => a.sourceKind === "AUDIO_TIMECODE");
      ok("[B.2] TEXT_OFFSET Anchorは通常どおり作られる", !!textAnchor);
      ok("[B.3・捏造しない] AUDIO_TIMECODE AnchorはUNAVAILABLE", audioAnchor?.quality === "UNAVAILABLE", audioAnchor?.quality);
      ok("[B.4] audioStartMs/audioEndMsはnullのまま", audioAnchor?.audioStartMs === null && audioAnchor?.audioEndMs === null);
      ok("[B.5] unavailableReasonが記録される", audioAnchor?.unavailableReason === "PROVIDER_NO_TIMECODE_SEGMENTS", audioAnchor?.unavailableReason);
    }

    // ============================================================
    // C: evidenceSpanが2segmentにまたがる場合、AUDIO_TIMECODEはUNAVAILABLE
    //    (捏造せず、どちらのsegmentにも属すると断定しない・境界値)。
    // ============================================================
    {
      const fx = await makeFixture("c");
      const rawText = "資料を金曜までに送付する。担当は田中さん。";
      const seg1Len = "資料を金曜までに送付する。".length;
      const { capture, outcome } = await runVoiceShadowWrite(fx, {
        rawText,
        evidenceSpan: { start: seg1Len - 2, end: seg1Len + 2 }, // segment1とsegment2にまたがる
        transcriptSegments: [
          { startMs: 0, endMs: 2000, text: "資料を金曜までに送付する。" },
          { startMs: 2000, endMs: 4000, text: "担当は田中さん。" },
        ],
      });
      ok("[C.1] shadow書込みはSUCCEEDEDになる", outcome === "SUCCEEDED", outcome);
      const audioAnchor = await db.formationSourceAnchor.findFirst({ where: { captureId: capture.id, sourceKind: "AUDIO_TIMECODE" } });
      ok("[C.2・境界値・捏造しない] segmentをまたぐevidenceはUNAVAILABLEになる", audioAnchor?.quality === "UNAVAILABLE", audioAnchor?.quality);
    }

    // ============================================================
    // D: TEXT sourceTypeのCaptureでは、そもそもAUDIO_TIMECODE Anchor自体を
    //    作らない(無関係なsourceKindでDBを汚さない)。
    // ============================================================
    {
      const fx = await makeFixture("d");
      const { capture, outcome } = await runVoiceShadowWrite(fx, {
        rawText: "資料を送付する。",
        evidenceSpan: { start: 0, end: 5 },
        transcriptSegments: null,
        sourceType: "TEXT",
      });
      ok("[D.1] shadow書込みはSUCCEEDEDになる", outcome === "SUCCEEDED", outcome);
      const audioAnchor = await db.formationSourceAnchor.findFirst({ where: { captureId: capture.id, sourceKind: "AUDIO_TIMECODE" } });
      ok("[D.2] TEXT Captureに対してAUDIO_TIMECODE Anchorは作られない", audioAnchor === null);
    }

    // ============================================================
    // E: 話題分割された子Capture相当(=このcaptureId自身の文字起こしAiRunが
    //    存在しない)場合も、AUDIO_TIMECODEはUNAVAILABLEに安全にfallbackする
    //    (誤ったtimecodeを表示するくらいなら無い方が安全、という既知の限界の確認)。
    // ============================================================
    {
      const fx = await makeFixture("e");
      // transcriptSegments:nullだが、これは「話題分割された子Capture」を模している
      // (実際には親のtranscriptSegmentsは親のcaptureIdに紐づいており、子からは
      // 見えない。ここでは直接null=文字起こしAiRunなしとして同じ結果を確認する)。
      const { capture, outcome } = await runVoiceShadowWrite(fx, {
        rawText: "分割後の後半部分のテキストです。",
        evidenceSpan: { start: 0, end: 5 },
        transcriptSegments: null,
      });
      ok("[E.1] shadow書込みはSUCCEEDEDになる", outcome === "SUCCEEDED", outcome);
      const audioAnchor = await db.formationSourceAnchor.findFirst({ where: { captureId: capture.id, sourceKind: "AUDIO_TIMECODE" } });
      ok("[E.2・既知の限界の確認] 文字起こしAiRunが見つからないCaptureはUNAVAILABLEになる", audioAnchor?.quality === "UNAVAILABLE", audioAnchor?.quality);
    }

    // ============================================================
    // F: Merge後もAUDIO_TIMECODE固有field(audioStartMs/audioEndMs/segmentIndex)
    //    が正確に継承されることをDBで再確認する(指示書§4「Split/Merge後も
    //    全kind固有fieldが保持されることをDBで再確認する」)。
    // ============================================================
    {
      const fx = await makeFixture("f");
      const cap = await db.capture.create({
        data: { workspaceId: fx.workspaceId, domainId: fx.domainId, createdById: fx.userId, sourceType: "VOICE", rawText: "資料を送る/確認する", processingStatus: "READY" },
      });
      const session = await db.formationSession.create({
        data: { workspaceId: fx.workspaceId, domainId: fx.domainId, subjectUserId: fx.userId, captureId: cap.id, clientSessionKey: "merge-f", state: "REVIEW_READY" },
      });

      async function seedVoiceCandidate(key: string, title: string, span: { start: number; end: number }, audioStartMs: number, audioEndMs: number, segmentIndex: number) {
        const identity = await db.formationCandidateIdentity.create({
          data: { workspaceId: fx.workspaceId, sessionId: session.id, candidateKey: key, currentRevision: 1 },
        });
        const revision = await db.formationCandidateRevision.create({
          data: {
            workspaceId: fx.workspaceId,
            candidateId: identity.id,
            revision: 1,
            type: "TASK",
            title,
            proposedFields: candidatePayload(key, span),
            confidence: 0.9,
            schemaVersion: "1.0",
          },
        });
        const excerpt = title;
        await db.formationSourceAnchor.create({
          data: {
            workspaceId: fx.workspaceId,
            revisionId: revision.id,
            sourceKind: "AUDIO_TIMECODE",
            captureId: cap.id,
            excerptHash: createHash("sha256").update(excerpt).digest("hex"),
            quality: "AVAILABLE",
            audioStartMs,
            audioEndMs,
            segmentIndex,
            piiClassification: "NONE",
          },
        });
        return identity;
      }

      const a = await seedVoiceCandidate("a", "資料を送る", { start: 0, end: 5 }, 0, 2000, 0);
      const b = await seedVoiceCandidate("b", "確認する", { start: 6, end: 10 }, 2000, 4000, 1);

      const result = await mergeFormationCandidates({
        sessionId: session.id,
        workspaceId: fx.workspaceId,
        clientEventId: `ce-${RUN_ID}-f`,
        parents: [
          { candidateId: a.id, expectedRevision: 1 },
          { candidateId: b.id, expectedRevision: 1 },
        ],
        merged: { type: "TASK", title: "資料を送って確認する", completionCondition: "資料送付と確認が完了する" },
        actorUserId: fx.userId,
      });
      ok("[F.1] Mergeが成功する", result.ok === true, JSON.stringify(result));

      if (result.ok) {
        const newAudioAnchors = await db.formationSourceAnchor.findMany({
          where: { revisionId: result.newRevisionId, workspaceId: fx.workspaceId, sourceKind: "AUDIO_TIMECODE" },
        });
        ok("[F.2・非課金受入] Merge後、両親のAUDIO_TIMECODE Anchor(2件)が新候補へ継承される", newAudioAnchors.length === 2, String(newAudioAnchors.length));
        const seg0 = newAudioAnchors.find((a: any) => a.segmentIndex === 0);
        const seg1 = newAudioAnchors.find((a: any) => a.segmentIndex === 1);
        ok("[F.3] segmentIndex=0のaudioStartMs/audioEndMsが正確に継承される", seg0?.audioStartMs === 0 && seg0?.audioEndMs === 2000, JSON.stringify(seg0));
        ok("[F.4] segmentIndex=1のaudioStartMs/audioEndMsが正確に継承される", seg1?.audioStartMs === 2000 && seg1?.audioEndMs === 4000, JSON.stringify(seg1));
      }
    }
  } catch (err) {
    failed++;
    failures.push(`予期しない例外: ${String(err)}`);
    console.error(err);
  }

  for (const uid of userIds) {
    const result = await cleanupFormationVerifyUser(db, uid);
    if (result.errors.length > 0) {
      failed++;
      failures.push(`cleanup失敗(userId=${uid}): ${JSON.stringify(result.errors)}`);
    }
  }
  const leftover = await assertNoLeftoverFormationVerifyUsers(db, EMAIL_PREFIX);
  ok("[cleanup] test用Userが1件も残っていない", leftover.clean, JSON.stringify(leftover.remainingUserIds));

  denyGuard.restore();
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
