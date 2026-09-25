# 正本改訂 ADD-2026-09-26-AUTH-EMAIL：メールアドレス確認・パスワード再設定

| 項目 | 値 |
|---|---|
| 状態 | 有効（正本v5.0への追補。矛盾する場合は本追補を優先） |
| 作成 | 2026-09-26（Gate AUTH-EMAIL-01） |
| 基準コード | `8a85e191af8605dd018ff85597935e89da4041c0`（DOC-SYNC-04）に本Gateを適用 |
| 出典 | 全機能仕様一覧 FR-AUTH-01「公開前は検証メールが必須」、AUTH-RESET「検証済mailのみ利用し安全にpassword再発行。token、期限、rate limit、mail provider、監査」 |
| 運用手順 | [MAIL_RUNBOOK](../runbooks/MAIL_RUNBOOK.md) |

## 1. 決定事項

### 1.1 利用者決定（2026-09-26）
| 項目 | 決定 |
|---|---|
| 送信方式 | SMTP＋nodemailer。送信処理は差し替え可能にする。開発環境では実送信せずサーバーログへ出力する |
| 未確認ユーザー | ログイン不可。既存ユーザーは確認済みとして扱う |
| 確認リンク | 有効期限24時間、1回限り |
| 再送 | 60秒間隔、かつ1時間に5回まで。新しいリンクを発行すると旧リンクは無効 |
| パスワード再設定 | 本Gateで実装する |

### 1.2 実装上の既定値（利用者の個別指定なし）
値は`app/src/lib/auth/emailTokenCore.ts`の定数1箇所にまとめてある。

| 項目 | 値 | 理由 |
|---|---|---|
| 再設定リンクの有効期限 | 60分 | 奪取された場合の被害が確認リンクより大きいため短くする |
| 再設定メールの再送 | 確認メールと同じ（60秒間隔、1時間に5回まで） | 規則を1つにする |
| IP単位の発行上限 | 同一IPから1時間20件 | 1ユーザー単位の上限を、多数のアドレスへの一斉送信で迂回されないようにする |
| 古いtoken行の削除 | 発行時に、そのユーザーの7日より古い行を削除 | 上限判定に必要な期間（1時間）より十分長く、不要な行を残さない |

## 2. 統合正本v5.0への追補

### 2.1 認証フロー
```
登録 ─→ users.email_verified_at = NULL で作成 ─→ 確認メール(24時間・1回限り)
         │
ログイン ─→ パスワード一致かつ未確認 → 403 ACCESS_DENIED (reason=EMAIL_NOT_VERIFIED)
         │                              └→ 画面から確認メールを再送
確認リンク ─→ /verify-email?token=… ─(ボタン押下)→ POST /auth/email/verify → 確認完了
パスワード再設定 ─→ /forgot-password → メール(60分・1回限り) → /reset-password?token=…
                  → POST /auth/password/reset → パスワード変更・全セッション失効
```

### 2.2 不変条件
- tokenは32byteの乱数（base64url 43文字）。DBにはSHA-256のみ保存し、平文はメール本文にだけ含める。監査ログとdebugログにも平文を書かない。
- 発行と消費は`users`行の`FOR UPDATE`で直列化する（同時再送で上限を超えない。同じtokenを同時に使っても成功は1回だけ）。
- 消費は「未消費・supersedeされていない・期限内」の条件付きUPDATEが1件だった場合だけ成功する。期限はちょうど`expires_at`の時点で失効する。
- 新しいtokenを発行すると、同じユーザー・同じ用途の未消費tokenは`superseded_at`を設定して無効にする。
- 消費時に`users.email`と発行時の`sent_to_email`が一致しなければ無効とする（将来のメールアドレス変更への備え）。
- 確認メールはメール未確認の未削除ユーザーへだけ、再設定メールはメール確認済みの未削除ユーザーへだけ発行する（AUTH-RESET「検証済mailのみ利用」）。
- 再送・再設定要求の応答は、登録の有無・確認済みか否か・上限に達したかどうかを区別しない（メールアドレスの列挙対策）。送信は応答後（Next.js `after()`）に行う。
- メール内リンクは設定`APP_BASE_URL`から組み立て、リクエストのHostヘッダは使わない（Hostヘッダを偽装して他ドメインのリンクを送らせる攻撃への対策）。
- 確認は画面を開いただけでは完了せず、ボタン押下のPOSTで完了する（メールのリンクの先読みでtokenを消費させない）。tokenを含む画面は`Referrer-Policy: no-referrer`とする。
- パスワード再設定の成功時は全セッションを失効させる（`revoked_reason=PASSWORD_RESET`）。パスワードポリシー違反ではtokenを消費しない。TOTP（MFA）の設定は変更しない。

## 3. DOC-10 DB物理設計書への追補

### 3.1 新規table `auth_email_tokens`
| 列 | 型 | 説明 |
|---|---|---|
| `id` | text PK | |
| `user_id` | text NOT NULL | `users`へのFK（ON DELETE CASCADE） |
| `purpose` | text NOT NULL | `EMAIL_VERIFICATION` / `PASSWORD_RESET`（CHECK） |
| `token_hash` | text NOT NULL UNIQUE | tokenのSHA-256（hex） |
| `sent_to_email` | text NOT NULL | 発行時点の送信先 |
| `request_ip` | text | 発行要求元IP（IP単位の上限に使用） |
| `expires_at` | timestamp(3) NOT NULL | |
| `consumed_at` | timestamp(3) | 使用済み |
| `superseded_at` | timestamp(3) | 新しいtokenの発行で無効化 |
| `created_at` | timestamp(3) NOT NULL | アプリ側で明示的に設定（DBのtimezone設定に依存しない） |

