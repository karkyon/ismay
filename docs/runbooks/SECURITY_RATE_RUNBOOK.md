# rate limit・client IP Runbook

| 項目 | 値 |
|---|---|
| 対象 | `app/server.mjs`（custom server）、`app/src/lib/security/`（client IP解決・rate limit） |
| omega-dev2の現行構成 | 2026-09-27 SECURITY-RATE-02C（HEAD `2b00550`）で配備・受入済み：`ismay-app.service`は`node server.mjs`＋**`NODE_ENV=development`（開発モード）**、Redisは`127.0.0.1:16379`のみ、`backend=redis`・`peer=custom-server`・`trustedProxies=0`（§1.5） |
| 関連 | [DEC-SECURITY-RATE-02](../decisions/DEC-SECURITY-RATE-02.md)、[ADD-2026-09-26-SECURITY-RATE](../spec-addenda/ADD-2026-09-26-SECURITY-RATE.md) |

## 1. 初回設定（omega-dev2）

### 1.1 `app/.env`へ追加
```dotenv
REDIS_URL=redis://127.0.0.1:16379
RATE_LIMIT_HMAC_KEY=<openssl rand -base64 32 の出力>
```
- Redisは`docker-compose.yml`の`ismay-redis`（`docker compose ps`でhealthyを確認）。host側は`127.0.0.1:16379`だけに公開する（SECURITY-RATE-02C `7ec4d7f`。Redisは認証なしのため、全interfaceへ公開しない。Dockerが公開したportはufw等の規則を迂回する）。`REDIS_URL`は`redis://localhost:16379`等のloopback表記でもよい。確認：`ss -ltnp | grep 16379`が`127.0.0.1:16379`だけを示すこと
- `RATE_LIMIT_HMAC_KEY`はrepositoryへ入れない。変更すると全bucketが満杯に戻る（ロック中の利用者も解除される）だけで、データへの影響は無い。
- **設定しないままproductionで起動すると**、login・MFAはprocess内の縮退limiterで動き、確認メール再送・再設定メール要求は（client IPが分かる場合）発行されなくなる（fail closed）。

### 1.2 起動方法の確認
`npm run start`は`node server.mjs`になった。systemd unitの`ExecStart`がどちらを呼んでいるか確認する。
```bash
systemctl cat ismay-app.service | grep -E 'ExecStart|WorkingDirectory'
```
| ExecStartの内容 | 対応 |
|---|---|
| `npm run start`（または`npm start`）、`node …/app/server.mjs` | 変更不要 |
| `next start -p 13000`（`npx next start`等を含む） | `node server.mjs`または`npm run start`へ変更し`sudo systemctl daemon-reload` |
| `next dev -p 13000`（`npx next dev`・`npm run dev`を含む） | 同上（開発モードのまま使う場合は`Environment=NODE_ENV=development`を維持して`node server.mjs`へ。§1.5） |

`next start`・`next dev`を直接起動するとpeer不明になり、**IP単位の上限（login・MFA・確認メール再送・再設定メール要求のすべて）が判定されず無効になる**。email・user単位の上限は動く。Redis障害時のfail closedとは別の状態で、メール系もfail closedにはならない（DEC §7.1）。

### 1.3 再起動と確認
```bash
cd ~/projects/ismay/app && npm ci && npx prisma generate && npm run build
sudo systemctl restart ismay-app.service
journalctl -u ismay-app.service -n 50 --no-pager | grep -E 'SECURITY-RATE|listening'
```
期待する出力:
```
[SECURITY-RATE] backend=redis redis://127.0.0.1:16379 peer=custom-server trustedProxies=0
> ISMAY server listening on *:13000 (production, peer address stamping enabled)
```
| 出力 | 意味・対応 |
|---|---|
| `backend=UNCONFIGURED(…)`（error） | `REDIS_URL`・`RATE_LIMIT_HMAC_KEY`の未設定・不正。§1.1 |
| `peer=unavailable(…)` | custom serverを経由していない（`next start`・`next dev`で起動）。IP単位の上限はすべて無効。§1.2 |
| `trustedProxies=INVALID(…)`（error） | `TRUSTED_PROXY_CIDRS`の書式誤り。client IPは不明として扱われている。§3 |

