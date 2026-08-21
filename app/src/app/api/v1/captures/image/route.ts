import type { NextRequest } from "next/server";
import { db } from "@/lib/db";
import { debugServer } from "@/lib/debugServer";
import { requireAuth, requireCsrf } from "@/lib/auth/guard";
import { ensureDefaultWorkspace } from "@/lib/workspace";
import { apiOk, apiError } from "@/lib/auth/response";
import { uploadImageObject, buildImageObjectKey } from "@/lib/storage";

/**
 * POST /api/v1/captures/image(2026-08-21新設。FR-CAP-02将来項目「画像」の前倒し実装)。
 * 「Inboxに写真や図などイメージデータからのOCR文字起こし機能」の要望に対応。
 *
 * POST /captures/audio(2026-08-21新設)と対称的な設計。処理の骨格
 * (EventLog/OutboxEvent発行、冪等性、MinIOアップロードをトランザクション外で先行実施)は揃えている。
 *
 * 対応形式: jpg / jpeg / png / gif / webp(Claude API Visionの対応形式に準拠)。
 * ファイルサイズ上限7MB(Claude API直接利用時の上限「10MB(base64エンコード後)」に対し、
 * base64エンコードで約1.33倍に膨らむことを踏まえた安全マージン。2026-08-21 web検索で
 * 公式Vision仕様を確認のうえ設定。想像で決めていない)。
 */

const MAX_FILE_SIZE_BYTES = 7 * 1024 * 1024; // 7MB(base64後 約9.3MB、Claude API上限10MB以内)
const ALLOWED_EXTENSIONS = ["jpg", "jpeg", "png", "gif", "webp"];
const EXTENSION_TO_CONTENT_TYPE: Record<string, string> = {
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  png: "image/png",
  gif: "image/gif",
  webp: "image/webp",
};

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
    return apiError("VALIDATION_FAILED", "画像ファイル(file)を指定してください");
  }
  debugServer.input("POST /captures/image", "requestBody", { fileName: file.name, size: file.size, type: file.type });

  const ext = file.name.split(".").pop()?.toLowerCase() ?? "";
  if (!ALLOWED_EXTENSIONS.includes(ext)) {
    return apiError("VALIDATION_FAILED", `対応していない形式です(対応: ${ALLOWED_EXTENSIONS.join("/")})`, {
      fieldErrors: { file: "対応形式のファイルを選択してください" },
    });
  }
  if (file.size > MAX_FILE_SIZE_BYTES) {
    return apiError("VALIDATION_FAILED", "ファイルサイズが7MBを超えています", {
      fieldErrors: { file: "7MB以下のファイルを選択してください" },
    });
  }

  const clientDraftId = (formData.get("clientDraftId") as string | null) ?? crypto.randomUUID();
  const { workspaceId, domainId } = await ensureDefaultWorkspace(auth.user.userId, auth.user.email);

  // 冪等性(clientDraftId+userで重複投稿防止)。POST /captures/audioと同じ方針。
  const existing = await db.capture.findFirst({
    where: { workspaceId, createdById: auth.user.userId, clientDraftId },
    select: { id: true },
  });
  if (existing) {
    return apiOk({ id: existing.id, processingStatus: "QUEUED" }, { status: 200 });
  }

  const buffer = Buffer.from(await file.arrayBuffer());
  const tempCapture = await db.capture.create({
    data: {
      workspaceId,
      domainId,
      createdById: auth.user.userId,
      sourceType: "IMAGE",
      processingStatus: "SAVED",
      clientDraftId,
    },
  });

  const objectKey = buildImageObjectKey(workspaceId, tempCapture.id, file.name);
  const contentType = EXTENSION_TO_CONTENT_TYPE[ext] ?? file.type ?? "application/octet-stream";
  try {
    await uploadImageObject({ objectKey, buffer, contentType });
  } catch (err) {
    debugServer.error("POST /captures/image", "MinIOアップロード失敗", err);
    await db.capture.update({ where: { id: tempCapture.id }, data: { processingStatus: "FAILED" } });
    return apiError("VALIDATION_FAILED", "画像ファイルの保存に失敗しました。しばらくしてから再度お試しください");
  }

  const created = await db.$transaction(async (tx) => {
    const updated = await tx.capture.update({
      where: { id: tempCapture.id },
      data: { imageObjectKey: objectKey, processingStatus: "QUEUED", version: { increment: 1 } },
    });

    await tx.eventLog.create({
      data: {
        aggregateType: "Capture",
        aggregateId: tempCapture.id,
        eventType: "CAPTURE_SAVED",
        afterJson: { sourceType: "IMAGE", processingStatus: "QUEUED", objectKey },
        actorType: "USER",
        actorId: auth.user.userId,
      },
    });

    await tx.outboxEvent.create({
      data: {
        eventName: "ImageOcrRequested.v1",
        eventVersion: "1",
        aggregateId: tempCapture.id,
        aggregateVersion: updated.version,
        payload: { captureId: tempCapture.id, workspaceId },
      },
    });
    debugServer.event("POST /captures/image", "ImageOcrRequested.v1", { aggregateId: tempCapture.id });

    return updated;
  });

  return apiOk({ id: created.id, processingStatus: created.processingStatus }, { status: 201 });
}
