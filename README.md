# ISMAY

雑な会話・メモ・音声から「まだタスク化されていない約束・責任・判断・待ち・制約・リスク」を発見し、
本人固有の実行現実（Personal Execution Model／PEM）に合わせて整理・計画・進捗管理するAI個人参謀アプリ。

## 中核思想（4原則）

1. 管理労力を劇的に減らす
2. まだタスクになっていない約束・責任を扱う
3. 本人固有の実行現実に合わせる
4. 賢いが、勝手には動かない

設計文書一式の構成・読み順は `ISMAY_開発資料一式_README_v1_1.md`（プロジェクトナレッジ側）を参照。本READMEは**実装リポジトリ側の技術的な現状**を示す。

---

## 技術スタック

| 領域 | 技術 |
|---|---|
| フロントエンド／API | Next.js 16、React 19、TypeScript、Tailwind CSS、Radix UI |
| バリデーション | Zod v4 |
| ORM | Prisma 7.9.1（`prisma-client` ジェネレータ、rust-freeクライアント＋`@prisma/adapter-pg`） |
| DB | PostgreSQL 17 ＋ pgvector（Embedding列） |
| キャッシュ／キュー基盤 | Redis 7 |
| オブジェクトストレージ | MinIO（S3互換） |
| ランタイム | Node.js 22（nvm管理） |
| インフラ | Docker Compose（ローカル開発機） |
| 認証 | 自前実装のOIDC準拠セッション（パスワード＋TOTP多要素、Firebase等の外部IdP非依存） |
| パスワードハッシュ | `hash-wasm`（Argon2id、WASM実装・ネイティブビルド不要） |
| TOTP | `otplib`（Google Authenticator等の認証アプリと互換） |
| JWT | `jose` |

開発機はUbuntu 26.04 LTS。Windows 11 PCからVSCode「Remote-SSH」で接続し、リモート上で直接編集・実行する。

---

## ディレクトリ構成

```
ismay/
├── docker-compose.yml        # postgres(pgvector) / redis / minio。すべて restart: unless-stopped
├── docker-data/               # 各コンテナの永続化データ（gitignore対象）
├── .nvmrc                     # Node 22
└── app/                        # Next.jsアプリ本体
    ├── prisma/
    │   ├── schema.prisma       # TBL-001〜026 全反映 ＋ 認証拡張(UserSession/UserTotpSecret) ＋ pgvector Embedding
    │   └── migrations/
    ├── prisma.config.ts
    └── src/
        ├── lib/
        │   ├── db.ts            # Prisma Clientシングルトン(@prisma/adapter-pg使用)
        │   └── auth/            # 認証ロジック一式(下記参照)
        ├── app/
        │   ├── api/v1/auth/     # 認証API(下記参照)
        │   ├── register/        # UI: 新規登録(動作確認用)
        │   ├── login/            # UI-01: サインイン画面
        │   └── dashboard/        # UI: ログイン後の動作確認画面(MFA設定・セッション一覧)
        └── components/auth/     # 上記画面のクライアントコンポーネント
```

---

## データベース（schema.prisma）

DB設計書v1.1のTBL-001〜026を全反映（29モデル）。列定義が正式資料に明記されていない部分は
schema.prisma内に `[推論]` コメントで明示している（次回レビュー対象）。

追加で以下2テーブルを新設（OIDC準拠認証の実装に必要なため）：

| モデル | 用途 |
|---|---|
| `UserSession` | FR-AUTH-04対応。端末・セッション単位でRefresh Tokenのハッシュを保持し、個別失効／全端末ログアウトを可能にする |
| `UserTotpSecret` | FR-AUTH-03対応。TOTP秘密鍵（AES-256-GCM暗号化）と復旧コード（ハッシュ化）を保持 |

pgvector列（`responsibility_embeddings.embedding`）は `Unsupported("vector(1536)")` 宣言＋
`previewFeatures = ["postgresqlExtensions"]` で運用。ivfflat索引はデータ投入後に作成予定（保留中）。

---

## 認証機能（実装済み）

**方式：OIDC準拠の自前実装**（Firebase Authentication等の外部IdPには依存しない）。
Access Tokenは短寿命JWT、Refresh Tokenは不透明トークン＋DBハッシュ保存でローテーションする。
Web側はSecure・HttpOnly・SameSite=LaxのCookie運用とし、状態変更系リクエストはDouble Submit Cookie方式のCSRFトークンで保護する。

### APIエンドポイント（`API-AUTH`）

| メソッド | パス | 内容 |
|---|---|---|
| POST | `/api/v1/auth/register` | 新規登録(FR-AUTH-01) |
| POST | `/api/v1/auth/login` | ログイン(FR-AUTH-02)。TOTP登録済みなら`mfaRequired:true`とチャレンジトークンを返す |
| POST | `/api/v1/auth/mfa/enroll` | TOTP初回登録：秘密鍵・QRコード発行(要ログイン) |
| POST | `/api/v1/auth/mfa/enroll/confirm` | TOTP登録確定：6桁コード検証→有効化・復旧コード発行 |
| POST | `/api/v1/auth/mfa/verify` | ログイン時のTOTP／復旧コード検証 |
| POST | `/api/v1/auth/refresh` | Refresh Tokenローテーション(再利用検知つき) |
| POST | `/api/v1/auth/logout` | 現セッションの失効 |
| GET | `/api/v1/auth/sessions` | FR-AUTH-04: 有効セッション一覧 |
| DELETE | `/api/v1/auth/sessions/{id}` | FR-AUTH-04: 指定端末の失効 |
| GET | `/api/v1/auth/me` | ログイン中ユーザー情報取得 |

