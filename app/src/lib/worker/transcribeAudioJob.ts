import { db } from "@/lib/db";
import type { Prisma } from "@/generated/prisma/client";
import { debugServer } from "@/lib/debugServer";
import { downloadAudioObject } from "@/lib/storage";
import { getActiveTranscriptionProvider, getActiveSegmentProvider } from "@/lib/ai/config";
import { estimateTranscriptionCostMicros } from "@/lib/ai/openaiTranscriptionProvider";
import { estimateCostMicros } from "@/lib/ai/pricing";
import type { AiTextSegment } from "@/lib/ai/segmentProvider";

/**
 * jobs テーブルの TRANSCRIBE_AUDIO ジョブをポーリング処理する(2026-08-21新設)。
 * API-CAP-02(音声入力)実装の一部。処理内容:
 *  1. MinIOから音声ファイルを取得
 *  2. 文字起こしプロバイダー(既定OpenAI gpt-transcribe)へ送信
 *  3. 成功時: Capture.rawTextへ書き込み、processingStatus=SAVED→AI抽出キューへ自動投入
 *     (CaptureAnalysisRequested.v1を発行。POST /captures同様の自動チェーン)
 *  4. 失敗時: Capture.processingStatus=FAILEDとし、AiRunに失敗理由を記録
 *
 * [2026-08-21再修正] AiRun.promptVersion/schemaVersionは必須列(NOT NULL)であるにも
 * かかわらず、前回パッチでは渡し忘れており、実サーバーのtsc(型情報が完全な状態)で
 * 初めて発覚した。本サンドボックスはPrisma Client生成がネットワーク制約で行えず、
 * 簡易スタブでの検証では検出できなかった不備であり、schema.prismaを直接再確認した
 * うえで両フィールドを追加した。
 *
 * [2026-08-21追加] 話題自動分割(カルキョンさんの指示「音声のテーマ切り替わりでの
 * 複数Capture自動分割」に対応)。文字起こし成功後、原文が一定の長さ以上
 * (SEGMENT_MIN_TEXT_LENGTH)の場合のみ話題分割AIを呼び、明確な話題の切れ目が
 * あれば複数Captureへ分割する。短いメモは呼ばない(コスト・誤分割リスクの両面で
 * 割に合わないため)。分割AI自体が失敗しても文字起こし結果は失わない
 * (分割なしの従来どおり1件のCaptureとして扱うようフォールバックする)。
 *
 * aiExtractJob.tsと同じ設計方針: プロバイダー呼び出し自体の失敗はJobを成功扱いで終える
 * (Capture側をFAILEDにするのみ)。Jobレベル再試行はDB接続断など無関係の例外にのみ適用。
 */

const JOB_BATCH_SIZE = 2; // 音声ファイルは処理が重いため抽出より少なめのバッチ
const BASE_BACKOFF_SECONDS = 30;
const PROMPT_VERSION = "voice-transcribe-v1";
const SCHEMA_VERSION = "n/a"; // 文字起こしは構造化出力ではないため、抽出プロンプトと違いスキーマバージョンの概念が無い
/** [2026-08-21追加] この文字数未満の文字起こし結果は話題分割AIを呼ばない(短いメモは分割不要)。 */
const SEGMENT_MIN_TEXT_LENGTH = 1200;
/** [2026-08-21追加] この文字数未満のセグメントは前のセグメントへ統合する(過剰分割対策)。 */
const SEGMENT_MIN_CHUNK_LENGTH = 150;

