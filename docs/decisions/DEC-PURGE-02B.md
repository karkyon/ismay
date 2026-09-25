# DEC-PURGE-02B 30日Purgeで「FKにより到達できないデータ」の保持・匿名化・削除契約

| 項目 | 値 |
|---|---|
| 状態 | **PROPOSED（決定待ち）**。この記録はコード上の削除方式を決めない |
| 作成 | 2026-09-25（Gate PURGE-CONTRACT-02B） |
| 基準コード | `f2299da` + PURGE hardening 02（SCOPE-02F / ELIGIBILITY-02C / AUDIT-02D / REPORT-02E） |
| 関連 | `app/src/lib/admin/purgeJob.ts`、`purgeGraph.ts`、`scripts/run_account_purge.ts` |

## 1. 背景

30日Purge（`purgeJob.ts`）は、削除対象の表を**外部キー（FK）グラフで`workspaces`/`users`へ到達できるか**で機械的に決める（列名の推測はしない、fix03以降の確定方針）。そのため、FKを持たない表や行為者参照しか持たない表は「対象外（保持）」になる。

しかし「FKが無い」ことは「個人データが無い」ことを意味しない。hardening 02では、これらの表をdry-runと実行結果の`retainedUnscopedTables`に**保持表として明示**するところまでを実装した。削除・匿名化・保持の方式はここで決める。

## 2. 正本の根拠（現時点で確定している要求）

- DOC-09 §1：「監査証跡自体は最小限の法的・安全目的で保持し、**内容データを残さない**」。
- DOC-09 §4：保持期間はdata category別のpolicy tableで設定し、legal holdを除いて期限Jobで削除する（policy tableは未実装）。
- DOC-09 §5：削除は`REQUESTED→DISCOVERED→PROPAGATING→RECOMPUTING→COMPLETED/FAILED`で伝播させる。Embedding、cache、search index、AI batch result、backup expiryも台帳に載せる。
- DOC-09 §9（受入条件）：「deletion graphの全nodeが**完了または明示retain reasonを持つ**」。
- 統合正本 §19.3：削除モードの語彙は`EXCLUDED_FROM_USE / REDACTED / ANONYMIZED / CRYPTOGRAPHICALLY_ERASED / PHYSICALLY_DELETED / LEGALLY_RETAINED`（`lib/pem/coreTypes.ts` `EVIDENCE_DELETION_MODES`と同じ）。
- 統合正本 §21.1：「本文・PIIを監査logへ複製しない」。
- DOC-10 CHG-080：「Evidence/Audit/Job/Outboxへworkspace/subject/request情報を追加」（**未実装**。現状はFKでscopeできない原因）。
- 全機能仕様一覧 PRV-PURGE：「Purge Job、deletion ledger、MinIO lifecycle、backup例外説明を予定」。

**正本に無いもの**：上記の表ごとの保持期間、法定保持の要否、匿名化と物理削除のどちらを採るか。したがって、この記録は選択肢と推奨を示すにとどめ、決定は利用者（プロダクトオーナー）が行う。

## 3. 対象と実データの確認結果（実コード・実DBで確認済み）

| 表 | 個人データになり得る列 | 実際の書込み例（ファイル） | hardening 02後の挙動 |
|---|---|---|---|
| `consents` | `subject_id`（=userId）、`scope`（JSON） | `api/v1/captures/[id]/consent/route.ts`：`subjectId: auth.user.userId`、`scope: {participantsNotified, retentionDays}` | 保持（未変更）。`captures.consent_id`はSET NULLのため、Capture削除後は孤立行になる |
| `event_logs` | `aggregate_id`、`before_json`/`after_json`、`actor_id`（=userId）、`reason` | `api/v1/responsibilities/[id]/route.ts`：`beforeJson/afterJson`にResponsibilityの**title・description本文** | 保持（未変更）。**本文が残るためDOC-09 §1に抵触する状態** |
| `outbox_events` | `aggregate_id`、`payload` | `api/v1/captures/route.ts`：`payload: {captureId, workspaceId, domainId, sourceType}` | 保持（未変更） |
| `jobs` | `aggregate_id`、`payload`、`last_error` | `lib/worker/relay.ts`：`payload: {captureId}`。`last_error`はworker例外の文言 | 保持（未変更） |
| `audit_logs` | `actor_user_id`（FKだがNULL可能）、`target_id`（=userIdの文字列）、`ip_address`、`reason` | `api/v1/auth/account/delete/route.ts`：本人をactorとする`ACCOUNT_DELETE_REQUESTED` | **行は保持し、`actor_user_id`だけをNULL化**（匿名化件数として別計上）。`target_id`・`ip_address`は残る |
| `ai_runs`のうち`capture_id`がNULLの行 | `workspace_id`（FKなし）、tokens、cost、`error_code` | `lib/ai/pemOnboarding.ts`：`workspaceId`のみ設定（captureなし） | 保持（`capture_id`がある行はhardening 02で削除される） |
| Object Storage（MinIO） | `captures.audio_object_key`/`image_object_key`、`capture_images.object_key`が指す音声・画像の実体 | Capture音声・画像のアップロード | **DB行は削除されるが、オブジェクト本体は残る**（キーを失った孤立オブジェクトになる） |
| 個別エンティティの30日Purge | `responsibilities.deleted_at`等（アカウント削除ではない単体のsoft delete） | `api/v1/responsibilities/[id]/route.ts` DELETE | **未実装**（アカウント単位のPurgeとは別の機能） |

