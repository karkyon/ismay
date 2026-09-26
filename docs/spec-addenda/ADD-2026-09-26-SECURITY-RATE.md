# 正本改訂 ADD-2026-09-26-SECURITY-RATE：proxy信頼境界・永続rate limit

| 項目 | 値 |
|---|---|
| 状態 | 有効（正本v5.0への追補。矛盾する場合は本追補を優先） |
| 作成 | 2026-09-26（Gate SECURITY-RATE-02A：契約、SECURITY-RATE-02B：実装） |
| 決定記録 | [DEC-SECURITY-RATE-02](../decisions/DEC-SECURITY-RATE-02.md) |
| 運用手順 | [SECURITY_RATE_RUNBOOK](../runbooks/SECURITY_RATE_RUNBOOK.md) |
| 出典 | 全機能仕様一覧 SEC-RATE、統合正本v5.0 §23.3、DOC-11 §7、AUTH-RESET |

## 1. 統合正本v5.0 §23.3（セキュリティ）への追補
- client IPは直近の接続元を基準とし、`X-Forwarded-For`は明示設定した信頼proxy（`TRUSTED_PROXY_CIDRS`）からの接続に限り右から解釈する。接続元が取得できない場合はIP不明とし、攻撃者が書けるheaderで補わない（DEC §3）。
- 認証系のrate limitはRedisのtoken bucketで行い、複数process・再起動をまたいで共有する。keyはserver secretによるHMACで仮名化する（DEC §4〜§6）。
- Redis障害時、login・MFAはprocess内の同じ規則へ縮退し、メール送信を伴う要求はfail closedとする。productionでRedis未設定を黙って許可しない（DEC §7）。

## 2. DOC-11 API・Event仕様書 §7への追補
| API | 追加の制限 | 上限到達時 |
|---|---|---|
| `POST /api/v1/auth/login` | email単位（15分10回、成功で満杯へ）、client IP単位（15分30回、成功した試行は数えない） | email単位：`403 ACCOUNT_LOCKED`、IP単位：`429 RATE_LIMITED`。いずれも`Retry-After`（秒） |
| `POST /api/v1/auth/mfa/verify` | user単位（15分5回、成功で満杯へ）、client IP単位（15分30回） | `429 RATE_LIMITED`＋`Retry-After` |
| `POST /api/v1/auth/email/resend` | client IP単位（1時間20回）。DBの発行上限（60秒間隔・1時間5回/user、1時間20件/IP）は維持 | 応答は常に`200 {accepted: true, message}`（発行・送信しない） |
| `POST /api/v1/auth/password/forgot` | 同上 | 同上 |

- 試行の前に1回分を原子的に消費し、成功時にだけ戻す。ロック中は正しいパスワード・コードでも同じ応答を返す。
- 登録の有無に関わらず同じ規則で数え、応答から登録有無を判別できないようにする（AUTH-EMAIL-01の列挙対策を維持）。
- 新しいエラーコードは追加しない（既存の`ACCOUNT_LOCKED`・`RATE_LIMITED`）。
- 値の承認は未決（OPEN-AUTH-06）。email単位のloginは旧実装の値を継承している。

### 2.1 監査ログ（`audit_logs`）
| action | target_type / target_id | reason | 記録時点 |
|---|---|---|---|
| `RATE_LIMIT_BLOCKED` | `RateLimitPolicy` / policy id | scope、次元、HMAC digestの先頭16文字、retryAfterMs、backend、policy version | bucketが拒否状態へ変わった最初の1回 |
| `RATE_LIMIT_BACKEND_DEGRADED` | `RateLimitBackend` / `REDIS`・`UNCONFIGURED` | scope、原因 | 縮退中5分に1回 |

`actor_type=SYSTEM`、`actor_user_id`・`ip_address`はNULL。生のemail・IP・userId・password・token・コードは記録しない。

## 3. DOC-10 DB物理設計書への追補
Prisma migrationは追加しない。Redis（`docker-compose.yml`の`redis`）に次のkeyを置く。

| key | 型 | field | TTL |
|---|---|---|---|
| `ismay:rl:v<version>:<policyId>:<digest>` | hash | `t`（残量、小数）、`ts`（計算時刻ms、Redis serverの`TIME`）、`b`（拒否通知済み`0`/`1`） | `windowMs＋60秒`（TTL切れ＝満杯） |

## 4. 実行構成（本番起動）
| 項目 | 変更前 | 変更後 |
|---|---|---|
| `npm run start` | `next start -p 13000` | `node server.mjs`（Next.js custom server。接続元を内部header `x-ismay-peer-address`へnonce付きで渡す以外は`next start`と同じ） |
| rollback | — | `npm run start:next`（`next start -p 13000`。client IPは不明になり、IP単位の制限は判定されない） |

### 4.1 環境変数（`app/.env`）
| 変数 | 必須 | 内容 |
|---|---|---|
| `REDIS_URL` | production必須 | 例：`redis://127.0.0.1:16379`（`redis://`または`rediss://`） |
| `RATE_LIMIT_HMAC_KEY` | production必須 | base64（decode後32byte以上）。`openssl rand -base64 32` |
| `TRUSTED_PROXY_CIDRS` | 任意 | reverse proxyを置く場合だけ、そのaddressをカンマ区切りのCIDRで指定（例：`127.0.0.1/32,::1`）。未設定時はforwarded系headerを使わない |
| `ISMAY_LISTEN_HOST` | 任意 | listenするaddress（未設定時は全interface、`next start -p 13000`と同じ）。reverse proxy配下では`127.0.0.1`を推奨 |
| `PORT` | 任意 | 既定13000 |

## 5. DOC-12 EVAL・受入テストへの追補
Gate SECURITY-RATE-02Bで作成・実行（件数は環境Aの結果。環境Bの結果は実装状況台帳へ記録する）。

| 受入script / test | 件数 | 主な検証 |
|---|---:|---|
| `app/src/lib/security/__tests__/securityRate.test.ts` | 138 | IPv4/IPv6/mapped・CIDR parser、信頼proxy chain、偽装XFF、不正・長大header、peer stamp、HMAC keyの安定性と用途分離、token bucketの境界・retry-after・全か無か、backend構成判定、旧実装の除去 |
| `scripts/verify_gate_security_rate_02.ts` | 67（信頼proxy試験を含む） | [R1]〜[R8] 実Redis（複数client・複数process同時要求、TTL、atomicity、RESET/REFUND、監査、再接続、接続不能・未設定時policy）、[H1]〜[H8] HTTP（login連続失敗、成功後の挙動、列挙耐性、MFA、resend/forgot、偽装header、信頼proxy、CSRF・cookie・session・refresh回帰） |
