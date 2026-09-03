# ISMAY

雑な会話・メモ・音声から「まだタスク化されていない約束・責任・判断・待ち・制約・リスク」を発見し、
本人固有の実行現実（Personal Execution Model／PEM）に合わせて整理・計画・進捗管理するAI個人参謀アプリ。

## 中核思想（4原則）

1. 管理労力を劇的に減らす
2. まだタスクになっていない約束・責任を扱う
3. 本人固有の実行現実に合わせる
4. 賢いが、勝手には動かない

## 仕様正本の所在・優先順位

仕様正本一式（統合正本仕様書v5.0、DOC-01〜13、旧世代のWebシステム要件定義書等）は
**本リポジトリの外側、プロジェクトナレッジ側**に置かれる。読み順・全体構成は
`ISMAY_v5_正本セット_INDEX.md`（プロジェクトナレッジ側）を参照。

優先順位は以下の通り（数字が小さいほど優先）：

1. プロジェクトナレッジ側の統合正本仕様書v5.0・DOC-XXシリーズ（最新版が常に正）
2. 本リポジトリの実装コード（正本と乖離があれば正本を優先し、コード側を是正する。
   ただし正本記載が実装より明らかに古い場合は差分を報告し正本側の更新を提案する）
3. 本README・`app/README.md`（実装の技術的な現状を示す二次資料。正本そのものではない）

DOC-13（Traceability・実装状況台帳）はプロジェクトナレッジ側で管理され、Gate closureごとに
更新される。**プロジェクトナレッジ側の台帳は本リポジトリへ自動反映されないため、
両者が乖離することがある。実装状況の一次情報は常に本リポジトリの実コードである。**

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
| インフラ | Docker Compose（ローカル開発機）＋ GitHub Actions CI |
| 認証 | 自前実装のOIDC準拠セッション（パスワード＋TOTP多要素、外部IdP非依存） |
| パスワードハッシュ | `hash-wasm`（Argon2id、WASM実装・ネイティブビルド不要） |
| TOTP | `otplib`（Google Authenticator等の認証アプリと互換） |
| JWT | `jose` |
| AI Worker実行方式 | Next.js `instrumentation.ts`のregister()フックにインプロセス組込み（別プロセス化はしていない。単一インスタンス運用を前提とした設計判断。詳細は`app/src/lib/worker/index.ts`冒頭コメント参照） |

開発機はUbuntu 26.04 LTS。Windows 11 PCからVSCode「Remote-SSH」で接続し、リモート上で直接編集・実行する。

---

## AI Provider構成（TBD-05: 決着済み）

旧README・一部プロジェクトナレッジ文書で「TBD-05：AI提供事業者」を未決事項としていたが、
実装は既に管理画面（`/admin/ai-providers`）で事業者・モデルを切り替え可能な
マルチプロバイダー方式（`app/src/lib/ai/registry.ts`）として決着している。
2026-08-20のカルキョンさん指示「どの事業者でも対応できるよう管理画面で切り替えできる設計にしろ」
に基づく。

| Capability | 現在の登録事業者 | 備考 |
|---|---|---|
| EXTRACTION（AI抽出） | Anthropic（Claude Haiku 4.5＝高頻度、Claude Sonnet 5＝低頻度高品質） | |
| EMBEDDING | OpenAI | |
| TRANSCRIPTION（文字起こし） | OpenAI（gpt-transcribe） | 2026-08-21確定 |
| OCR | Anthropic（Claude Vision） | 専用OCR事業者は用意しない方針 |
| SEGMENTATION（音声テーマ分割） | Anthropic（Claude Haiku 4.5） | |
| PEM_DIALOGUE（PEM初回対話） | Anthropic（Claude Sonnet 5相当） | |
| PEM_ADVICE（PEM助言・週次レビュー） | Anthropic（Claude Sonnet 5相当） | |

