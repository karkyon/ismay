# DEC-SECURITY-RATE-02：proxy信頼境界・client IP・永続rate limit

| 項目 | 値 |
|---|---|
| 状態 | **採用**（Gate SECURITY-RATE-02A）。方式・信頼境界・障害時policyは本記録で確定。新規の閾値（§5の「実装上の既定値」）は値の承認待ち（OPEN-AUTH-06） |
| 作成 | 2026-09-26（Gate SECURITY-RATE-02A：棚卸し・契約。実装はGate SECURITY-RATE-02B） |
| 基準コード | `12c3174`（DOC-SYNC-05。コードは`d3844e4`と同一） |
| 出典 | 全機能仕様一覧 SEC-RATE「Login、AI、検索、export等の濫用を制限。Redis token bucket、device/IP signal、lockout監査を予定」（β前必須）、統合正本v5.0 §23.3「rate limit…を必須とする」、DOC-11 §7「AI/refresh/materialize/bulkにはuser/workspace rate limit」、AUTH-RESET「token、期限、rate limit…」 |
| 関連 | [ADD-2026-09-26-SECURITY-RATE](../spec-addenda/ADD-2026-09-26-SECURITY-RATE.md)、[SECURITY_RATE_RUNBOOK](../runbooks/SECURITY_RATE_RUNBOOK.md)、[ADD-2026-09-26-AUTH-EMAIL](../spec-addenda/ADD-2026-09-26-AUTH-EMAIL.md)、未決事項台帳 OPEN-AUTH-02/05/06/07 |

## 1. 結論

1. client IPは**直近の接続元（peer）**を基準にする。`X-Forwarded-For`は`TRUSTED_PROXY_CIDRS`で明示した信頼proxyからの接続に限り、右から走査して使う。`Forwarded`・`X-Real-IP`は使わない。peerが取得できない場合はIP不明とし、攻撃者が書けるheaderで埋めない。
2. Next.js 16のroute handlerはpeerを取得できない（§2.2）。本番起動を**最小のcustom server**（`app/server.mjs`、`npm run start`）へ変え、接続socketの`remoteAddress`をprocess内nonce付きで内部headerへ書いて渡す。
3. rate limitはRedisの**token bucket**（正本SEC-RATEの方式）を1回のLua script実行で判定・消費する。keyは生のemail・IP・userIdを含まず、server secretによるHMAC-SHA256で仮名化し、用途別prefixとpolicy versionを持つ。
4. 対象はpassword login・MFA verify・確認メール再送・パスワード再設定メール要求。メール発行のDB上限（AUTH-EMAIL-01）は多層防御として維持する。
5. Redis障害時：login・MFAはprocess内の同じ規則のlimiterへ縮退（監査・error logあり）、メール送信系はfail closed（応答は変えず発行・送信しない）。productionでRedis・HMAC key未設定を黙って許可しない（同じ縮退＋起動時error）。
6. Prisma migrationは追加しない（Redisのみ。監査は既存`audit_logs`）。

## 2. 現行経路の棚卸し（`d3844e4`）

### 2.1 client IPを読む箇所
| 箇所 | 読み方（変更前） | 用途 |
|---|---|---|
| `lib/auth/guard.ts` `clientIp` | `X-Forwarded-For`の**先頭要素**、無ければ`X-Real-IP` | 下記すべて |
| `auth/login` | `clientIp` | `user_sessions.ip_address` |
| `auth/mfa/verify` | `clientIp` | `user_sessions.ip_address` |
| `auth/refresh` | `clientIp` | `user_sessions.ip_address`（回転時に上書き） |
| `auth/register` `auth/email/resend` `auth/password/forgot` | `clientIp` | `auth_email_tokens.request_ip`（**IP単位の発行上限1時間20件の判定**）、`audit_logs.ip_address` |
| `auth/email/verify` `auth/password/reset` | `clientIp` | `audit_logs.ip_address` |
| その他のroute・worker | 読まない（`grep`で確認：`x-forwarded`・`x-real-ip`・`forwarded`・`remoteAddress`は`guard.ts`のみ） | — |

**欠陥**：先頭要素はclientが自由に書ける。`X-Forwarded-For`を毎回変えるだけでIP単位の発行上限を無効化でき、session一覧・監査に偽のIPが記録される。

### 2.2 Next.jsの挙動（`node_modules/next`で確認）
- `NextRequest.ip`はNext.js 15で廃止（`dist/docs/01-app/02-guides/upgrading/version-15.md`）。route handlerから接続socketへ触れる公開APIは無い。
- `next start`のserverは`req.headers['x-forwarded-for'] ??= socket.remoteAddress`（`dist/server/base-server.js`）。**headerが無い場合にだけ**接続元を補うため、clientが送ったheaderと区別できない。
- custom serverは公式機能（`dist/docs/01-app/02-guides/custom-server.md`）。`standalone`出力とは併用不可（ISMAYは`standalone`を使っていない）。

