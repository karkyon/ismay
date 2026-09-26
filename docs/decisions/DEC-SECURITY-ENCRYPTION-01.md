# DEC-SECURITY-ENCRYPTION-01：機微データ暗号化の契約（TBD-17）

| 項目 | 値 |
|---|---|
| 状態 | **PROPOSED**（利用者承認前。schema変更・backfill・暗号化対象の拡張は行わない） |
| 作成 | 2026-09-26（Gate SECURITY-ENCRYPTION-01A、調査・契約のみ） |
| 基準コード | `cabd6a12ce14d9f3ddd966940ba4515d1b08380c`＋AUDIT-BASELINE-01 |
| 未決事項台帳 | OPEN-SECURITY-ENCRYPTION-01（DECISION_REQUIRED） |
| 関連 | README「TBD-17」、DOC-09 §7（credentialのkey rotation・revocation・audit追加）、DEC-PURGE-02B、ADD-2026-09-26-AUTH-EMAIL |

## 1. 現状（実コードで確認した事実）

### 1.1 暗号化しているもの
| 対象 | 列 | 実装 | 鍵（環境変数） |
|---|---|---|---|
| TOTP秘密鍵 | `user_totp_secrets.secret_encrypted` | `lib/auth/totp.ts` `encryptTotpSecret` / `decryptTotpSecret` | `MFA_ENCRYPTION_KEY`（base64・32byte） |
| TOTP登録中の秘密鍵 | 登録用JWTのclaim `secretEnc`（DBには保存しない） | 同上で暗号化してから`signEnrollmentToken`へ渡す | 同上 |
| AI provider APIキー | `ai_provider_credentials.encrypted_api_key` | `lib/ai/credentialCrypto.ts` `encryptApiKey` / `decryptApiKey` | `AI_CREDENTIAL_ENCRYPTION_KEY`（base64・32byte） |

### 1.2 方式の実態
| 観点 | 実態 |
|---|---|
| 暗号 | AES-256-GCM、IV 12byte（`randomBytes(12)`）、tag 16byte |
| 保存形式 | `base64(iv).base64(tag).base64(ciphertext)`（区切り`.`、version・key IDを持たない） |
| AAD（付加認証データ） | 使っていない。暗号文を別の行・列へ移しても復号できる |
| 用途分離 | 用途ごとに別の鍵（MFA用・AI credential用）。鍵導出（HKDF）はしていない |
| key version・rotation | 無い。鍵を変えると既存の暗号文はすべて復号できなくなる。再暗号化の仕組みも無い |
| 復号失敗時 | TOTP：例外（`mfa/verify`・`mfa/enroll/confirm`がエラーになり、ログインのMFA段が失敗する）。AI credential：`getDecryptedApiKey`がエラーをログに出し、**環境変数のAPIキーへ黙ってフォールバック**する |
| 鍵の保管 | `app/.env`（gitignore対象）。backupとの分離の取り決めは無い |
| 表示 | AI credentialは`last4`だけを返す。TOTP秘密鍵は登録時のQRコード以外で返さない |

### 1.3 hashで保存しているもの（暗号化ではない）
- Refresh Token（`user_sessions.refresh_token_hash`、SHA-256）
- 復旧コード（`user_totp_secrets.recovery_codes_hash`、SHA-256）
- メール確認・再設定token（`auth_email_tokens.token_hash`、SHA-256）
- パスワード（`users.password_hash`、Argon2id）

## 2. 問題
1. 暗号化しているのはcredential/secretの2種だけで、対象範囲の契約が無い（TBD-17が暫定のまま）。
2. key versionが無く、鍵のrotation・漏洩時の鍵交換ができない。
3. AADが無く、暗号文の行・列の入れ替えを検出できない。
4. AI credentialの復号失敗が、環境変数キーへの無音フォールバックになる（鍵の取り違えや改ざんを検知しにくい）。
5. DB dump・backupが漏洩した場合、secret以外の個人データ（Capture原文、Responsibility、PEM等）はすべて平文である。
6. backupと鍵の保管場所の分離が決まっていない（同じ場所に置くと暗号化の意味が無くなる）。

## 3. 対象データの棚卸しと分類
分類：**S**＝credential/secret、**I**＝direct identifier（直接識別子）、**C**＝sensitive content（本人の記述・推定）、**O**＝operational metadata、**A**＝audit/legal record。