### 1.4 受入試験
```bash
cd ~/projects/ismay/app
EXPECT_PEER_RESOLVED=1 npx tsx ../scripts/verify_gate_security_rate_02.ts
```
- テストユーザー（`gate-security-rate-02-…@example.invalid`）・作成したRedis key・監査記録は終了時に削除する。
- 信頼proxy試験（[H7]）は、`TRUSTED_PROXY_CIDRS`にloopbackを含む別instanceを指定した場合だけ行う（`TRUSTED_PROXY_BASE_URL=…`）。指定しなければSKIPと表示される（成功扱いにしない）。
- omega-dev2の環境B受入（SECURITY-RATE-02C、2026-09-27）：64/0・SKIP 1（[H7]）。回帰12本の結果は全機能トレーサビリティ台帳 §2.2。

### 1.5 omega-dev2の現行構成（開発モード運用）
| 項目 | 値 |
|---|---|
| unit | `ExecStart=/home/karkyon/.nvm/versions/node/v22.23.2/bin/node /home/karkyon/projects/ismay/app/server.mjs`、`Environment=NODE_ENV=development`（旧unitは`npx next dev -p 13000 -H 0.0.0.0`。backupは`/etc/systemd/system/ismay-app.service.bak_02c_*`） |
| 起動log | `[SECURITY-RATE] backend=redis redis://localhost:16379 peer=custom-server trustedProxies=0`、`> ISMAY server listening on *:13000 (development, peer address stamping enabled)` |
| `app/.env` | mode 600。`REDIS_URL`・`RATE_LIMIT_HMAC_KEY`設定済み |
| 利用者判断 | 開発モードのまま運用する（production化はHTTPS reverse proxy・Secure Cookie・`TRUSTED_PROXY_CIDRS`とセットの別Gate。HTTPのままproductionにするとcookieがSecureになりloginできない） |

- `NODE_ENV=development`のcustom serverは`next({ dev: true })`で動き、ページ・APIは要求時にcompileされる。**HMR（ブラウザの自動再読込）は無効**。コード変更後は`sudo systemctl restart ismay-app.service`で反映する。
- 開発モードでは`npm run build`の成果物（`.next`の本番build）は使われない（buildは品質Gateとしてのみ実行する）。
- 開発モードのdebug出力がrequest body（email等）をjournalへ出す（limiter自身の行には出ない）。対処はSECURITY-RATE-02D（未決事項台帳 §3.1）。

## 2. 監視
```bash
# 縮退(60秒に1回)
journalctl -u ismay-app.service --since "1 hour ago" --no-pager | grep 'SECURITY-RATE] DEGRADED'
# Redisに接続しているか(接続名 ismay-rate-limit)
docker exec ismay-redis redis-cli CLIENT LIST | grep ismay-rate-limit
```
```sql
-- 拒否(bucketが拒否状態になった最初の1回)と縮退(5分に1回)
SELECT occurred_at, action, target_id, reason FROM audit_logs
 WHERE action IN ('RATE_LIMIT_BLOCKED','RATE_LIMIT_BACKEND_DEGRADED')
 ORDER BY occurred_at DESC LIMIT 50;
```
`reason`の`key=`はHMAC digestの先頭16文字で、元のemail・IPへは戻せない。同じ値が短時間に多数あれば同一対象への集中を示す。

## 3. reverse proxyを置く場合
1. proxyが`X-Forwarded-For`へ接続元を**追記**するように設定する（nginx：`proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;`）。
2. appをproxyからだけ到達できるようにする：`ISMAY_LISTEN_HOST=127.0.0.1`（同一host）またはfirewall。
3. `TRUSTED_PROXY_CIDRS`にproxyのaddress（appから見た接続元）を指定する：同一hostなら`127.0.0.1/32,::1`。
4. 再起動し、§1.3の`trustedProxies=N`を確認。session一覧（ダッシュボード）のIPがproxyのaddressではなく利用者のaddressになることを確認する。

