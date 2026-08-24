-- Phase 0C-1-2: ReasonPrompt / ReasonPromptStateEvent / ExecutionReasonAnswer新設
-- 出典: ISMAY_PEMサブシステム_統合正本仕様書_v4_0 8.2節・8.3節

CREATE TABLE "reason_prompts" (
    "id" TEXT NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "subject_user_id" TEXT NOT NULL,
    "trigger_event_id" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "reason_prompts_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "reason_prompts_trigger_event_id_uq" ON "reason_prompts"("trigger_event_id");

ALTER TABLE "reason_prompts"
  ADD CONSTRAINT "reason_prompts_trigger_event_fkey"
  FOREIGN KEY ("trigger_event_id") REFERENCES "responsibility_execution_events"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE TABLE "reason_prompt_state_events" (
    "id" TEXT NOT NULL,
    "prompt_id" TEXT NOT NULL,
    "state" TEXT NOT NULL,
    "occurred_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "reason_prompt_state_events_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "reason_prompt_state_events_prompt_id_idx" ON "reason_prompt_state_events"("prompt_id");

ALTER TABLE "reason_prompt_state_events"
  ADD CONSTRAINT "reason_prompt_state_events_prompt_fkey"
  FOREIGN KEY ("prompt_id") REFERENCES "reason_prompts"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE TABLE "execution_reason_answers" (
    "id" TEXT NOT NULL,
    "workspace_id" TEXT NOT NULL,
    "subject_user_id" TEXT NOT NULL,
    "prompt_id" TEXT NOT NULL,
    "trigger_event_id" TEXT NOT NULL,
    "reason_code" TEXT,
    "ai_classified_reason_code" TEXT,
    "free_text" TEXT,
    "structured_detail" JSONB,
    "question_version" TEXT NOT NULL,
    "revision_of_answer_id" TEXT,
    "answered_at" TIMESTAMP(3) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "execution_reason_answers_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "execution_reason_answers_prompt_id_idx" ON "execution_reason_answers"("prompt_id");

ALTER TABLE "execution_reason_answers"
  ADD CONSTRAINT "execution_reason_answers_prompt_fkey"
  FOREIGN KEY ("prompt_id") REFERENCES "reason_prompts"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;