index：`(user_id, purpose, created_at)`、`(request_ip, created_at)`。

### 3.2 アカウントPurgeとの関係
`users`へのNOT NULL FKを持つため、アカウントPurgeのFKグラフで**user scopeの削除対象**になる（`PURGE_RETENTION_POLICY`への登録は不要）。受入：`verify_gate_auth_email_01.ts` [A12]。

### 3.3 Migration
| Migration | 内容 | Rollback |
|---|---|---|
| `20260926010000_auth_email_01` | `auth_email_tokens`の作成。`email_verified_at`がNULLの既存ユーザーを`created_at`で確認済みにする | 表を削除（確認済みにした既存ユーザーは戻さない。旧実装は登録時に即時確認済みにしていたため、戻す必要がない） |

## 4. DOC-11 API・Event仕様書への追補

| API | 認証 | 入力 | 応答 |
|---|---|---|---|
| `POST /api/v1/auth/register`（変更） | 不要 | 変更なし | `201 {user, verificationRequired: true}`。確認メールを応答後に送る |
| `POST /api/v1/auth/login`（変更） | 不要 | 変更なし | パスワードが一致し、かつメール未確認なら`403 ACCESS_DENIED`、`error.reason = "EMAIL_NOT_VERIFIED"` |
| `POST /api/v1/auth/mfa/verify`（変更） | 不要 | 変更なし | 同上（多重防御） |
| `POST /api/v1/auth/email/resend` | 不要 | `{email}` | 常に`200 {accepted: true, message}` |
| `POST /api/v1/auth/email/verify` | 不要 | `{token}` | `200 {verified, alreadyVerified}` / `400 VALIDATION_FAILED`、`error.reason`は`NOT_FOUND` / `USED` / `EXPIRED` / `SUPERSEDED` / `EMAIL_CHANGED` / `USER_INACTIVE` / `LOCK_CONFLICT` |
| `POST /api/v1/auth/password/forgot` | 不要 | `{email}` | 常に`200 {accepted: true, message}` |
| `POST /api/v1/auth/password/reset` | 不要 | `{token, newPassword}` | `200 {reset: true}`（認証Cookieを削除）/ `400 VALIDATION_FAILED`（ポリシー違反は`fieldErrors.newPassword`、それ以外は`error.reason`） |

エラーコードは既存の`ACCESS_DENIED` / `VALIDATION_FAILED`を使い、新しいコードは追加していない（DOC-02 §8に該当するコードが無いため、詳細は`error.reason`で返す）。

### 4.1 監査ログ（`audit_logs`）
| action | actor | result | reason |
|---|---|---|---|
| `EMAIL_VERIFICATION_SENT` | SYSTEM | SUCCESS / FAILURE | `transport=…` / `SEND_FAILED: …` / `MAIL_CONFIG_ERROR: …`、および`tokenId` |
| `PASSWORD_RESET_REQUESTED` | SYSTEM | SUCCESS / FAILURE | 同上 |
| `EMAIL_VERIFIED` | USER（成功）/ SYSTEM（失敗） | SUCCESS / FAILURE | `tokenId`、失敗理由 |
| `PASSWORD_RESET_COMPLETED` | USER（成功）/ SYSTEM（失敗） | SUCCESS / FAILURE | `tokenId`、`revokedSessions`、失敗理由 |

いずれも`target_type=User`、`target_id=userId`、`ip_address`は要求元IP（アカウントPurgeで墨消しされる）。存在しないアドレスへの要求は対象ユーザーが無いため記録しない。

## 5. 画面
| 画面 | 内容 |
|---|---|
| `/register` | 登録後は確認メールの案内と再送ボタンを表示（ログイン画面へは遷移しない） |
| `/login` | メール未確認で拒否された場合に再送ボタンを表示。「パスワードをお忘れの方」「アカウント登録」への導線 |
| `/verify-email?token=` | ボタン押下で確認を完了。完了後はURLからtokenを消す |
| `/forgot-password` | 再設定メールの要求 |
| `/reset-password?token=` | 新しいパスワード（確認入力つき）の設定 |

再送ボタンは押した後60秒間押せない（サーバー側の再送間隔と同じ）。

## 6. DOC-12 EVAL・受入テストへの追補
| 受入script / test | 件数 | 主な検証 |
|---|---:|---|
| `app/src/lib/auth/__tests__/emailTokenCore.test.ts` | 70 | 期限・再送間隔・上限の境界値、token形式・hash、リンク・本文、送信設定の検証、旧実装の即時確認が残っていないこと |
| `scripts/verify_gate_auth_email_01.ts` | 77 | [A1]〜[A13]：発行・送信・hashのみ保存、再送間隔と旧リンク無効、1時間5回、1回限り、24時間の期限、発行対象、パスワード再設定と全セッション失効、同時実行、送信失敗、IP上限、削除済みユーザー、アカウントPurge、DB制約 |

HTTP経由でregister→loginする既存の受入script 5本（`verify_gate_2_1_live`、`verify_gate_m1a_acceptance`、`verify_gate_m1b1_shadow_acceptance`、`verify_gate_m1b2_dual_read_acceptance`、`verify_project_context_m1a2_live`）は、登録直後に`scripts/lib/testEmailVerification.ts`でテストユーザー（`@example.invalid`のみ）を確認済みにしてからloginするよう変更した。

## 7. 未決事項
[未決事項台帳](../status/未決事項台帳.md)のOPEN-AUTH-01〜05を参照。
