-- R1-02: FormationAtomicityOverrideへclientEventId/requestHash idempotency契約を追加
-- 出典: Claude向け ISMAY 69b5a87以降 監査是正・M1-B6完遂・PEM-0連続実装指示 (2026-08-31) R1-02。
--
-- 本ファイルはPrisma engineが本サンドボックスで取得不能なため手動で作成した。
-- expand → backfill → NOT NULL の順で行い、既存行(あれば)を破壊しない。

-- 1) expand: まずNULL許容で追加する。
ALTER TABLE "formation_atomicity_overrides" ADD COLUMN "client_event_id" TEXT;
ALTER TABLE "formation_atomicity_overrides" ADD COLUMN "request_hash" TEXT;

-- 2) backfill: 既存行(移行前に作られたoverride)には、当時clientEventIdが
--    存在しなかったため、行のidから決定論的に導出した一意な値を補う。
--    「不明を分類済みと混同しない」DEC-STATE-001/R1-05と同じ精神で、
--    正規の新規clientEventIdと衝突しない`legacy-override-`prefixを用いる。
UPDATE "formation_atomicity_overrides"
SET
  "client_event_id" = 'legacy-override-' || "id",
  "request_hash" = 'legacy-override-' || "id"
WHERE "client_event_id" IS NULL;

-- 3) switch/contract: NOT NULL化し、idempotency keyのunique indexを追加する。
ALTER TABLE "formation_atomicity_overrides" ALTER COLUMN "client_event_id" SET NOT NULL;
ALTER TABLE "formation_atomicity_overrides" ALTER COLUMN "request_hash" SET NOT NULL;

CREATE UNIQUE INDEX "formation_atomicity_overrides_workspace_client_uq" ON "formation_atomicity_overrides"("workspace_id", "client_event_id");
