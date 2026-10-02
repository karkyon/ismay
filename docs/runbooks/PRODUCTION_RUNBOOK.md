# 本番構成 Runbook（HTTPS・reverse proxy・production起動）

| 項目 | 値 |
|---|---|
| 対象 | `deploy/caddy/Caddyfile`、`docker-compose.yml`の`caddy`、`app/server.mjs`、systemd `ismay-app.service` |
| Gate | PROD-DEPLOY-01（2026-10-02）。利用者決定：Caddy＋内部CA、production起動、PostgreSQL・MinIO・Redisはloopbackのみ |
| 関連 | [SECURITY_RATE_RUNBOOK](SECURITY_RATE_RUNBOOK.md)（Redis・HMAC key・health監視）、[DEC-SECURITY-RATE-02](../decisions/DEC-SECURITY-RATE-02.md) §3（client IP・信頼proxy） |

## 1. 構成
```
browser ──HTTPS:10443──▶ Caddy(ismay-caddy, host network, 内部CA)
                              │ X-Forwarded-For = 接続元(信頼していない接続元から届いた値は捨てる)
                              ▼
                       app: node server.mjs  listen 127.0.0.1:13000 と [::1]:13000(NODE_ENV=production)
                              │ TRUSTED_PROXY_CIDRS=::1/128 → [::1]から来た要求だけX-Forwarded-Forを右から解釈
                              ▼
              PostgreSQL 127.0.0.1:15432 / Redis 127.0.0.1:16379(認証あり) / MinIO 127.0.0.1:19000・19001
```
- 利用者のアクセス先は`https://192.168.1.11:10443`（ポート規約 10000+443）。`http://…:13000`へはLANから到達できない。
- Caddyが`[::1]`から接続し、appは`::1/128`だけを信頼proxyとする。同一host上の受入scriptなどが`127.0.0.1:13000`へ直接送った`X-Forwarded-For`は信頼されない（接続元addressで区別する）。**hostのIPv6 loopback（`::1`）が必要**。
- 80番（HTTP→HTTPS転送）とHTTP/3（UDP）は使わない（同居する他projectのportと衝突させない）。
- productionではcookieがSecureになる。HTTPS以外（`http://…:13000`）ではbrowserのloginが成立しない。
- productionでは開発用debug出力（API入出力・イベント）は出ない（`lib/debugServer.ts`）。エラーは出る（emailは仮名化）。

## 2. 設定値
### 2.1 repository直下の`.env`（docker compose用、gitignore対象、mode 600）
| 変数 | 内容 |
|---|---|
| `REDIS_PASSWORD` | Redisのpassword（`openssl rand -base64 32`）。未設定だと`docker compose`がエラーで止まる |
| `ISMAY_PUBLIC_HOSTS` | 利用者がアクセスするURL（カンマ区切り）。例：`https://192.168.1.11:10443, https://localhost:10443` |
| `ISMAY_UPSTREAM` | 任意。Caddyの接続先（既定`[::1]:13000`） |

### 2.2 `app/.env`
| 変数 | 値 |
|---|---|
| `REDIS_URL` | `redis://:<REDIS_PASSWORD>@localhost:16379`（passwordにURLで使えない文字がある場合はURL encode） |
| `ISMAY_LISTEN_HOST` | `127.0.0.1,::1` |
| `TRUSTED_PROXY_CIDRS` | `::1/128` |
| `APP_BASE_URL` | `https://192.168.1.11:10443`（メール内リンクの基点） |

### 2.3 systemd unit
`Environment=NODE_ENV=production`。`ExecStart`は`node …/app/server.mjs`のまま。production起動は`npm run build`の成果物（`.next`）を使うため、**コード更新時はbuildしてから再起動**する：
```bash
cd ~/projects/ismay && git pull --ff-only
cd app && npm ci && npx prisma migrate deploy && npx prisma generate && npm run build
sudo systemctl restart ismay-app.service
```