新しい事業者を追加する場合、対応する`AiExtractionProvider`等のインターフェース実装を作成し、
`registry.ts`の登録表へ1行追加するだけでよい。APIキー等の秘密情報はWorkspace単位で
DB(`AiProviderCredential`、暗号化)に登録するBYOK運用に加え、環境変数（`ANTHROPIC_API_KEY`等）
へのフォールバックも各Provider実装側で用意している。

**未決事項として残っている部分**：地域・データ保持・training policy（プロジェクトナレッジ側
DOC-13の`DEC-002`）は本番外部AI送信の前提として未確定のまま。事業者そのものの選定(TBD-05)とは
別の論点として引き続き保留。

---

## ディレクトリ構成

```
ismay/
├── docker-compose.yml        # postgres(pgvector) / redis / minio。すべて restart: unless-stopped
├── docker-data/               # 各コンテナの永続化データ（gitignore対象）
├── .nvmrc                     # Node 22
├── .github/workflows/ci.yml   # CI(node22/npm ci/prisma validate・generate/tsc/eslint/test:all/build)
├── scripts/                   # 再利用スクリプト(実DB受入試験 verify_gate_*.ts 等)
└── app/                        # Next.jsアプリ本体
    ├── prisma/
    │   ├── schema.prisma       # DB設計書v1.1のTBL群 ＋ v5各Gateで拡張されたmodel群
    │   └── migrations/
    ├── prisma.config.ts
    └── src/
        ├── instrumentation.ts   # AI Worker起動フック(register())
        ├── lib/
        │   ├── db.ts              # Prisma Clientシングルトン(@prisma/adapter-pg使用)
        │   ├── auth/               # 認証ロジック一式
        │   ├── ai/                 # AI Provider registry・抽出・PEM対話等
        │   ├── formation/          # Formation Session(候補生成→本人確定)ドメイン
        │   ├── pem/                # Personal Execution Model(Execution Ledger・Consent・Recompute Queue等)
        │   ├── projectContext/     # Project Context(外部連携境界)ドメイン
        │   ├── patterns/           # Case Pattern Catalog(確度計算式)
        │   ├── notifications/      # 通知(FN-NTF-01)
        │   └── worker/             # Outbox relay・AI Job・Recompute Queue等のtickループ
        ├── app/
        │   ├── api/v1/              # 全APIルート(認証/Capture/Responsibility/Formation/
        │   │                        #   PEM/ProjectContext/Admin等)
        │   ├── register/ login/     # 認証UI
        │   ├── dashboard/ today/ inbox/ responsibilities/ relations/ search/ tags/
        │   │                        # 業務系UI
        │   ├── pem/                 # PEM UI
        │   ├── project-contexts/    # Project Context UI
        │   └── admin/                # 管理コンソール(AI Provider設定・使用量)
        └── components/              # 上記画面のクライアントコンポーネント
```

現在のAPI route数・Prisma model数・migration数などの変動する数値は、リポジトリの成長に伴い
本READMEへ手書きすると即座に陳腐化するため、固定値としては記載しない。以下のコマンドで
その時点の実測値を確認すること：

```bash
cd app
grep -c "^model " prisma/schema.prisma        # Prisma model数
ls prisma/migrations | wc -l                   # migration数
find src/app/api -name "route.ts" | wc -l       # APIルート数
find src/app -name "page.tsx" | wc -l           # 画面数
find src/lib -path '*/__tests__/*.test.ts' | wc -l   # pure/invariant testファイル数
```

---

## 実装済み機能領域（2026-09-03時点、実コードベース）

以下は実装が存在する主要領域の一覧であり、各機能の完成度・受入条件はプロジェクトナレッジ側の
DOC-12（EVAL受入テスト仕様書）・DOC-13（Traceability台帳）を参照すること。本READMEは
「存在する／しない」の見取り図に留め、詳細な受入状況までは追跡しない（DOC-13が本来の役割）。

- **認証**：OIDC準拠セッション、TOTP MFA、Refresh Tokenローテーション、セッション一覧・個別失効
- **Capture→AI候補→本人決定**：テキスト/音声/画像入力、AI抽出、Responsibility化
- **Formation Session**：候補分析→質問→本人回答→確定のドメイン(`lib/formation/`)。
  Atomicity Assessment、PII分類、Source Anchor、Question Policy等を含む