### 2.3 試行回数の制限
| 対象 | 変更前 | 問題 |
|---|---|---|
| login失敗 | `login/route.ts`のprocess内`Map`（同一emailで15分10回、正しいパスワードで解除） | 再起動で消える、複数processで共有されない、判定と記録が別処理で同時要求により上限を超え得る、IP単位の制限なし（多数アカウントへのcredential stuffingを止めない） |
| MFA verify | **制限なし** | challenge token（2分）の間に6桁コードを何度でも試せる。取り直せば無制限 |
| 確認メール再送・再設定メール要求 | DB（`auth_email_tokens`）：60秒間隔・1時間5回/user、1時間20件/IP | IP値が偽装可能（§2.1）。存在しないアドレス宛ての要求は数えない（送信は発生しない） |
| 再設定token・確認tokenの消費 | 32byte乱数のhash照合 | 総当たりは現実的でない。rate limit対象外とする |
| refresh token | 回転時に同じ`user_sessions`行のhashを更新。失効済みsessionのtokenが提示された場合だけ系列を失効 | **回転済みの旧tokenの再利用は`NOT_FOUND`になるだけで系列失効しない**（`rotateSession`のコメントは「再送を検知したら系列失効」と書いているが実装と一致しない）。本Gateの範囲外としてOPEN-AUTH-07へ記録 |

### 2.4 Redis・実行構成
| 項目 | 実態 |
|---|---|
| Redis client | **無い**（`app/package.json`にRedis clientが無く、`src`にRedisを使うコードが無い） |
| Redis server | `docker-compose.yml`の`redis:7-alpine`（host `16379`→`6379`、認証なし、`restart: unless-stopped`、`./docker-data/redis`に永続化） |
| 起動 | systemd `ismay-app.service`（unit fileはリポジトリ外）。`package.json`の`start`は`next start -p 13000` |
| reverse proxy | リポジトリ内に構成なし。READMEのアクセスURLは`http://192.168.1.11:13000`（LANから直接） |
| worker | `instrumentation.ts`で同一process内に起動（単一instance前提） |

## 3. 信頼境界

### 3.1 peer（直近の接続元）
- `app/server.mjs`（`npm run start`）がrequestごとに受信した`x-ismay-peer-address`を**削除してから**`<nonce> <socket.remoteAddress>`で上書きし、Next.jsの標準handlerへ渡す。
- nonceは起動ごとの32byte乱数で、同じprocessの`globalThis[Symbol.for("ismay.peerAddressStamp.v1")]`（書換え不可）にだけ置く。`lib/security/clientIp.ts`がnonceを定数時間比較し、一致した場合だけpeerとして採用する。clientは値を知り得ない。
- `next start`・`next dev`で起動した場合はnonceが存在しないため、同名headerは無視され、**peer不明＝client IP不明**になる（安全側）。起動時logに`peer=unavailable`と出る。

### 3.2 client IPの決定
| 条件 | client IP |
|---|---|
| peer不明 | 不明（null） |
| `TRUSTED_PROXY_CIDRS`未設定 | peer。forwarded系headerは一切使わない |
| peerが信頼proxyでない | peer（偽装`X-Forwarded-For`を無視） |
| peerが信頼proxy | `X-Forwarded-For`を右から走査し、最初の信頼proxyでないaddress。要素が不正なら不明。全hopが信頼proxyなら最も左。`X-Forwarded-For`が無ければpeer |
| `TRUSTED_PROXY_CIDRS`が不正 | 不明（起動時と初回にerror log）。部分的に解釈して信頼範囲を変えない |

- `NODE_ENV`でproxy信頼を暗黙に有効化しない。
- 複数の`X-Forwarded-For` headerは連結後に扱う（Fetch APIの`Headers.get`）。8192文字を超える場合は右側だけを使う（proxyは右端へ追記するため、攻撃者が左側を水増ししても解決できる）。右から16 hopを超えて信頼proxyが続く場合は不明。
- `Forwarded`（RFC 7239）・`X-Real-IP`は採用しない（信頼proxyは`X-Forwarded-For`を付ける構成に限定し、解釈を1つにする）。