export async function processTranscribeAudioJobs(): Promise<{ processed: number }> {
  const now = new Date();
  const candidates = await db.job.findMany({
    where: {
      jobType: "TRANSCRIBE_AUDIO",
      status: "QUEUED",
      OR: [{ nextRunAt: null }, { nextRunAt: { lte: now } }],
    },
    orderBy: { createdAt: "asc" },
    take: JOB_BATCH_SIZE,
  });

  let processed = 0;
  for (const job of candidates) {
    const claimed = await db.job.updateMany({
      where: { id: job.id, status: "QUEUED" },
      data: { status: "RUNNING" },
    });
    if (claimed.count === 0) continue;
    debugServer.state("Worker/transcribeAudioJob", "Job.status", { jobId: job.id, status: "RUNNING" });

    const payload = job.payload as { captureId?: string } | null;
    const captureId = payload?.captureId;
    if (!captureId) {
      await db.job.update({
        where: { id: job.id },
        data: { status: "DEAD_LETTER", lastError: "payload.captureIdが不正です" },
      });
      continue;
    }

    try {
      const result = await runTranscriptionForCapture(captureId);
      debugServer.event("Worker/transcribeAudioJob", "runTranscriptionForCapture", {
        jobId: job.id,
        captureId,
        status: result.status,
      });
      await db.job.update({
        where: { id: job.id },
        data: {
          status: "SUCCEEDED",
          lastError: result.status === "FAILED" ? result.reason.slice(0, 500) : null,
        },
      });
      processed++;
    } catch (err) {
      const attempts = job.attempts + 1;
      const isDead = attempts >= job.maxAttempts;
      const backoffSeconds = BASE_BACKOFF_SECONDS * Math.pow(2, attempts - 1);
      await db.job.update({
        where: { id: job.id },
        data: {
          status: isDead ? "DEAD_LETTER" : "QUEUED",
          attempts,
          lastError: String(err).slice(0, 500),
          nextRunAt: isDead ? null : new Date(Date.now() + backoffSeconds * 1000),
        },
      });
      debugServer.error("Worker/transcribeAudioJob", "想定外の例外", { jobId: job.id, captureId, err });
    }
  }

  return { processed };
}

type TranscriptionRunResult = { status: "READY" } | { status: "FAILED"; reason: string } | { status: "SKIPPED"; reason: string };

async function runTranscriptionForCapture(captureId: string): Promise<TranscriptionRunResult> {
  const capture = await db.capture.findUnique({ where: { id: captureId } });
  if (!capture || capture.deletedAt) {
    return { status: "SKIPPED", reason: "Captureが存在しないか削除済みです" };
  }
  if (!capture.audioObjectKey) {
    await markCaptureFailed(capture.id, capture.version, "audioObjectKeyが設定されていません");
    return { status: "FAILED", reason: "audioObjectKeyが設定されていません" };
  }

  const claimed = await db.capture.updateMany({
    where: { id: capture.id, version: capture.version, processingStatus: "QUEUED" },
    data: { processingStatus: "PROCESSING", version: { increment: 1 } },
  });
  if (claimed.count === 0) {
    return { status: "SKIPPED", reason: "既にPROCESSING/READY等へ遷移済みのためスキップしました" };
  }
  const processingVersion = capture.version + 1;

  const provider = await getActiveTranscriptionProvider(capture.workspaceId);
  const audioBuffer = await downloadAudioObject(capture.audioObjectKey).catch((err) => {
    debugServer.error("transcribeAudioJob", "MinIOからのダウンロードに失敗", err);
    return null;
  });
  if (!audioBuffer) {
    await markCaptureFailed(capture.id, processingVersion, "音声ファイルの取得に失敗しました");
    return { status: "FAILED", reason: "音声ファイルの取得に失敗しました" };
  }

  const fileName = capture.audioObjectKey.split("/").pop() ?? "audio";
  const outcome = await provider.transcribe({
    audioBuffer,
    contentType: guessContentType(fileName),
    fileName,
  });

  // AiRun.promptVersion/schemaVersionはschema.prisma上NOT NULL(String、String?ではない)。
  // 抽出(extract.ts)と違い文字起こしにはプロンプト/スキーマの概念が薄いが、
  // 必須列であるため固定文字列を設定する。
  const aiRun = await db.aiRun.create({
    data: {
      captureId: capture.id,
      provider: provider.providerName,
      model: provider.modelName,
      promptVersion: PROMPT_VERSION,
      schemaVersion: SCHEMA_VERSION,
      status: outcome.ok ? "SUCCEEDED" : "FAILED",
      latencyMs: outcome.usage?.latencyMs ?? null,
      costMicros: outcome.ok ? estimateTranscriptionCostMicros(outcome.durationSeconds) : null,
      errorCode: outcome.ok ? null : outcome.message,
      // [M1-B6C-2新設・2026-09-01] Providerが返したsegmentsをそのまま保存する。
      // undefinedの場合(Providerがverbose_json形式のsegmentsを返さなかった)は
      // 列をnullのままにする(空配列との違いを保つ。捏造しない)。
      transcriptSegments: outcome.ok && outcome.segments ? (outcome.segments as unknown as object) : undefined,
      startedAt: new Date(),
      finishedAt: new Date(),
    },
  });
  debugServer.event("transcribeAudioJob", "AiRun記録", { aiRunId: aiRun.id, ok: outcome.ok });

  if (!outcome.ok) {
    await markCaptureFailed(capture.id, processingVersion, outcome.message);
    return { status: "FAILED", reason: outcome.message };
  }

  // 文字起こし成功: 話題分割を試みたうえで、rawTextへの書き込み・AI抽出キューへの
  // 自動投入を行う(processCompletedTranscription側で分割有無を判定する)。
  await processCompletedTranscription(capture, outcome.text);

  return { status: "READY" };
}

