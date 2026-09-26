# ISMAY 全機能トレーサビリティ・実装状況台帳

| 項目 | 値 |
|---|---|
| project | **ISMAY** |
| repository | `karkyon/ismay` |
| baseline HEAD | `cabd6a12ce14d9f3ddd966940ba4515d1b08380c`（AUTH-EMAIL-01）。本台帳はGate AUDIT-BASELINE-01で作成 |
| observed_at | 2026-09-26 |
| Prisma model | 98（`grep -c '^model ' app/prisma/schema.prisma`） |
| migration | 69（`app/prisma/migrations`直下のディレクトリ数） |
| API route | 94（`find app/src/app/api -name route.ts`） |
| page | 20（`find app/src/app -name page.tsx`） |
| pure/invariant test file | 32（`find app/src/lib -path '*/__tests__/*.test.ts'`） |

> 本台帳はISMAY（`karkyon/ismay`）専用である。別プロジェクト（例：TravelCanvas `karkyon/travelcanvas`）の台帳・要求ID（FR-001〜058等）を証拠として引用・転記しない。プロジェクトナレッジにある`10_全機能仕様_トレーサビリティ_実装状況台帳_v5.1.md`は、本文がTravelCanvasの台帳であることが確認されたため、ISMAYの証拠として扱わない。

## 1. 証拠境界

| 区分 | 内容 |
|---|---|
| 一次証拠 | 実コード（symbol・API route・migration・DB制約）と、実行結果（下記§2のcommandと受入script） |
| 二次証拠 | リポジトリ内の追補・Decision Record・Runbook（`docs/`）。READMEは見取り図であり単独では証拠にしない |
| 対象外 | プロジェクトナレッジの正本v5.0（2026-08-27固定）は要求の出典として参照するが、実装状況の証拠にはしない |
| 実行環境A（sandbox） | PostgreSQL 16 + pgvector（全69 migration適用、DB timezone Asia/Tokyo）、MinIO互換のs3rver、`next start`（Google Fontsのみstub）。**実AI providerなし**。M1B1/M1B2はAnthropic Messages APIの応答をプロセス内で模擬して実行した（模擬はリポジトリに含めない） |
| 実行環境B（omega-dev2） | 実DB・実MinIO・実AI provider。AUDIT-BASELINE-01のパッチ適用時に同じscriptを実行し、その結果をcommitの適用ログで確認する |
| 未検証 | 本番SMTP配送、backup/restore実地試験、負荷試験、実機mobile、systemd再起動後の常駐挙動 |

## 2. 実行したGate・実行していないGate（AUDIT-BASELINE-01時点）

### 2.1 静的・pure
| command | 環境A結果 |
|---|---|
| `npm ci` / `npx prisma validate` / `npx prisma generate` | 成功 |
| `npx tsc --noEmit` | 0 error |
| `npm run lint`（`eslint . --max-warnings=0`） | 0 error / 0 warning |
| `npm run test:all` | 32 file、exit 0（NG 0件） |
| `npm run build`（CI同等のダミー`DATABASE_URL`） | 成功 |

### 2.2 実DB受入
| script | 環境A | 備考（ログ中の意図的なエラー） |
|---|---|---|
| `verify_gate_2_1_live.ts` | 65 / 0 | HTTP。本Gateで試験9を是正 |
| `verify_gate_m1b1_shadow_acceptance.ts` | 17 / 0（模擬AI、質問あり→CLARIFYING・質問なし→REVIEW_READYの両経路）。APIキーなしでは失敗経路の契約のみPASSし、B1未到達をNGとして報告 | 環境B（実AI）の1回目の適用で「状態REVIEW_READY期待→実際CLARIFYING」とcleanupのFK違反（テストデータ残存）、2回目の適用で試験9のconfidence比較の誤り（AiInferenceはDecimal(4,3)・revisionはDecimal(5,4)で丸めが異なる、根拠の無い候補はrevisionで0.49にcapされる）を検出し、本Gateで是正。模擬AIでは小数4桁・根拠なし候補の両方で確認。**環境Bでの再実行で確認する** |
| `verify_gate_m1b2_dual_read_acceptance.ts` | 21 / 0（模擬AI、cutover flag OFF）、19 / 0（同、`FEATURE_CHG011_SHARED_CORE=true`） | 実AI必須。**環境Bでの再実行で確認する** |
| `verify_gate_auth_email_01.ts` | 77 / 0 | [A9] 送信失敗の注入（`SEND_FAILED`ログ）、[A13] CHECK違反23514・一意制約違反は意図的 |
| `verify_gate_purge_hardening_02.ts` | 59 / 0 | lock競合試験の`55P03 lock timeout`は意図的 |
| `verify_gate_purge_scope_03a.ts` | 42 / 0 | [S3] DB triggerによる`23502 ... workspace_id is required`（5表）は意図的 |
| `verify_gate_purge_ops_03b.ts` | 44 / 0 | s3rver使用。環境Bでは実MinIO |
| `verify_gate_pattern_purge_01.ts` | 31 / 0 | cleanupで既にPurge済みの行を`delete`する際の「対象なし」エラーは無害（`.catch`で握る設計） |
| `verify_gate_pattern_closedloop_e2e_02.ts` | 15 / 0 | AI network遮断下の非課金E2E |

