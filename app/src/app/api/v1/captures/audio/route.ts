import type { NextRequest } from "next/server";
import { db } from "@/lib/db";
import { debugServer } from "@/lib/debugServer";
import { requireAuth, requireCsrf } from "@/lib/auth/guard";
import { ensureDefaultWorkspace } from "@/lib/workspace";
import { apiOk, apiError } from "@/lib/auth/response";
import { uploadAudioObject, buildAudioObjectKey } from "@/lib/storage";

/**
 * POST /api/v1/captures/audio(2026-08-21新設。API-CAP-02音声入力)。
 * 「Inboxへの音声ファイルの投入。mp4等形式は？」という指摘に対応。
 *
 * POST /captures(JSON)とは別エンドポイントにした理由: multipart/form-dataは
 * 既存のCreateCaptureSchema(zod, JSON専用)と構造が異なり、混在させるとPOST /captures側の
 * 見通しが悪くなるため。処理の骨格(EventLog/OutboxEvent発行)は揃えている。
 *
 * 対応形式: mp3 / mp4(音声トラックのみ) / m4a / wav / webm / ogg。
 * ファイルサイズ上限25MB(OpenAI gpt-transcribe側の制約に合わせる)。
 */

const MAX_FILE_SIZE_BYTES = 25 * 1024 * 1024; // 25MB
const ALLOWED_EXTENSIONS = ["mp3", "mp4", "m4a", "wav", "webm", "ogg"];

export async function POST(req: NextRequest) {
  const auth = await requireAuth(req);
  if (!auth.authenticated) {
    return apiError("AUTH_REQUIRED", "ログインが必要です");
  }
  if (!requireCsrf(req)) {
    return apiError("ACCESS_DENIED", "CSRFトークンが不正です");
  }

  const formData = await req.formData().catch(() => null);
  const file = formData?.get("file");
  if (!formData || !(file instanceof File)) {
    return apiError("VALIDATION_FAILED", "音声ファイル(file)を指定してください");
  }
  debugServer.input("POST /captures/audio", "requestBody", { fileName: file.name, size: file.size, type: file.type });

  const ext = file.name.split(".").pop()?.toLowerCase() ?? "";
  if (!ALLOWED_EXTENSIONS.includes(ext)) {
    return apiError("VALIDATION_FAILED", `対応していない形式です(対応: ${ALLOWED_EXTENSIONS.join("/")})`, {
      fieldErrors: { file: "対応形式のファイルを選択してください" },
    });
  }
  if (file.size > MAX_FILE_SIZE_BYTES) {
    return apiError("VALIDATION_FAILED", "ファイルサイズが25MBを超えています", {
      fieldErrors: { file: "25MB以下のファイルを選択してください" },
    });
  }

  const clientDraftId = (formData.get("clientDraftId") as string | null) ?? crypto.randomUUID();
  const { workspaceId, domainId } = await ensureDefaultWorkspace(auth.user.userId, auth.user.email);

  // 冪等性(clientDraftId+userで重複投稿防止)。POST /capturesの既存方針と揃える。
  const existing = await db.capture.findFirst({
    where: { workspaceId, createdById: auth.user.userId, clientDraftId },
    select: { id: true },
  });
  if (existing) {
    return apiOk({ id: existing.id, processingStatus: "QUEUED" }, { status: 200 });
  }

  const buffer = Buffer.from(await file.arrayBuffer());
  // MinIOアップロードはトランザクションの外(副作用のあるI/O)で先に済ませ、
  // 成功後にDBへ確定させる方針にする(トランザクション内で長時間I/Oを抱えない)。
  const tempCapture = await db.capture.create({
    data: {
      workspaceId,
      domainId,
      createdById: auth.user.userId,
      sourceType: "VOICE",
      processingStatus: "SAVED",
      clientDraftId,
    },
  });

  const objectKey = buildAudioObjectKey(workspaceId, tempCapture.id, file.name);
  try {
    await uploadAudioObject({ objectKey, buffer, contentType: file.type || "application/octet-stream" });
  } catch (err) {
    debugServer.error("POST /captures/audio", "MinIOアップロード失敗", err);
    await db.capture.update({ where: { id: tempCapture.id }, data: { processingStatus: "FAILED" } });
    return apiError("VALIDATION_FAILED", "音声ファイルの保存に失敗しました。しばらくしてから再度お試しください");
  }

  const created = await db.$transaction(async (tx) => {
    const updated = await tx.capture.update({
      where: { id: tempCapture.id },
      data: { audioObjectKey: objectKey, processingStatus: "QUEUED", version: { increment: 1 } },
    });

    await tx.eventLog.create({
      data: {
        aggregateType: "Capture",
        aggregateId: tempCapture.id,
        eventType: "CAPTURE_SAVED",
        afterJson: { sourceType: "VOICE", processingStatus: "QUEUED", objectKey },
        actorType: "USER",
        actorId: auth.user.userId,
      },
    });

    await tx.outboxEvent.create({
      data: {
        eventName: "AudioTranscriptionRequested.v1",
        eventVersion: "1",
        aggregateId: tempCapture.id,
        aggregateVersion: updated.version,
        payload: { captureId: tempCapture.id, workspaceId },
      },
    });
    debugServer.event("POST /captures/audio", "AudioTranscriptionRequested.v1", { aggregateId: tempCapture.id });

    return updated;
  });

  return apiOk({ id: created.id, processingStatus: created.processingStatus }, { status: 201 });
}
