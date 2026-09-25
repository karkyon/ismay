# 実装状況台帳：アカウント30日Purge

DOC-13（Traceability・実装状況台帳）への追補。Gateごとに、commit・変更・検証・状態を記録する。

| 項目 | 値 |
|---|---|
| 更新 | 2026-09-25（DOC-SYNC-04） |
| 基準HEAD | `e7f476995e5207acdcdf3d3e025adaaf99ede26d` |
| 規模 | Prisma 97 model、68 migration、API route 90 |

## 1. Gate履歴
| Gate | commit | 内容 | 実DB受入 | 状態 |
|---|---|---|---|---|
| PATTERN-PURGE-01 | `b5e09a1` | 動的FKグラフによるPurge Job（HTTP） | — | 置換済み |
| fix01 | `1c370a9` | NULL可能な逆参照による循環の解消 | 初回実行で失敗 | 置換済み |
| fix02 | `ad10ad1` | 複合FKの列対応（`pg_constraint` ordinal）、制約単位のNULL判定 | — | 完了 |
| fix03 | `583c363` | scopeの推移的解決（54表の漏れを是正） | — | 完了 |
| fix04 | `aeb8756` | 受入scriptの期待値を修正 | 29/29 | 完了 |
| fix05 (SECURITY-02A) | `f2299da` | HTTPをfail closedにし、運用CLIへ移行 | — | 完了 |
| hardening 02 (SCOPE-02F / ELIGIBILITY-02C / AUDIT-02D / REPORT-02E) | `1f636a8` | snapshot方式、transaction内再検証・lock、監査分離、件数分離 | 59/59、31/31 | 完了 |
| PURGE-SCOPE-03A | `2cb4a9c` | 明示的scope列、DB trigger、audit_logsの墨消し | 42/42、59/59、31/31 | 完了 |
| PURGE-OPS-03B | `e7f4769` | 台帳3表、Object Storage段（6段順序）、lease・retry・DEAD_LETTER・再開、保持ポリシー登録制 | 44/44（実MinIO）、42/42、59/59、31/31 | 完了 |
| DOC-SYNC-04 | 本commit | 正本追補、Runbook、本台帳、未決事項台帳、古いコメントの注記 | — | 完了 |

## 2. 要求→実装→検証
| 要求 | 実装 | 検証 |
|---|---|---|
| 30日経過後に物理削除（DB設計書8章） | `lib/admin/purgeJob.ts` `executePurgeForUser` | hardening_02 [D]、pure 30日境界 |
| 削除漏れの防止（全表） | FKグラフの推移的scope、明示的scope列、`PURGE_RETENTION_POLICY` | scope_03a [S1]、ops_03b [O9]、pattern_purge_01 |
| 他人のデータを消さない | transaction内でmembership再取得、SHARED_WORKSPACE、EXTERNAL_REFERENCE | hardening_02 [E][G][K] |
| 復元・変更との競合 | `FOR UPDATE`・DB時刻での再検証、lock競合時は無変更 | hardening_02 [B][C][H]、ops_03b [O4] |
| Object Storageの回収（DEC-PURGE-02B §7.1） | `lib/admin/purgeLedger.ts`、`purgeObjects.ts`、`storage.ts` | ops_03b [O1][O2][O3][O7] |
| 監査証跡（DOC-09 §1） | `audit_logs`は保持・墨消し、SYSTEM監査、監査失敗の分離 | scope_03a [S2]、hardening_02 [I]、ops_03b [O6] |
| 運用（batch・lease・retry・DEAD_LETTER・再開） | `purge_runs`/`purge_items`/`purge_item_objects`、CLI `--resume`/`--status` | ops_03b [O2][O3][O5][O6] |
| 新規書込みのscope列必須 | DB trigger `ismay_require_workspace_scope`、静的検査 | scope_03a [S3]、`purgeScopeWriteSites.test.ts` |

## 3. 実装済みでないもの
[未決事項台帳](./未決事項台帳.md)を参照（OPEN-PURGE-01〜06）。
