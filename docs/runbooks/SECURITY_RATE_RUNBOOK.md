# rate limit・client IP Runbook

| 項目 | 値 |
|---|---|
| 対象 | `app/server.mjs`（本番起動）、`app/src/lib/security/`（client IP解決・rate limit） |
| 関連 | [DEC-SECURITY-RATE-02](../decisions/DEC-SECURITY-RATE-02.md)、[ADD-2026-09-26-SECURITY-RATE](../spec-addenda/ADD-2026-09-26-SECURITY-RATE.md) |

## 1. 初回設定（omega-dev2）

### 1.1 `app/.env`へ追加
```dotenv
REDIS_URL=redis://127.0.0.1:16379
RATE_LIMIT_HMAC_KEY=<openssl rand -base64 32 の出力>
```
- Redisは`docker-compose.yml`の`ismay-redis`（`docker compose ps`でhealthyを確認）。
- `RATE_LIMIT_HMAC_KEY`はrepositoryへ入れない。変更すると全bucketが満杯に戻る（ロック中の利用者も解除される）だけで、データへの影響は無い。
- **設定しないままproductionで起動すると**、login・MFAはprocess内の縮退limiterで動き、確認メール再送・再設定メール要求は（client IPが分かる場合）発行されなくなる（fail closed）。

### 1.2 起動方法の確認
`npm run start`は`node server.mjs`になった。systemd unitの`ExecStart`がどちらを呼んでいるか確認する。
```bash
systemctl cat ismay-app.service | grep -E 'ExecStart|WorkingDirectory'
```
| ExecStartの内容 | 対応 |
|---|---|
| `npm run start`（または`npm start`） | 変更不要 |
| `next start -p 13000`（`npx next start`等を含む） | `node server.mjs`または`npm run start`へ変更し`sudo systemctl daemon-reload` |

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
| `peer=unavailable(…)` | custom serverを経由していない（`next start`で起動）。§1.2 |
| `trustedProxies=INVALID(…)`（error） | `TRUSTED_PROXY_CIDRS`の書式誤り。client IPは不明として扱われている。§3 |

### 1.4 受入試験
```bash
cd ~/projects/ismay/app
EXPECT_PEER_RESOLVED=1 npx tsx ../scripts/verify_gate_security_rate_02.ts
```
- テストユーザー（`gate-security-rate-02-…@example.invalid`）・作成したRedis key・監査記録は終了時に削除する。
- 信頼proxy試験（[H7]）は、`TRUSTED_PROXY_CIDRS`にloopbackを含む別instanceを指定した場合だけ行う（`TRUSTED_PROXY_BASE_URL=…`）。指定しなければSKIPと表示される（成功扱いにしない）。

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
| 起動方法だけ戻す | `ExecStart`を`npm run start:next`へ | client IPが不明になる（IP単位の制限は判定されない、session一覧のIPは空）。email・user単位の制限は動く |
| Gate全体 | SECURITY-RATE-02Bのcommitをrevertしてbuild・再起動 | 旧実装（process内Map・偽装可能なclient IP・MFA無制限）へ戻る。Redisのkeyは放置してよい（TTLで消える） |
