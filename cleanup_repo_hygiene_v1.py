#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
cleanup_repo_hygiene_v1.py

目的：
  apply_ismay_captures_v1.py実行時に発覚した事故の後始末。
  - cleanup()をgit push後に呼んでいたため、以下が誤ってコミットされていた：
      app/prisma/schema.prisma.bak_20260818_135259
      app/src/lib/auth/response.ts.bak_20260818_135259
      apply_ismay_captures_v1.py
  - さらに調査の結果、前回セッションの事故で残った
      app/prisma/schema.prisma.bak_20260817
    も未除去のまま残っていることが判明した。
  - ルート.gitignoreに *.bak_* パターンが実際には存在していなかった
    （前回ハンドオフ資料「再発防止した」との記載と実態が不一致）。

本スクリプトが行うこと：
  1) 上記4ファイルをリポジトリから削除(git rm)
  2) ルート.gitignoreに *.bak_* パターンを追記（今後の再発防止・恒久対策）
  3) prisma validate / tsc --noEmit で問題ないことを確認（コード内容は変更していないが念のため）
  4) 全て成功した場合のみ commit / push
  5) 成功後、スクリプト自身を削除

実行方法（サーバー側 ~/projects/ismay で）：
  python3 cleanup_repo_hygiene_v1.py
"""

import subprocess
import sys
from pathlib import Path

BASE_DIR = Path.cwd()
APP_DIR = BASE_DIR / "app"
GITIGNORE_PATH = BASE_DIR / ".gitignore"

FILES_TO_REMOVE = [
    BASE_DIR / "app" / "prisma" / "schema.prisma.bak_20260818_135259",
    BASE_DIR / "app" / "prisma" / "schema.prisma.bak_20260817",
    BASE_DIR / "app" / "src" / "lib" / "auth" / "response.ts.bak_20260818_135259",
    BASE_DIR / "apply_ismay_captures_v1.py",
]

GITIGNORE_APPEND = """
# 一度きりのパッチスクリプトが作るバックアップファイル(再発防止。2026-08-18事故対応)
*.bak_*
"""


def fail(step: str, detail: str = "") -> None:
    print(f"\n[FAIL] {step}")
    if detail:
        print(detail)
    print("pushは実行していません。GitHub上のコードは変更されていません。")
    sys.exit(1)


def run(cmd: list[str], cwd: Path, step: str, allow_fail: bool = False) -> str:
    print(f"\n[RUN] ({cwd}) $ {' '.join(cmd)}")
    result = subprocess.run(cmd, cwd=str(cwd), capture_output=True, text=True)
    print(result.stdout[-3000:])
    if result.returncode != 0:
        print(result.stderr[-3000:])
        if not allow_fail:
            fail(step, result.stderr[-3000:] or result.stdout[-3000:])
    return result.stdout


def check_preconditions() -> None:
    print("=== 事前チェック ===")
    if not GITIGNORE_PATH.exists():
        fail("事前チェック", f".gitignoreが見つかりません: {GITIGNORE_PATH}\n"
                              "リポジトリルート(~/projects/ismay)で実行してください。")
    gitignore_text = GITIGNORE_PATH.read_text(encoding="utf-8")
    if "*.bak_*" in gitignore_text:
        fail("事前チェック", ".gitignoreに既に*.bak_*が存在します。二重適用を避けるため中断します。"
                              "（誤コミットファイルが残っている場合は手動確認してください）")
    print("[OK] 事前チェック完了。")


def remove_tracked_files() -> None:
    print("\n=== 誤コミットファイルの除去 ===")
    any_removed = False
    for f in FILES_TO_REMOVE:
        rel = f.relative_to(BASE_DIR)
        # git管理下に無いファイルを誤って指定した場合はエラーにせずスキップ
        check = subprocess.run(
            ["git", "ls-files", "--error-unmatch", str(rel)],
            cwd=str(BASE_DIR), capture_output=True, text=True,
        )
        if check.returncode != 0:
            print(f"[SKIP] {rel} はgit管理下に存在しません(既に無い/対象外)")
            continue
        run(["git", "rm", "-f", "--quiet", str(rel)], BASE_DIR, f"git rm {rel}")
        print(f"[REMOVE] {rel}")
        any_removed = True

    if not any_removed:
        fail("誤コミットファイルの除去", "削除対象のファイルが1つもgit管理下に見つかりませんでした。"
                                          "リポジトリの状態が想定と異なる可能性があるため中断します。")


def patch_gitignore() -> None:
    print("\n=== .gitignore 恒久修正 ===")
    text = GITIGNORE_PATH.read_text(encoding="utf-8")
    GITIGNORE_PATH.write_text(text.rstrip("\n") + "\n" + GITIGNORE_APPEND.strip("\n") + "\n", encoding="utf-8")
    print(f"[PATCH] {GITIGNORE_PATH} : *.bak_* パターンを追記")


def verify() -> None:
    print("\n=== 検証 ===")
    run(["npx", "prisma", "validate"], APP_DIR, "prisma validate")
    run(["npx", "tsc", "--noEmit"], APP_DIR, "tsc --noEmit")
    print("\n[OK] 検証成功。GitHubへpushします。")


def ship() -> None:
    run(["git", "add", "-A"], BASE_DIR, "git add")
    run(
        [
            "git", "commit", "-m",
            (
                "chore: 誤コミットされたバックアップファイル・パッチスクリプトを除去\n\n"
                "apply_ismay_captures_v1.py実行時、cleanup()をgit push後に呼んでいたため\n"
                "schema.prisma.bak_*、response.ts.bak_*、apply_ismay_captures_v1.py自体が\n"
                "誤ってコミットされていた事故の後始末。\n"
                "併せて前回セッションの残骸(schema.prisma.bak_20260817)も除去。\n"
                "ルート.gitignoreに*.bak_*パターンを追加し、今後の一度きりパッチスクリプトの\n"
                "後始末漏れに対する恒久的なセーフティネットとする。"
            ),
        ],
        BASE_DIR, "git commit",
    )
    run(["git", "push"], BASE_DIR, "git push")
    print("\n[OK] GitHubへpush完了しました。")


def cleanup_self() -> None:
    print("\n=== 後始末 ===")
    self_path = Path(__file__).resolve()
    print(f"[CLEANUP] {self_path} を削除")
    self_path.unlink()


def main() -> None:
    check_preconditions()
    remove_tracked_files()
    patch_gitignore()
    verify()
    ship()
    cleanup_self()
    print("\n=== 完了 ===")
    print("リポジトリの衛生状態を修正しました。今後のパッチスクリプトでは、")
    print("cleanup()をgit push“前”に呼ぶよう設計を修正済みです(次回パッチから適用)。")


if __name__ == "__main__":
    main()
