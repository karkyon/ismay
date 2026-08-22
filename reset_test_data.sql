-- ISMAY テストデータ全削除SQL(2026-08-21)
-- 削除順序はschema.prismaの外部キー参照方向に基づく(子→親の順)。
-- 保持するもの: users/user_sessions/user_totp_secrets(ログイン維持)、
-- workspaces/workspace_members/domains(ワークスペース自体)、
-- ai_provider_configs/ai_provider_credentials(AIプロバイダー設定・APIキー)、
-- tags(タグ定義自体は残す。中間テーブルresponsibility_tagsのみ消える)、
-- audit_logs(監査ログ)。

BEGIN;

DELETE FROM ai_inferences;
DELETE FROM ai_runs;
DELETE FROM responsibility_relations;
DELETE FROM responsibility_tags;
DELETE FROM responsibility_embeddings;
DELETE FROM task_details;
DELETE FROM commitment_details;
DELETE FROM decision_details;
DELETE FROM waiting_details;
DELETE FROM constraints;
DELETE FROM recurrence_rules;
DELETE FROM pem_evidence_links;
DELETE FROM evidences;
DELETE FROM responsibilities;
DELETE FROM captures;
DELETE FROM consents;
DELETE FROM event_logs;
DELETE FROM outbox_events;
DELETE FROM jobs;

COMMIT;