`TRUSTED_PROXY_CIDRS`に私設address帯（`192.168.0.0/16`等）をまとめて指定しない。LAN内の他端末が`X-Forwarded-For`を偽装できるようになる。

## 4. 障害対応
| 事象 | 挙動 | 対応 |
|---|---|---|
| Redis停止・接続断 | login・MFAはprocess内縮退（同じ規則。再起動で消える）。メール再送・再設定要求は応答は通常どおりで送信しない | `docker compose up -d redis`。ioredisが自動再接続（最大2秒間隔）し、次の要求からRedisで判定する |
| 利用者がロックされた（`ACCOUNT_LOCKED`） | `Retry-After`秒後に1回分ずつ回復（15分で満杯） | 待つのが原則。即時解除が必要な場合は§4.1 |
| 同じIPの利用者全員が`RATE_LIMITED` | 同一IPからの失敗が多い（NAT配下等） | 監査`RATE_LIMIT_BLOCKED`を確認。攻撃でなければ§4.1で該当IPのkeyを削除 |

### 4.1 特定のbucketを削除する（ロック解除）
keyは`RATE_LIMIT_HMAC_KEY`によるHMACで、生のemail・IPからは手で組み立てられないため、`scripts/rate_limit_unlock.ts`で計算する（入力値は表示しない）。
```bash
cd ~/projects/ismay/app
npx tsx ../scripts/rate_limit_unlock.ts LOGIN_ACCOUNT user@example.com            # key・残量・TTLを表示
npx tsx ../scripts/rate_limit_unlock.ts LOGIN_ACCOUNT user@example.com --delete   # 削除(満杯へ戻す)
npx tsx ../scripts/rate_limit_unlock.ts LOGIN_IP 203.0.113.5 --delete
npx tsx ../scripts/rate_limit_unlock.ts MFA_USER <userId> --delete
```
policy名は`LOGIN_ACCOUNT` / `LOGIN_IP` / `MFA_USER` / `MFA_IP` / `EMAIL_RESEND_IP` / `PASSWORD_FORGOT_IP`。

## 5. 値・規則の変更
- 値は`app/src/lib/security/rateLimitPolicies.ts`の1箇所。容量・windowを変えるときは`version`を1上げる（旧versionのkeyは参照されずTTLで消える）。
- 変更したらDEC-SECURITY-RATE-02 §5・ADD §2・未決事項台帳OPEN-AUTH-06を更新する。

## 6. rollback
| 範囲 | 手順 | 影響 |
|---|---|---|
| 起動方法だけ戻す | `ExecStart`を`npm run start:next`（omega-dev2の開発モードでは旧unitの`next dev`、backup `ismay-app.service.bak_02c_*`）へ戻し`sudo systemctl daemon-reload && sudo systemctl restart ismay-app.service` | peer不明（DEC §7.1）：**IP単位の上限はlogin・MFA・確認メール再送・再設定メール要求のすべてで判定されず無効**。メール系はfail closedにはならず、宛先ごとのDB上限（60秒間隔・1時間5回/user）だけが効く。email・user単位の制限は動く。session一覧・監査のIPは空 |
| `RATE_LIMIT_HMAC_KEY`だけ外す（`REDIS_URL`は残す） | `.env`から削除して再起動 | `NODE_ENV`に関わらず`backend=UNCONFIGURED`（error log）：login・MFAはprocess内縮退、メール系はfail closed（発行・送信しない）。02Cの受入失敗時のrollbackはこの状態だった |
| `REDIS_URL`・`RATE_LIMIT_HMAC_KEY`を両方外す | 同上 | production：上と同じUNCONFIGURED。production以外（omega-dev2の開発モードを含む）：`LOCAL_DEV`（全policyをprocess内で判定、fail closedにならない） |
| Redisの公開範囲 | `docker-compose.yml`の`ports`を変更して`docker compose up -d redis` | 全interfaceへ戻すと認証なしのRedisがLANから操作可能になる。戻さない |
| Gate全体 | SECURITY-RATE-02Bのcommitをrevertしてbuild・再起動 | 旧実装（process内Map・偽装可能なclient IP・MFA無制限）へ戻る。Redisのkeyは放置してよい（TTLで消える） |
