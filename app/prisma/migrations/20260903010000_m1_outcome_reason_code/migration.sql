-- M1-OUTCOME: Lifecycle Outcome Reason
-- 出典: 統合正本仕様書v5.0 §7.4「NOT_NEEDEDへ、単なる不要化と履行断念を
-- 混在させてはならない。状態とは別にLifecycle Outcome Reasonを記録する」、
-- §27.1「既存NOT_NEEDEDは放棄か不要かを推測せずUNKNOWN_LEGACY理由とする」。

ALTER TABLE "responsibilities" ADD COLUMN "outcome_reason_code" TEXT;

-- 既存のNOT_NEEDED行は放棄か不要かを推測せず、一律UNKNOWN_LEGACYとする。
UPDATE "responsibilities" SET "outcome_reason_code" = 'UNKNOWN_LEGACY' WHERE "status" = 'NOT_NEEDED';
