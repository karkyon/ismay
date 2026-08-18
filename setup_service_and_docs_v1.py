#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
ISMAY 常時起動化(systemd) + README整備パッチ（一度きり実行・プロジェクトルート直下）
====================================================================
1. プロジェクトルートにREADME.mdを新規作成(技術仕様・起動手順・URL一覧を集約)
2. Next.jsアプリをsystemdサービス(ismay-app.service)として登録し、
   サーバー再起動・クラッシュ時も自動復帰するようにする(Restart=always)
3. 動作確認後、README.mdをGitHubへpush

sudo権限が必要な操作（systemdユニット配置・有効化）を含むため、
実行中にsudoパスワードの入力を求められる場合があります。

実行方法:
    cd ~/projects/ismay
    python3 setup_service_and_docs_v1.py
"""
import subprocess
import sys
import os
import base64
import getpass

REPO_ROOT = os.path.dirname(os.path.abspath(__file__))
APP_DIR = os.path.join(REPO_ROOT, "app")
README_PATH = os.path.join(REPO_ROOT, "README.md")
SERVICE_NAME = "ismay-app.service"
SERVICE_TMP_PATH = "/tmp/" + SERVICE_NAME
SERVICE_DEST_PATH = "/etc/systemd/system/" + SERVICE_NAME
PORT = "13000"

README_B64 = "IyBJU01BWQoK6ZuR44Gq5Lya6Kmx44O744Oh44Oi44O76Z+z5aOw44GL44KJ44CM44G+44Gg44K/44K544Kv5YyW44GV44KM44Gm44GE44Gq44GE57SE5p2f44O76LKs5Lu744O75Yik5pat44O75b6F44Gh44O75Yi257SE44O744Oq44K544Kv44CN44KS55m66KaL44GX44CBCuacrOS6uuWbuuacieOBruWun+ihjOePvuWun++8iFBlcnNvbmFsIEV4ZWN1dGlvbiBNb2RlbO+8j1BFTe+8ieOBq+WQiOOCj+OBm+OBpuaVtOeQhuODu+ioiOeUu+ODu+mAsuaNl+euoeeQhuOBmeOCi0FJ5YCL5Lq65Y+C6KyA44Ki44OX44Oq44CCCgojIyDkuK3moLjmgJ3mg7PvvIg05Y6f5YmH77yJCgoxLiDnrqHnkIblirTlipvjgpLliofnmoTjgavmuJvjgonjgZkKMi4g44G+44Gg44K/44K544Kv44Gr44Gq44Gj44Gm44GE44Gq44GE57SE5p2f44O76LKs5Lu744KS5omx44GGCjMuIOacrOS6uuWbuuacieOBruWun+ihjOePvuWun+OBq+WQiOOCj+OBm+OCiwo0LiDos6LjgYTjgYzjgIHli53miYvjgavjga/li5XjgYvjgarjgYQKCuioreioiOaWh+abuOS4gOW8j+OBruani+aIkOODu+iqreOBv+mghuOBryBgSVNNQVlf6ZaL55m66LOH5paZ5LiA5byPX1JFQURNRV92MV8xLm1kYO+8iOODl+ODreOCuOOCp+OCr+ODiOODiuODrOODg+OCuOWBtO+8ieOCkuWPgueFp+OAguacrFJFQURNReOBryoq5a6f6KOF44Oq44Od44K444OI44Oq5YG044Gu5oqA6KGT55qE44Gq54++54q2KirjgpLnpLrjgZnjgIIKCi0tLQoKIyMg5oqA6KGT44K544K/44OD44KvCgp8IOmgmOWfnyB8IOaKgOihkyB8CnwtLS18LS0tfAp8IOODleODreODs+ODiOOCqOODs+ODie+8j0FQSSB8IE5leHQuanMgMTbjgIFSZWFjdCAxOeOAgVR5cGVTY3JpcHTjgIFUYWlsd2luZCBDU1PjgIFSYWRpeCBVSSB8Cnwg44OQ44Oq44OH44O844K344On44OzIHwgWm9kIHY0IHwKfCBPUk0gfCBQcmlzbWEgNy45LjHvvIhgcHJpc21hLWNsaWVudGAg44K444Kn44ON44Os44O844K/44CBcnVzdC1mcmVl44Kv44Op44Kk44Ki44Oz44OI77yLYEBwcmlzbWEvYWRhcHRlci1wZ2DvvIkgfAp8IERCIHwgUG9zdGdyZVNRTCAxNyDvvIsgcGd2ZWN0b3LvvIhFbWJlZGRpbmfliJfvvIkgfAp8IOOCreODo+ODg+OCt+ODpe+8j+OCreODpeODvOWfuuebpCB8IFJlZGlzIDcgfAp8IOOCquODluOCuOOCp+OCr+ODiOOCueODiOODrOODvOOCuCB8IE1pbklP77yIUzPkupLmj5vvvIkgfAp8IOODqeODs+OCv+OCpOODoCB8IE5vZGUuanMgMjLvvIhudm3nrqHnkIbvvIkgfAp8IOOCpOODs+ODleODqSB8IERvY2tlciBDb21wb3Nl77yI44Ot44O844Kr44Or6ZaL55m65qmf77yJIHwKfCDoqo3oqLwgfCDoh6rliY3lrp/oo4Xjga5PSURD5rqW5oug44K744OD44K344On44Oz77yI44OR44K544Ov44O844OJ77yLVE9UUOWkmuimgee0oOOAgUZpcmViYXNl562J44Gu5aSW6YOoSWRQ6Z2e5L6d5a2Y77yJIHwKfCDjg5Hjgrnjg6/jg7zjg4njg4/jg4Pjgrfjg6UgfCBgaGFzaC13YXNtYO+8iEFyZ29uMmlk44CBV0FTTeWun+ijheODu+ODjeOCpOODhuOCo+ODluODk+ODq+ODieS4jeimge+8iSB8CnwgVE9UUCB8IGBvdHBsaWJg77yIR29vZ2xlIEF1dGhlbnRpY2F0b3LnrYnjga7oqo3oqLzjgqLjg5fjg6rjgajkupLmj5vvvIkgfAp8IEpXVCB8IGBqb3NlYCB8CgrplovnmbrmqZ/jga9VYnVudHUgMjYuMDQgTFRT44CCV2luZG93cyAxMSBQQ+OBi+OCiVZTQ29kZeOAjFJlbW90ZS1TU0jjgI3jgafmjqXntprjgZfjgIHjg6rjg6Ljg7zjg4jkuIrjgafnm7TmjqXnt6jpm4bjg7vlrp/ooYzjgZnjgovjgIIKCi0tLQoKIyMg44OH44Kj44Os44Kv44OI44Oq5qeL5oiQCgpgYGAKaXNtYXkvCuKUnOKUgOKUgCBkb2NrZXItY29tcG9zZS55bWwgICAgICAgICMgcG9zdGdyZXMocGd2ZWN0b3IpIC8gcmVkaXMgLyBtaW5pb+OAguOBmeOBueOBpiByZXN0YXJ0OiB1bmxlc3Mtc3RvcHBlZArilJzilIDilIAgZG9ja2VyLWRhdGEvICAgICAgICAgICAgICAgIyDlkITjgrPjg7Pjg4bjg4rjga7msLjntprljJbjg4fjg7zjgr/vvIhnaXRpZ25vcmXlr77osaHvvIkK4pSc4pSA4pSAIC5udm1yYyAgICAgICAgICAgICAgICAgICAgICMgTm9kZSAyMgrilJTilIDilIAgYXBwLyAgICAgICAgICAgICAgICAgICAgICAgICMgTmV4dC5qc+OCouODl+ODquacrOS9kwogICAg4pSc4pSA4pSAIHByaXNtYS8KICAgIOKUgiAgIOKUnOKUgOKUgCBzY2hlbWEucHJpc21hICAgICAgICMgVEJMLTAwMeOAnDAyNiDlhajlj43mmKAg77yLIOiqjeiovOaLoeW8tShVc2VyU2Vzc2lvbi9Vc2VyVG90cFNlY3JldCkg77yLIHBndmVjdG9yIEVtYmVkZGluZwogICAg4pSCICAg4pSU4pSA4pSAIG1pZ3JhdGlvbnMvCiAgICDilJzilIDilIAgcHJpc21hLmNvbmZpZy50cwogICAg4pSU4pSA4pSAIHNyYy8KICAgICAgICDilJzilIDilIAgbGliLwogICAgICAgIOKUgiAgIOKUnOKUgOKUgCBkYi50cyAgICAgICAgICAgICMgUHJpc21hIENsaWVudOOCt+ODs+OCsOODq+ODiOODsyhAcHJpc21hL2FkYXB0ZXItcGfkvb/nlKgpCiAgICAgICAg4pSCICAg4pSU4pSA4pSAIGF1dGgvICAgICAgICAgICAgIyDoqo3oqLzjg63jgrjjg4Pjgq/kuIDlvI8o5LiL6KiY5Y+C54WnKQogICAgICAgIOKUnOKUgOKUgCBhcHAvCiAgICAgICAg4pSCICAg4pSc4pSA4pSAIGFwaS92MS9hdXRoLyAgICAgIyDoqo3oqLxBUEko5LiL6KiY5Y+C54WnKQogICAgICAgIOKUgiAgIOKUnOKUgOKUgCByZWdpc3Rlci8gICAgICAgICMgVUk6IOaWsOimj+eZu+mMsijli5XkvZznorroqo3nlKgpCiAgICAgICAg4pSCICAg4pSc4pSA4pSAIGxvZ2luLyAgICAgICAgICAgICMgVUktMDE6IOOCteOCpOODs+OCpOODs+eUu+mdogogICAgICAgIOKUgiAgIOKUlOKUgOKUgCBkYXNoYm9hcmQvICAgICAgICAjIFVJOiDjg63jgrDjgqTjg7Plvozjga7li5XkvZznorroqo3nlLvpnaIoTUZB6Kit5a6a44O744K744OD44K344On44Oz5LiA6KanKQogICAgICAgIOKUlOKUgOKUgCBjb21wb25lbnRzL2F1dGgvICAgICAjIOS4iuiomOeUu+mdouOBruOCr+ODqeOCpOOCouODs+ODiOOCs+ODs+ODneODvOODjeODs+ODiApgYGAKCi0tLQoKIyMg44OH44O844K/44OZ44O844K577yIc2NoZW1hLnByaXNtYe+8iQoKRELoqK3oqIjmm7h2MS4x44GuVEJMLTAwMeOAnDAyNuOCkuWFqOWPjeaYoO+8iDI544Oi44OH44Or77yJ44CC5YiX5a6a576p44GM5q2j5byP6LOH5paZ44Gr5piO6KiY44GV44KM44Gm44GE44Gq44GE6YOo5YiG44GvCnNjaGVtYS5wcmlzbWHlhoXjgasgYFvmjqjoq5ZdYCDjgrPjg6Hjg7Pjg4jjgafmmI7npLrjgZfjgabjgYTjgovvvIjmrKHlm57jg6zjg5Pjg6Xjg7zlr77osaHvvInjgIIKCui/veWKoOOBp+S7peS4izLjg4bjg7zjg5bjg6vjgpLmlrDoqK3vvIhPSURD5rqW5oug6KqN6Ki844Gu5a6f6KOF44Gr5b+F6KaB44Gq44Gf44KB77yJ77yaCgp8IOODouODh+ODqyB8IOeUqOmAlCB8CnwtLS18LS0tfAp8IGBVc2VyU2Vzc2lvbmAgfCBGUi1BVVRILTA05a++5b+c44CC56uv5pyr44O744K744OD44K344On44Oz5Y2Y5L2N44GnUmVmcmVzaCBUb2tlbuOBruODj+ODg+OCt+ODpeOCkuS/neaMgeOBl+OAgeWAi+WIpeWkseWKue+8j+WFqOerr+acq+ODreOCsOOCouOCpuODiOOCkuWPr+iDveOBq+OBmeOCiyB8CnwgYFVzZXJUb3RwU2VjcmV0YCB8IEZSLUFVVEgtMDPlr77lv5zjgIJUT1RQ56eY5a+G6Y2177yIQUVTLTI1Ni1HQ03mmpflj7fljJbvvInjgajlvqnml6fjgrPjg7zjg4nvvIjjg4/jg4Pjgrfjg6XljJbvvInjgpLkv53mjIEgfAoKcGd2ZWN0b3LliJfvvIhgcmVzcG9uc2liaWxpdHlfZW1iZWRkaW5ncy5lbWJlZGRpbmdg77yJ44GvIGBVbnN1cHBvcnRlZCgidmVjdG9yKDE1MzYpIilgIOWuo+iogO+8iwpgcHJldmlld0ZlYXR1cmVzID0gWyJwb3N0Z3Jlc3FsRXh0ZW5zaW9ucyJdYCDjgafpgYvnlKjjgIJpdmZmbGF057Si5byV44Gv44OH44O844K/5oqV5YWl5b6M44Gr5L2c5oiQ5LqI5a6a77yI5L+d55WZ5Lit77yJ44CCCgotLS0KCiMjIOiqjeiovOapn+iDve+8iOWun+ijhea4iOOBv++8iQoKKirmlrnlvI/vvJpPSURD5rqW5oug44Gu6Ieq5YmN5a6f6KOFKirvvIhGaXJlYmFzZSBBdXRoZW50aWNhdGlvbuetieOBruWklumDqElkUOOBq+OBr+S+neWtmOOBl+OBquOBhO+8ieOAggpBY2Nlc3MgVG9rZW7jga/nn63lr7/lkb1KV1TjgIFSZWZyZXNoIFRva2Vu44Gv5LiN6YCP5piO44OI44O844Kv44Oz77yLRELjg4/jg4Pjgrfjg6Xkv53lrZjjgafjg63jg7zjg4bjg7zjgrfjg6fjg7PjgZnjgovjgIIKV2Vi5YG044GvU2VjdXJl44O7SHR0cE9ubHnjg7tTYW1lU2l0ZT1MYXjjga5Db29raWXpgYvnlKjjgajjgZfjgIHnirbmhYvlpInmm7Tns7vjg6rjgq/jgqjjgrnjg4jjga9Eb3VibGUgU3VibWl0IENvb2tpZeaWueW8j+OBrkNTUkbjg4jjg7zjgq/jg7Pjgafkv53orbfjgZnjgovjgIIKCiMjIyBBUEnjgqjjg7Pjg4njg53jgqTjg7Pjg4jvvIhgQVBJLUFVVEhg77yJCgp8IOODoeOCveODg+ODiSB8IOODkeOCuSB8IOWGheWuuSB8CnwtLS18LS0tfC0tLXwKfCBQT1NUIHwgYC9hcGkvdjEvYXV0aC9yZWdpc3RlcmAgfCDmlrDopo/nmbvpjLIoRlItQVVUSC0wMSkgfAp8IFBPU1QgfCBgL2FwaS92MS9hdXRoL2xvZ2luYCB8IOODreOCsOOCpOODsyhGUi1BVVRILTAyKeOAglRPVFDnmbvpjLLmuIjjgb/jgarjgolgbWZhUmVxdWlyZWQ6dHJ1ZWDjgajjg4Hjg6Pjg6zjg7Pjgrjjg4jjg7zjgq/jg7PjgpLov5TjgZkgfAp8IFBPU1QgfCBgL2FwaS92MS9hdXRoL21mYS9lbnJvbGxgIHwgVE9UUOWIneWbnueZu+mMsu+8muenmOWvhumNteODu1FS44Kz44O844OJ55m66KGMKOimgeODreOCsOOCpOODsykgfAp8IFBPU1QgfCBgL2FwaS92MS9hdXRoL21mYS9lbnJvbGwvY29uZmlybWAgfCBUT1RQ55m76Yyy56K65a6a77yaNuahgeOCs+ODvOODieaknOiovOKGkuacieWKueWMluODu+W+qeaXp+OCs+ODvOODieeZuuihjCB8CnwgUE9TVCB8IGAvYXBpL3YxL2F1dGgvbWZhL3ZlcmlmeWAgfCDjg63jgrDjgqTjg7PmmYLjga5UT1RQ77yP5b6p5pen44Kz44O844OJ5qSc6Ki8IHwKfCBQT1NUIHwgYC9hcGkvdjEvYXV0aC9yZWZyZXNoYCB8IFJlZnJlc2ggVG9rZW7jg63jg7zjg4bjg7zjgrfjg6fjg7Mo5YaN5Yip55So5qSc55+l44Gk44GNKSB8CnwgUE9TVCB8IGAvYXBpL3YxL2F1dGgvbG9nb3V0YCB8IOePvuOCu+ODg+OCt+ODp+ODs+OBruWkseWKuSB8CnwgR0VUIHwgYC9hcGkvdjEvYXV0aC9zZXNzaW9uc2AgfCBGUi1BVVRILTA0OiDmnInlirnjgrvjg4Pjgrfjg6fjg7PkuIDopqcgfAp8IERFTEVURSB8IGAvYXBpL3YxL2F1dGgvc2Vzc2lvbnMve2lkfWAgfCBGUi1BVVRILTA0OiDmjIflrprnq6/mnKvjga7lpLHlirkgfAp8IEdFVCB8IGAvYXBpL3YxL2F1dGgvbWVgIHwg44Ot44Kw44Kk44Oz5Lit44Om44O844K244O85oOF5aCx5Y+W5b6XIHwKCuODrOOCueODneODs+OCueW9ouW8j+OBr0FQSeioreioiOabuHYxLjHjga7lhbHpgJrlv5znrZTvvIhgeyBkYXRhLCBtZXRhIH1gIC8gYHsgZXJyb3I6IHsgY29kZSwgbWVzc2FnZSwgLi4uIH0gfWDvvInjgavmupbmi6DjgIIKCiMjIyDnlLvpnaIKCi0gYC9yZWdpc3RlcmAg4oCmIOWLleS9nOeiuuiqjeeUqOOBruaWsOimj+eZu+mMsuODleOCqeODvOODoAotIGAvbG9naW5gIOKApiBVSS0wMeebuOW9k+OBruOCteOCpOODs+OCpOODs+eUu+mdou+8iOODkeOCueODr+ODvOODieKGkuW/heimgeOBquOCiVRPVFDlhaXlipvjga4y5q616ZqO77yJCi0gYC9kYXNoYm9hcmRgIOKApiDjg63jgrDjgqTjg7Plvozjga7li5XkvZznorroqo3nlLvpnaLjgIJNRkHoqK3lrprvvIhRUuOCs+ODvOODieihqOekuuODu+W+qeaXp+OCs+ODvOODieeZuuihjO+8ieOBqOODreOCsOOCpOODs+S4reOCu+ODg+OCt+ODp+ODs+S4gOimp+ODu+WAi+WIpeWkseWKueODu+ODreOCsOOCouOCpuODiOOBjOOBp+OBjeOCiwoKIyMjIOaXouefpeOBruacquWujOS6huODu+aaq+WumuS6i+mghQoKfCDpoIXnm64gfCDnirbmhYsgfAp8LS0tfC0tLXwKfCDjg6Hjg7zjg6vjgqLjg4njg6zjgrnnorroqo3vvIhGUi1BVVRILTAx5pys5p2l6KaB5Lu277yJIHwgKirmnKrlrp/oo4UqKuOAgk5vdGlmaWNhdGlvbuWfuuebpChNT0QtMDgp44GM54Sh44GE44Gf44KB44CB55m76Yyy5pmC44Gr5pqr5a6a55qE44Gr6Ieq5YuV5qSc6Ki85riI44G/5omx44GE77yIYHJlZ2lzdGVyL3JvdXRlLnRzYOOBq2BUT0RPYOaYjuiomO+8iSB8Cnwg44Ot44Kw44Kk44Oz5aSx5pWX44Ot44OD44KvIHwg44K144O844OQ44O844Oh44Oi44Oq5YaF44Kr44Km44Oz44K/44Gr44KI44KL57Ch5piT5a6f6KOF44CC44OX44Ot44K744K55YaN6LW35YuV44Gn44Oq44K744OD44OI44GV44KM44KL44CC5rC457aa5YyW44O7SVDljZjkvY3jga7jg6zjg7zjg4jliLbpmZDjga/mnKrlrp/oo4UgfAp8IFRCRC0xN++8iOapn+W+ruODh+ODvOOCv+OBruOCq+ODqeODoOODrOODmeODq+aal+WPt+WMluaWueW8j++8iSB8IOacquaxuuS6i+mgheWPsOW4s+OBp+ato+W8j+axuuWumuW+heOBoeOAguePvueKtlRPVFDnp5jlr4bpjbXjga7jgb/jgqLjg5fjg6rlsaRBRVMtMjU2LUdDTeOBp+aal+WPt+WMlu+8iGBNRkFfRU5DUllQVElPTl9LRVlg5L2/55So77yJIHwKCi0tLQoKIyMg44K744OD44OI44Ki44OD44OX44O76LW35YuVCgojIyMg5YmN5o+QCgpgYGBiYXNoCiMg44Kk44Oz44OV44OpKFBvc3RncmVTUUwvUmVkaXMvTWluSU8p6LW35YuVCmNkIH4vcHJvamVjdHMvaXNtYXkKZG9ja2VyIGNvbXBvc2UgdXAgLWQKZG9ja2VyIGNvbXBvc2UgcHMgICAjIOWFqOOBpmhlYWx0aHnjgavjgarjgovjgb7jgaflvoXjgaQKYGBgCgojIyMg55Kw5aKD5aSJ5pWw77yIYGFwcC8uZW52YOOAgWdpdGlnbm9yZeWvvuixoe+8iQoKfCDlpInmlbAgfCDlhoXlrrkgfAp8LS0tfC0tLXwKfCBgREFUQUJBU0VfVVJMYCB8IGBwb3N0Z3Jlc3FsOi8vaXNtYXk6aXNtYXlfZGV2X3Bhc3N3b3JkQGxvY2FsaG9zdDoxNTQzMi9pc21heV9kZXZgIHwKfCBgQVVUSF9KV1RfU0VDUkVUYCB8IEFjY2Vzcy9NRkHjg4Hjg6Pjg6zjg7PjgrgvVE9UUOeZu+mMsuODiOODvOOCr+ODs+e9suWQjemNte+8iGJhc2U2NCwgNDhieXRl77yJ44CCYG9wZW5zc2wgcmFuZCAtYmFzZTY0IDQ4YCB8CnwgYE1GQV9FTkNSWVBUSU9OX0tFWWAgfCBUT1RQ56eY5a+G6Y215pqX5Y+35YyW55SoKGJhc2U2NCwgMzJieXRlKeOAgmBvcGVuc3NsIHJhbmQgLWJhc2U2NCAzMmAgfAoKIyMjIOmWi+eZuuOCteODvOODkOODvOi1t+WLle+8iOaJi+WLle+8iQoKYGBgYmFzaApjZCB+L3Byb2plY3RzL2lzbWF5L2FwcApucG0gcnVuIGRldiAgICMgbmV4dCBkZXYgLXAgMTMwMDAKYGBgCgojIyMg5bi45pmC6LW35YuV77yIc3lzdGVtZO+8iQoKYGlzbWF5LWFwcC5zZXJ2aWNlYCDjgajjgZfjgaZzeXN0ZW1k566h55CG5LiL44Gn5bi45pmC56i85YON44GV44Gb44KL77yI44K144O844OQ44O85YaN6LW35YuV44O744Kv44Op44OD44K344Ol5pmC44KC6Ieq5YuV5b6p5biw77yJ44CCCuOCu+ODg+ODiOOCouODg+ODl+aJi+mghuOBr+acrOODquODneOCuOODiOODqumBi+eUqOiAhe+8iGthcmt5b27vvInjga7jgrvjg4Pjg4jjgqLjg4Pjg5fjg63jgrDjgpLlj4LnhafjgILnqLzlg43norroqo3vvJoKCmBgYGJhc2gKc3VkbyBzeXN0ZW1jdGwgc3RhdHVzIGlzbWF5LWFwcC5zZXJ2aWNlCmBgYAoKIyMjIOOCouOCr+OCu+OCuVVSTAoKfCDnlKjpgJQgfCBVUkwgfAp8LS0tfC0tLXwKfCDjgqLjg5fjg6rmnKzkvZPvvIjmlrDopo/nmbvpjLLvvIkgfCBgaHR0cDovLzE5Mi4xNjguMS4xMToxMzAwMC9yZWdpc3RlcmAgfAp8IOODreOCsOOCpOODsyB8IGBodHRwOi8vMTkyLjE2OC4xLjExOjEzMDAwL2xvZ2luYCB8Cnwg44OA44OD44K344Ol44Oc44O844OJKE1GQeioreWumuODu+OCu+ODg+OCt+ODp+ODs+euoeeQhikgfCBgaHR0cDovLzE5Mi4xNjguMS4xMToxMzAwMC9kYXNoYm9hcmRgIHwKfCBQcmlzbWEgU3R1ZGlvKERC56K66KqN55So44CB5Yil6YCU6LW35YuV6KaBKSB8IGBodHRwOi8vMTkyLjE2OC4xLjExOjE1NTU1YO+8iGBucHggcHJpc21hIHN0dWRpbyAtLXBvcnQgMTU1NTVg77yJIHwKfCBNaW5JT+OCs+ODs+OCveODvOODqyB8IGBodHRwOi8vMTkyLjE2OC4xLjExOjE5MDAxYCB8CgrjgrXjg7zjg5Djg7zlpJbvvIjlkIzkuIBMQU7lpJbvvInjgYvjgonjgqLjgq/jgrvjgrnjgZnjgovloLTlkIjjga9WUE7mjqXntprjgIHjgb7jgZ/jga9TU0jjg53jg7zjg4jjg5Xjgqnjg6/jg7zjg4fjgqPjg7PjgrAK77yI5L6L77yaYHNzaCAtTCAxMzAwMDpsb2NhbGhvc3Q6MTMwMDAga2Fya3lvbkAxOTIuMTY4LjEuMTFg77yJ44KS5Yip55So44GZ44KL44CCCgotLS0KCiMjIOmWi+eZuuimj+e0hO+8iOOBk+OBruODquODneOCuOODiOODquWbuuacie+8iQoKLSAqKuODneODvOODiOimj+e0hCoq77ya5LuW44OX44Ot44K444Kn44Kv44OI44Go5ZCM5bGF44GZ44KL5YWx5pyJ44K144O844OQ44O844Gu44Gf44KB44CB5YWo44Od44O844OI44GvIGAxMDAwMCArIOWFg+OBruODneODvOODiOeVquWPt2Ag44Go44GZ44KLCiAg77yI5L6L77yaTmV4dC5qc+aomea6ljMwMDDihpIxMzAwMOOAgVBvc3RncmVTUUzmqJnmupY1NDMy4oaSMTU0MzLjgIFSZWRpc+aomea6ljYzNznihpIxNjM3Oe+8iQotICoq5ZG95ZCN6KaP57SEKirvvJpEb2NrZXLjg6rjgr3jg7zjgrnnrYnjga8gYGlzbWF5LWAg44OX44Os44OV44Kj44OD44Kv44K544Gn5ZCN5YmN56m66ZaT5YiG6Zui44GZ44KLCi0gKirjgrPjg7Pjg5HjgqTjg6vjgqjjg6njg7ww5Lu244Ky44O844OIKirvvJpgc2NoZW1hLnByaXNtYWDlpInmm7TjgoTmlrDmqZ/og73ov73liqDlvozjgIFgbnB4IHByaXNtYSBnZW5lcmF0ZSAmJiBucHggdHNjIC0tbm9FbWl0YOOBjAogIOOCqOODqeODvDDku7bjgavjgarjgovjgZPjgajjgpLnorroqo3jgZfjgabjgYvjgonjga7jgb9gZ2l0IHB1c2hg44GZ44KL77yI44Kk44Oz44OV44Op44O76YGL55So6Kit6KiI5pu4djEuMSA1LjHnr4Djga7jg57jg7zjgrjjgrLjg7zjg4jjgajlkIzkuIDmlrnph53jgpLjg63jg7zjgqvjg6vjgafjgoLlvrnlupXvvIkKLSAqKuOCueOCr+ODquODl+ODiOmFjee9rioq77ya57mw44KK6L+U44GX5L2/44GG5YaN5Yip55So44K544Kv44Oq44OX44OI44GvYHNjcmlwdHMvYOmFjeS4i+OAgURC44K544Kt44O844Oe5Y+N5pig44Gq44Gp5LiA5bqm44GN44KK44Gu44OR44OD44OB44K544Kv44Oq44OX44OI44GvCiAg44OX44Ot44K444Kn44Kv44OI44Or44O844OI55u05LiL44Gr572u44GN44CB6YGp55So5a6M5LqG5b6M44Gv6Ieq5YuV5YmK6Zmk44GZ44KL6YGL55So44Go44GZ44KLCgotLS0KCiMjIOacquaxuuS6i+mghe+8iFRCRO+8iQoK5q2j5pys44GvIGBJU01BWV/mnKrmsbrkuovpoIVf5aSJ5pu0566h55CG5Y+w5bizYCDvvIjjg5fjg63jgrjjgqfjgq/jg4jjg4rjg6zjg4PjgrjlgbTjgIHmnIDmlrDniYjjgpLlj4LnhafvvInjgILnibnjgavku6XkuIvjga9NMOmWi+Wni+WJjeOBq+WEquWFiOaxuuWumuOBmeOBueOBjemgheebru+8mgoKLSBUQkQtMDLvvJroqo3oqLzmlrnlvI8g4oaSICoq5pys44Oq44Od44K444OI44Oq44Gn44GvT0lEQ+a6luaLoOOBruiHquWJjeWun+ijheOBqOOBl+OBpuaxuuedgO+8iDIwMjYtMDgtMTjvvIkqKgotIFRCRC0wNe+8mkFJ5o+Q5L6b5LqL5qWt6ICFCi0gVEJELTA277ya5oSP5ZGz5qSc57Si5Z+655ukCi0gVEJELTE377ya5qmf5b6u44OH44O844K/44Gu44Kr44Op44Og44Os44OZ44Or5pqX5Y+35YyW5pa55byP77yIVE9UUOenmOWvhumNteOBr+aaq+WumueahOOBq+OCouODl+ODquWxpEFFUy0yNTYtR0NN77yJCgotLS0KCiMjIOWPgueFp+ioreioiOaWh+abuO+8iOato+acrOOAgeODl+ODreOCuOOCp+OCr+ODiOODiuODrOODg+OCuOWBtO+8iQoKLSBgSVNNQVlfV2Vi44K344K544OG44Og6KaB5Lu25a6a576p5pu4X3YyXzIubWRgCi0gYElTTUFZX+OCt+OCueODhuODoOWfuuacrOioreioiOabuF92MV8yLm1kYAotIGBJU01BWV9EQl/jg4fjg7zjgr/oqK3oqIjmm7hfdjFfMS5tZGAKLSBgSVNNQVlfQVBJX+OCpOODmeODs+ODiOioreioiOabuF92MV8xLm1kYAotIGBJU01BWV/jgqTjg7Pjg5Xjg6lf6YGL55So6Kit6KiI5pu4X3YxXzEubWRgCi0gYElTTUFZX0FJX1BFTeioreioiOabuF92MV8xLm1kYAotIGBJU01BWV/mqZ/og73liKXoqbPntLDoqK3oqIjmm7hfdjFfMS5tZGAKLSBgSVNNQVlf55S76Z2iVVjoqK3oqIjmm7hf44Ov44Kk44Ok44O844OV44Os44O844OgX3YyXzEuaHRtbGAKLSBgSVNNQVlf55So6KqeX+eKtuaFi1/jgrPjg7zjg4nlrprnvqnmm7hfdjFfMS5tZGAKLSBgSVNNQVlf44OG44K544OIX+WPl+WFpeS7leanmOabuF92MV8xLm1kYAotIGBJU01BWV/mqZ/og73opoHku7bjg4jjg6zjg7zjgrXjg5Pjg6rjg4bjgqPlj7DluLNfdjFfMS54bHN4YAo="


def run(cmd, cwd=None, capture=False):
    print("\n$ " + " ".join(cmd))
    if capture:
        result = subprocess.run(cmd, cwd=cwd, capture_output=True, text=True)
        if result.stdout:
            print(result.stdout, end="")
        if result.stderr:
            print(result.stderr, end="")
        return result.returncode, result.stdout.strip()
    result = subprocess.run(cmd, cwd=cwd)
    return result.returncode, ""


def fail(message):
    print("\n[FAIL] " + message)
    sys.exit(1)


def detect_node_bin():
    # nvm等でインストールされたnodeの絶対パスをログインシェル経由で解決する
    code, out = run(["bash", "-lc", "command -v node"], capture=True)
    if code != 0 or not out:
        fail("nodeの絶対パスを検出できませんでした。nvm環境が正しくロードされているか確認してください。")
    return out


def main():
    user = getpass.getuser()

    print("[1/5] README.md をプロジェクトルートへ書き込み")
    with open(README_PATH, "wb") as f:
        f.write(base64.b64decode(README_B64))

    print("[2/5] node実行パスを検出")
    node_bin = detect_node_bin()
    node_dir = os.path.dirname(node_bin)
    npx_bin = os.path.join(node_dir, "npx")
    print("  node: " + node_bin)
    print("  npx : " + npx_bin)

    unit_content = f'''[Unit]
Description=ISMAY Next.js Dev Server
After=network.target docker.service
Wants=docker.service

[Service]
Type=simple
User={user}
WorkingDirectory={APP_DIR}
Environment=PATH={node_dir}:/usr/bin:/bin
Environment=NODE_ENV=development
ExecStart={npx_bin} next dev -p {PORT} -H 0.0.0.0
Restart=always
RestartSec=5
StandardOutput=journal
StandardError=journal

[Install]
WantedBy=multi-user.target
'''

    print("[3/5] systemdユニットを配置・有効化 (sudo が必要です)")
    with open(SERVICE_TMP_PATH, "w", encoding="utf-8") as f:
        f.write(unit_content)

    steps = [
        ["sudo", "cp", SERVICE_TMP_PATH, SERVICE_DEST_PATH],
        ["sudo", "systemctl", "daemon-reload"],
        ["sudo", "systemctl", "enable", "--now", SERVICE_NAME],
    ]
    for step in steps:
        code, _ = run(step)
        if code != 0:
            fail("systemd設定でエラーが発生しました: " + " ".join(step))

    print("[4/5] 起動確認 (数秒待機)")
    run(["sleep", "3"])
    code, status_out = run(["systemctl", "is-active", SERVICE_NAME], capture=True)
    if status_out != "active":
        run(["sudo", "journalctl", "-u", SERVICE_NAME, "--no-pager", "-n", "40"])
        fail(SERVICE_NAME + " が active になりませんでした。上記ログを確認してください。")
    print("  -> " + SERVICE_NAME + " は active です")

    print("[5/5] README.mdをGitHubへpush")
    run(["git", "add", "-A"], cwd=REPO_ROOT)
    commit_msg = "docs: プロジェクトREADME整備(技術仕様・認証API・起動手順・URL一覧)"
    code, _ = run(["git", "commit", "-m", commit_msg], cwd=REPO_ROOT)
    if code != 0:
        print("[WARN] コミットする変更がありません。")
    else:
        code, _ = run(["git", "push", "origin", "main"], cwd=REPO_ROOT)
        if code != 0:
            fail("git pushに失敗しました。手動で `git push origin main` を実行してください。")

    print("\n=== 完了 ===")
    print("常時稼働サービス: " + SERVICE_NAME + " (Restart=always, サーバー起動時に自動起動)")
    print("状態確認: sudo systemctl status " + SERVICE_NAME)
    print("ログ確認: sudo journalctl -u " + SERVICE_NAME + " -f")
    print("")
    print("アクセスURL:")
    print("  http://192.168.1.11:" + PORT + "/register")
    print("  http://192.168.1.11:" + PORT + "/login")
    print("  http://192.168.1.11:" + PORT + "/dashboard")

    os.remove(os.path.abspath(__file__))


if __name__ == "__main__":
    main()
