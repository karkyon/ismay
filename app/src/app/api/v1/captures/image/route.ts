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
 * [2026-08-21修正] 複数ページ結合対応。カルキョンさんの指示「画像OCRの複数ページ結合」に
 * 対応するため、単一ファイル("file")ではなく複数ファイル("files")を受け付ける形へ変更した。
 * ノート数枚を1回の会議メモとして撮影した場合、1つのCaptureへまとめて紐づけ、
 * OCR時に1回のVision API呼び出しでページ順を保った1本の書き起こしにする
 * (ocrImageJob.ts参照。ページごとに個別OCRしてから連結する方式より高精度と判断)。
 *
 * 対応形式: jpg / jpeg / png / gif / webp(Claude API Visionの対応形式に準拠)。
 * ファイルサイズ上限は1枚あたり7MB(Claude API直接利用時の上限「10MB(base64エンコード後)」に
 * 対し、base64エンコードで約1.33倍に膨らむことを踏まえた安全マージン。2026-08-21 web検索で
 * 公式Vision仕様を確認のうえ設定)。1回のアップロードで最大20枚まで
 * (Anthropic Messages APIの1リクエストあたり画像上限を踏まえた安全な上限)。
 */

const MAX_FILE_SIZE_BYTES = 7 * 1024 * 1024; // 7MB(base64後 約9.3MB、Claude API上限10MB以内)
const MAX_PAGES = 20;
const ALLOWED_EXTENSIONS = ["jpg", "jpeg", "png", "gif", "webp"];
const ALLOWED_PRIORITIES = ["REALTIME", "BATCH"];
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
  if (!formData) {
    return apiError("VALIDATION_FAILED", "リクエストの形式が不正です");
  }
  // [2026-08-21修正] "files"(複数)を主とし、旧クライアント互換のため単数"file"も拾う。
  const files = [...formData.getAll("files"), ...formData.getAll("file")].filter(
    (f): f is File => f instanceof File,
  );
  if (files.length === 0) {
    return apiError("VALIDATION_FAILED", "画像ファイル(files)を指定してください");
  }
  if (files.length > MAX_PAGES) {
    return apiError("VALIDATION_FAILED", `一度にアップロードできるのは${MAX_PAGES}枚までです`, {
      fieldErrors: { files: `${MAX_PAGES}枚以下にしてください` },
    });
  }
  debugServer.input("POST /captures/image", "requestBody", {
    fileCount: files.length,
    files: files.map((f) => ({ fileName: f.name, size: f.size, type: f.type })),
  });

  for (const file of files) {
    const ext = file.name.split(".").pop()?.toLowerCase() ?? "";
    if (!ALLOWED_EXTENSIONS.includes(ext)) {
      return apiError("VALIDATION_FAILED", `対応していない形式です(対応: ${ALLOWED_EXTENSIONS.join("/")}): ${file.name}`, {
        fieldErrors: { files: "対応形式のファイルを選択してください" },
      });
    }
    if (file.size > MAX_FILE_SIZE_BYTES) {
      return apiError("VALIDATION_FAILED", `ファイルサイズが7MBを超えています: ${file.name}`, {
        fieldErrors: { files: "7MB以下のファイルを選択してください" },
      });
    }
  }

  const clientDraftId = (formData.get("clientDraftId") as string | null) ?? crypto.randomUUID();
  // [2026-08-21追加] カルキョンさんの指示「緊急性が高いのかバッチでいいのか選択させる」に対応。
  // 画像はOCR・AI抽出の両方がAnthropicのため、BATCH選択時は両ステップとも50%引きが効く。
  const rawPriority = formData.get("processingPriority") as string | null;
  const processingPriority = ALLOWED_PRIORITIES.includes(rawPriority ?? "") ? (rawPriority as string) : "REALTIME";
  const { workspaceId, domainId } = await ensureDefaultWorkspace(auth.user.userId, auth.user.email);

  // 冪等性(clientDraftId+userで重複投稿防止)。POST /captures/audioと同じ方針。
  const existing = await db.capture.findFirst({
    where: { workspaceId, createdById: auth.user.userId, clientDraftId },
    select: { id: true },
  });
  if (existing) {
    return apiOk({ id: existing.id, processingStatus: "QUEUED" }, { status: 200 });
  }

  const tempCapture = await db.capture.create({
    data: {
      workspaceId,
      domainId,
      createdById: auth.user.userId,
      sourceType: "IMAGE",
      processingStatus: "SAVED",
      processingPriority,
      clientDraftId,
    },
  });

  // MinIOアップロードはトランザクションの外(副作用のあるI/O)で先に済ませ、
  // 全ページ成功後にDBへ確定させる方針にする(既存の音声/単一画像実装と同じ方針)。
  const uploadedKeys: string[] = [];
  try {
    for (let pageIndex = 0; pageIndex < files.length; pageIndex++) {
      const file = files[pageIndex];
      const ext = file.name.split(".").pop()?.toLowerCase() ?? "";
      const objectKey = buildImageObjectKey(workspaceId, tempCapture.id, pageIndex, file.name);
      const buffer = Buffer.from(await file.arrayBuffer());
      const contentType = EXTENSION_TO_CONTENT_TYPE[ext] ?? file.type ?? "application/octet-stream";
      await uploadImageObject({ objectKey, buffer, contentType });
      uploadedKeys.push(objectKey);
    }
  } catch (err) {
    debugServer.error("POST /captures/image", "MinIOアップロード失敗", err);
    await db.capture.update({ where: { id: tempCapture.id }, data: { processingStatus: "FAILED" } });
    return apiError("VALIDATION_FAILED", "画像ファイルの保存に失敗しました。しばらくしてから再度お試しください");
  }

  const created = await db.$transaction(async (tx) => {
    for (let pageIndex = 0; pageIndex < uploadedKeys.length; pageIndex++) {
      await tx.captureImage.create({
        data: { captureId: tempCapture.id, objectKey: uploadedKeys[pageIndex], pageIndex },
      });
    }

    const updated = await tx.capture.update({
      where: { id: tempCapture.id },
      // 旧単一列imageObjectKeyには先頭ページのキーだけ入れておく(過去コード・レポート等が
      // 参照していても壊れないようにするための互換目的。読み出し側はCaptureImageを優先する)。
      data: { imageObjectKey: uploadedKeys[0], processingStatus: "QUEUED", version: { increment: 1 } },
    });

    await tx.eventLog.create({
      data: {
        aggregateType: "Capture",
        aggregateId: tempCapture.id,
        eventType: "CAPTURE_SAVED",
        afterJson: { sourceType: "IMAGE", processingStatus: "QUEUED", pageCount: uploadedKeys.length },
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
    debugServer.event("POST /captures/image", "ImageOcrRequested.v1", {
      aggregateId: tempCapture.id,
      pageCount: uploadedKeys.length,
    });

    return updated;
  });

  return apiOk({ id: created.id, processingStatus: created.processingStatus, pageCount: uploadedKeys.length }, { status: 201 });
}
