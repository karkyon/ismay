# メール送信Runbook（確認メール・パスワード再設定）

| 項目 | 値 |
|---|---|
| 対象 | `app/src/lib/mail/`（送信）、`app/src/lib/auth/emailToken.ts`（発行・消費） |
| 関連 | [ADD-2026-09-26-AUTH-EMAIL](../spec-addenda/ADD-2026-09-26-AUTH-EMAIL.md) |

## 1. 送信方式の切替（`app/.env`）

### 1.1 開発（既定）：ログ出力
`MAIL_TRANSPORT`を設定しない、または`MAIL_TRANSPORT=log`にする。メールは送信されず、本文（確認リンクを含む）がサーバーの標準出力に出る。

```bash
journalctl -u ismay-app.service -n 200 --no-pager | grep -A20 "ISMAY MAIL:log"
```

`APP_BASE_URL`が未設定の場合、リンクは`http://localhost:13000`を基点にする。LAN内の別端末から開く場合は、`APP_BASE_URL=http://192.168.1.11:13000`のように設定する。

**ログ出力はリンクがログに残るため、一般公開の環境では使わないこと。**

### 1.2 本番：SMTP
```dotenv
MAIL_TRANSPORT=smtp
APP_BASE_URL=https://ismay.example.com
MAIL_FROM="ISMAY <no-reply@example.com>"
SMTP_HOST=smtp.example.com
SMTP_PORT=587
# SMTP_SECURE=true   # 465番ポート(SMTPS)を使う場合。未設定時は465のときだけtrue
SMTP_USER=...
SMTP_PASS=...
```

| 変数 | 必須 | 内容 |
|---|---|---|
| `APP_BASE_URL` | smtp時は必須 | メール内リンクの基点。リクエストのHostヘッダは使わない |
| `MAIL_FROM` | smtp時は必須 | 差出人 |
| `SMTP_HOST` | smtp時は必須 | |
| `SMTP_PORT` | 任意 | 既定587（STARTTLS） |
| `SMTP_SECURE` | 任意 | `true` / `false` |
| `SMTP_USER` / `SMTP_PASS` | 任意 | 両方設定するか、両方未設定にする |

設定を変えたら`sudo systemctl restart ismay-app.service`で再起動する。設定に誤りがある場合、送信は行われず、`audit_logs`に`MAIL_CONFIG_ERROR`として記録され、サーバーログに`[ISMAY MAIL] 設定エラー`が出る。

## 2. 確認
```sql
-- 直近の送信結果
SELECT occurred_at, action, result, reason FROM audit_logs
WHERE action IN ('EMAIL_VERIFICATION_SENT','PASSWORD_RESET_REQUESTED','EMAIL_VERIFIED','PASSWORD_RESET_COMPLETED')
ORDER BY occurred_at DESC LIMIT 20;
-- 特定ユーザーのtoken状態(token本体はhashのみ)
SELECT purpose, created_at, expires_at, consumed_at, superseded_at FROM auth_email_tokens
WHERE user_id = '<userId>' ORDER BY created_at DESC;
```

## 3. よくある問い合わせ
| 症状 | 確認・対処 |
|---|---|
| 確認メールが届かない | `audit_logs`の`EMAIL_VERIFICATION_SENT`を確認。FAILUREなら`reason`（SMTP設定・接続）を確認する。SUCCESSなら迷惑メールフォルダを確認してもらう |
| 再送しても届かない | 60秒以内の再送、または1時間に5回を超えた再送は、画面上は受け付けたように見えても発行されない（アドレスの列挙対策）。時間をおいて再送してもらう |
| リンクが無効と表示される | 画面の文言で理由が分かる（使用済み・期限切れ・新しいメールで無効化）。最新のメールのリンクを使うか、再送する |
| パスワード再設定メールが届かない | 再設定メールはメール確認済みのユーザーにだけ送る。未確認ならログイン画面から確認メールを再送してもらう |

## 4. 運用者による手動確認（緊急時のみ）
メールが届かない環境で、運用者が本人確認を別途行ったうえで確認済みにする場合：
```sql
UPDATE users SET email_verified_at = now() AT TIME ZONE 'UTC' WHERE email = '<address>' AND email_verified_at IS NULL;
```
実施した場合は日時・理由・実施者を記録すること（この操作はアプリの監査ログに残らない）。
