#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
ISMAY schema.prisma 反映パッチ（一度きり実行・プロジェクトルート直下）
====================================================================
DB設計書v1.1 TBL-001〜026 + 認証拡張(UserSession/UserTotpSecret) +
pgvector Embedding(responsibility_embeddings) を反映した schema.prisma を
サーバーへ適用し、検証・マイグレーション・コンパイルチェックを行い、
すべて成功した場合のみ GitHub へ自動push する。

実行方法:
    cd ~/projects/ismay
    python3 apply_ismay_schema_v2.py

失敗した場合は該当ステップで停止し、pushは一切行わない。
成功した場合、バックアップと本スクリプト自身を自動削除する。
"""
import subprocess
import sys
import os
import shutil
import datetime

REPO_ROOT = os.path.dirname(os.path.abspath(__file__))
APP_DIR = os.path.join(REPO_ROOT, "app")
SCHEMA_PATH = os.path.join(APP_DIR, "prisma", "schema.prisma")
BACKUP_PATH = SCHEMA_PATH + ".bak_" + datetime.date.today().strftime("%Y%m%d")

NEW_SCHEMA = r'''// ISMAY schema.prisma
// DB設計書v1.1 3章「テーブル一覧」の TBL-001〜026 を反映。
// 列定義が正式資料に明記されていない部分は [推論] とコメントし、次回レビュー対象とする。
// 認証方式は「OIDC準拠（システム基本設計書v1.2 7章）」の決定に基づき、
// 自前のセッション・リフレッシュトークン・TOTP MFAテーブルを新設する（TBD-02準拠実装）。
//
// 生成: `npx prisma generate`
// 適用: `npx prisma migrate dev --name init_core_schema`

generator client {
  provider        = "prisma-client"
  output          = "../src/generated/prisma"
  previewFeatures = ["postgresqlExtensions"]
}

datasource db {
  provider   = "postgresql"
  extensions = [vector]
}

// =====================================================================
// MOD-01 Identity: users / workspaces / workspace_members / domains
// =====================================================================

/// TBL-001 users - 本人アカウント
model User {
  id              String    @id @default(uuid())
  email           String    @unique
  emailVerifiedAt DateTime? @map("email_verified_at")
  passwordHash    String    @map("password_hash")
  displayName     String?   @map("display_name")
  locale          String    @default("ja-JP")
  timeZone        String    @default("Asia/Tokyo") @map("time_zone")
  /// ACTIVE/SUSPENDED/DELETED [推論]
  status          String    @default("ACTIVE")
  version         Int       @default(0)
  createdAt       DateTime  @default(now()) @map("created_at")
  updatedAt       DateTime  @updatedAt @map("updated_at")
  deletedAt       DateTime? @map("deleted_at")

  workspaceMembers    WorkspaceMember[]
  sessions            UserSession[]
  totpSecret          UserTotpSecret?
  capturesCreated     Capture[]              @relation("CaptureCreatedBy")
  responsibilitiesCreated Responsibility[]   @relation("ResponsibilityCreatedBy")
  responsibilitiesUpdated Responsibility[]   @relation("ResponsibilityUpdatedBy")
  pemObservations     PemObservation[]
  pemHypotheses       PemHypothesis[]
  notifications       Notification[]
  auditLogsAsActor    AuditLog[]             @relation("AuditActorUser")

  @@map("users")
}

/// FR-AUTH-04対応: セッション・端末の確認/失効。OIDC Access/Refresh運用の実体。[新設・推論]
model UserSession {
  id                  String    @id @default(uuid())
  userId              String    @map("user_id")
  user                User      @relation(fields: [userId], references: [id], onDelete: Cascade)
  deviceLabel         String?   @map("device_label")
  userAgent           String?   @map("user_agent")
  ipAddress           String?   @map("ip_address")
  /// Refresh Tokenはハッシュのみ保存し、平文は保持しない
  refreshTokenHash    String    @map("refresh_token_hash")
  /// ローテーション世代を束ねる系列ID。再利用検知（Token再送攻撃対策）に使用
  refreshTokenFamily  String    @map("refresh_token_family")
  issuedAt            DateTime  @default(now()) @map("issued_at")
  lastUsedAt          DateTime  @default(now()) @map("last_used_at")
  expiresAt           DateTime  @map("expires_at")
  revokedAt           DateTime? @map("revoked_at")
  revokedReason        String?   @map("revoked_reason")

  @@index([userId, revokedAt])
  @@index([refreshTokenFamily])
  @@map("user_sessions")
}

/// FR-AUTH-03対応: TOTP MFA秘密鍵と復旧コード。[新設・推論]
model UserTotpSecret {
  id                String    @id @default(uuid())
  userId            String    @unique @map("user_id")
  user              User      @relation(fields: [userId], references: [id], onDelete: Cascade)
  /// アプリ層AES-256-GCM等で暗号化して保存（TBD-17の決定に従う）
  secretEncrypted   String    @map("secret_encrypted")
  /// リカバリコードはハッシュ化して配列保存。使用済みは別途 usedAt を持つ小テーブル化も検討可
  recoveryCodesHash Json      @map("recovery_codes_hash")
  enrolledAt        DateTime  @default(now()) @map("enrolled_at")
  disabledAt        DateTime? @map("disabled_at")

  @@map("user_totp_secrets")
}

/// TBL-002 workspaces - データ所有境界 [推論]
model Workspace {
  id        String    @id @default(uuid())
  name      String
  version   Int       @default(0)
  createdAt DateTime  @default(now()) @map("created_at")
  updatedAt DateTime  @updatedAt @map("updated_at")
  deletedAt DateTime? @map("deleted_at")

  members       WorkspaceMember[]
  domains       Domain[]
  captures      Capture[]
  responsibilities Responsibility[]
  integrations  Integration[]

  @@map("workspaces")
}

/// TBL-003 workspace_members - 所属・ロール（履歴保持）[推論]
model WorkspaceMember {
  id          String    @id @default(uuid())
  workspaceId String    @map("workspace_id")
  workspace   Workspace @relation(fields: [workspaceId], references: [id], onDelete: Cascade)
  userId      String    @map("user_id")
  user        User      @relation(fields: [userId], references: [id], onDelete: Cascade)
  /// OWNER/ADMIN/MEMBER [推論]
  role        String    @default("MEMBER")
  joinedAt    DateTime  @default(now()) @map("joined_at")
  leftAt      DateTime? @map("left_at")
  createdAt   DateTime  @default(now()) @map("created_at")

  @@index([workspaceId, userId])
  @@map("workspace_members")
}

/// TBL-004 domains - 仕事・個人等の機密境界 [推論]
model Domain {
  id          String    @id @default(uuid())
  workspaceId String    @map("workspace_id")
  workspace   Workspace @relation(fields: [workspaceId], references: [id], onDelete: Cascade)
  name        String
  /// WORK/PERSONAL/OTHER [推論]
  kind        String    @default("PERSONAL")
  /// AI参照可否等のポリシー [推論]
  aiPolicy    Json?     @map("ai_policy")
  createdAt   DateTime  @default(now()) @map("created_at")
  updatedAt   DateTime  @updatedAt @map("updated_at")
  deletedAt   DateTime? @map("deleted_at")

  captures         Capture[]
  responsibilities Responsibility[]

  @@map("domains")
}

// =====================================================================
// MOD-02 Capture
// =====================================================================

/// TBL-005 captures
model Capture {
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
}

// =====================================================================
// MOD-03 Responsibility
// =====================================================================

/// TBL-006 responsibilities - 全責任の共通正本
model Responsibility {
  id               String    @id @default(uuid())
  workspaceId      String    @map("workspace_id")
  workspace        Workspace @relation(fields: [workspaceId], references: [id])
  domainId         String    @map("domain_id")
  domain           Domain    @relation(fields: [domainId], references: [id])
  originCaptureId  String?   @map("origin_capture_id")
  originCapture    Capture?  @relation(fields: [originCaptureId], references: [id])
  /// TASK/COMMITMENT/DECISION/WAITING/EVENT/RISK/CONCERN/HABIT/IDEA
  /// (v1.1注記: Constraintは含まない。Goalは本テーブルに現れない)
  type             String
  title            String
  description      String?
  status           String
  importance       Int?
  /// 0〜1
  confidence       Decimal?  @db.Decimal(4, 3)
  /// USER/AI/IMPORT/SYSTEM
  sourceKind       String    @map("source_kind")
  hardDeadlineAt   DateTime? @map("hard_deadline_at")
  targetAt         DateTime? @map("target_at")
  startAfterAt     DateTime? @map("start_after_at")
  completedAt      DateTime? @map("completed_at")
  version          Int       @default(0)
  createdById      String    @map("created_by")
  createdBy        User      @relation("ResponsibilityCreatedBy", fields: [createdById], references: [id])
  updatedById      String    @map("updated_by")
  updatedBy        User      @relation("ResponsibilityUpdatedBy", fields: [updatedById], references: [id])
  createdAt        DateTime  @default(now()) @map("created_at")
  updatedAt        DateTime  @updatedAt @map("updated_at")
  deletedAt        DateTime? @map("deleted_at")

  taskDetail       TaskDetail?
  commitmentDetail CommitmentDetail?
  decisionDetail   DecisionDetail?
  waitingDetail    WaitingDetail?
  constraints      Constraint[]
  recurrenceRule   RecurrenceRule?
  relationsFrom    ResponsibilityRelation[] @relation("RelationFrom")
  relationsTo      ResponsibilityRelation[] @relation("RelationTo")
  evidences        Evidence[]
  embedding        ResponsibilityEmbedding?

  @@index([workspaceId, id])
  @@map("responsibilities")
}

/// TBL-007 task_details - Task固有属性 [推論]
model TaskDetail {
  responsibilityId    String          @id @map("responsibility_id")
  responsibility      Responsibility  @relation(fields: [responsibilityId], references: [id], onDelete: Cascade)
  estimatedMinutesMin Int?            @map("estimated_minutes_min")
  estimatedMinutesMax Int?            @map("estimated_minutes_max")
  location            String?
  requiredTools       Json?           @map("required_tools")

  @@map("task_details")
}

/// TBL-008 commitment_details - 約束固有属性 [推論]
model CommitmentDetail {
  responsibilityId    String         @id @map("responsibility_id")
  responsibility      Responsibility @relation(fields: [responsibilityId], references: [id], onDelete: Cascade)
  counterpartyName    String?        @map("counterparty_name")
  counterpartyContact String?        @map("counterparty_contact")
  promiseText         String?        @map("promise_text")

  @@map("commitment_details")
}

/// TBL-009 decision_details - 判断固有属性 [推論]
model DecisionDetail {
  responsibilityId String         @id @map("responsibility_id")
  responsibility   Responsibility @relation(fields: [responsibilityId], references: [id], onDelete: Cascade)
  options          Json?
  chosenOption     String?        @map("chosen_option")
  rationale        String?
  decidedAt        DateTime?      @map("decided_at")

  @@map("decision_details")
}

/// TBL-010 waiting_details - 待ち固有属性 [推論]
model WaitingDetail {
  responsibilityId  String         @id @map("responsibility_id")
  responsibility    Responsibility @relation(fields: [responsibilityId], references: [id], onDelete: Cascade)
  waitingOn         String?        @map("waiting_on")
  expectedReplyBy   DateTime?      @map("expected_reply_by")
  followUpAt        DateTime?      @map("follow_up_at")
  reminderSentAt    DateTime?      @map("reminder_sent_at")

  @@map("waiting_details")
}

/// TBL-011 constraints - 期限・場所・権限等（責任に従属、responsibilities.typeには含めない）[推論]
model Constraint {
  id               String         @id @default(uuid())
  responsibilityId String         @map("responsibility_id")
  responsibility   Responsibility @relation(fields: [responsibilityId], references: [id], onDelete: Cascade)
  /// DEADLINE/LOCATION/PERMISSION/RESOURCE等 [推論]
  constraintType   String         @map("constraint_type")
  value            Json
  note             String?
  createdAt        DateTime       @default(now()) @map("created_at")

  @@map("constraints")
}

/// TBL-012 responsibility_relations - 責任間の有向関係
model ResponsibilityRelation {
  id            String    @id @default(uuid())
  fromId        String    @map("from_id")
  from          Responsibility @relation("RelationFrom", fields: [fromId], references: [id])
  toId          String    @map("to_id")
  to            Responsibility @relation("RelationTo", fields: [toId], references: [id])
  /// PRECEDES/BLOCKS/DEPENDS_ON等
  relationType  String    @map("relation_type")
  /// CANDIDATE/CONFIRMED/REJECTED
  status        String
  confidence    Decimal?  @db.Decimal(4, 3)
  sourceKind    String?   @map("source_kind")
  sourceRef     String?   @map("source_ref")
  confirmedById String?   @map("confirmed_by")
  confirmedAt   DateTime? @map("confirmed_at")
  createdAt     DateTime  @default(now()) @map("created_at")
  deletedAt     DateTime? @map("deleted_at")

  @@map("responsibility_relations")
}

/// TBL-020 recurrence_rules（FN-REC-01対応）
model RecurrenceRule {
  id                String         @id @default(uuid())
  responsibilityId  String         @unique @map("responsibility_id")
  responsibility    Responsibility @relation(fields: [responsibilityId], references: [id], onDelete: Cascade)
  /// DAILY/WEEKLY/MONTHLY等
  frequency         String
  interval          Int
  weekdays          Json?
  exceptions        Json?
  pausedUntil       DateTime?      @map("paused_until")
  /// CARRY/DROP/RENOTIFY
  carryoverPolicy   String         @map("carryover_policy")
  lastGeneratedAt   DateTime?      @map("last_generated_at")
  version           Int            @default(0)

  @@map("recurrence_rules")
}

// =====================================================================
// EventLog / Outbox
// =====================================================================

/// TBL-013 event_logs（原則削除不可）
model EventLog {
  id              String   @id @default(uuid())
  aggregateType   String   @map("aggregate_type")
  aggregateId     String   @map("aggregate_id")
  eventType       String   @map("event_type")
  beforeJson      Json?    @map("before_json")
  afterJson       Json?    @map("after_json")
  actorType       String   @map("actor_type")
  actorId         String?  @map("actor_id")
  reason          String?
  correlationId   String?  @map("correlation_id")
  occurredAt      DateTime @default(now()) @map("occurred_at")

  @@index([aggregateType, aggregateId])
  @@map("event_logs")
}

/// TBL-025 outbox_events - 確実なイベント配送 [推論]
model OutboxEvent {
  id               String    @id @default(uuid())
  eventName        String    @map("event_name")
  eventVersion     String    @map("event_version")
  aggregateId      String    @map("aggregate_id")
  aggregateVersion Int       @map("aggregate_version")
  correlationId    String?   @map("correlation_id")
  causationId      String?   @map("causation_id")
  payload          Json
  /// PENDING/PUBLISHED/FAILED [推論]
  status           String    @default("PENDING")
  publishedAt      DateTime? @map("published_at")
  createdAt        DateTime  @default(now()) @map("created_at")

  @@index([status, createdAt])
  @@map("outbox_events")
}

/// TBL-026 jobs - 非同期処理状態 [推論]
model Job {
  id             String    @id @default(uuid())
  jobType        String    @map("job_type")
  aggregateId    String    @map("aggregate_id")
  sourceVersion  Int       @map("source_version")
  /// QUEUED/RUNNING/SUCCEEDED/FAILED/DEAD_LETTER [推論]
  status         String    @default("QUEUED")
  attempts       Int       @default(0)
  maxAttempts    Int       @default(5) @map("max_attempts")
  nextRunAt      DateTime? @map("next_run_at")
  lastError      String?   @map("last_error")
  payload        Json?
  createdAt      DateTime  @default(now()) @map("created_at")
  updatedAt      DateTime  @updatedAt @map("updated_at")

  @@unique([jobType, aggregateId, sourceVersion])
  @@index([status, nextRunAt])
  @@map("jobs")
}

// =====================================================================
// MOD-06 AI Gateway
// =====================================================================

/// TBL-014 ai_inferences
model AiInference {
  id             String    @id @default(uuid())
  captureId      String    @map("capture_id")
  capture        Capture   @relation(fields: [captureId], references: [id])
  aiRunId        String    @map("ai_run_id")
  aiRun          AiRun     @relation(fields: [aiRunId], references: [id])
  /// RESPONSIBILITY/RELATION/DEADLINE等
  inferenceType  String    @map("inference_type")
  payload        Json
  evidenceSpans  Json      @map("evidence_spans")
  confidence     Decimal   @db.Decimal(4, 3)
  /// PENDING/ACCEPTED/EDITED/REJECTED/EXPIRED
  decision       String    @default("PENDING")
  decidedById    String?   @map("decided_by")
  decidedAt      DateTime? @map("decided_at")
  createdAt      DateTime  @default(now()) @map("created_at")

  @@map("ai_inferences")
}

/// TBL-015 ai_runs - モデル実行・費用・結果 [推論]
model AiRun {
  id             String    @id @default(uuid())
  captureId      String?   @map("capture_id")
  capture        Capture?  @relation(fields: [captureId], references: [id])
  provider       String
  model          String
  promptVersion  String    @map("prompt_version")
  schemaVersion  String    @map("schema_version")
  inputTokens    Int?      @map("input_tokens")
  outputTokens   Int?      @map("output_tokens")
  costMicros     BigInt?   @map("cost_micros")
  latencyMs      Int?      @map("latency_ms")
  /// PENDING/SUCCEEDED/FAILED [推論]
  status         String    @default("PENDING")
  errorCode      String?   @map("error_code")
  startedAt      DateTime  @default(now()) @map("started_at")
  finishedAt     DateTime? @map("finished_at")

  inferences AiInference[]

  @@map("ai_runs")
}

/// 新設: pgvector Embedding。DB設計書v1.1 7章「検索・Embedding」に対応。TBL番号未採番
model ResponsibilityEmbedding {
  responsibilityId String         @id @map("responsibility_id")
  responsibility   Responsibility @relation(fields: [responsibilityId], references: [id], onDelete: Cascade)
  workspaceId      String         @map("workspace_id")
  domainId         String         @map("domain_id")
  modelVersion     String         @map("model_version")
  /// pgvector型。previewFeatures=postgresqlExtensions前提でPrismaは型検証をスキップする
  embedding        Unsupported("vector(1536)")
  createdAt        DateTime       @default(now()) @map("created_at")
  updatedAt        DateTime       @updatedAt @map("updated_at")

  @@index([workspaceId, domainId])
  @@map("responsibility_embeddings")
}

// =====================================================================
// MOD-05 PEM
// =====================================================================

/// TBL-016 pem_observations [推論・DB設計書4.5節に準拠]
model PemObservation {
  id             String    @id @default(uuid())
  userId         String    @map("user_id")
  user           User      @relation(fields: [userId], references: [id])
  observationType String   @map("observation_type")
  payload        Json
  validUntil     DateTime? @map("valid_until")
  occurredAt     DateTime  @default(now()) @map("occurred_at")
  createdAt      DateTime  @default(now()) @map("created_at")
  deletedAt      DateTime? @map("deleted_at")

  evidenceLinks PemEvidenceLink[]

  @@map("pem_observations")
}

/// TBL-017 pem_hypotheses [推論・DB設計書4.5節に準拠]
model PemHypothesis {
  id          String    @id @default(uuid())
  userId      String    @map("user_id")
  user        User      @relation(fields: [userId], references: [id])
  statement   String
  sampleSize  Int       @map("sample_size")
  windowFrom  DateTime  @map("window_from")
  windowTo    DateTime  @map("window_to")
  confidence  Decimal   @db.Decimal(4, 3)
  validUntil  DateTime? @map("valid_until")
  /// CONFIRMED/REJECTED/PENDING [推論]
  userVerdict String    @default("PENDING") @map("user_verdict")
  createdAt   DateTime  @default(now()) @map("created_at")
  updatedAt   DateTime  @updatedAt @map("updated_at")
  deletedAt   DateTime? @map("deleted_at")

  evidenceLinks PemEvidenceLink[]

  @@map("pem_hypotheses")
}

/// TBL-018 pem_evidence_links - PEMと証拠参照（責任に従属）[推論]
model PemEvidenceLink {
  id               String          @id @default(uuid())
  pemObservationId String?         @map("pem_observation_id")
  pemObservation   PemObservation? @relation(fields: [pemObservationId], references: [id])
  pemHypothesisId  String?         @map("pem_hypothesis_id")
  pemHypothesis    PemHypothesis?  @relation(fields: [pemHypothesisId], references: [id])
  evidenceId       String          @map("evidence_id")
  evidence         Evidence        @relation(fields: [evidenceId], references: [id])
  createdAt        DateTime        @default(now()) @map("created_at")

  @@map("pem_evidence_links")
}

/// TBL-019 evidences - 完了等の証拠候補 [推論]
model Evidence {
  id               String          @id @default(uuid())
  responsibilityId String?         @map("responsibility_id")
  responsibility   Responsibility? @relation(fields: [responsibilityId], references: [id])
  sourceType       String          @map("source_type")
  sourceRef        String?         @map("source_ref")
  capturedAt       DateTime?       @map("captured_at")
  confidence       Decimal?        @db.Decimal(4, 3)
  /// CANDIDATE/CONFIRMED/REJECTED [推論]
  status           String          @default("CANDIDATE")
  createdAt        DateTime        @default(now()) @map("created_at")

  pemEvidenceLinks PemEvidenceLink[]

  @@map("evidences")
}

// =====================================================================
// MOD-08 Notification / MOD-09 Privacy / MOD-11 Integration / MOD-10 Admin
// =====================================================================

/// TBL-021 notifications [推論]
model Notification {
  id               String    @id @default(uuid())
  userId           String    @map("user_id")
  user             User      @relation(fields: [userId], references: [id])
  /// DEADLINE/FOLLOW_UP/RISK等 [推論]
  type             String
  dedupeKey        String    @map("dedupe_key")
  payload          Json
  channel          String    @default("IN_APP")
  /// SCHEDULED/SENT/READ/SUPPRESSED [推論]
  status           String    @default("SCHEDULED")
  scheduledAt      DateTime  @map("scheduled_at")
  sentAt           DateTime? @map("sent_at")
  readAt           DateTime? @map("read_at")
  createdAt        DateTime  @default(now()) @map("created_at")

  @@unique([dedupeKey])
  @@index([userId, status])
  @@map("notifications")
}

/// TBL-022 consents（FN-PRV-02対応）
model Consent {
  id          String    @id @default(uuid())
  captureId   String?   @map("capture_id")
  subjectId   String    @map("subject_id")
  purpose     String
  scope       Json
  grantedAt   DateTime  @default(now()) @map("granted_at")
  expiresAt   DateTime? @map("expires_at")
  withdrawnAt DateTime? @map("withdrawn_at")

  captures Capture[]

  @@map("consents")
}

/// TBL-023 integrations - 外部連携メタデータ（P6予約）[推論]
model Integration {
  id          String    @id @default(uuid())
  workspaceId String    @map("workspace_id")
  workspace   Workspace @relation(fields: [workspaceId], references: [id])
  provider    String
  scope       Json
  /// CONNECTED/REVOKED [推論]
  status      String    @default("CONNECTED")
  connectedAt DateTime  @default(now()) @map("connected_at")
  revokedAt   DateTime? @map("revoked_at")

  @@map("integrations")
}

/// TBL-024 audit_logs - 管理・権限・外部操作 [推論]
model AuditLog {
  id           String   @id @default(uuid())
  actorUserId  String?  @map("actor_user_id")
  actorUser    User?    @relation("AuditActorUser", fields: [actorUserId], references: [id])
  actorType    String   @map("actor_type")
  action       String
  targetType   String   @map("target_type")
  targetId     String?  @map("target_id")
  /// SUCCESS/FAILURE [推論]
  result       String
  reason       String?
  ipAddress    String?  @map("ip_address")
  occurredAt   DateTime @default(now()) @map("occurred_at")

  @@index([targetType, targetId])
  @@map("audit_logs")
}
'''


def run(cmd, cwd):
    print("\n$ " + " ".join(cmd))
    result = subprocess.run(cmd, cwd=cwd)
    return result.returncode


def fail(message):
    print("\n[FAIL] " + message)
    print("       pushは行いません。schema.prismaは新しい内容のまま残ります。")
    print("       ロールバックする場合: cp '" + BACKUP_PATH + "' '" + SCHEMA_PATH + "'")
    sys.exit(1)


def main():
    if not os.path.isfile(SCHEMA_PATH):
        fail("schema.prismaが見つかりません: " + SCHEMA_PATH)

    print("[1/6] 現行schema.prismaをバックアップ: " + BACKUP_PATH)
    shutil.copy2(SCHEMA_PATH, BACKUP_PATH)

    print("[2/6] 新schema.prisma(TBL-001〜026 + 認証拡張 + pgvector)を書き込み")
    with open(SCHEMA_PATH, "w", encoding="utf-8") as f:
        f.write(NEW_SCHEMA)

    print("[3/6] npx prisma validate")
    if run(["npx", "prisma", "validate"], cwd=APP_DIR) != 0:
        fail("prisma validateでエラーが検出されました。")

    print("[4/6] npx prisma generate")
    if run(["npx", "prisma", "generate"], cwd=APP_DIR) != 0:
        fail("prisma generateでエラーが検出されました。")

    print("[5/6] npx prisma migrate dev --name init_core_schema_v2")
    if run(["npx", "prisma", "migrate", "dev", "--name", "init_core_schema_v2"], cwd=APP_DIR) != 0:
        fail("マイグレーション適用でエラーが検出されました。pgvector拡張(CREATE EXTENSION vector)が有効か確認してください。")

    print("[6/6] npx tsc --noEmit (コンパイルエラー0件ゲート)")
    if run(["npx", "tsc", "--noEmit"], cwd=APP_DIR) != 0:
        fail("TypeScriptコンパイルエラーが検出されました。")

    print("\n[OK] 全ステップ成功（コンパイルエラー0件）。GitHubへpushします。")
    run(["git", "add", "-A"], cwd=REPO_ROOT)
    commit_msg = "feat(db): schema.prisma に TBL-001-026 全反映 + 認証拡張(session/TOTP) + pgvector embedding を追加"
    if run(["git", "commit", "-m", commit_msg], cwd=REPO_ROOT) != 0:
        print("[WARN] コミットする変更がないか、コミットに失敗しました。git statusを確認してください。")
        sys.exit(1)
    if run(["git", "push", "origin", "main"], cwd=REPO_ROOT) != 0:
        fail("git pushに失敗しました。手動で `git push origin main` を実行してください。")

    print("\n[CLEANUP] バックアップと本スクリプト自身を削除します")
    if os.path.exists(BACKUP_PATH):
        os.remove(BACKUP_PATH)
    os.remove(os.path.abspath(__file__))

    print("\n完了しました。次: npx prisma studio --port 15555 で26+3テーブルを目視確認してください。")


if __name__ == "__main__":
    main()