### 3.3 address・CIDRの解釈（`lib/security/ipAddress.ts`）
- IPv4は10進4組のみ（先頭0・8進/16進・省略形を拒否）。IPv6はRFC 4291表記（`::`・末尾IPv4埋込み）、zone IDは拒否。IPv4-mapped IPv6はIPv4へ正規化（`::ffff:127.0.0.1`→`127.0.0.1`）。IPv6の文字列表現はRFC 5952。
- `X-Forwarded-For`の要素は前後空白を除き、`v4:port`・`[v6]`・`[v6]:port`のportだけを除く。`unknown`・難読化名（`_hidden`）等は不正。
- `TRUSTED_PROXY_CIDRS`はカンマ区切り、最大32件。host部が0でない値（`10.0.0.1/8`）・prefix 0（全アドレス）・mapped表記・空要素は設定誤りとして全体を拒否。単一address指定は`/32`・`/128`。

## 4. key
- `RATE_LIMIT_HMAC_KEY`（base64/base64url、decode後32byte以上）。`digest = HMAC-SHA256(key, "ismay-rate-limit␟policyId␟version␟dimension␟正規化値")`の先頭128bit（hex 32文字）。
- Redis key：`ismay:rl:v<version>:<policyId>:<digest>`。policyを変えるときはversionを上げる（旧keyはTTLで消える）。
- 正規化：emailは前後空白除去＋小文字（`users.email`の保存規則と同じ）、IPは§3.3の正規化表現、userIdはそのまま。
- process内縮退limiterも起動ごとの乱数keyでHMACし、生の値をMapのkeyにしない。
- device次元は採用しない：信頼できる端末識別子が無い（User-Agentは攻撃者が書ける）。端末cookieによるlockout回避は将来の選択肢（§10）。

## 5. policy（`lib/security/rateLimitPolicies.ts`、この1箇所で管理）
| id | 次元 | 容量 / 補充window | Redis障害時 | 成功時 | 値の出典 |
|---|---|---|---|---|---|
| `auth.login.account` | email | 10回 / 15分 | process内縮退 | 満杯へ戻す | **既存値の継承**（旧login：15分10回で失敗ロック、正しいパスワードで解除） |
| `auth.login.ip` | client IP | 30回 / 15分 | process内縮退 | 1回分戻す | 実装上の既定値 |
| `auth.mfa.user` | userId | 5回 / 15分 | process内縮退 | 満杯へ戻す | 実装上の既定値 |
| `auth.mfa.ip` | client IP | 30回 / 15分 | process内縮退 | 1回分戻す | 実装上の既定値 |
| `auth.email_resend.ip` | client IP | 20回 / 1時間 | fail closed | — | 既存のIP上限値（1時間20件）と同値 |
| `auth.password_forgot.ip` | client IP | 20回 / 1時間 | fail closed | — | 同上 |

- 「実装上の既定値」は正本に閾値が無いため置いた値で、利用者の承認を待つ（OPEN-AUTH-06）。
- IP次元はclient IPが解決できた場合だけ判定する。不明なIPを共通のkeyにまとめない（1人が全利用者を締め出せるため）。
- メールの宛先単位のRedis制限は置かない：送信が発生するのは登録済みアドレスだけで、そこはDBの1時間5回・60秒間隔（利用者決定）が既に制限している。Redis側で宛先を数えると、DB側で拒否された再送も1回に数えて利用者決定より厳しくなる。
- 成功時の扱い：試行の**前に**1回分を消費し（同時要求でも上限を超えない）、正しいパスワード・コードだった場合だけ戻す。account/userは満杯へ（旧実装の`clearFailures`と同じ）、IPは今回分だけ（1つの正規アカウントでIPの失敗回数を消せないように）。

## 6. 方式：token bucket
- 容量`capacity`、`windowMs`で空から満杯まで連続補充（速度`capacity / windowMs`）。任意の長さTの区間で通る回数は`capacity + T × capacity / windowMs`以下で、固定windowの境界で2倍通る問題が無い。長期の上限速度は旧実装（15分10回の固定window）と同じ1時間40回。
- 1回の`EVAL`で、対象の全bucketを判定し、全bucketに残量がある場合だけ全bucketから同時に消費する（一部だけ消費される状態を作らない）。時刻はRedis serverの`TIME`（process・hostの時計のずれに依存しない）。TTLは`windowMs＋60秒`（TTL切れ＝満杯）。
- 拒否時は全bucketが再び許可されるまでの時間を`Retry-After`（秒、切り上げ）で返す。
- 浮動小数の補充誤差で「補充ちょうど」の時刻に拒否しないよう、`1e-6`の許容量を置く。
- 採らなかった方式：固定window（境界burst）、sliding log（要求ごとにsorted setへ追記し、攻撃時にmemoryが要求数に比例）、DB（PostgreSQLの行lock・書込みを攻撃量に比例させる）。