- **Responsibility**：9種別、Graph/PERT、検索、タグ、Bulk操作、Recurrence/Cycle
- **Project Context**：外部連携境界、Link(PRIMARY/SUPPORTING/REFERENCE)、External Reference Conflict Queue
- **PEM(Personal Execution Model)**：Execution Ledger、Consent管理、Session Projection、
  Reason Prompt、Execution Correction(REVOKE)、Recompute Queue(checkpoint/rebuild)、
  Onboarding対話、週次レビュー・助言、データエクスポート、個別Evidence削除
- **Case Pattern Catalog**：確度計算式の基盤のみ(`lib/patterns/casePatternMath.ts`)。
  永続化スキーマ・Detector・提案API・UIは未着手(下記「既知の未完了・保留事項」参照)
- **通知**：静穏時間帯・まとめ通知
- **監査ログ**：本人スコープの一覧表示
- **CI**：GitHub Actions(node22/npm ci/prisma validate・generate/tsc/eslint/全pure test/build)

---

## 既知の未完了・保留事項

「全機能完成」ではない。以下は2026-09-03時点で明示的に未実装、または意図的に保留されている
主要項目（詳細な根拠・出典はコード内コメント、および指示書
`Claude向け_ISMAY_390c380以降_監査是正・次工程連続実装指示_2026-09-03.md`を参照）：

| 項目 | 状態 |
|---|---|
| メールアドレス確認 | **未実装**。登録時に暫定的に即時検証済み扱い(`register/route.ts`にコメント明記)。Notification基盤(provider)未確定のため |
| 管理者ロール(RBAC) | **意図的に未実装**。個人利用(1ユーザー1Workspace)を前提とし、`requireAuth`のみで認可。複数ユーザー・ロール分離が必要になった場合の拡張ポイントとしてコード内に明記済み |
| 30日Purge Job | **未実装**。アカウント削除はsoft delete(`deletedAt`)まで。物理削除ジョブは別途スケジュール実装が必要 |
| Case Pattern永続化(6 table)・Detector・提案API・UI | **未実装**。確度計算式(`casePatternMath.ts`)のみ存在。DOC-06 §5の永続化スキーマ着手前に複数の設計判断(trigger条件・embedding model選定・Formation Candidateとの接続方式)を要する |
| Metric Catalog(v4.0 10.3節の残り9指標) | **意図的に保留**。登録済みは1指標のみ。分子・分母・除外・品質等の完全な文言が業務判断待ちとコード内に明記済み |
| Activity Evidence Ledger | **未実装**。概念レベルの記述のみで具体的なデータ契約・API契約が正本に未確定 |
| Context Playbook | **未実装**。同上の理由で非推奨(想像でデータ契約を埋めない方針) |
| Planning/Reality Mode | **未着手**(既存Relation/Constraint/PERTの接続のみ部分実装) |
| TBD-17(機微データのカラムレベル暗号化方式) | 未決事項台帳で正式決定待ち。現状TOTP秘密鍵のみアプリ層AES-256-GCMで暗号化(`MFA_ENCRYPTION_KEY`使用) |

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
| `ANTHROPIC_API_KEY` | AI抽出/OCR/セグメンテーション/PEM対話・助言のフォールバック用(Workspace単位のBYOK未登録時) |
| `OPENAI_API_KEY` | Embedding/文字起こしのフォールバック用(同上) |

`.env.example`は現時点で用意されていない。上記変数がリポジトリの唯一の一次情報である
(2026-09-03時点)。

### アプリのセットアップ・開発サーバー起動

```bash
cd ~/projects/ismay/app
npm ci
npx prisma generate
npx prisma migrate deploy   # 未適用migrationの反映(prisma migrate devは対話待ちで
                              # 自動化スクリプト内でハングするため使わない)
npm run dev                  # next dev -p 13000
```

