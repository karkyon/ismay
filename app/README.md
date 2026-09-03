# ISMAY app/

ISMAYのNext.js 16アプリ本体。全体構成・仕様正本の所在はリポジトリルートの
`../README.md`を参照。本ファイルは`app/`ディレクトリ内で作業する際の
セットアップ・テスト・ビルド・Worker運用手順に特化した実務資料である。

## セットアップ

```bash
# リポジトリルートでインフラ起動(postgres/redis/minio)
cd ~/projects/ismay
docker compose up -d
docker compose ps   # 全てhealthyになるまで待つ

cd app
npm ci
npx prisma generate
npx prisma migrate deploy   # 未適用migrationの反映
```

`app/.env`(gitignore対象)に以下を設定する:

| 変数 | 内容 |
|---|---|
| `DATABASE_URL` | `postgresql://ismay:ismay_dev_password@localhost:15432/ismay_dev` |
| `AUTH_JWT_SECRET` | `openssl rand -base64 48` |
| `MFA_ENCRYPTION_KEY` | `openssl rand -base64 32` |
| `ANTHROPIC_API_KEY` | AI Provider未登録Workspace向けフォールバック |
| `OPENAI_API_KEY` | 同上(Embedding/文字起こし) |

## 開発サーバー起動

```bash
npm run dev   # next dev -p 13000
```

AI Worker(Outbox relay、AI抽出Job、文字起こし、OCR、Recompute Queue等のtickループ)は
別プロセスではなく、`src/instrumentation.ts`のregister()フック経由でNext.jsサーバー
起動時にインプロセス起動する。`npm run dev`/`npm run start`いずれでも自動的に動く。
詳細は`src/lib/worker/index.ts`冒頭コメント参照。

## 型チェック・Lint

```bash
npx tsc --noEmit
npm run lint
```

サンドボックス環境等、`npx prisma generate`がネットワーク制約でブロックされる場合は
`src/generated/prisma/client.ts`に最小限の`any`型スタブ(`PrismaClient`/`Prisma`
namespace)を一時的に作成してから`tsc --noEmit`を実行し、確認後は必ず削除してから
`eslint`を実行すること(スタブが残っているとeslintの対象に含まれてしまうため)。
このスタブは`Prisma.TransactionClient`等の型精度が実クライアントより粗く、
既知の「型widening由来のノイズ」が一定数出る。実サーバーでの
`prisma generate`後の`tsc --noEmit`が最終ゲートであり、スタブでの結果はあくまで
簡易チェックである。

## テスト

```bash
npm run test:all       # 全pure/invariant test。__tests__配下のtest.tsファイルを
                         # find+xargsで自動列挙して実行するため、新しいtestファイルを
                         # 追加してもpackage.jsonへの追記は不要(自動的に対象に入る)。
                         # DB接続・外部AI通信なし。

# 個別実行(デバッグ用、詳しくはpackage.jsonのscripts一覧を参照)
npm run test:formation
npm run test:pem
npm run test:pattern-math
npm run test:ai
```

実DB受入試験(`../scripts/verify_gate_*.ts`)はDB接続ありの個別Gate受入試験であり、
`test:all`には含まれない(CIにも含まれない。DB未提供のため)。DBが利用可能な状態で
リポジトリルートから以下のように実行する:

```bash
cd ~/projects/ismay
node --import tsx scripts/verify_gate_XXX.ts
```

verify scriptはAI課金経路を`scripts/lib/aiNetworkDenyGuard.ts`で機械的に遮断し、
実行中にAI providerへの通信が発生していないことを証明する。REOPEN/Correction系の
Eventを作るverify scriptのcleanupは、`ExecutionReasonAnswer → ReasonPromptStateEvent
→ ReasonPrompt → ExecutionEvent`のFK順序を守ること(このリポジトリで複数回発生している
既知の失敗パターン。`scripts/lib/formationVerifyCleanup.ts`の共有helperを再利用する)。

## ビルド

```bash
npm run build   # next build
```

サンドボックス等、`fonts.googleapis.com`へのネットワークアクセスがブロックされた
環境では`next/font/google`のフォント取得に失敗しビルドが通らない(コードの正しさとは
無関係のネットワーク制約)。実サーバー(`omega-dev2`)またはネットワーク制限のないCI環境
でのみビルドの成否を最終判定できる。

## CI

`../.github/workflows/ci.yml`が`main`へのpush/PRごとに
`npm ci → prisma validate/generate → tsc --noEmit → eslint → test:all → build`を実行する。

## Prisma運用メモ

- `npx prisma migrate dev`は対話待ちで自動化スクリプト内でハングするため使わない。
  非対話の`npx prisma migrate deploy`を使う。
- 適用済みmigrationは編集しない。スキーマ変更は常にexpand-onlyの新migrationを追加する。
- `@relation`を持つmodelは参照される側にも対応する配列fieldが必要。
- `@default(autoincrement())`は`@unique`または`@id`が必要。
- PostgreSQL識別子は63byte制限があるため、`@@unique`制約名の長さに注意する。
- JSON?列への明示的なnull設定には`Prisma.DbNull`(裸の`null`ではなく)を使う。
- 複合FKのバリデーションエラーは実サーバーでのみ検出される(サンドボックスの`any`
  スタブでは検出できない)。

## ディレクトリ構成の要点

主要なドメインロジックは`src/lib/`配下にドメイン単位で分割されている
(`formation/`＝Formation Session、`pem/`＝Personal Execution Model、
`projectContext/`＝Project Context、`patterns/`＝Case Pattern Catalog、
`worker/`＝バックグラウンドJob群)。APIルートは`src/app/api/v1/`配下、
画面は`src/app/`配下にドメインごとのディレクトリで分かれる。詳細な機能一覧・
実装状況はリポジトリルートの`../README.md`、および仕様正本(プロジェクトナレッジ側)の
DOC-13(Traceability・実装状況台帳)を参照。
