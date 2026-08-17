#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
ISMAY 認証機能フォローアップ修正パッチ（一度きり実行・プロジェクトルート直下）
====================================================================
Prisma 7の"prisma-client"ジェネレータ(rust-free client)はドライバアダプタ必須のため、
`new PrismaClient()`のみでは "adapter is missing" コンパイルエラーになる。
本パッチは @prisma/adapter-pg を導入し、src/lib/db.ts をアダプタ対応版に差し替える。

実行方法:
    cd ~/projects/ismay
    python3 fix_prisma_adapter_v1.py
"""
import subprocess
import sys
import os
import base64

REPO_ROOT = os.path.dirname(os.path.abspath(__file__))
APP_DIR = os.path.join(REPO_ROOT, "app")
DB_TS_PATH = os.path.join(APP_DIR, "src", "lib", "db.ts")

DB_TS_B64 = "aW1wb3J0IHsgUHJpc21hQ2xpZW50IH0gZnJvbSAiQC9nZW5lcmF0ZWQvcHJpc21hL2NsaWVudCI7CmltcG9ydCB7IFByaXNtYVBnIH0gZnJvbSAiQHByaXNtYS9hZGFwdGVyLXBnIjsKCmRlY2xhcmUgZ2xvYmFsIHsKICAvLyBlc2xpbnQtZGlzYWJsZS1uZXh0LWxpbmUgbm8tdmFyCiAgdmFyIF9faXNtYXlQcmlzbWE6IFByaXNtYUNsaWVudCB8IHVuZGVmaW5lZDsKfQoKZnVuY3Rpb24gY3JlYXRlQ2xpZW50KCk6IFByaXNtYUNsaWVudCB7CiAgY29uc3QgY29ubmVjdGlvblN0cmluZyA9IHByb2Nlc3MuZW52LkRBVEFCQVNFX1VSTDsKICBpZiAoIWNvbm5lY3Rpb25TdHJpbmcpIHsKICAgIHRocm93IG5ldyBFcnJvcigiREFUQUJBU0VfVVJMIOOBjOacquioreWumuOBp+OBmSguZW5244KS56K66KqN44GX44Gm44GP44Gg44GV44GEKSIpOwogIH0KICBjb25zdCBhZGFwdGVyID0gbmV3IFByaXNtYVBnKHsgY29ubmVjdGlvblN0cmluZyB9KTsKICByZXR1cm4gbmV3IFByaXNtYUNsaWVudCh7CiAgICBhZGFwdGVyLAogICAgbG9nOiBwcm9jZXNzLmVudi5OT0RFX0VOViA9PT0gImRldmVsb3BtZW50IiA/IFsid2FybiIsICJlcnJvciJdIDogWyJlcnJvciJdLAogIH0pOwp9CgpleHBvcnQgY29uc3QgZGI6IFByaXNtYUNsaWVudCA9IGdsb2JhbFRoaXMuX19pc21heVByaXNtYSA/PyBjcmVhdGVDbGllbnQoKTsKCmlmIChwcm9jZXNzLmVudi5OT0RFX0VOViAhPT0gInByb2R1Y3Rpb24iKSB7CiAgZ2xvYmFsVGhpcy5fX2lzbWF5UHJpc21hID0gZGI7Cn0K"

NEW_DEPS = ["@prisma/adapter-pg", "pg"]
NEW_DEV_DEPS = ["@types/pg"]


def run(cmd, cwd):
    print("\n$ " + " ".join(cmd))
    result = subprocess.run(cmd, cwd=cwd)
    return result.returncode


def fail(message):
    print("\n[FAIL] " + message)
    print("       pushは行いません。")
    sys.exit(1)


def main():
    if not os.path.isfile(DB_TS_PATH):
        fail("db.ts が見つかりません: " + DB_TS_PATH)

    print("[1/4] npm install (@prisma/adapter-pg, pg)")
    if run(["npm", "install", "--save"] + NEW_DEPS, cwd=APP_DIR) != 0:
        fail("npm installでエラーが検出されました。")
    if run(["npm", "install", "--save-dev"] + NEW_DEV_DEPS, cwd=APP_DIR) != 0:
        fail("npm installでエラーが検出されました(開発用)。")

    print("[2/4] src/lib/db.ts をドライバアダプタ対応版に差し替え")
    with open(DB_TS_PATH, "wb") as f:
        f.write(base64.b64decode(DB_TS_B64))

    print("[3/4] npx prisma generate && npx tsc --noEmit")
    if run(["npx", "prisma", "generate"], cwd=APP_DIR) != 0:
        fail("prisma generateでエラーが検出されました。")
    if run(["npx", "tsc", "--noEmit"], cwd=APP_DIR) != 0:
        fail("TypeScriptコンパイルエラーが検出されました。")

    print("[4/4] コンパイルエラー0件を確認。GitHubへpushします。")
    run(["git", "add", "-A"], cwd=REPO_ROOT)
    commit_msg = "fix(auth): Prisma 7 rust-freeクライアントのドライバアダプタ(@prisma/adapter-pg)対応"
    if run(["git", "commit", "-m", commit_msg], cwd=REPO_ROOT) != 0:
        print("[WARN] コミットする変更がありません。")
        sys.exit(0)
    if run(["git", "push", "origin", "main"], cwd=REPO_ROOT) != 0:
        fail("git pushに失敗しました。手動で `git push origin main` を実行してください。")

    print("\n完了しました。")
    os.remove(os.path.abspath(__file__))


if __name__ == "__main__":
    main()