| 領域 | 主な列（表） | 分類 | 現状 | 検索・索引での利用 |
|---|---|---|---|---|
| TOTP秘密鍵 | `user_totp_secrets.secret_encrypted` | S | 暗号化 | 無し |
| AI provider APIキー | `ai_provider_credentials.encrypted_api_key` | S | 暗号化（`last4`は平文） | 無し |
| パスワード・各種token | `users.password_hash`、`*_hash` | S | hash | 照合のみ |
| メールアドレス | `users.email`、`auth_email_tokens.sent_to_email` | I | 平文 | **ログイン時の完全一致照会**、一意制約 |
| 表示名 | `users.display_name` | I | 平文 | 無し |
| IP・user-agent | `user_sessions.ip_address` `user_agent`、`audit_logs.ip_address`、`auth_email_tokens.request_ip` | I/O | 平文（Purgeで墨消し・削除） | request_ipは発行上限の集計に使う |
| Capture原文・要約・文字起こし・OCR | `captures.raw_text` `ai_summary`、`ai_runs.transcript_segments` | C | 平文 | **キーワード検索（ILIKE部分一致）**、AIへの送信 |
| Responsibility | `responsibilities.title` `description`、`commitment_details.counterparty_name` `counterparty_contact` `promise_text`、`waiting_details.waiting_on`、`decision_details.*`、`task_details.location` | C（counterparty_contactはI） | 平文 | **キーワード検索（title・description・counterparty）**、一覧の表示 |
| Formation | `formation_candidate_revisions.title` `description` `proposed_fields`、`formation_answer_events.value_json`、`formation_questions.prompt_text`、`formation_source_anchors.*` | C | 平文 | 表示・照合 |
| AI推定 | `ai_inferences.payload` `evidence_spans` | C | 平文 | 表示 |
| PEM | `pem_observations.payload`、`pem_hypotheses.statement`、`pem_onboarding_conversations.messages`、`execution_reason_answers.free_text`、`pem_weekly_reviews.summary_json`、`bootstrap_assertions.statement` | C | 平文 | 表示・集計 |
| Project Context | `project_contexts.name` `description`、`external_context_references.canonical_url`、`project_context_snapshot_revisions.payload` | C | 平文 | 表示 |
| 外部連携credential | `integrations`（token列は無い。scopeのみ） | S（将来） | 未実装 | — |
| Case Pattern | `case_pattern_revisions.representative_text`、`case_pattern_suggestion_revisions.*` | C（派生） | 平文 | 照合はembedding |
| Embedding | `responsibility_embeddings`等の`vector(1536)` | C（派生） | 平文のvector | **pgvectorの類似度検索** |
| 通知 | `notifications.payload` | C | 平文 | 表示 |
| event/outbox/job | `event_logs.before_json` `after_json`、`outbox_events.payload`、`jobs.payload` `last_error` | C/O | 平文 | Worker処理 |
| 監査ログ | `audit_logs.reason` `ip_address` | A | 平文（本文は記録しない方針） | 管理画面の検索 |
| Purge台帳 | `purge_items.*_manifest`、`purge_item_objects.object_key` | A/O | 平文（object keyは完了後にhashのみ） | 運用CLI |
| MinIOの音声・画像 | bucket `ismay-audio` | C | サーバー側暗号化の設定は未確認（`putObject`はSSE指定なし） | — |
| アプリのログ | debugログ（本番は無効）、`console.error`、メールのlog transport | C/S | `redactSensitive`でtoken等のキー名を伏せる。log transportは確認リンクを出力する | — |
| export | `lib/dataExport.ts`（本人向けJSON/CSV） | C | 平文で本人へ渡す（本人の権利行使のため） | — |
| backup | DB dump・MinIO | 全分類 | 手順・暗号化・鍵分離が未決（DEC-006） | — |

## 4. 脅威モデルと選択肢の比較
| 脅威・観点 | 1. アプリ層AES-256-GCMを正式化（用途別鍵・versioned envelope） | 2. KMS envelope encryption | 3. PostgreSQL側暗号化（pgcrypto等） | 4. disk/volume暗号化のみ（比較対象） |
|---|---|---|---|---|
| DB dump・backup漏洩 | 対象列は保護される | 対象列は保護される | 鍵をSQLで渡すため、query log・`pg_stat_statements`に鍵が残る危険 | **保護されない**（dumpは平文） |
| アプリhost侵害 | 保護されない（鍵がプロセスにある） | 一部緩和（KMSの利用監査・失効が可能） | 保護されない | 保護されない |
| 運用者権限（DB直接参照） | 対象列は読めない | 対象列は読めない | 鍵を渡せば読める | 読める |
| 検索・並べ替え・索引 | 対象列はILIKE・索引不可（完全一致はblind indexで可能） | 同左 | 同左（復号関数を使うと全件走査） | 影響なし |
| rotation | key versionで段階的に再暗号化 | KEKのrotationはKMS側で容易、DEKは再wrap | 困難 | 鍵交換は運用 |
| 可用性 | 外部依存なし | KMS障害で復号不可（cacheが必要） | 外部依存なし | 影響なし |
| cost | 無し | KMSの利用料・ネットワーク | 無し | 無し |
| local開発 | `.env`の鍵で動く | KMS emulatorか開発用の代替鍵が必要 | 動く | 影響なし |
| backup/restore | 鍵を別保管すれば安全。鍵を失うと復元不能 | KMSの鍵が残る限り復元可能 | 同1 | 影響なし |
| Purge | 行ごと物理削除なので影響なし（crypto-shreddingも可能） | 同左 | 同左 | 影響なし |
| rollback | versionで旧形式を読めれば可能 | 同左 | 困難 | — |

