#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
apply_ismay_captures_v1.py

目的：
  ISMAY MVPの本丸機能である Capture業務API 一式を追加する。
  - API-CAP-01 POST /api/v1/captures            原文即時保存
  - (拡張)      GET  /api/v1/captures            一覧(cursor方式)
  - (拡張)      GET  /api/v1/captures/{id}       詳細
  - API-CAP-03 POST /api/v1/captures/{id}/analyze     解析要求(キューイングのみ。AI Worker本体は別途実装)
  - API-CAP-04 GET  /api/v1/captures/{id}/inferences  AI候補一覧取得
  - API-CAP-05 POST /api/v1/captures/{id}/consent     会議録音の同意登録(FN-PRV-02)

前提・スコープ（正直に明記）：
  - API-CAP-02 (音声アップロード予約) と API-PRV-03 (原音削除) は、
    MinIO/Object Storageクライアントの追加実装が必要なため本パッチのスコープ外。
    次回セッションで別途実装する。
  - AI Worker（実際の推論実行）は未実装。/analyze はprocessingStatusを
    QUEUEDへ遷移させ、CaptureAnalysisRequested.v1をOutboxへ積むところまでを担う。

実行方式：
  現行schema.prismaにはCapture.clientDraftId列が存在しないため
  （API仕様書4.1節が要求する「clientDraftId＋userで冪等」を満たす列）、
  今回はschema.prismaへの列追加を含む。DBへの実マイグレーションを伴うため、
  本スクリプトは以下を全て自動実行し、**コンパイルエラー0件の場合のみ**
  GitHubへpushする。

  1) schema.prisma / response.ts のバックアップ
  2) schema.prisma へ Capture.clientDraftId 列 + 一意制約を追加
  3) response.ts の apiError に extra フィールド対応を追加(後方互換の追記のみ)
  4) 新規ファイル一式を作成
     - app/src/lib/workspace.ts
     - app/src/app/api/v1/captures/route.ts
     - app/src/app/api/v1/captures/[id]/route.ts
     - app/src/app/api/v1/captures/[id]/analyze/route.ts
     - app/src/app/api/v1/captures/[id]/inferences/route.ts
     - app/src/app/api/v1/captures/[id]/consent/route.ts
  5) prisma validate → prisma generate → prisma migrate dev → tsc --noEmit
  6) 全て成功した場合のみ git add / commit / push
  7) 失敗時はどのステップで止まったかを表示し、pushしない（ロールバック手順を表示）
  8) 成功時はバックアップとスクリプト自身を自動削除（ゴミ掃除込み）

実行方法（サーバー側 ~/projects/ismay で）：
  python3 apply_ismay_captures_v1.py
