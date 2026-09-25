# 実装状況台帳：認証（メール確認・パスワード再設定）

DOC-13（Traceability・実装状況台帳）への追補。

| 項目 | 値 |
|---|---|
| 更新 | 2026-09-26（AUTH-EMAIL-01） |
| 基準HEAD | `8a85e191af8605dd018ff85597935e89da4041c0`に本Gateを適用 |

## 1. Gate履歴
| Gate | commit | 内容 | 受入 | 状態 |
|---|---|---|---|---|
| AUTH-EMAIL-01 | 本commit | メールアドレス確認、確認メール再送、パスワード再設定、SMTP/ログ送信、`auth_email_tokens` | pure 70/70、実DB 77/77、Purge回帰（hardening_02 59、scope_03a 42、ops_03b 44、pattern_purge_01 31） | 完了 |

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
[未決事項台帳](./未決事項台帳.md)のOPEN-AUTH-01〜05を参照。