## 7. Redis障害・未設定
| 状態 | login・MFA | 確認メール再送・再設定メール要求 |
|---|---|---|
| Redis正常 | Redis | Redis |
| 接続断・timeout（command 500ms、再接続中は待たずに即縮退） | **process内の同じ規則のlimiterへ縮退**（再起動で消える・process間で共有されない） | **fail closed**：応答は通常と同じaccepted、発行・送信しない |
| production（`NODE_ENV=production`）でREDIS_URL・RATE_LIMIT_HMAC_KEYが未設定・不正 | 同上（縮退） | 同上（fail closed） |
| production以外でREDIS_URL未設定 | 全policyをprocess内で判定（開発用） | 同左 |

- 縮退中はerror log（`[SECURITY-RATE] DEGRADED`、60秒に1回）と監査`RATE_LIMIT_BACKEND_DEGRADED`（5分に1回）を出す。起動時は`[SECURITY-RATE] backend=…`を1行出し、UNCONFIGUREDはerrorで出す。
- 起動は止めない：Redis停止でログインまで止めると、既存アカウントの利用を完全に止めることになるため（指示書4.4の推奨案）。
- ioredisは自動再接続（最大2秒間隔）。

## 8. 応答（列挙耐性の維持）
| endpoint | 上限到達 | 備考 |
|---|---|---|
| login（account） | `403 ACCOUNT_LOCKED`＋`Retry-After` | 旧実装と同じcode。登録の有無に関わらず同じ規則で消費するため、応答から登録有無を判別できない。ロック中は正しいパスワードでも同じ応答 |
| login（IP） | `429 RATE_LIMITED`＋`Retry-After` | |
| MFA verify | `429 RATE_LIMITED`＋`Retry-After` | challenge tokenを取り直しても回数は戻らない（user単位） |
| email resend・password forgot | 常に`200 {accepted: true, message}` | 上限到達・fail closedでも応答を変えない（AUTH-EMAIL-01の契約） |

エラーコードは既存の`ACCOUNT_LOCKED`・`RATE_LIMITED`（`lib/auth/response.ts`）を使い、新しいコードを追加しない。

## 9. 監査・ログ
| action | target | reason | 記録時点 |
|---|---|---|---|
| `RATE_LIMIT_BLOCKED` | `RateLimitPolicy` / policy id | `<scope> dimension=… key=<digest先頭16文字> retryAfterMs=… backend=redis|local v=…` | bucketが拒否状態へ変わった最初の1回（連続拒否ごとには書かない：攻撃量に比例した書込みを避ける） |
| `RATE_LIMIT_BACKEND_DEGRADED` | `RateLimitBackend` / `REDIS`・`UNCONFIGURED` | scope・原因 | 縮退中5分に1回 |

- `actor_type=SYSTEM`、`ip_address`は**記録しない**（NULL）。これらの行は対象ユーザーと結びつかないためアカウントPurgeの墨消し（`actor_user_id`・`target_type=User`で特定）の対象にならず、IPが無期限に残るため。同一keyの追跡はdigestで行う。生のemail・IP・userId・password・token・コードをreason・debug logへ書かない。

## 10. 選択肢（検討結果）
| 論点 | 選択肢 | 判断 |
|---|---|---|
| peerの取得 | A: custom server（採用） / B: `next start`のまま、reverse proxyで`X-Forwarded-For`を上書きし、appをloopbackにだけbind / C: 取得しない（IP次元のpolicyは常に不判定） | A。Bは運用設定の正しさに全面依存し、app側で検証できない（proxyを迂回して直接接続されると偽装を見分けられない）。Cは現行運用（LANから直接接続）でIP単位の制限・session一覧のIP表示を失う。Aはrollback（`npm run start:next`）でCと同じ安全側に戻る |
| 信頼proxy | 私設address帯を自動で信頼 / 明示設定のみ（採用） | 明示設定のみ。LAN内の他端末も私設addressのため、自動信頼は偽装を許す |
| lockout DoS（他人のemailでロックさせる） | 端末cookieで既知端末を除外 / IP×account複合key / 現状維持（採用） | 現状維持（旧実装と同じ）。端末cookieは新しい端末識別の契約が要る。監査`RATE_LIMIT_BLOCKED`で検知可能にした |
| Redis障害時のlogin | fail closed / fail open / process内縮退（採用） | 指示書4.4の推奨案 |
| 起動時のRedis必須化 | 起動拒否 / 縮退＋error（採用） | 起動拒否はRedisの一時停止で全利用者を締め出す |

## 11. 残る論点
- OPEN-AUTH-06：§5の「実装上の既定値」の承認。
- OPEN-AUTH-07：回転済みrefresh tokenの再利用検知（§2.3）。
- 本Gateの対象外：register・AI・検索・export・materialize・bulkのrate limit（DOC-11 §7のuser/workspace単位）、health endpoint（現状はlogと監査のみ）、Redisの認証・TLS（docker-composeのRedisは認証なしでhost `16379`を公開）。
