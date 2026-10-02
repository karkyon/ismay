# 実装状況台帳：認証（メール確認・パスワード再設定）

DOC-13（Traceability・実装状況台帳）への追補。

| 項目 | 値 |
|---|---|
| 更新 | 2026-10-02（AUTH-REFRESH-07・PROD-DEPLOY-01） |
| 基準HEAD | `cabd6a12ce14d9f3ddd966940ba4515d1b08380c`（AUTH-EMAIL-01適用後。2026-09-26 AUDIT-BASELINE-01でcommit hashを確定） |

## 1. Gate履歴
| Gate | commit | 内容 | 受入 | 状態 |
|---|---|---|---|---|
| AUTH-EMAIL-01 | `cabd6a1` | メールアドレス確認、確認メール再送、パスワード再設定、SMTP/ログ送信、`auth_email_tokens` | pure 70/70、実DB 77/77、Purge回帰（hardening_02 59、scope_03a 42、ops_03b 44、pattern_purge_01 31） | 完了 |
| SECURITY-RATE-02A | `8c0922f` | proxy信頼境界・client IP・永続rate limitの契約（[DEC-SECURITY-RATE-02](../decisions/DEC-SECURITY-RATE-02.md)） | — | 完了 |
| SECURITY-RATE-02B | `9b8e866` | client IP解決の一本化（custom serverでpeer取得、`TRUSTED_PROXY_CIDRS`）、Redis token bucket（login・MFA verify・email resend・password forgot）、縮退・fail closed、監査 | 環境A：pure 138/0、実Redis＋HTTP 67/0、回帰（auth_email_01 77/0、2_1_live 65/0、m1a EV-C-001〜004 PASS、m1a2 28/0）。環境BはSECURITY-RATE-02Cで実施 | 完了 |
| SECURITY-RATE-02C | `7ec4d7f`（Redisをloopback限定）、`2b00550`（M1-A/M1-A2受入cleanupの是正）、本台帳を更新したcommit（文書同期） | omega-dev2配備：`ismay-app.service`を`node server.mjs`＋`NODE_ENV=development`へ、`RATE_LIMIT_HMAC_KEY`設定、Redisを`127.0.0.1:16379`へ | 環境B（2026-09-27、`2b00550`）：品質Gate（tsc・lint・test:all・build）PASS、`backend=redis`・`peer=custom-server`、再起動をまたいだbucket継続、security_rate_02 64/0・SKIP 1（[H7]）、回帰（2_1_live 65/0、m1a 17/0、m1a2 30/0、auth_email_01 77/0、M1B1 17/0・M1B2 19/0（実AI）、Purge 59/42/44/31、closedloop 15/0）、テストユーザー残存0 | 完了 |
| SECURITY-RATE-02D | `c098c99` | Redis認証、HMAC key rotation（`RATE_LIMIT_HMAC_KEY_PREVIOUS`）、debug出力のemail仮名化、health | 環境A・B 18/0 | 完了 |
| AUTH-REFRESH-07 | `0b475ef` | 回転済みRefresh Tokenの再利用検知（失効hash表・比較更新・猶予10秒・系列失効・監査`AUTH_REFRESH_REUSE_DETECTED`）、[DEC-AUTH-REFRESH-07](../decisions/DEC-AUTH-REFRESH-07.md) | pure 20/0、環境A・B 25/0、security_rate_02 [H8]（409） | 完了（猶予時間は承認待ち） |
| PROD-DEPLOY-01 | `e6b050d`・`4356ab6` | HTTPS（Caddy内部CA）・Secure Cookie・信頼proxy`::1`・production起動 | 環境B 22/0（2026-10-02、run `20261002-175652-9b2d7d`）、回帰15本全PASS | 完了 |

## 2. 要求→実装→検証
| 要求 | 実装 | 検証 |
|---|---|---|
| 公開前は検証メールが必須（FR-AUTH-01） | `register`は未確認で作成、`login`/`mfa/verify`は未確認を拒否 | `emailTokenCore.test.ts`（配線）、実DB [A4] |
| token・期限（AUTH-RESET） | `auth_email_tokens`（hashのみ）、確認24時間・再設定60分、1回限り | [A1][A4][A5][A7] |
| rate limit（AUTH-RESET） | 60秒間隔、1時間5回、IP単位1時間20件、`users`行lockで直列化 | [A2][A3][A8][A10]、pure境界値 |
| 新リンクで旧リンク無効（利用者決定） | 発行時に未消費tokenをsuperseded | [A2] |
| mail provider（AUTH-RESET） | `lib/mail/`（smtp=nodemailer / log） | pure（設定検証）、sandboxでSMTP受信サーバーへの送信を確認 |
| 監査（AUTH-RESET） | `audit_logs`の4 action | [A1][A2][A4][A7][A9] |
| 検証済mailのみでpassword再発行（AUTH-RESET） | 再設定tokenは確認済みユーザーにだけ発行 | [A6] |
| 再設定後の全端末ログアウト | `revoked_reason=PASSWORD_RESET` | [A7] |
| アカウントPurgeで削除 | usersへのCASCADE FK（user scope） | [A12] |

## 3. 実装済みでないもの
[未決事項台帳](./未決事項台帳.md)のOPEN-AUTH-01〜07を参照。
