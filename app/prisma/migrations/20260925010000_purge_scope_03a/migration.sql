-- PURGE-SCOPE-03A: FKを持たない表へ明示的なscope列(workspace_id)を追加する。
-- 出典: DEC-PURGE-02B(2026-09-25利用者決定「FKが無いから保持、という設計を終わらせ、
-- 明示的なscope列でPurge対象を特定する」)、DOC-10 CHG-080「Evidence/Audit/Job/Outboxへ
-- workspace/subject情報追加」。
--
-- 方針:
--   - event_logs / outbox_events / jobs / consents へworkspace_idを追加し、workspaces(id)へFK。
--     30日Purgeは実行時にpg_constraintからFKグラフを読むため、これらの表は自動的に
--     workspace scopeの削除対象になる(列名の推測はしない)。
--   - ai_runs.workspace_id(2026-08-23追加済み、FK無し)へFKを追加する。既存行に
--     削除済みworkspaceを指す孤立値が残り得るため、既存行を検証しないNOT VALIDで追加する
--     (新規行・更新行は検証される)。
--   - ON DELETE CASCADE: Purgeは子表を先に明示削除して件数を記録するため通常はCASCADEが
--     発火しない。RESTRICTにすると、workspace行を削除する既存の検証用cleanupが
--     これらの行の削除漏れで失敗するため、所有データとしてworkspaceと運命を共にさせる。
--   - 新規行はworkspace_id必須(BEFORE INSERT/UPDATE trigger)。CHECK制約にすると、
--     backfillで解決できなかった旧行(集約が既に存在しない孤立行)の状態更新まで
--     失敗するため、INSERTと「非NULL→NULL」への更新だけを拒否する。
--   - backfillで解決できない旧行はworkspace_id=NULLのまま残る(削除はしない)。
--     Purge CLIが件数を「scope未解決の旧行」として表示する。

-- 1) 列追加
ALTER TABLE "event_logs" ADD COLUMN "workspace_id" TEXT;
ALTER TABLE "outbox_events" ADD COLUMN "workspace_id" TEXT;
ALTER TABLE "jobs" ADD COLUMN "workspace_id" TEXT;
ALTER TABLE "consents" ADD COLUMN "workspace_id" TEXT;

-- 2) backfill(集約IDはUUIDで全表一意。workspace_idを持つ集約表を突き合わせる)
CREATE TEMP TABLE "_purge_scope_03a_aggregates" AS
  SELECT "id", "workspace_id" FROM "captures"
  UNION ALL SELECT "id", "workspace_id" FROM "responsibilities"
  UNION ALL SELECT "id", "workspace_id" FROM "project_contexts"
  UNION ALL SELECT "id", "workspace_id" FROM "external_context_references"
  UNION ALL SELECT "id", "workspace_id" FROM "formation_sessions";
CREATE INDEX ON "_purge_scope_03a_aggregates" ("id");

UPDATE "event_logs" e SET "workspace_id" = a."workspace_id"
  FROM "_purge_scope_03a_aggregates" a WHERE e."workspace_id" IS NULL AND e."aggregate_id" = a."id";
UPDATE "outbox_events" o SET "workspace_id" = a."workspace_id"
  FROM "_purge_scope_03a_aggregates" a WHERE o."workspace_id" IS NULL AND o."aggregate_id" = a."id";
UPDATE "jobs" j SET "workspace_id" = a."workspace_id"
  FROM "_purge_scope_03a_aggregates" a WHERE j."workspace_id" IS NULL AND j."aggregate_id" = a."id";
DROP TABLE "_purge_scope_03a_aggregates";

-- consents: capture_id列 → captures、次にcaptures.consent_id(逆参照) → captures。
UPDATE "consents" c SET "workspace_id" = cap."workspace_id"
  FROM "captures" cap WHERE c."workspace_id" IS NULL AND c."capture_id" = cap."id";
UPDATE "consents" c SET "workspace_id" = cap."workspace_id"
  FROM "captures" cap WHERE c."workspace_id" IS NULL AND cap."consent_id" = c."id";

-- ai_runs: workspace_id未設定でcaptureがある行はcaptureのworkspaceで埋める(元から存在する列の正しい値)。
UPDATE "ai_runs" r SET "workspace_id" = cap."workspace_id"
  FROM "captures" cap WHERE r."workspace_id" IS NULL AND r."capture_id" = cap."id";

-- 3) FK
ALTER TABLE "event_logs" ADD CONSTRAINT "event_logs_workspace_id_fkey"
  FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "outbox_events" ADD CONSTRAINT "outbox_events_workspace_id_fkey"
  FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "jobs" ADD CONSTRAINT "jobs_workspace_id_fkey"
  FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "consents" ADD CONSTRAINT "consents_workspace_id_fkey"
  FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ai_runs" ADD CONSTRAINT "ai_runs_workspace_id_fkey"
  FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE NOT VALID;

-- 4) index(Purge snapshotの絞り込み用)
CREATE INDEX "event_logs_workspace_id_idx" ON "event_logs"("workspace_id");
CREATE INDEX "outbox_events_workspace_id_idx" ON "outbox_events"("workspace_id");
CREATE INDEX "jobs_workspace_id_idx" ON "jobs"("workspace_id");
CREATE INDEX "consents_workspace_id_idx" ON "consents"("workspace_id");
CREATE INDEX "ai_runs_workspace_id_idx" ON "ai_runs"("workspace_id");

-- 5) 新規行のworkspace_id必須化(write-time validation)
CREATE OR REPLACE FUNCTION "ismay_require_workspace_scope"() RETURNS trigger AS $$
BEGIN
  IF NEW."workspace_id" IS NULL AND (TG_OP = 'INSERT' OR OLD."workspace_id" IS NOT NULL) THEN
    RAISE EXCEPTION 'PURGE-SCOPE-03A: %.workspace_id is required (explicit purge scope column)', TG_TABLE_NAME
      USING ERRCODE = '23502';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "event_logs_require_workspace_scope" BEFORE INSERT OR UPDATE OF "workspace_id" ON "event_logs"
  FOR EACH ROW EXECUTE FUNCTION "ismay_require_workspace_scope"();
CREATE TRIGGER "outbox_events_require_workspace_scope" BEFORE INSERT OR UPDATE OF "workspace_id" ON "outbox_events"
  FOR EACH ROW EXECUTE FUNCTION "ismay_require_workspace_scope"();
CREATE TRIGGER "jobs_require_workspace_scope" BEFORE INSERT OR UPDATE OF "workspace_id" ON "jobs"
  FOR EACH ROW EXECUTE FUNCTION "ismay_require_workspace_scope"();
CREATE TRIGGER "consents_require_workspace_scope" BEFORE INSERT OR UPDATE OF "workspace_id" ON "consents"
  FOR EACH ROW EXECUTE FUNCTION "ismay_require_workspace_scope"();
CREATE TRIGGER "ai_runs_require_workspace_scope" BEFORE INSERT OR UPDATE OF "workspace_id" ON "ai_runs"
  FOR EACH ROW EXECUTE FUNCTION "ismay_require_workspace_scope"();
