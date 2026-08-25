-- Completion Gate 2.1: ResponsibilityLifecycleEvent新設
-- 出典: ISMAY_PEMサブシステム_統合正本仕様書_v4_0 8.1節「Correction」、
--       ISMAY_PEM_v3_3_1整合性修正_用語コード定義書_v1_0 8章(Correction Type)。
--
-- ResponsibilityExecutionEvent(Execution Ledger)はimmutableな正本Eventのみを保持し、
-- 「過去のEventを訂正する」という行為自体はここへ別レコードとしてinsert-onlyで追記する。
--
-- [外部監査P0-3是正] correction_of_event_id/resulting_event_idは、event_idのみの
-- 単一FKでは、DB制約上は別Workspaceのresponsibility_execution_eventsを参照できて
-- しまう(アプリ側の検索条件だけにtenant境界を委ねる状態は、v4.0 4.1節が要求する
-- 「DB制約とアプリケーション認可による二重化」に反する)。まずresponsibility_execution_events
-- 側に(id, workspace_id)の複合uniqueを追加し、その上でworkspace_idを含む複合FKにする。

CREATE UNIQUE INDEX "ree_id_workspace_uq"
  ON "responsibility_execution_events"("id", "workspace_id");

CREATE TABLE "responsibility_lifecycle_events" (
    "id" TEXT NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "subject_user_id" TEXT NOT NULL,
    "responsibility_id" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "correction_type" TEXT,
    "correction_of_event_id" TEXT,
    "resulting_event_id" TEXT,
    "from_state" TEXT NOT NULL,
    "to_state" TEXT NOT NULL,
    "reason" TEXT,
    "actor_type" TEXT NOT NULL,
    "actor_user_id" TEXT,
    "idempotency_key" TEXT NOT NULL,
    "request_payload_hash" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "responsibility_lifecycle_events_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "rle_idempotency_uq"
  ON "responsibility_lifecycle_events"("workspace_id", "subject_user_id", "idempotency_key");
CREATE INDEX "responsibility_lifecycle_events_responsibility_id_idx"
  ON "responsibility_lifecycle_events"("responsibility_id");
CREATE INDEX "responsibility_lifecycle_events_correction_of_event_id_idx"
  ON "responsibility_lifecycle_events"("correction_of_event_id", "workspace_id");

ALTER TABLE "responsibility_lifecycle_events"
  ADD CONSTRAINT "responsibility_lifecycle_events_responsibility_workspace_fkey"
  FOREIGN KEY ("responsibility_id", "workspace_id")
  REFERENCES "responsibilities"("id", "workspace_id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "responsibility_lifecycle_events"
  ADD CONSTRAINT "responsibility_lifecycle_events_correction_of_event_fkey"
  FOREIGN KEY ("correction_of_event_id", "workspace_id")
  REFERENCES "responsibility_execution_events"("id", "workspace_id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "responsibility_lifecycle_events"
  ADD CONSTRAINT "responsibility_lifecycle_events_resulting_event_fkey"
  FOREIGN KEY ("resulting_event_id", "workspace_id")
  REFERENCES "responsibility_execution_events"("id", "workspace_id")
  ON DELETE RESTRICT ON UPDATE CASCADE;