## 4. 表ごとの選択肢と推奨

各表の記号は次の3案を指す：A＝物理削除（PHYSICALLY_DELETED）、B＝匿名化・墨消し（ANONYMIZED/REDACTED）、C＝法定保持（LEGALLY_RETAINED、期限つき）。

### 4.1 `event_logs`
- A：Purge対象の全行（snapshotで確定したPK集合）の`aggregate_id`に一致する行を、同じtransaction内で削除する。プライバシー影響：最小。監査影響：業務イベント履歴が消える（監査証跡は`audit_logs`側に残る）。
- B：行は残し、`before_json`/`after_json`/`reason`をNULL、`actor_id`をNULLにする。プライバシー影響：本文は消えるが、時刻・種別・aggregate_idは残る。監査影響：件数・時系列を保てる。
- C：policy tableで期限を定め、期限Jobで削除する。
- **推奨：A**。DOC-09 §1は「内容データを残さない」としており、event_logsは監査証跡ではなく業務イベントログである。実装は、snapshotのtemp tableが持つPK集合と`aggregate_id`を突き合わせればよく、列名の推測は不要。

### 4.2 `outbox_events`
- A：`aggregate_id`がPurge対象PK集合に一致する行を削除する（`PENDING`も含む。削除済み集約のイベントは配信すべきでないため）。
- B：`payload`を空にして残す。
- **推奨：A**。

### 4.3 `jobs`
- A：`aggregate_id`がPurge対象PK集合に一致する行を削除する（`RUNNING`中のjobは、workerの取得処理との競合を避けるため、Purgeの行ロック内で削除する）。
- B：`payload`/`last_error`をNULLにして残す。
- **推奨：A**。あわせて`last_error`へ本文を書かないwrite-time規約も必要（統合正本 §21.1）。

### 4.4 `consents`
- A：`subject_id`=userId、または削除されたCaptureが参照していた行を削除する。
- C：同意の証跡として、期限つきで`purpose/granted_at/withdrawn_at/expires_at`だけを残し、`scope`（JSON）を削除する。`subject_id`は残す場合も仮名化する。
- **推奨：法定保持の要否を利用者が決めること**。要件が無ければA、あればC。

### 4.5 `audit_logs`
- 現行（hardening 02で明示化）：行は保持し、`actor_user_id`をNULL化する。
- B（推奨案）：行は保持（DOC-09 §1の「最小限保持」）し、Purge時に本人が関係する行（`target_id`=userId、またはactorが本人）の`ip_address`をNULL化する。`reason`は本文を含まない既存規約を維持する。保持期間はpolicy tableで定める。
- A：本人関係の行を削除する。§1の「監査証跡自体は保持」と衝突する。
- **推奨：B**。運用ledgerの強い永続保証（Purge対象外の独立した台帳やoutbox）が必要かどうかは、PURGE-OPS-03のPurgeRun/PurgeItem台帳と合わせて決める。

### 4.6 `ai_runs`（`capture_id`がNULLの行）
- A1：`ai_runs.workspace_id`へFK（NULL可能）を追加するmigrationを入れ、FKグラフで自然にscopeへ入るようにする（DOC-10 CHG-080の方針に沿い、列名推測に頼らない）。
- A2：`workspace_id`の列名一致で削除する（列名推測になるため非推奨）。
- **推奨：A1**。

### 4.7 Object Storage（MinIO）
- 推奨：Purge transactionの中で、snapshotから削除対象のobject keyを収集し、**commit後**にobject削除要求をretryつきのoutbox（またはPurgeItem台帳）で実行する。DB削除とobject削除は原子的にできないため、失敗しても再試行できる台帳化が必要（PRV-PURGE、PURGE-OPS-03と統合）。

### 4.8 個別エンティティのsoft deleteの30日Purge
- `responsibilities/[id]` DELETEのコメント「30日後にPurge Job」は、**アカウントPurgeとは別の未実装機能**である。対象表と削除伝播（DOC-09 §5）の範囲を別Gateで定義する。

## 5. 決定が必要な質問（利用者向け）

1. `consents`に法定保持の要件はあるか（あれば期間）。
2. `audit_logs`の保持期間と、`target_id`（userIdのUUID）を仮名のまま残してよいか。
3. `event_logs`/`outbox_events`/`jobs`は推奨A（Purge対象PK集合に一致する行を物理削除）でよいか。
4. `ai_runs.workspace_id`へFKを追加してよいか（推奨A1）。
5. Object Storage削除をPURGE-OPS-03の台帳（PurgeRun/PurgeItem）へ含めてよいか。

## 6. 決定までの運用

- CLIは保持表をdry-run・実行時に警告として表示する。「完全削除」という表現は使わない（確認文字列も「物理削除」に変更した）。
- 決定後、この記録を`ACCEPTED`へ更新し、実装Gate（仮称PURGE-CONTRACT-IMPL-02G）で実装と実DB受入（E2E-02の項目8）を行う。
