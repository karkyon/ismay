# DEC-AUTH-REFRESH-07：回転済みRefresh Tokenの再利用検知

| 項目 | 値 |
|---|---|
| 状態 | **採用**（Gate AUTH-REFRESH-07、2026-10-02）。猶予時間10秒は実装上の既定値で、値の承認待ち（OPEN-AUTH-07の残件） |
| 作成 | 2026-10-02（契約と実装を同じGateで行う。利用者指示「実装コードまで一気に」） |
| 是正対象 | OPEN-AUTH-07（SECURITY-RATE-02Aの棚卸しで判明：回転済みの旧tokenの再利用で系列が失効しない） |
| 出典 | システム基本設計書v1.2 7章「Access Token短寿命、Refresh Tokenローテーション」、`lib/auth/session.ts`旧コメント「同一Refresh Tokenの再送（盗難後の再利用）を検知した場合は、該当トークン系列を丸ごと失効させる」 |
| 関連 | [DEC-SECURITY-RATE-02](DEC-SECURITY-RATE-02.md) §2.3、未決事項台帳 OPEN-AUTH-07 |

## 1. 旧実装の欠陥
- `rotateSession`は同じ`user_sessions`行の`refresh_token_hash`を新しいhashで上書きするだけだった。回転済みの旧tokenを後から提示しても行が見つからず`NOT_FOUND`になるだけで、**系列（session）は失効しない**。コメントの「再送を検知したら系列失効」と実装が一致していなかった。
- 失効させていたのは「失効済みsessionのtoken」が提示された場合だけ。
- 同じtokenで同時に回転要求が来ると、両方が同じ行を読み、両方が新tokenを発行して後勝ちで上書きする（先に返したtokenが無効になる）。
- 回転に失敗するとrefresh routeは常にcookieを消すため、別tabが同時にrefreshすると、先に成功したtabの新しいcookieまで消していた。
- `refresh_token_hash`にindexが無く、回転のたびに全件走査していた。

## 2. 決定
| 論点 | 決定 |
|---|---|
| 失効したhashの保持 | 新表`user_session_retired_refresh_tokens`（`session_id`→`user_sessions` CASCADE、`token_hash`一意、`retired_at`）。平文は保存しない。回転時に、そのsessionの30日（Refresh Tokenの有効期間）より古い行を削除する |
| 旧tokenの再提示 | 失効から**猶予時間（10秒）以内**：同時要求（複数tab・再送）の競合とみなし、拒否するだけ（`SUPERSEDED`、sessionは維持）。**猶予を過ぎた**：盗難後の再利用とみなし、そのsessionの系列（`refresh_token_family`）を`REUSE_DETECTED`で失効させる |
| 同時回転 | 現在のhashが提示hashのままの場合だけ更新する**比較更新**（`UPDATE … WHERE id=? AND refresh_token_hash=? AND revoked_at IS NULL`）。行lockにより1件だけ成功し、残りは`SUPERSEDED` |
| 失効済みsessionのtoken | 従来どおり系列を失効させ`REUSE_DETECTED` |
| 原子性 | 読取り・比較更新・失効hashの記録・失効を1 transactionで行う |
| 監査 | `AUTH_REFRESH_REUSE_DETECTED`（`actor_type=SYSTEM`、`target_type=User`・`target_id=userId`、reasonはsession id・family先頭8文字・検知元・失効件数、`ip_address`はclient IP）。生token・hashは記録しない。本人の行としてアカウントPurgeの墨消し対象になる |
| HTTP応答 | `SUPERSEDED`：`409 VERSION_CONFLICT`（`retryable: true`）、**cookieを消さない**（先に成功した要求のcookieを壊さない）。その他の失敗：従来どおり`401 AUTH_REQUIRED`でcookieを消す |
| client | refreshが409なら300ms待って元の要求を1回再送する（cookieは先行要求が更新済み） |
| エラーコード | 新設しない（既存の`VERSION_CONFLICT`・`AUTH_REQUIRED`） |

## 3. 競合モデル
| 状況 | 結果 |
|---|---|
| 同じtokenで同時にN要求 | 1件だけ200（新token）、残りは409。sessionは維持 |
| 回転直後（10秒以内）に旧tokenが届く（遅延した再送・別tab） | 409。sessionは維持 |
| 10秒を過ぎて旧tokenが届く（盗難したtokenの再利用、または長時間後の再送） | 401。sessionを失効（正規利用者も再login） |
| 攻撃者が正規利用者より先に回転した | 正規利用者の旧tokenが後から届いた時点で（10秒を過ぎていれば）検知し、sessionを失効させる。攻撃者の新tokenも同じsessionのため使えなくなる |

- 猶予時間の短縮は誤検知（正規利用者の強制logout）を、延長は検知漏れの時間を増やす。10秒は「同時要求・再送の競合」を吸収するための実装上の既定値（`lib/auth/refreshRotation.ts`の定数）。
- 失効後もAccess Token（15分のJWT）は期限まで有効（従来どおり。API側はsessionの失効をAccess Tokenごとには照会しない）。

## 4. migration
`20261002010000_auth_refresh_07`：`user_session_retired_refresh_tokens`の新設、`user_sessions(refresh_token_hash)`のindex追加。既存行の変換は無い（適用時点の各sessionの現在tokenはそのまま有効）。rollback時は表が残っても旧コードは参照しないため無害。

## 5. Purge
新表は`user_sessions`への必須FK（CASCADE）で、アカウントPurgeのFK探索ではuser scopeとして削除される（受入[F7]）。

## 6. 検証
- pure：`lib/auth/__tests__/refreshRotation.test.ts`（猶予の境界、時計の逆行、保持期間、応答の対応、配線の静的確認）
- 実DB・HTTP：`scripts/verify_gate_auth_refresh_07.ts`（[F1]〜[F7]）、`scripts/verify_gate_security_rate_02.ts` [H8]（回転直後の旧tokenは409）
