-- PATTERN-MANAGEMENT-UI-01: CasePattern退避(retire)機能。
-- 出典: Claude向け_ISMAY_d68e9bf以降_ActionSlot正本準拠・CasePattern実分解
-- 完遂・残工程連続実装指示_2026-09-17.md P1「11. Pattern管理UI・duration・
-- docs」のUI部分。

ALTER TABLE "case_patterns" ADD COLUMN "retired_at" TIMESTAMP(3);
ALTER TABLE "case_patterns" ADD COLUMN "retired_by_id" TEXT;

ALTER TABLE "case_patterns" ADD CONSTRAINT "case_patterns_retired_by_id_fkey"
  FOREIGN KEY ("retired_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE INDEX "case_patterns_workspace_retired_at_idx" ON "case_patterns"("workspace_id", "retired_at");