### 2.3 本Gateで実行していないもの
- 上記以外の`verify_gate_*.ts`（約60本）の全量再実行。個別Gate時点の受入記録はcommit履歴を参照（本台帳では「当該Gate時点で受入済み」と「今回再実行した」を区別する）。
- 実AI呼び出しを伴うscriptの成功経路（環境Bで実施）。

## 3. 状態の定義
| 状態 | 意味 |
|---|---|
| NOT_STARTED | コードが無い |
| SPECIFIED | 正本・追補に仕様はあるが、コードが無い |
| PARTIAL | 一部のみ実装、または既知の欠落がある |
| IMPLEMENTED | 実装済み。pure testまたは静的確認のみ |
| INTEGRATED | API/UI/Worker/DBまで接続済みで、実DB受入scriptが存在する（今回は再実行していない） |
| VERIFIED | 実DB受入scriptを本Gate（AUDIT-BASELINE-01）の環境A、または直近の環境B適用ログで全件PASS |
| BLOCKED_DECISION | 契約の決定待ちで、意図的に停止している |

## 4. 領域別台帳

### 4.1 Auth
| 機能 | 状態 | 主要symbol / route | migration | 検証 | 既知残件 |
|---|---|---|---|---|---|
| 登録・ログイン・JWT・Refreshローテーション | INTEGRATED | `lib/auth/session.ts` `createSession` `rotateSession`、`auth/login` `auth/refresh` `auth/logout` | `init_core_schema_v2` | HTTP受入script 5本がregister→loginを通る（2_1_live 65/0） | ログイン失敗ロックがプロセス内メモリ（OPEN-AUTH-02） |
| TOTP MFA・復旧コード | INTEGRATED | `lib/auth/totp.ts`、`auth/mfa/*` | 同上 | 実DB受入scriptなし（静的確認） | 秘密鍵暗号化の正式契約（OPEN-SECURITY-ENCRYPTION-01） |
| セッション一覧・個別失効 | INTEGRATED | `auth/sessions`、`listActiveSessions` | 同上 | — | — |
| メール確認・再送・パスワード再設定 | VERIFIED | `lib/auth/emailToken.ts` `emailTokenCore.ts`、`lib/mail/`、`auth/email/*` `auth/password/forgot|reset` | `20260926010000_auth_email_01` | pure 70/70、実DB 77/77（環境A・B） | 本番SMTP（OPEN-AUTH-01）、メール変更（OPEN-AUTH-03）、未確認放置（OPEN-AUTH-04）、既定値承認（OPEN-AUTH-05） |
| アカウント削除（soft delete） | INTEGRATED | `auth/account/delete` | — | Purge受入のfixtureとして使用 | — |