レスポンス形式はAPI設計書v1.1の共通応答（`{ data, meta }` / `{ error: { code, message, ... } }`）に準拠。

### 画面

- `/register` … 動作確認用の新規登録フォーム
- `/login` … UI-01相当のサインイン画面（パスワード→必要ならTOTP入力の2段階）
- `/dashboard` … ログイン後の動作確認画面。MFA設定（QRコード表示・復旧コード発行）とログイン中セッション一覧・個別失効・ログアウトができる

### 既知の未完了・暫定事項

| 項目 | 状態 |
|---|---|
| メールアドレス確認（FR-AUTH-01本来要件） | **未実装**。Notification基盤(MOD-08)が無いため、登録時に暫定的に自動検証済み扱い（`register/route.ts`に`TODO`明記） |
| ログイン失敗ロック | サーバーメモリ内カウンタによる簡易実装。プロセス再起動でリセットされる。永続化・IP単位のレート制限は未実装 |
| TBD-17（機微データのカラムレベル暗号化方式） | 未決事項台帳で正式決定待ち。現状TOTP秘密鍵のみアプリ層AES-256-GCMで暗号化（`MFA_ENCRYPTION_KEY`使用） |

---

## セットアップ・起動

### 前提

```bash
# インフラ(PostgreSQL/Redis/MinIO)起動
cd ~/projects/ismay
docker compose up -d
docker compose ps   # 全てhealthyになるまで待つ
```

### 環境変数（`app/.env`、gitignore対象）

| 変数 | 内容 |
|---|---|
| `DATABASE_URL` | `postgresql://ismay:ismay_dev_password@localhost:15432/ismay_dev` |
| `AUTH_JWT_SECRET` | Access/MFAチャレンジ/TOTP登録トークン署名鍵（base64, 48byte）。`openssl rand -base64 48` |
| `MFA_ENCRYPTION_KEY` | TOTP秘密鍵暗号化用(base64, 32byte)。`openssl rand -base64 32` |

### 開発サーバー起動（手動）

```bash
cd ~/projects/ismay/app
npm run dev   # next dev -p 13000
```

### 常時起動（systemd）

`ismay-app.service` としてsystemd管理下で常時稼働させる（サーバー再起動・クラッシュ時も自動復帰）。
セットアップ手順は本リポジトリ運用者（karkyon）のセットアップログを参照。稼働確認：

```bash
sudo systemctl status ismay-app.service
```

### アクセスURL

| 用途 | URL |
|---|---|
| アプリ本体（新規登録） | `http://192.168.1.11:13000/register` |
| ログイン | `http://192.168.1.11:13000/login` |
| ダッシュボード(MFA設定・セッション管理) | `http://192.168.1.11:13000/dashboard` |
| Prisma Studio(DB確認用、別途起動要) | `http://192.168.1.11:15555`（`npx prisma studio --port 15555`） |
| MinIOコンソール | `http://192.168.1.11:19001` |

サーバー外（同一LAN外）からアクセスする場合はVPN接続、またはSSHポートフォワーディング
（例：`ssh -L 13000:localhost:13000 karkyon@192.168.1.11`）を利用する。

---

## 開発規約（このリポジトリ固有）

- **ポート規約**：他プロジェクトと同居する共有サーバーのため、全ポートは `10000 + 元のポート番号` とする
  （例：Next.js標準3000→13000、PostgreSQL標準5432→15432、Redis標準6379→16379）
- **命名規約**：Dockerリソース等は `ismay-` プレフィックスで名前空間分離する
- **コンパイルエラー0件ゲート**：`schema.prisma`変更や新機能追加後、`npx prisma generate && npx tsc --noEmit`が
  エラー0件になることを確認してからのみ`git push`する（インフラ・運用設計書v1.1 5.1節のマージゲートと同一方針をローカルでも徹底）
- **スクリプト配置**：繰り返し使う再利用スクリプトは`scripts/`配下、DBスキーマ反映など一度きりのパッチスクリプトは
  プロジェクトルート直下に置き、適用完了後は自動削除する運用とする

---

## 未決事項（TBD）

正本は `ISMAY_未決事項_変更管理台帳` （プロジェクトナレッジ側、最新版を参照）。特に以下はM0開始前に優先決定すべき項目：

- TBD-02：認証方式 → **本リポジトリではOIDC準拠の自前実装として決着（2026-08-18）**
- TBD-05：AI提供事業者
- TBD-06：意味検索基盤
- TBD-17：機微データのカラムレベル暗号化方式（TOTP秘密鍵は暫定的にアプリ層AES-256-GCM）

---

## 参照設計文書（正本、プロジェクトナレッジ側）

- `ISMAY_Webシステム要件定義書_v2_2.md`
- `ISMAY_システム基本設計書_v1_2.md`
- `ISMAY_DB_データ設計書_v1_1.md`
- `ISMAY_API_イベント設計書_v1_1.md`
- `ISMAY_インフラ_運用設計書_v1_1.md`
- `ISMAY_AI_PEM設計書_v1_1.md`
- `ISMAY_機能別詳細設計書_v1_1.md`
- `ISMAY_画面UX設計書_ワイヤーフレーム_v2_1.html`
- `ISMAY_用語_状態_コード定義書_v1_1.md`
- `ISMAY_テスト_受入仕様書_v1_1.md`
- `ISMAY_機能要件トレーサビリティ台帳_v1_1.xlsx`