## 3. 証明書（内部CA）
- Caddyが初回起動時に内部CA（root・中間）とserver証明書を作る。root証明書：`~/projects/ismay/docker-data/caddy/data/caddy/pki/authorities/local/root.crt`（有効期間約10年）。中間・server証明書はCaddyが自動更新する。
- **各端末へroot証明書を一度だけ信頼登録する**（配備scriptは`~/ismay-caddy-root.crt`へもcopyする）：
  - Windows：`root.crt`をダブルクリック →「証明書のインストール」→「ローカル コンピューター」→「信頼されたルート証明機関」
  - macOS：キーチェーンアクセスへ追加 →「常に信頼」
  - iOS：AirDrop等で転送 → 設定「プロファイルがダウンロード済み」でインストール →「一般 > 情報 > 証明書信頼設定」で有効化
  - Android：設定「セキュリティ > 暗号化と認証情報 > 証明書のインストール > CA証明書」
  - Firefox：設定「証明書を表示 > 認証局証明書 > インポート」（OSとは別に必要）
- 指紋の確認：`openssl x509 -in root.crt -noout -fingerprint -sha256`
- `docker-data/caddy/data`を消すとCAが作り直され、各端末へ再登録が必要になる。backup対象に含める。

## 4. 確認
```bash
# 待受け(13000はloopbackのみ、10443は全interface、15432/16379/19000/19001はloopbackのみ)
ss -ltn | grep -E ':(13000|10443|15432|16379|19000|19001)\b'
# 起動log
journalctl -u ismay-app.service -n 50 --no-pager | grep -E 'SECURITY-RATE|listening'
#   [SECURITY-RATE] backend=redis redis://localhost:16379 peer=custom-server trustedProxies=1
#   > ISMAY server listening on 127.0.0.1:13000 (production, ...) / [::1]:13000
# health(同一hostからは詳細あり)
curl -s http://127.0.0.1:13000/api/v1/health
curl -s --cacert docker-data/caddy/data/caddy/pki/authorities/local/root.crt https://localhost:10443/api/v1/health
```
受入：`scripts/verify_gate_prod_deploy_01.ts`（HTTPS・Secure Cookie・偽装header・production構成・LANから13000へ到達不可）。

## 5. LANからDB・MinIO管理画面を使う（SSHトンネル）
```bash
ssh -L 15432:127.0.0.1:15432 -L 19001:127.0.0.1:19001 karkyon@192.168.1.11
# 手元の localhost:15432(PostgreSQL) / http://localhost:19001(MinIO console) へ接続
```
Prisma Studioも`ssh -L 15555:127.0.0.1:15555`で同様に使う。

## 6. 障害対応
| 事象 | 確認・対応 |
|---|---|
| browserで証明書エラー | root証明書の信頼登録（§3）。URLのhostが`ISMAY_PUBLIC_HOSTS`に含まれるか |
| 502（Caddyがappへ接続できない） | `systemctl status ismay-app.service`、`ss -ltn \| grep 13000`で`[::1]:13000`を待ち受けているか（`ISMAY_LISTEN_HOST`） |
| session一覧のIPが全員`::1` | `TRUSTED_PROXY_CIDRS=::1/128`が未設定（Caddyの付けた接続元が使われていない） |
| loginできない（cookieが保存されない） | HTTPSでアクセスしているか（production cookieはSecure） |
| `docker compose`が`REDIS_PASSWORD is required`で止まる | repository直下の`.env`（§2.1） |
| health 503 | `curl -s http://127.0.0.1:13000/api/v1/health`の`problems`を見る（[SECURITY_RATE_RUNBOOK](SECURITY_RATE_RUNBOOK.md) §2） |

## 7. rollback（開発モード・HTTPへ戻す）
1. `sudo systemctl stop ismay-app.service`
2. unitの`Environment=NODE_ENV=production`を`development`へ（配備前のunitは`/etc/systemd/system/ismay-app.service.bak_prod01_*`）、`sudo systemctl daemon-reload`
3. `app/.env`から`ISMAY_LISTEN_HOST`・`TRUSTED_PROXY_CIDRS`を外す（`APP_BASE_URL`は元の値へ）
4. `docker compose stop caddy`
5. `sudo systemctl start ismay-app.service` → `http://192.168.1.11:13000`

PostgreSQL・MinIO・Redisのloopback限定とRedis認証は、HTTPへ戻しても維持する（戻すとLANから認証なしのRedis等へ到達できる）。