AI Workerは別プロセスではなく、Next.jsサーバー起動時に`instrumentation.ts`経由で
インプロセス起動する(`npm run dev`/`npm run start`のいずれでも自動的に動く)。

### ビルド・型チェック・Lint

```bash
cd app
npx tsc --noEmit
npm run lint
npm run build
```

### テスト

```bash
cd app
npm run test:all       # 全pure/invariant test(__tests__配下のtest.tsファイルを自動列挙、
                         # DB・外部AI通信なし。ファイル追加時も手動でscriptを足す必要はない)

# 個別に実行したい場合(デバッグ用)
npm run test:formation  # Formation Sessionドメインのみ
npm run test:pem        # PEM主要Phaseのみ
npm run test:pattern-math
```

実DB受入試験(`scripts/verify_gate_*.ts`)は個別のGate完了時にDB接続ありで手動実行するもので、
`npm run test:all`には含まれない(CIにもDB未提供のため含まれない)。DBが利用可能な状態で
個別に`node --import tsx scripts/verify_gate_XXX.ts`のように実行する。

### CI(GitHub Actions)

`.github/workflows/ci.yml`が`main`へのpush/PRごとに、node22固定環境で
`npm ci → prisma validate/generate → tsc --noEmit → eslint → test:all → build`
を実行する。DB接続を要するverify scriptとAPIキー必須のAI試験はCI対象外
(postgres+pgvectorがCI環境に未提供のため)。

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
| ダッシュボード | `http://192.168.1.11:13000/dashboard` |
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
  エラー0件になることを確認してからのみ`git push`する
- **スクリプト配置**：繰り返し使う再利用スクリプトは`scripts/`配下、DBスキーマ反映など一度きりの
  パッチスクリプトはプロジェクトルート直下に置き、適用完了後は成功・失敗を問わず
  自分自身のみを自己削除する運用とする(広いglobで他スクリプトを巻き込んで削除しない)
- **想像実装の禁止**：正本に記述のない語彙・状態・閾値・API・UIを想像で追加しない。
  不足する意思決定は`DECISION_REQUIRED`として選択肢・影響・推奨案を提示して止める
- **履歴の不可変性**：Event/Receipt/Revision/Ledgerの履歴はUPDATE/DELETEで改変せず、
  Correction/Event追記方式を守る

---

## 未決事項（TBD）

正本は `ISMAY_未決事項_変更管理台帳` （プロジェクトナレッジ側、最新版を参照）。

- TBD-02：認証方式 → **本リポジトリではOIDC準拠の自前実装として決着（2026-08-18）**
- TBD-05：AI提供事業者 → **決着済み（上記「AI Provider構成」参照）**。地域・保持・training policy等の運用面(DEC-002)は別途未決
- TBD-06：意味検索基盤 → pgvector exact cosine運用で当面決着(ANN/HNSW化はp95レイテンシ>100msまたはワークスペースあたり行数>10,000まで保留)
- TBD-17：機微データのカラムレベル暗号化方式（TOTP秘密鍵は暫定的にアプリ層AES-256-GCM）

---

## 参照設計文書（正本、プロジェクトナレッジ側）

- `ISMAY_統合正本仕様書_v5_0.md`(最上位正本)
- `01`〜`13`のDOC-XXシリーズ(用語定義、FormationSession、ProjectContext、
  ExecutionEvent/SessionProjection、Metric/CasePattern、PEMModel、Planning/Reality、
  Consent/DataGovernance、API/Event、DB物理設計、EVAL受入テスト、Traceability台帳)
- `ISMAY_v5_正本セット_INDEX.md`(読み順・全体構成の入口)
- `ISMAY_全機能仕様一覧_*.html`(機能一覧、更新日付ごとに複数版が存在することがあるため
  ファイル名の日付で最新版を確認する)

旧世代(v1.x)の設計文書群(`ISMAY_Webシステム要件定義書_v2_2.md`等)はv5正本セットへの移行元として
参照価値が残るが、v5正本セットと矛盾する場合はv5正本セットを優先する。