## 5. 推奨案
**選択肢1（アプリ層AES-256-GCMの正式化）を採用し、鍵の供給元を差し替え可能にして、将来選択肢2（KMS）へ移れる形にする。** あわせて**選択肢4（volume暗号化）とbackupの暗号化・鍵の別保管を前提条件**とする（列暗号化だけではbackup・OS層の漏洩を防げないため）。

### 5.1 envelope形式（案）
```
v1.<keyId>.<base64url(iv 12byte)>.<base64url(tag 16byte)>.<base64url(ciphertext)>
```
- `keyId`：鍵の世代（例：`mfa-2026a`）。復号時はkeyring（鍵束）から世代を引く。
- AAD：`<purpose>|<table>.<column>|<rowId>`を付け、暗号文の行・列の入れ替えを検出する。
- 用途別鍵：MFA・AI credential（・将来のIntegration token）ごとに鍵を分ける。keyringは`ENCRYPTION_KEYRING_<PURPOSE>`（世代つきの鍵の一覧）と`ENCRYPTION_ACTIVE_KEY_<PURPOSE>`で与える。
- 旧形式（区切り3つ、prefixなし）は「v0」として読み取りだけを許す（dual-read）。

### 5.2 対象範囲（段階）
| 段階 | 対象 | 理由 |
|---|---|---|
| 必須（S） | TOTP秘密鍵、AI provider APIキー、将来のIntegration token | 漏洩時の被害が直接的で、検索に使わない |
| 検討（I） | メールアドレス（blind index併用）、`commitment_details.counterparty_contact` | ログイン照会があるため、HMAC-SHA256のblind index列が必要 |
| 保留（C） | Capture原文、Responsibility、Formation、PEM、Project Context等 | キーワード検索（ILIKE）・AI送信・embeddingと両立しない。列暗号化するとkeyword検索を失う。volume・backup暗号化とアクセス制御で先に守る |

## 6. 移行・backfill案（承認後）
1. envelope・keyringのライブラリとpure test（形式、AAD不一致の検出、未知version・未知keyIdでの失敗、v0の読み取り）。
2. dual-read：復号はv1とv0の両方を受け付ける。暗号化（書込み）は切替flagが有効になるまでv0のまま。
3. dual-write/cutover：flagを有効にし、新規書込みをv1へ。
4. backfill：対象行を1件ずつ`FOR UPDATE`で読み、v1へ再暗号化する。件数・失敗を記録し、再実行できるようにする。
5. v0の読み取りを止める（全件v1を確認してから）。

### 6.1 key rotation
新しい`keyId`を追加してactiveにする → 新規書込みは新鍵 → backfillと同じ手順で旧鍵の行を再暗号化 → 旧鍵の行が0件になったらkeyringから旧鍵を外す。

### 6.2 blind index（採用する場合）
`email_bidx = HMAC-SHA256(key_bidx, normalize(email))`。ログインと一意制約は`email_bidx`で行う。blind indexの鍵は暗号鍵と別にする。部分一致検索はできない。

### 6.3 失敗時の挙動・rollback
- 復号失敗（AAD不一致・未知keyId・tag不一致）は**fail closed**。AI credentialの環境変数への無音フォールバックは廃止し、明示的なエラーと監査記録にする（案。承認事項）。
- rollbackは、dual-read期間中であればflagを戻すだけで済む。backfill後にrollbackする場合もv1を読めるコードを残す。

### 6.4 性能
AES-GCMはsecret数件の暗号化・復号では無視できる。content列まで対象にした場合は、一覧取得のたびに復号が必要になり、検索が全件走査になる。

## 7. 未決質問（利用者の決定が必要）
1. 推奨案（選択肢1＋将来KMS）でよいか。KMSを最初から使うか。
2. 暗号化の対象範囲：S（secret）だけか、I（メールアドレス等）まで含めるか。
3. C（Capture原文・PEM等）を列暗号化しない代わりに、volume暗号化・backup暗号化・鍵の別保管を必須とすることでよいか。
4. AI credentialの復号失敗時、環境変数キーへのフォールバックを廃止してよいか。
5. 鍵・keyringの保管場所（`.env`・別ファイル・secret manager）と、backupとの分離方法。
6. rotationの周期（定期か、漏洩時のみか）。
7. MinIOのサーバー側暗号化（SSE）を有効にするか。
8. メールのlog transport（確認リンクをログへ出す）を本番で禁止する仕組み（起動時に拒否する等）を入れるか。

## 8. 実装Gate分割案（承認後）
| Gate | 内容 |
|---|---|
| SECURITY-ENCRYPTION-01B | envelope・keyringライブラリ、pure test（DBは変えない） |
| SECURITY-ENCRYPTION-01C | TOTP秘密鍵・AI credentialのdual-read、flagによるcutover、backfill CLI、実DB受入 |
| SECURITY-ENCRYPTION-01D | （Iを対象にする場合）blind index列・migration・ログイン照会の切替 |
| SECURITY-ENCRYPTION-01E | 運用：volume・backup暗号化、鍵の別保管、rotation手順のRunbook |
