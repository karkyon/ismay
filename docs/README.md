# docs

リポジトリで管理する設計文書。プロジェクトナレッジへアップロード済みの正本v5.0（統合正本、DOC-02〜13）は2026-08-27時点で固定している。それ以降の決定・改訂は、ここに追補として記録する（追補が正本と矛盾する場合は追補を優先する）。

| 種別 | 文書 | 内容 |
|---|---|---|
| 決定記録 | [decisions/DEC-PURGE-02B.md](decisions/DEC-PURGE-02B.md) | FKを持たない表の扱い、Object Storageの削除順序（ACCEPTED） |
| 正本追補 | [spec-addenda/ADD-2026-09-25-PURGE.md](spec-addenda/ADD-2026-09-25-PURGE.md) | アカウント30日Purge（統合正本・DOC-09/10/11/12/13への追補） |
| 正本追補 | [spec-addenda/ADD-2026-09-26-AUTH-EMAIL.md](spec-addenda/ADD-2026-09-26-AUTH-EMAIL.md) | メールアドレス確認・パスワード再設定（統合正本・DOC-10/11/12への追補） |
| 運用手順 | [runbooks/PURGE_RUNBOOK.md](runbooks/PURGE_RUNBOOK.md) | Purge CLIの実行・再開・障害対応 |
| 運用手順 | [runbooks/MAIL_RUNBOOK.md](runbooks/MAIL_RUNBOOK.md) | メール送信の設定（SMTP/ログ）・確認・問い合わせ対応 |
| 実装状況 | [status/実装状況台帳_PURGE.md](status/実装状況台帳_PURGE.md) | Gate・commit・受入結果 |
| 実装状況 | [status/実装状況台帳_AUTH.md](status/実装状況台帳_AUTH.md) | 認証（メール確認・パスワード再設定）のGate・受入結果 |
| 未決事項 | [status/未決事項台帳.md](status/未決事項台帳.md) | 推測で実装しない項目、未着手の項目 |