"""

import subprocess
import sys
import shutil
from pathlib import Path
from datetime import datetime

BASE_DIR = Path.cwd()
APP_DIR = BASE_DIR / "app"
SCHEMA_PATH = APP_DIR / "prisma" / "schema.prisma"
RESPONSE_PATH = APP_DIR / "src" / "lib" / "auth" / "response.ts"
WORKSPACE_LIB_PATH = APP_DIR / "src" / "lib" / "workspace.ts"
CAPTURES_DIR = APP_DIR / "src" / "app" / "api" / "v1" / "captures"

TIMESTAMP = datetime.now().strftime("%Y%m%d_%H%M%S")

created_files = []
backup_files = []


def fail(step: str, detail: str = "") -> None:
    print(f"\n[FAIL] {step}")
    if detail:
        print(detail)
    print("\n--- ロールバック手順 ---")
    for orig, backup in backup_files:
        print(f"  cp {backup} {orig}")
    for f in created_files:
        print(f"  rm {f}")
    print("pushは実行していません。GitHub上のコードは変更されていません。")
    sys.exit(1)


def run(cmd: list[str], cwd: Path, step: str) -> str:
    print(f"\n[RUN] ({cwd}) $ {' '.join(cmd)}")
    result = subprocess.run(cmd, cwd=str(cwd), capture_output=True, text=True)
    print(result.stdout[-4000:])
    if result.returncode != 0:
        print(result.stderr[-4000:])
        fail(step, result.stderr[-4000:] or result.stdout[-4000:])
    return result.stdout


def backup(path: Path) -> Path:
    backup_path = path.with_name(f"{path.name}.bak_{TIMESTAMP}")
    shutil.copy2(path, backup_path)
    backup_files.append((path, backup_path))
    print(f"[BACKUP] {path} -> {backup_path}")
    return backup_path


def check_preconditions() -> None:
    print("=== 事前チェック ===")
    if not SCHEMA_PATH.exists():
        fail("事前チェック", f"schema.prismaが見つかりません: {SCHEMA_PATH}\n"
                              f"このスクリプトはリポジトリルート(~/projects/ismay)で実行してください。")
    if not RESPONSE_PATH.exists():
        fail("事前チェック", f"response.tsが見つかりません: {RESPONSE_PATH}")

    schema_text = SCHEMA_PATH.read_text(encoding="utf-8")
    if "clientDraftId" in schema_text:
        fail("事前チェック", "schema.prismaに既にclientDraftIdが存在します。"
                              "本パッチは既に適用済みの可能性があります。二重適用を避けるため中断します。")
    if CAPTURE_MODEL_MARKER not in schema_text:
        fail("事前チェック", "Captureモデルの想定テキストが見つかりません。"
                              "GitHub上のschema.prismaが前回セッションから変更されている可能性があるため、"
                              "推測での適用を避けて中断します。手動確認をお願いします。")

    response_text = RESPONSE_PATH.read_text(encoding="utf-8")
    if "extra?: Record<string, unknown>" in response_text:
        fail("事前チェック", "response.tsに既にextra対応が存在します。二重適用を避けるため中断します。")
    if APIERROR_MARKER not in response_text:
        fail("事前チェック", "response.tsのapiError想定テキストが見つかりません。"
                              "GitHub上のコードが前回セッションから変更されている可能性があるため中断します。")

    if CAPTURES_DIR.exists():
        fail("事前チェック", f"{CAPTURES_DIR} が既に存在します。二重適用を避けるため中断します。")

    print("[OK] 事前チェック完了。想定通りの現行コードであることを確認しました。")


# ---------------------------------------------------------------------------
# 1. schema.prisma パッチ（Capture.clientDraftId 列 + 一意制約）
# ---------------------------------------------------------------------------

CAPTURE_MODEL_MARKER = '''model Capture {
  id                 String    @id @default(uuid())
  workspaceId        String    @map("workspace_id")
  workspace          Workspace @relation(fields: [workspaceId], references: [id])
  domainId           String?   @map("domain_id")
  domain             Domain?   @relation(fields: [domainId], references: [id])
  createdById        String    @map("created_by")
  createdBy          User      @relation("CaptureCreatedBy", fields: [createdById], references: [id])
  /// TEXT/VOICE/MEETING/IMPORT
  sourceType         String    @map("source_type")
  rawText            String?   @map("raw_text")
  audioObjectKey     String?   @map("audio_object_key")
  language           String    @default("ja-JP")
  /// SAVED/QUEUED/PROCESSING/READY/FAILED
  processingStatus   String    @default("SAVED") @map("processing_status")
  sourceCapturedAt   DateTime? @map("source_captured_at")
  consentId          String?   @map("consent_id")
  consent            Consent?  @relation(fields: [consentId], references: [id])
  version            Int       @default(0)
  createdAt          DateTime  @default(now()) @map("created_at")
  updatedAt          DateTime  @updatedAt @map("updated_at")
  deletedAt          DateTime? @map("deleted_at")

  responsibilities Responsibility[]
  aiInferences     AiInference[]
  aiRuns           AiRun[]

  @@index([workspaceId, createdAt(sort: Desc)])
  @@index([processingStatus, updatedAt])
  @@map("captures")
}'''

CAPTURE_MODEL_REPLACEMENT = '''model Capture {
  id                 String    @id @default(uuid())
  workspaceId        String    @map("workspace_id")
  workspace          Workspace @relation(fields: [workspaceId], references: [id])
  domainId           String?   @map("domain_id")
  domain             Domain?   @relation(fields: [domainId], references: [id])
  createdById        String    @map("created_by")
  createdBy          User      @relation("CaptureCreatedBy", fields: [createdById], references: [id])
  /// TEXT/VOICE/MEETING/IMPORT
  sourceType         String    @map("source_type")
  rawText            String?   @map("raw_text")
  audioObjectKey     String?   @map("audio_object_key")
  language           String    @default("ja-JP")
  /// SAVED/QUEUED/PROCESSING/READY/FAILED
  processingStatus   String    @default("SAVED") @map("processing_status")
  sourceCapturedAt   DateTime? @map("source_captured_at")
  consentId          String?   @map("consent_id")
  consent            Consent?  @relation(fields: [consentId], references: [id])
  /// API-CAP-01冪等キー(API・イベント設計書v1.1 4.1節: 「clientDraftId+userで冪等」)。[新設]
  clientDraftId      String?   @map("client_draft_id")
  version            Int       @default(0)
  createdAt          DateTime  @default(now()) @map("created_at")
  updatedAt          DateTime  @updatedAt @map("updated_at")
  deletedAt          DateTime? @map("deleted_at")

  responsibilities Responsibility[]
  aiInferences     AiInference[]
  aiRuns           AiRun[]

  @@index([workspaceId, createdAt(sort: Desc)])
  @@index([processingStatus, updatedAt])
  @@unique([workspaceId, createdById, clientDraftId], name: "captures_idempotency_key")
  @@map("captures")
}'''


# ---------------------------------------------------------------------------
# 2. response.ts パッチ（apiError に extra 対応を追記。既存呼び出しへの後方互換あり）
# ---------------------------------------------------------------------------

APIERROR_MARKER = '''export function apiError(
  code: ErrorCode,
  message: string,
  opts?: { fieldErrors?: Record<string, string>; retryable?: boolean },
) {
  return NextResponse.json(
    {
      error: {
        code,
        message,
        fieldErrors: opts?.fieldErrors,
        retryable: opts?.retryable ?? false,
        requestId: randomUUID(),
      },
    },
    { status: STATUS_BY_CODE[code] },
  );
}'''

APIERROR_REPLACEMENT = '''export function apiError(
  code: ErrorCode,
  message: string,
  opts?: {
    fieldErrors?: Record<string, string>;
    retryable?: boolean;
    /** 409競合応答等でlatestVersion等の追加情報を返す場合に使う(機能別詳細設計書v1.1 18章) */
    extra?: Record<string, unknown>;
  },
) {
  return NextResponse.json(
    {
      error: {
        code,
        message,
        fieldErrors: opts?.fieldErrors,
        retryable: opts?.retryable ?? false,
        requestId: randomUUID(),
        ...(opts?.extra ?? {}),
      },
    },
    { status: STATUS_BY_CODE[code] },
  );
}'''


# ---------------------------------------------------------------------------
# 3. 新規ファイル群
# ---------------------------------------------------------------------------

WORKSPACE_LIB_CONTENT = '''import { db } from "@/lib/db";

export interface DefaultWorkspaceContext {
  workspaceId: string;
  domainId: string;
}

/**
 * ユーザーの所属Workspaceを取得する。存在しない場合は個人用Workspace＋
 * 既定Domain(kind=PERSONAL)を新設して返す。
 *
 * MVP(M0〜M4)では「1ユーザー＝1個人用Workspace」を前提とする(将来の共有Workspace対応はスコープ外)。
 * DB設計書v1.1 1章「Domainは表示分類ではなくプライバシー・連携・AI参照境界として使う」に基づき、
 * 初回アクセス時に既定Domain(kind=PERSONAL)も同時に作成する。
 *
 * [既知の制約] 同一ユーザーからの初回同時リクエストが競合した場合、
 * ごく稀にWorkspaceが重複作成される可能性がある(MVPでは許容。
 * 恒久対策はWorkspaceMemberへのユーザー単位一意制約導入を別途検討)。
 */
export async function ensureDefaultWorkspace(
  userId: string,
  displayNameHint?: string | null,
): Promise<DefaultWorkspaceContext> {
  const membership = await db.workspaceMember.findFirst({
    where: { userId, leftAt: null },
    orderBy: { joinedAt: "asc" },
    select: { workspaceId: true },
  });

  if (membership) {
    const domain = await db.domain.findFirst({
      where: { workspaceId: membership.workspaceId, deletedAt: null },
      orderBy: { createdAt: "asc" },
      select: { id: true },
    });
    if (domain) {
      return { workspaceId: membership.workspaceId, domainId: domain.id };
    }
    // Workspaceは存在するが既定Domainが無い異常系: ここで補完する
    const createdDomain = await db.domain.create({
      data: { workspaceId: membership.workspaceId, name: "個人", kind: "PERSONAL" },
      select: { id: true },
    });
    return { workspaceId: membership.workspaceId, domainId: createdDomain.id };
  }

  const workspaceName = displayNameHint ? `${displayNameHint}のワークスペース` : "個人ワークスペース";

  return db.$transaction(async (tx) => {
    const workspace = await tx.workspace.create({ data: { name: workspaceName } });
    await tx.workspaceMember.create({
      data: { workspaceId: workspace.id, userId, role: "OWNER" },
    });
    const domain = await tx.domain.create({
      data: { workspaceId: workspace.id, name: "個人", kind: "PERSONAL" },
    });
    return { workspaceId: workspace.id, domainId: domain.id };
  });
}
'''

CAPTURES_ROUTE_CONTENT = '''import type { NextRequest } from "next/server";
import { z } from "zod";
import { db } from "@/lib/db";
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
  const created = await db.$transaction(async (tx) => {
    const capture = await tx.capture.create({
      data: {
        workspaceId,
        domainId: resolvedDomainId,
        createdById: auth.user.userId,
        sourceType,
        rawText: rawText ?? null,
        processingStatus: "SAVED",
        sourceCapturedAt: capturedAt ? new Date(capturedAt) : null,
        clientDraftId,
      },
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
'''

CAPTURE_DETAIL_ROUTE_CONTENT = '''import type { NextRequest } from "next/server";
import { db } from "@/lib/db";
import { requireAuth } from "@/lib/auth/guard";
import { ensureDefaultWorkspace } from "@/lib/workspace";
import { apiOk, apiError } from "@/lib/auth/response";

/** UI-04向け詳細取得。 */
export async function GET(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const auth = await requireAuth(req);
  if (!auth.authenticated) {
    return apiError("AUTH_REQUIRED", "ログインが必要です");
  }

  const { id } = await ctx.params;
  const { workspaceId } = await ensureDefaultWorkspace(auth.user.userId, auth.user.email);

  const capture = await db.capture.findFirst({
    where: { id, workspaceId, deletedAt: null },
    select: {
      id: true,
      sourceType: true,
      rawText: true,
      audioObjectKey: true,
      processingStatus: true,
      domainId: true,
      consentId: true,
      sourceCapturedAt: true,
      version: true,
      createdAt: true,
      updatedAt: true,
    },
  });

  if (!capture) {
    // 他Workspaceのcapture IDを推測されても存在有無を漏らさない(IDOR対策。sessions/[id]と同じ方針)
    return apiError("RESOURCE_NOT_FOUND", "指定されたCaptureが見つかりません");
  }

  return apiOk({ capture });
}
'''

CAPTURE_ANALYZE_ROUTE_CONTENT = '''import type { NextRequest } from "next/server";
import { db } from "@/lib/db";
import { requireAuth, requireCsrf } from "@/lib/auth/guard";
import { ensureDefaultWorkspace } from "@/lib/workspace";
import { apiOk, apiError } from "@/lib/auth/response";

/**
 * API-CAP-03: POST /captures/{id}/analyze 解析再要求
 *
 * [スコープ] AI Workerは本パッチでは未実装。本APIはprocessingStatusを
 * QUEUEDへ遷移させ、CaptureAnalysisRequested.v1をOutboxへ積むところまでを担う。
 * 実際の推論実行・InferenceReadyへの遷移は次回セッションのAI Worker実装で行う。
 */
export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const auth = await requireAuth(req);
  if (!auth.authenticated) {
    return apiError("AUTH_REQUIRED", "ログインが必要です");
  }
  if (!requireCsrf(req)) {
    return apiError("ACCESS_DENIED", "CSRFトークンが不正です");
  }

  const { id } = await ctx.params;
  const { workspaceId } = await ensureDefaultWorkspace(auth.user.userId, auth.user.email);

  const capture = await db.capture.findFirst({ where: { id, workspaceId, deletedAt: null } });
  if (!capture) {
    return apiError("RESOURCE_NOT_FOUND", "指定されたCaptureが見つかりません");
  }

  // FN-PRV-02: source_type=MEETINGは同意登録(consent_id確定)まで解析キューへ投入しない
  if (capture.sourceType === "MEETING" && !capture.consentId) {
    return apiError("STATE_TRANSITION_INVALID", "会議録音は同意登録が完了するまで解析できません");
  }
  if (capture.sourceType !== "VOICE" && !capture.rawText) {
    return apiError("STATE_TRANSITION_INVALID", "本文が未保存のため解析できません");
  }
  if (capture.processingStatus === "PROCESSING" || capture.processingStatus === "QUEUED") {
    // 既に解析待ち・解析中: 二重投入せず現在状態を返す(冪等)
    return apiOk({ id: capture.id, processingStatus: capture.processingStatus, version: capture.version });
  }

  const result = await db.$transaction(async (tx) => {
    const updateResult = await tx.capture.updateMany({
      where: { id: capture.id, version: capture.version },
      data: { processingStatus: "QUEUED", version: { increment: 1 } },
    });
    if (updateResult.count === 0) {
      return null;
    }
    const next = await tx.capture.findUniqueOrThrow({ where: { id: capture.id } });

    await tx.eventLog.create({
      data: {
        aggregateType: "Capture",
        aggregateId: capture.id,
        eventType: "CAPTURE_ANALYSIS_REQUESTED",
        beforeJson: { processingStatus: capture.processingStatus },
        afterJson: { processingStatus: next.processingStatus },
        actorType: "USER",
        actorId: auth.user.userId,
        correlationId: req.headers.get("x-correlation-id") ?? undefined,
      },
    });

    await tx.outboxEvent.create({
      data: {
        eventName: "CaptureAnalysisRequested.v1",
        eventVersion: "1",
        aggregateId: capture.id,
        aggregateVersion: next.version,
        correlationId: req.headers.get("x-correlation-id") ?? undefined,
        payload: { captureId: capture.id, workspaceId, sourceType: capture.sourceType },
      },
    });

    return next;
  });

  if (!result) {
    // 機能別詳細設計書v1.1 18章「競合制御」: 409応答にlatestVersionを含める
    const latest = await db.capture.findUnique({
      where: { id: capture.id },
      select: { version: true, processingStatus: true },
    });
    return apiError("VERSION_CONFLICT", "他の更新と競合しました。最新の状態を取得してください", {
      retryable: true,
      extra: { latestVersion: latest?.version, processingStatus: latest?.processingStatus },
    });
  }

  return apiOk({ id: result.id, processingStatus: result.processingStatus, version: result.version });
}
'''

CAPTURE_INFERENCES_ROUTE_CONTENT = '''import type { NextRequest } from "next/server";
import { db } from "@/lib/db";
import { requireAuth } from "@/lib/auth/guard";
import { ensureDefaultWorkspace } from "@/lib/workspace";
import { apiOk, apiError } from "@/lib/auth/response";

/**
 * API-CAP-04: GET /captures/{id}/inferences 候補取得(UI-04)
 *
 * [既知の制約] AI Workerが未実装のため、現時点では常に空配列を返す
 * (ai_inferencesへの書き込みはAI Worker実装後に発生する)。
 */
export async function GET(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const auth = await requireAuth(req);
  if (!auth.authenticated) {
    return apiError("AUTH_REQUIRED", "ログインが必要です");
  }

  const { id } = await ctx.params;
  const { workspaceId } = await ensureDefaultWorkspace(auth.user.userId, auth.user.email);

  const capture = await db.capture.findFirst({
    where: { id, workspaceId, deletedAt: null },
    select: { id: true },
  });
  if (!capture) {
    return apiError("RESOURCE_NOT_FOUND", "指定されたCaptureが見つかりません");
  }

  const inferences = await db.aiInference.findMany({
    where: { captureId: id },
    orderBy: { createdAt: "asc" },
    select: {
      id: true,
      inferenceType: true,
      payload: true,
      evidenceSpans: true,
      confidence: true,
      decision: true,
      decidedAt: true,
      createdAt: true,
    },
  });

  return apiOk({ inferences });
}
'''

CAPTURE_CONSENT_ROUTE_CONTENT = '''import type { NextRequest } from "next/server";
import { z } from "zod";
import { db } from "@/lib/db";
import { requireAuth, requireCsrf } from "@/lib/auth/guard";
import { ensureDefaultWorkspace } from "@/lib/workspace";
import { apiOk, apiError } from "@/lib/auth/response";

const ConsentSchema = z.object({
  purpose: z.string().min(1).max(64),
  participantsNotified: z.boolean().optional().default(false),
  retentionDays: z.number().int().min(1).max(3650).optional(),
});

// FN-PRV-02(TBD-04で確定): 会議録音の既定保持日数
const DEFAULT_RETENTION_DAYS = 7;

/** API-CAP-05: POST /captures/{id}/consent 会議録音の同意・利用目的登録(FN-PRV-02) */
export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const auth = await requireAuth(req);
  if (!auth.authenticated) {
    return apiError("AUTH_REQUIRED", "ログインが必要です");
  }
  if (!requireCsrf(req)) {
    return apiError("ACCESS_DENIED", "CSRFトークンが不正です");
  }

  const json = await req.json().catch(() => null);
  const parsed = ConsentSchema.safeParse(json);
  if (!parsed.success) {
    return apiError("VALIDATION_FAILED", "入力内容を確認してください", {
      fieldErrors: Object.fromEntries(
        Object.entries(parsed.error.flatten().fieldErrors).map(([k, v]) => [k, v?.[0] ?? "不正な値です"]),
      ),
    });
  }
  const { purpose, participantsNotified, retentionDays } = parsed.data;

  const { id } = await ctx.params;
  const { workspaceId } = await ensureDefaultWorkspace(auth.user.userId, auth.user.email);

  const capture = await db.capture.findFirst({ where: { id, workspaceId, deletedAt: null } });
  if (!capture) {
    return apiError("RESOURCE_NOT_FOUND", "指定されたCaptureが見つかりません");
  }

  const retentionDaysResolved = retentionDays ?? DEFAULT_RETENTION_DAYS;
  const expiresAt = new Date(Date.now() + retentionDaysResolved * 24 * 60 * 60 * 1000);

  const result = await db
    .$transaction(async (tx) => {
      const consent = await tx.consent.create({
        data: {
          captureId: capture.id,
          subjectId: auth.user.userId,
          purpose,
          scope: { participantsNotified, retentionDays: retentionDaysResolved },
          expiresAt,
        },
      });

      const updateResult = await tx.capture.updateMany({
        where: { id: capture.id, version: capture.version },
        data: { consentId: consent.id, version: { increment: 1 } },
      });
      if (updateResult.count === 0) {
        throw new Error("ISMAY_VERSION_CONFLICT");
      }

      await tx.eventLog.create({
        data: {
          aggregateType: "Capture",
          aggregateId: capture.id,
          eventType: "CONSENT_REGISTERED",
          afterJson: { consentId: consent.id, purpose },
          actorType: "USER",
          actorId: auth.user.userId,
          correlationId: req.headers.get("x-correlation-id") ?? undefined,
        },
      });

      await tx.outboxEvent.create({
        data: {
          eventName: "ConsentRegistered.v1",
          eventVersion: "1",
          aggregateId: capture.id,
          aggregateVersion: capture.version + 1,
          correlationId: req.headers.get("x-correlation-id") ?? undefined,
          payload: { captureId: capture.id, consentId: consent.id },
        },
      });

      return consent;
    })
    .catch((e: unknown) => {
      if (e instanceof Error && e.message === "ISMAY_VERSION_CONFLICT") {
        return null;
      }
      throw e;
    });

  if (!result) {
    return apiError("VERSION_CONFLICT", "他の更新と競合しました。もう一度お試しください", { retryable: true });
  }

  return apiOk({ consentId: result.id, expiresAt: result.expiresAt }, { status: 201 });
}
'''


def write_new_file(path: Path, content: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(content, encoding="utf-8")
    created_files.append(path)
    print(f"[CREATE] {path}")


def apply_patches() -> None:
    print("\n=== パッチ適用 ===")

    backup(SCHEMA_PATH)
    schema_text = SCHEMA_PATH.read_text(encoding="utf-8")
    schema_text = schema_text.replace(CAPTURE_MODEL_MARKER, CAPTURE_MODEL_REPLACEMENT, 1)
    SCHEMA_PATH.write_text(schema_text, encoding="utf-8")
    print(f"[PATCH] {SCHEMA_PATH} : Capture.clientDraftId 列 + 一意制約を追加")

    backup(RESPONSE_PATH)
    response_text = RESPONSE_PATH.read_text(encoding="utf-8")
    response_text = response_text.replace(APIERROR_MARKER, APIERROR_REPLACEMENT, 1)
    RESPONSE_PATH.write_text(response_text, encoding="utf-8")
    print(f"[PATCH] {RESPONSE_PATH} : apiError に extra フィールド対応を追加(後方互換)")

    write_new_file(WORKSPACE_LIB_PATH, WORKSPACE_LIB_CONTENT)
    write_new_file(CAPTURES_DIR / "route.ts", CAPTURES_ROUTE_CONTENT)
    write_new_file(CAPTURES_DIR / "[id]" / "route.ts", CAPTURE_DETAIL_ROUTE_CONTENT)
    write_new_file(CAPTURES_DIR / "[id]" / "analyze" / "route.ts", CAPTURE_ANALYZE_ROUTE_CONTENT)
    write_new_file(CAPTURES_DIR / "[id]" / "inferences" / "route.ts", CAPTURE_INFERENCES_ROUTE_CONTENT)
    write_new_file(CAPTURES_DIR / "[id]" / "consent" / "route.ts", CAPTURE_CONSENT_ROUTE_CONTENT)


def verify_and_ship() -> None:
    print("\n=== 検証(コンパイルエラー0件が確認できた場合のみpushします) ===")

    run(["npx", "prisma", "validate"], APP_DIR, "prisma validate")
    run(["npx", "prisma", "generate"], APP_DIR, "prisma generate")
    run(
        ["npx", "prisma", "migrate", "dev", "--name", "add_capture_client_draft_id"],
        APP_DIR,
        "prisma migrate dev",
    )
    run(["npx", "tsc", "--noEmit"], APP_DIR, "tsc --noEmit")

    print("\n[OK] 全検証ステップがコンパイルエラー0件で成功しました。GitHubへpushします。")

    run(["git", "add", "-A"], BASE_DIR, "git add")
    run(
        [
            "git",
            "commit",
            "-m",
            (
                "feat(captures): Capture業務API一式を実装\n\n"
                "- API-CAP-01 POST /api/v1/captures (原文即時保存, clientDraftId冪等)\n"
                "- GET /api/v1/captures (一覧, cursor方式)\n"
                "- GET /api/v1/captures/{id} (詳細)\n"
                "- API-CAP-03 POST /api/v1/captures/{id}/analyze (解析要求キューイング)\n"
                "- API-CAP-04 GET /api/v1/captures/{id}/inferences (AI候補一覧)\n"
                "- API-CAP-05 POST /api/v1/captures/{id}/consent (FN-PRV-02 会議同意)\n"
                "- schema.prisma: Capture.clientDraftId列+一意制約を新設\n"
                "- lib/workspace.ts: 個人用Workspace/Domain自動作成ヘルパーを新設\n"
                "- response.ts: apiErrorにextraフィールド対応を追加(409のlatestVersion等用)\n\n"
                "スコープ外(次回対応): API-CAP-02音声アップロード予約, API-PRV-03原音削除, AI Worker本体"
            ),
        ],
        BASE_DIR,
        "git commit",
    )
    run(["git", "push"], BASE_DIR, "git push")

    print("\n[OK] GitHubへpush完了しました。")


def cleanup() -> None:
    print("\n=== 後始末 ===")
    for _orig, backup_path in backup_files:
        if backup_path.exists():
            backup_path.unlink()
            print(f"[CLEANUP] {backup_path} を削除")
    self_path = Path(__file__).resolve()
    print(f"[CLEANUP] {self_path} を削除")
    self_path.unlink()


def main() -> None:
    check_preconditions()
    apply_patches()
    verify_and_ship()
    cleanup()
    print("\n=== 完了 ===")
    print("Capture業務API一式の追加・検証・GitHub pushが完了しました。")
    print("サーバープロセス(systemd: ismay-app.service)は 'next dev' 常時稼働のため、")
    print("コード変更は自動的に反映されます(再起動不要)。")
    print("\n次の確認: 認証済みCookieでPOST /api/v1/captures を叩き、201が返ること、")
    print("再送(同一clientDraftId)で200・同一idが返ることを確認してください。")


if __name__ == "__main__":
    main()