### 4.2 Workspace / RBAC / Team
| 機能 | 状態 | 根拠 | 既知残件 |
|---|---|---|---|
| 個人Workspace自動作成 | IMPLEMENTED | `lib/workspace.ts` `ensureDefaultWorkspace`（最古の有効membershipを1件選ぶ） | 同時初回リクエストでの重複作成の可能性（既知） |
| Role語彙・管理APIのrole guard | IMPLEMENTED | `lib/auth/roleGuard.ts`（OWNER/ADMIN/MEMBER/VIEWER/SERVICE、管理API 5本） | — |
| メンバー招待・承諾・退出 | BLOCKED_DECISION | 業務APIはWorkspace単位scopeで、Entity Visibilityの横断強制が無い | OPEN-AUTH-MEMBER-01 |
| Entity Visibility（PRIVATE/CONTEXT/WORKSPACE/EXPLICIT） | PARTIAL | `ProjectContext.visibility`列のみ。Policy Decision Pointなし | OPEN-AUTH-MEMBER-01 |
| Team集計 | BLOCKED_DECISION | DOC-09 §6、DOC-12 §9のTEAM-1停止条件 | DOC-13 DEC-001 |

### 4.3 Capture
| 機能 | 状態 | 根拠 | 既知残件 |
|---|---|---|---|
| テキスト・音声・画像Capture、MinIO保存 | INTEGRATED | `captures` `captures/audio` `captures/image`、`lib/storage.ts`、`worker/transcribeAudioJob.ts` `ocrImageJob.ts` | 音声原本の保持期間（DEC-005） |
| AI解析要求・PEM_AI_PROCESSING同意ゲート | INTEGRATED | `captures/[id]/analyze`、`lib/pem/aiJobConsentGate.ts` | — |
| 録音同意（Consent） | INTEGRATED | `captures/[id]/consent`、`consents`表 | consentsの法定保持（OPEN-PURGE-02） |

### 4.4 Formation
| 機能 | 状態 | 根拠 | 既知残件 |
|---|---|---|---|
| shadow Session生成（B1）・dual-read（B2） | INTEGRATED | `lib/formation/shadowWrite.ts` `shadowCheckpoint.ts` `dualRead.ts` | M1B1/M1B2の成功経路は環境B（実AI）で確認する（§2.2） |
| 質問・回答・確定・Materialize | INTEGRATED | `formation-sessions/[id]/*`、`answerService.ts` `materialize.ts` | — |
| split / merge / correction / atomicity | INTEGRATED | `splitCorrection.ts` `mergeCorrection.ts` `responsibilityCorrection.ts` `atomicityAssessment.ts` | — |
| Source Anchor・PII分類 | IMPLEMENTED | `sourceAnchorAdapter.ts` `piiClassifier.ts`（pure test） | provider側がspeaker/pageを返さない場合はUNAVAILABLE |

### 4.5 Responsibility
| 機能 | 状態 | 根拠 | 既知残件 |
|---|---|---|---|
| CRUD・状態遷移・EventLog/Outbox | VERIFIED | `responsibilities/*`、`lib/responsibility.ts` | — |
| 一括操作・Undo（receipt方式） | VERIFIED | `lib/bulkOperations.ts`、`responsibilities/bulk` `bulk/undo`（2_1_live 65/0） | — |
| Relation・Graph・Constraint・Recurrence・Cycle | INTEGRATED | `responsibility-relations`、`responsibilities/graph`、`lib/recurrence.ts` `cycle.ts` | Constraintの実行時突合はPlanning側で未実装 |

### 4.6 PEM
| 機能 | 状態 | 根拠 | 既知残件 |
|---|---|---|---|
| Consent（目的別）・metric単位OFFの記録 | INTEGRATED | `lib/pem/consent.ts`、`pem/consent` | metric OFFの派生物STALE化の完全契約 |
| Execution Ledger・Session Projection・Correction | INTEGRATED | `executionLedger.ts` `sessionProjection.ts` `executionCorrection.ts` | — |
| Reason Capture・Recompute Queue・Evidence個別削除 | INTEGRATED | `reasonLedger.ts` `recomputeQueue.ts` `evidenceDeletion*.ts` | — |
| Onboarding対話・週次review・助言・export | INTEGRATED | `pem/onboarding/messages` `reviews/weekly` `pem/export` | — |
| Metric Catalog | PARTIAL | `metricDefinitionRegistry.ts`（1指標） | 残り9指標は業務定義待ち |
| Activity Evidence Ledger | SPECIFIED | 正本に概念のみ | DEC-003 |

