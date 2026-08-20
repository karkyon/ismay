import type { NextRequest } from "next/server";
import { z } from "zod";
import { db } from "@/lib/db";
import { debugServer, redactSensitive } from "@/lib/debugServer";
import { requireAuth, requireCsrf } from "@/lib/auth/guard";
import { ensureDefaultWorkspace } from "@/lib/workspace";
import { apiOk, apiError } from "@/lib/auth/response";

// API・イベント設計書v1.1 4.1節: 「本文最大100,000文字」
const MAX_RAW_TEXT_LENGTH = 100_000;
const SOURCE_TYPES = ["TEXT", "VOICE", "MEETING", "IMPORT"] as const;

const CreateCaptureSchema = z.object({
  sourceType: z.enum(SOURCE_TYPES),
  rawText: z.string().min(1).max(MAX_RAW_TEXT_LENGTH).optional(),
  domainId: z.string().uuid().optional(),
  capturedAt: z.string().datetime().optional(),
  // API・イベント設計書v1.1 4.1節: 「clientDraftId＋userで冪等」の必須パラメータ
  clientDraftId: z.string().min(1).max(128),
});

const LIST_DEFAULT_LIMIT = 50;
const LIST_MAX_LIMIT = 100;

/** API-CAP-01: POST /captures 原文即時保存 */
export async function POST(req: NextRequest) {
  const auth = await requireAuth(req);
  if (!auth.authenticated) {
    return apiError("AUTH_REQUIRED", "ログインが必要です");
  }
  if (!requireCsrf(req)) {
    return apiError("ACCESS_DENIED", "CSRFトークンが不正です");
  }

  const json = await req.json().catch(() => null);
  debugServer.input("POST /captures", "requestBody", redactSensitive(json));
  const parsed = CreateCaptureSchema.safeParse(json);
  if (!parsed.success) {
    return apiError("VALIDATION_FAILED", "入力内容を確認してください", {
      fieldErrors: Object.fromEntries(
        Object.entries(parsed.error.flatten().fieldErrors).map(([k, v]) => [k, v?.[0] ?? "不正な値です"]),
      ),
    });
  }
  const { sourceType, rawText, domainId, capturedAt, clientDraftId } = parsed.data;

  // API・イベント設計書v1.1 4.1節: 「rawTextまたはaudio予約の一方が必要」
  // (audio予約=API-CAP-02は本パッチのスコープ外のため、VOICE以外はrawText必須とする)
  if (sourceType !== "VOICE" && !rawText) {
    return apiError("VALIDATION_FAILED", "rawTextを指定してください", {
      fieldErrors: { rawText: "TEXT/MEETING/IMPORTの場合は必須です" },
    });
  }

  const { workspaceId, domainId: defaultDomainId } = await ensureDefaultWorkspace(
    auth.user.userId,
    auth.user.email,
  );

  let resolvedDomainId = defaultDomainId;
  if (domainId) {
    const domain = await db.domain.findFirst({
      where: { id: domainId, workspaceId, deletedAt: null },
      select: { id: true },
    });
    if (!domain) {
      return apiError("VALIDATION_FAILED", "指定されたdomainIdが存在しません", {
        fieldErrors: { domainId: "許可されていないDomainです" },
      });
    }
    resolvedDomainId = domain.id;
  }

  // 冪等応答: 同一clientDraftIdの再送は新規作成せず既存Captureをそのまま返す
  const existing = await db.capture.findFirst({
    where: { workspaceId, createdById: auth.user.userId, clientDraftId },
    select: { id: true, processingStatus: true, createdAt: true, version: true },
  });
  if (existing) {
    return apiOk(
      {
        id: existing.id,
        processingStatus: existing.processingStatus,
        createdAt: existing.createdAt,
        version: existing.version,
      },
      { status: 200 },
    );
  }

  // FN-PRV-02: source_type=MEETINGは同意登録(consent_id確定)まで解析キューへ投入しない。
  // 同意登録はPOST /captures/{id}/consent(別API)で行うため、ここではconsentIdを設定せず
  // processingStatus=SAVEDのまま保存する(解析要求時にゲートする)。
  //
  // [2026-08-20修正] 機能別詳細設計書v1.1 3章FN-CAP-01手順6「Outbox Workerが解析Jobを作る」
  // が実装されておらず、保存のみでAI解析が一切自動起動しない不備を発見・修正した
  // (従来はPOST /captures/{id}/analyzeの手動呼び出しが必須で、UIにボタンはあるが
  // 誰も押さない限りAI抽出が永遠に走らなかった)。TEXT/IMPORT/同意済みMEETINGは
  // 保存と同時に自動でCaptureAnalysisRequested.v1を発行する。VOICE(文字起こし未実装)と
  // 未同意MEETINGのみ、従来通りSAVEDのまま留め、手動/別APIでの解析要求を待つ。
  const shouldAutoQueue = sourceType !== "VOICE" && sourceType !== "MEETING";

  const created = await db.$transaction(async (tx) => {
    const capture = await tx.capture.create({
      data: {
        workspaceId,
        domainId: resolvedDomainId,
        createdById: auth.user.userId,
        sourceType,
        rawText: rawText ?? null,
        processingStatus: shouldAutoQueue ? "QUEUED" : "SAVED",
        sourceCapturedAt: capturedAt ? new Date(capturedAt) : null,
        clientDraftId,
      },
    });
    debugServer.state("POST /captures", "Capture.processingStatus", {
      id: capture.id,
      processingStatus: capture.processingStatus,
    });

    await tx.eventLog.create({
      data: {
        aggregateType: "Capture",
        aggregateId: capture.id,
        eventType: "CAPTURE_SAVED",
        afterJson: { sourceType: capture.sourceType, processingStatus: capture.processingStatus },
        actorType: "USER",
        actorId: auth.user.userId,
        correlationId: req.headers.get("x-correlation-id") ?? undefined,
      },
    });
    debugServer.event("POST /captures", "CAPTURE_SAVED", { aggregateId: capture.id });

    await tx.outboxEvent.create({
      data: {
        eventName: "CaptureSaved.v1",
        eventVersion: "1",
        aggregateId: capture.id,
        aggregateVersion: capture.version,
        correlationId: req.headers.get("x-correlation-id") ?? undefined,
        payload: {
          captureId: capture.id,
          workspaceId,
          domainId: resolvedDomainId,
          sourceType: capture.sourceType,
        },
      },
    });
    debugServer.event("POST /captures", "CaptureSaved.v1", { aggregateId: capture.id });

    if (shouldAutoQueue) {
      await tx.eventLog.create({
        data: {
          aggregateType: "Capture",
          aggregateId: capture.id,
          eventType: "CAPTURE_ANALYSIS_REQUESTED",
          beforeJson: { processingStatus: "SAVED" },
          afterJson: { processingStatus: "QUEUED" },
          actorType: "SYSTEM",
          correlationId: req.headers.get("x-correlation-id") ?? undefined,
        },
      });
      await tx.outboxEvent.create({
        data: {
          eventName: "CaptureAnalysisRequested.v1",
          eventVersion: "1",
          aggregateId: capture.id,
          aggregateVersion: capture.version,
          correlationId: req.headers.get("x-correlation-id") ?? undefined,
          payload: { captureId: capture.id, workspaceId, sourceType: capture.sourceType },
        },
      });
      debugServer.event("POST /captures", "CaptureAnalysisRequested.v1(自動)", { aggregateId: capture.id });
    }

    return capture;
  });

  return apiOk(
    {
      id: created.id,
      processingStatus: created.processingStatus,
      createdAt: created.createdAt,
      version: created.version,
    },
    { status: 201 },
  );
}

