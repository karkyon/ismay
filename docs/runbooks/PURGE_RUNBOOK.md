# Purge運用Runbook（アカウント30日物理削除）

| 項目 | 値 |
|---|---|
| 対象 | `scripts/run_account_purge.ts`（唯一の実行経路。HTTPはfail closed） |
| 基準コード | `e7f4769`（PURGE-OPS-03B） |
| 関連 | [ADD-2026-09-25-PURGE](../spec-addenda/ADD-2026-09-25-PURGE.md)、[DEC-PURGE-02B](../decisions/DEC-PURGE-02B.md) |

## 1. 前提
- 実行者はサーバー上で`~/projects/ismay`を操作できる運用者。サーバーのshell権限が認可境界になる。
- `app/.env`の`DATABASE_URL`と`MINIO_*`（`MINIO_ENDPOINT` / `MINIO_PORT` / `MINIO_ACCESS_KEY` / `MINIO_SECRET_KEY` / `MINIO_BUCKET`）が有効であること。
- MinIOが停止している場合、実行してもobjectの不存在を確認できないため、DB削除へは進まない（itemはretry待ちになる）。

## 2. 通常手順
```bash
cd ~/projects/ismay/app

# 1) dry-run（何も削除しない）
npx tsx ../scripts/run_account_purge.ts --all

# 2) 実行（1名ずつが推奨）
npx tsx ../scripts/run_account_purge.ts --execute --email=user@example.com --operator=<名前>

# 3) 状況確認
npx tsx ../scripts/run_account_purge.ts --status=<runId>
```

dry-runで確認すること：
- 削除見込み（表・workspace・user）と更新見込み（循環遮断、匿名化、audit_logsの墨消し）
- Object Storageの削除見込み（DB参照件数・接頭辞一覧件数）。「確認できません」の場合はMinIOを確認する
- `[保持表]`が`PURGE_RETENTION_POLICY`の登録表（audit_logs・台帳3表）だけであること
- `[注意・PURGE-SCOPE-03A]`（scope列がNULLの旧行）の件数。これはどのユーザーのPurgeでも削除されない

## 3. exit codeと対処
| code | 意味 | 対処 |
|---:|---|---|
| 0 | 全item完了・監査記録済み | なし |
| 1 | 致命的エラー（引数・DB接続・未登録の非scope表など） | メッセージを確認する。「保持理由も登録されていない表」と出た場合は§5 |
| 2 | 完了していないitemがある | `--status`で状態を確認し、§4に従う |
| 4 | 監査記録が未完了のitemがある（削除自体は完了） | `--resume`で監査だけを再試行する |
| 6 | 2と4の両方 | 両方の対処を行う |

## 4. item状態ごとの対処
| status | phase | 意味 | 対処 |
|---|---|---|---|
| COMPLETED | COMPLETED | 完了 | なし |
| SKIPPED | NONE | 再検証で拒否（refusal_status参照） | NOT_DELETED＝復元済み、RETENTION_NOT_ELAPSED＝30日未満、SHARED_WORKSPACE＝他memberあり、EXTERNAL_REFERENCE＝他人の行が参照。いずれも**objectもDBも無変更**。原因を解消してから新しいrunで再実行する |
| RETRY_WAIT | OBJECTS_* | Object Storage段の失敗（MinIO停止・削除失敗・不存在を確認できない） | MinIOを確認し、`next_attempt_at`以降に`--resume=<runId>` |
| RETRY_WAIT | DB_PURGED | DBは削除済みで、監査記録が失敗 | `--resume`（DB段は再実行されず、監査のみ行われる） |
| RETRY_WAIT | — | LOCK_CONFLICT（users行が他で使用中） | 時間をおいて`--resume` |
| IN_PROGRESS | 任意 | 処理中、または異常終了 | leaseの期限（`lease_expires_at`、既定15分）を過ぎれば`--resume`で再取得される |
| DEAD_LETTER | 任意 | 試行上限に到達 | `last_error`を確認し、原因を解消してから新しいrunで再実行する（phaseが`DB_PURGED`以降であれば、DBは削除済み） |

## 5. 「保持理由も登録されていない表」で停止した場合
新しいtableがworkspace/userへFKで到達せず、`PURGE_RETENTION_POLICY`にも登録されていない。次のどちらかを行ってから再実行する。
1. その表に`workspace_id`（`workspaces`へのFK）を追加し、書込み箇所で設定する（推奨。PURGE-SCOPE-03Aと同じ方式）。
2. 個人データを持たない、または保持が正当化される場合は、保持理由を`app/src/lib/admin/purgeGraph.ts`の`PURGE_RETENTION_POLICY`へ登録し、Decision Recordに記録する。

## 6. 手動確認用SQL
```sql
-- run一覧
SELECT id, status, item_count, created_at, finished_at FROM purge_runs ORDER BY created_at DESC LIMIT 20;
-- 未完了item
SELECT id, user_id, status, phase, attempts, max_attempts, next_attempt_at, last_error
FROM purge_items WHERE status NOT IN ('COMPLETED') ORDER BY created_at;
-- itemのobject台帳（完了後はobject_keyがNULL）
SELECT source, status, count(*) FROM purge_item_objects WHERE item_id = '<itemId>' GROUP BY 1, 2;
-- scope列がNULLの旧行
SELECT 'event_logs', count(*) FROM event_logs WHERE workspace_id IS NULL
UNION ALL SELECT 'outbox_events', count(*) FROM outbox_events WHERE workspace_id IS NULL
UNION ALL SELECT 'jobs', count(*) FROM jobs WHERE workspace_id IS NULL
UNION ALL SELECT 'consents', count(*) FROM consents WHERE workspace_id IS NULL
UNION ALL SELECT 'ai_runs', count(*) FROM ai_runs WHERE workspace_id IS NULL;
```

## 7. 禁止事項
- `purge_items` / `purge_item_objects`を手でUPDATEして、phaseを進めたり戻したりしない（DB段の再実行や、object削除の飛ばしにつながる）。
- HTTPのPurge経路を再開しない（Platform Admin契約が正本で確定するまで）。
- MinIOのobjectを手で先に消してからDBを消す、という逆順の作業をしない（DEC-PURGE-02B §7.1）。
