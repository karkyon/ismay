#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
reset_test_data.py

ISMAY テストデータ全削除(2026-08-21、カルキョンさんの指示による一回限りの操作)。

[削除対象]
captures / responsibilities とそれらに紐づく全データ(AI推論・実行ログ・関係・
タグ付け・埋め込み・種別固有詳細・証跡・同意・イベントログ・Outbox・Job)。

[保持するもの]
- users / user_sessions / user_totp_secrets(ログイン状態を維持するため)
- workspaces / workspace_members / domains(ワークスペース自体)
- ai_provider_configs / ai_provider_credentials(AIプロバイダー設定・登録済みAPIキー)
- tags(タグの定義自体。中間テーブルresponsibility_tagsのみ消えるため、
  次に責任を作る際に同じタグを再利用できる)
- audit_logs(監査ログ)

削除順序はschema.prismaの外部キー参照方向を実際に確認したうえで、
子テーブル→親テーブルの順に組んでいる(推測ではない)。

このスクリプトは`app`ディレクトリの`npx prisma db execute`を使ってSQLを実行する
(DATABASE_URLの解決を既存のprisma.config.tsに任せるため、直接psqlへ接続文字列を
渡す方式より安全)。

使い方:
    cd ~/projects/ismay
    python3 reset_test_data.py
    (確認プロンプトで "DELETE" と入力すると実行されます)
"""
import subprocess
import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent
APP_DIR = REPO_ROOT / "app"
SQL_FILE = REPO_ROOT / "reset_test_data.sql"


def main() -> int:
    if not SQL_FILE.exists():
        print(f"エラー: {SQL_FILE} が見つかりません。同じディレクトリに配置してください。")
        return 1
    if not APP_DIR.exists():
        print(f"エラー: {APP_DIR} が見つかりません。リポジトリのルートで実行してください。")
        return 1

    print("=" * 60)
    print("ISMAY テストデータ全削除")
    print("=" * 60)
    print("削除対象: captures, responsibilities とそれに紐づく全データ")
    print("保持対象: ユーザー・ワークスペース・AIプロバイダー設定・タグ定義")
    print()
    print(SQL_FILE.read_text())
    print()
    answer = input('本当に削除しますか？ 元に戻せません。よろしければ "DELETE" と入力してください: ')
    if answer.strip() != "DELETE":
        print("キャンセルしました。何も削除していません。")
        return 0

    print("削除を実行します...")
    result = subprocess.run(
        ["npx", "prisma", "db", "execute", "--file", str(SQL_FILE)],
        cwd=APP_DIR,
        capture_output=True,
        text=True,
    )
    if result.stdout:
        print(result.stdout)
    if result.stderr:
        print(result.stderr, file=sys.stderr)
    if result.returncode != 0:
        print("エラー: 削除に失敗しました。上記のエラー内容を確認してください。")
        print("(BEGIN/COMMITでトランザクション化しているため、失敗時は何も変更されていません)")
        return 1

    print("完了: テストデータを削除しました。")
    print("次にInboxで新しいメモを保存すると、クリーンな状態から動作確認できます。")
    print("このスクリプト自身とreset_test_data.sqlは、確認後に手動で削除してください")
    print("(一度きりの操作用のため、リポジトリへのコミット対象にはしていません)。")
    return 0


if __name__ == "__main__":
    sys.exit(main())