/**
 * [2026-08-21追加] 文字起こし完了後の後処理。原文が十分長い場合のみ話題分割AIを呼び、
 * 明確な話題の切れ目があれば複数Captureへ分割する。分割しない場合(短文・分割AI失敗・
 * 単一セグメント判定)は、従来どおり1件のCaptureとして扱う。
 */
async function processCompletedTranscription(
  capture: { id: string; workspaceId: string; domainId: string | null; createdById: string; processingPriority: string; sourceCapturedAt: Date | null; consentId: string | null },
  rawText: string,
): Promise<void> {
  let segments: AiTextSegment[] | null = null;

  if (rawText.length >= SEGMENT_MIN_TEXT_LENGTH) {
    segments = await trySegmentText(capture.id, capture.workspaceId, rawText);
  }

  if (!segments || segments.length <= 1) {
    // 分割なし: 従来どおり1件のCaptureとして進める。
    await db.$transaction(async (tx: Prisma.TransactionClient) => {
      const updated = await tx.capture.update({
        where: { id: capture.id },
        data: { rawText, processingStatus: "QUEUED", version: { increment: 1 } },
      });
      await tx.eventLog.create({
        data: {
          aggregateType: "Capture",
          aggregateId: capture.id,
          eventType: "CAPTURE_TRANSCRIBED",
          afterJson: { textLength: rawText.length },
          actorType: "SYSTEM",
        },
      });
      await tx.outboxEvent.create({
        data: {
          eventName: "CaptureAnalysisRequested.v1",
          eventVersion: "1",
          aggregateId: capture.id,
          aggregateVersion: updated.version,
          payload: { captureId: capture.id, workspaceId: capture.workspaceId, sourceType: "VOICE" },
        },
      });
    });
    debugServer.event("transcribeAudioJob", "文字起こし完了・AI抽出キューへ自動投入(分割なし)", { captureId: capture.id });
    return;
  }

  // 分割あり: 1件目は既存Captureのrawtextを差し替え、2件目以降は新規Captureを作成する。
  // それぞれ独立にQUEUED→AI抽出キューへ投入する(1件失敗しても他へ影響しない)。
  await db.$transaction(async (tx: Prisma.TransactionClient) => {
    const firstSegment = segments![0];
    const updated = await tx.capture.update({
      where: { id: capture.id },
      data: {
        rawText: rawText.slice(firstSegment.startChar, firstSegment.endChar),
        processingStatus: "QUEUED",
        version: { increment: 1 },
      },
    });
    await tx.eventLog.create({
      data: {
        aggregateType: "Capture",
        aggregateId: capture.id,
        eventType: "CAPTURE_TRANSCRIBED",
        afterJson: { textLength: firstSegment.endChar - firstSegment.startChar, splitIntoCount: segments!.length, title: firstSegment.title },
        actorType: "SYSTEM",
      },
    });
    await tx.outboxEvent.create({
      data: {
        eventName: "CaptureAnalysisRequested.v1",
        eventVersion: "1",
        aggregateId: capture.id,
        aggregateVersion: updated.version,
        payload: { captureId: capture.id, workspaceId: capture.workspaceId, sourceType: "VOICE" },
      },
    });

    for (const segment of segments!.slice(1)) {
      const child = await tx.capture.create({
        data: {
          workspaceId: capture.workspaceId,
          domainId: capture.domainId,
          createdById: capture.createdById,
          sourceType: "VOICE",
          rawText: rawText.slice(segment.startChar, segment.endChar),
          processingStatus: "QUEUED",
          processingPriority: capture.processingPriority,
          sourceCapturedAt: capture.sourceCapturedAt,
          consentId: capture.consentId,
          splitFromCaptureId: capture.id,
        },
      });
      await tx.eventLog.create({
        data: {
          aggregateType: "Capture",
          aggregateId: child.id,
          eventType: "CAPTURE_SAVED",
          afterJson: { sourceType: "VOICE", processingStatus: "QUEUED", splitFromCaptureId: capture.id, title: segment.title },
          actorType: "SYSTEM",
        },
      });
      await tx.outboxEvent.create({
        data: {
          eventName: "CaptureAnalysisRequested.v1",
          eventVersion: "1",
          aggregateId: child.id,
          aggregateVersion: child.version,
          payload: { captureId: child.id, workspaceId: capture.workspaceId, sourceType: "VOICE" },
        },
      });
    }
  });
  debugServer.event("transcribeAudioJob", "文字起こし完了・話題分割してAI抽出キューへ自動投入", {
    captureId: capture.id,
    splitIntoCount: segments.length,
  });
}

