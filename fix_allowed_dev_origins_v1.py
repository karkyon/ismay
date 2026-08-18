#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
ISMAY next.config.ts 修正パッチ（一度きり実行・プロジェクトルート直下）
====================================================================
Next.js 16の開発サーバーはlocalhost以外のオリジンからの /_next/* アセット・
HMR接続へのクロスオリジンリクエストをデフォルトで403ブロックする。
LAN IP(192.168.1.11)経由でアクセスするとJSチャンクが読み込めずハイドレーションが
失敗し、フォームがネイティブ送信(ページ全体リロード)にフォールバックしてしまう。
next.config.ts に allowedDevOrigins を追加して解消する。

実行方法:
    cd ~/projects/ismay
    python3 fix_allowed_dev_origins_v1.py
"""
import subprocess
import sys
import os

REPO_ROOT = os.path.dirname(os.path.abspath(__file__))
APP_DIR = os.path.join(REPO_ROOT, "app")
CONFIG_PATH = os.path.join(APP_DIR, "next.config.ts")
SERVICE_NAME = "ismay-app.service"

NEW_CONFIG = """import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Next.js 16はデフォルトでlocalhost以外のオリジンからの/_next/*リクエストを
  // クロスオリジンとしてブロックする。LAN IP経由での開発アクセスを許可する。
  allowedDevOrigins: ["192.168.1.11", "localhost", "127.0.0.1"],
};

export default nextConfig;
"""


def run(cmd, cwd=None):
    print("\n$ " + " ".join(cmd))
    result = subprocess.run(cmd, cwd=cwd)
    return result.returncode


def fail(message):
    print("\n[FAIL] " + message)
    sys.exit(1)


def main():
    if not os.path.isfile(CONFIG_PATH):
        fail("next.config.ts が見つかりません: " + CONFIG_PATH)

    print("[1/4] next.config.ts を書き換え")
    with open(CONFIG_PATH, "w", encoding="utf-8") as f:
        f.write(NEW_CONFIG)

    print("[2/4] npx tsc --noEmit (コンパイルエラー0件ゲート)")
    if run(["npx", "tsc", "--noEmit"], cwd=APP_DIR) != 0:
        fail("TypeScriptコンパイルエラーが検出されました。")

    print("[3/4] サービスを再起動して設定を反映")
    if run(["sudo", "systemctl", "restart", SERVICE_NAME]) != 0:
        fail("サービス再起動に失敗しました。")
    run(["sleep", "3"])
    result = subprocess.run(["systemctl", "is-active", SERVICE_NAME], capture_output=True, text=True)
    if result.stdout.strip() != "active":
        run(["sudo", "journalctl", "-u", SERVICE_NAME, "--no-pager", "-n", "40"])
        fail(SERVICE_NAME + " が active になりませんでした。")
    print("  -> " + SERVICE_NAME + " は active です")

    print("[4/4] GitHubへpush")
    run(["git", "add", "-A"], cwd=REPO_ROOT)
    code = run(["git", "commit", "-m", "fix(config): LAN IPアクセス時のクロスオリジンブロックを解消(allowedDevOrigins追加)"], cwd=REPO_ROOT)
    if code != 0:
        print("[WARN] コミットする変更がありません。")
        sys.exit(0)
    if run(["git", "push", "origin", "main"], cwd=REPO_ROOT) != 0:
        fail("git pushに失敗しました。手動で `git push origin main` を実行してください。")

    print("\n完了しました。ブラウザのキャッシュをクリア(またはハードリロード Ctrl+Shift+R)してから再度お試しください。")
    os.remove(os.path.abspath(__file__))


if __name__ == "__main__":
    main()