/** UI-03(Inbox)向け一覧取得。API設計書v1.1 5章の共通cursor方式(既定50、最大100)に準拠。 */
export async function GET(req: NextRequest) {
  const auth = await requireAuth(req);
  if (!auth.authenticated) {
    return apiError("AUTH_REQUIRED", "ログインが必要です");
  }

  const url = new URL(req.url);
  const limitParam = Number(url.searchParams.get("limit"));
  const limit = Math.min(Math.max(Number.isFinite(limitParam) && limitParam > 0 ? limitParam : LIST_DEFAULT_LIMIT, 1), LIST_MAX_LIMIT);
  const cursor = url.searchParams.get("cursor") ?? undefined;
  const domainId = url.searchParams.get("domainId") ?? undefined;
  const processingStatus = url.searchParams.get("processingStatus") ?? undefined;

  const { workspaceId } = await ensureDefaultWorkspace(auth.user.userId, auth.user.email);

  const rows = await db.capture.findMany({
    where: {
      workspaceId,
      deletedAt: null,
      ...(domainId ? { domainId } : {}),
      ...(processingStatus ? { processingStatus } : {}),
    },
    orderBy: { createdAt: "desc" },
    take: limit + 1,
    ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
    select: {
      id: true,
      sourceType: true,
      rawText: true,
      processingStatus: true,
      domainId: true,
      sourceCapturedAt: true,
      version: true,
      createdAt: true,
    },
  });

  const hasNext = rows.length > limit;
  const page = hasNext ? rows.slice(0, limit) : rows;
  const nextCursor = hasNext ? page[page.length - 1]?.id : undefined;

  return apiOk({ captures: page }, { extraMeta: nextCursor ? { nextCursor } : {} });
}