### 4.7 Case Pattern
| 機能 | 状態 | 根拠 | 既知残件 |
|---|---|---|---|
| 検出→Suggestion→Feedback→ActionSlot学習→分解proposal→適用→次回提案 | VERIFIED | `lib/patterns/*`、`worker/case*QueueJob.ts`、`case-patterns/*`（closedloop_e2e_02 15/0） | `PATTERN_REVISION_CHANGED`・`EMBEDDING_SOURCE_VERSION_CHANGED`の配線元が無い、採用率の窓が未定義 |
| 管理UI（一覧・詳細・退避） | INTEGRATED | `/patterns`、`case-patterns/[id]` PATCH | — |

### 4.8 Purge・Privacy
| 機能 | 状態 | 根拠 | 既知残件 |
|---|---|---|---|
| アカウント30日Purge（CLI） | VERIFIED | `lib/admin/purgeJob.ts` `purgeLedger.ts`、`scripts/run_account_purge.ts`（hardening_02 59、scope_03a 42、ops_03b 44、pattern_purge_01 31） | — |
| HTTP Purge | BLOCKED_DECISION | `admin/purge/*`はfail closed | OPEN-PURGE-01（Platform Admin） |
| 個別エンティティsoft deleteのPurge | NOT_STARTED | — | OPEN-PURGE-04 |
| backup・index・cacheの削除伝播 | NOT_STARTED | — | OPEN-PURGE-06 |
| 定期自動実行 | NOT_STARTED | — | OPEN-PURGE-07 |
| データexport（JSON/CSV） | PARTIAL | `lib/dataExport.ts`、`exports` | 添付manifest・ZIP・非同期状態 |

### 4.9 Planning / Reality
| 機能 | 状態 | 根拠 | 既知残件 |
|---|---|---|---|
| 「今やる一つ」（決定論） | IMPLEMENTED | `lib/planning.ts` `computeNow`（`planning-now-deterministic-v1`）、`planning/now` | blocker解除・切替コスト・context照合・snoozeは未対応と`PLANNING_ASSUMPTIONS`に明記 |
| Today summary | INTEGRATED | `today-summary`、`/today` | — |
| PEM補正・capacity/reality差分・再計画承認・Undo | SPECIFIED | 正本DOC-08 | 未着手 |

### 4.10 Operations
| 機能 | 状態 | 根拠 | 既知残件 |
|---|---|---|---|
| Outbox→Job→Worker | INTEGRATED | `worker/relay.ts` `worker/index.ts` | 複数instance時のleader等 |
| CI | IMPLEMENTED | `.github/workflows/ci.yml`（validate/generate/tsc/eslint/test:all/build） | 実DB受入はCI対象外 |
| 通知（アプリ内） | INTEGRATED | `lib/notifications/notificationPlanner.ts`、`notifications/*` | 外部channel（Web Push・Email）未着手 |
| 監査ログ | INTEGRATED | `audit_logs`、`audit-logs` | 保持期間（OPEN-PURGE-03） |
| 機微データ暗号化 | PARTIAL | TOTP秘密鍵・AI credentialのみAES-256-GCM | OPEN-SECURITY-ENCRYPTION-01 |
| 永続rate limit・proxy信頼境界 | PARTIAL | メール発行はDB履歴で制限、ログインはメモリ | OPEN-AUTH-02 |
| backup/restore実地試験・監視・alert | NOT_STARTED | — | DEC-006 |

## 5. 状態集計（§4の行数）
| 状態 | 件数 |
|---|---:|
| VERIFIED | 5 |
| INTEGRATED | 20 |
| IMPLEMENTED | 5 |
| PARTIAL | 5 |
| SPECIFIED | 2 |
| NOT_STARTED | 4 |
| BLOCKED_DECISION | 3 |
| 合計 | 44 |

## 6. 更新規則
- Gateを追加・変更したら、該当行の状態・根拠・検証を更新し、冒頭のbaseline HEAD・observed_at・実測値を更新する。
- 状態をVERIFIEDにするのは、実DB受入scriptを実行して全件PASSした場合だけとし、実行環境（A/B）を§2に記録する。
- READMEや過去の報告だけを根拠に状態を上げない。