/** 話題分割AIを呼び、検証済みセグメント配列を返す。呼び出し自体の失敗やAI判定「分割不要」はnullで返す。 */
async function trySegmentText(captureId: string, workspaceId: string, rawText: string): Promise<AiTextSegment[] | null> {
  const provider = await getActiveSegmentProvider(workspaceId);
  const outcome = await provider.segmentText({ rawText, nowIso: new Date().toISOString() });

  await db.aiRun.create({
    data: {
      captureId,
      provider: provider.providerName,
      model: provider.modelName,
      promptVersion: provider.promptVersion,
      schemaVersion: provider.schemaVersion,
      status: outcome.ok ? "SUCCEEDED" : "FAILED",
      inputTokens: outcome.ok ? outcome.usage.inputTokens : (outcome.usage?.inputTokens ?? null),
      outputTokens: outcome.ok ? outcome.usage.outputTokens : (outcome.usage?.outputTokens ?? null),
      latencyMs: outcome.ok ? outcome.usage.latencyMs : (outcome.usage?.latencyMs ?? null),
      costMicros: outcome.ok ? estimateCostMicros(provider.modelName, outcome.usage.inputTokens, outcome.usage.outputTokens) : null,
      errorCode: outcome.ok ? null : outcome.message,
      startedAt: new Date(),
      finishedAt: new Date(),
    },
  });

  if (!outcome.ok) {
    debugServer.error("transcribeAudioJob", "話題分割AI失敗(分割なしにフォールバック)", { captureId, message: outcome.message });
    return null;
  }

  const validated = validateSegments(rawText, outcome.segments);
  debugServer.event("transcribeAudioJob", "話題分割結果", { captureId, segmentCount: validated.length });
  return validated;
}

/**
 * モデルが返したセグメント境界を検証・正規化する。
 * - 範囲外・逆転(end<=start)のセグメントは除去
 * - startChar昇順に並べ替え
 * - 重複区間は前のセグメントへ吸収
 * - SEGMENT_MIN_CHUNK_LENGTH未満の短いセグメントは前のセグメントへ統合
 * - 先頭は0、末尾はrawText.lengthに強制し、原文全体を過不足なく覆うようにする
 */
function validateSegments(rawText: string, rawSegments: AiTextSegment[]): AiTextSegment[] {
  const clamped = rawSegments
    .map((s) => ({
      title: (s.title ?? "").trim() || "（無題）",
      startChar: Math.max(0, Math.min(Math.trunc(s.startChar ?? 0), rawText.length)),
      endChar: Math.max(0, Math.min(Math.trunc(s.endChar ?? 0), rawText.length)),
    }))
    .filter((s) => s.endChar > s.startChar)
    .sort((a, b) => a.startChar - b.startChar);

  if (clamped.length === 0) return [];

  const merged: AiTextSegment[] = [];
  for (const seg of clamped) {
    const last = merged[merged.length - 1];
    if (last && seg.startChar < last.endChar) {
      // 前のセグメントと重複: 前のセグメントを拡張して吸収する
      last.endChar = Math.max(last.endChar, seg.endChar);
      continue;
    }
    if (last && seg.endChar - seg.startChar < SEGMENT_MIN_CHUNK_LENGTH) {
      // 短すぎるセグメント: 前のセグメントへ統合する
      last.endChar = seg.endChar;
      continue;
    }
    merged.push({ ...seg });
  }

  merged[0].startChar = 0;
  merged[merged.length - 1].endChar = rawText.length;
  return merged;
}

async function markCaptureFailed(captureId: string, expectedVersion: number, reason: string): Promise<void> {
  await db.capture.updateMany({
    where: { id: captureId, version: expectedVersion },
    data: { processingStatus: "FAILED", version: { increment: 1 } },
  });
  debugServer.error("transcribeAudioJob", "文字起こし失敗", { captureId, reason });
}

function guessContentType(fileName: string): string {
  const ext = fileName.split(".").pop()?.toLowerCase();
  const map: Record<string, string> = {
    mp3: "audio/mpeg",
    mp4: "audio/mp4",
    m4a: "audio/mp4",
    wav: "audio/wav",
    webm: "audio/webm",
    ogg: "audio/ogg",
  };
  return map[ext ?? ""] ?? "application/octet-stream";
}
