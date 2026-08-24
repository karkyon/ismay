# PEM Phase 0G 衝突台帳

出典: ISMAY_PEMサブシステム_統合正本仕様書_v4_0への批評「Phase 0G-D: 旧PEMとの衝突台帳」。

既存Prisma(`app/prisma/schema.prisma`)のPEM関連モデルと、v4.0仕様との不一致を
一覧化し、各モデルの扱い方針を決定する。この台帳が確定するまでPhase 0S/0Aの
DBスキーマ実装(EvidenceDeletionEvent・Consent Event化等)には着手しない。

| 既存モデル | v4.0との不一致 | 方針 | 対応Phase |
|---|---|---|---|
| `PemObservation.deletedAt` | v4.0はinsert-only + `EvidenceDeletionEvent`追記方式(16.3節)。既存は行への直接UPDATE | Migration(投影テーブルへ置換) | Phase 0C |
| `PemHypothesis.userVerdict`(CONFIRMED/REJECTED/TEMPORARY/PENDING) | v4.0は`UNREVIEWED/AGREED/DISAGREED/PARTIALLY_AGREED`(12.2節)。TEMPORARYは評決ではなくTemporary State側の概念 | Migration(値のマッピング表を別途作成し、データ移行を伴う) | Phase 0C |
| `PemOnboardingConversation.userId @unique` | v4.0は`INITIAL/RECALIBRATION/MAJOR_CHANGE`を複数履歴として許可(11章)。既存は1ユーザー1件固定・対話全体をJson上書き | Replace(新テーブルへ置換。旧データはbackfill) | Phase 0E |
| `PemWeeklyReview @@unique([userId, weekStart])` | v4.0はreview generation versionを要求(15章)。公開後の改訂を新versionとして残す必要がある | Migration(generationVersion列追加) | Phase 4/5 |
| `Consent.withdrawnAt`(同一行へのUPDATE想定) | v4.0はConsent Eventをinsert-only化(16.1節) | Replace(`PemConsentEvent`新設、既存Consentは移行) | Phase 0S |

## 凡例

- **そのまま維持**: v4.0と矛盾しない、または影響範囲がPEM外のため変更不要
- **Rename**: 列・値の名称のみ変更(データ移行は軽微)
- **Migration**: スキーマ変更+データ移行を伴う
- **Replace**: 新設テーブルへ置換し、旧テーブルは非推奨化
- **Deprecated**: 将来削除予定として維持のみ
- **Data backfill対象**: 既存データを新形式へ変換する処理が必要

## 現時点の結論

上記5件はいずれも「そのまま維持」ではなく、Phase 0S以降のDBスキーマ変更を伴う
Migration/Replace対象である。Phase 0G(本パッチ)はコード上の正本語彙・定義を
確定するに留め、実際のマイグレーションはPhase 0S(Consent)・Phase 0C(Model Layer)・
Phase 0E(Bootstrap再設計)・Phase 4/5(Weekly Review)で個別に実施する。

## 2026-08-24 訂正(Phase 0S調査結果)

既存 `Consent` モデル(captureId/subjectId/purpose/scope)は、実装コード全体をgrep調査した結果、アプリケーションコードから一切参照されていないことを確認した(FN-PRV-02向けに定義されたが未配線のモデル)。当初「Replace対象」としていたのは誤りで、PEMのConsent(`PemConsentEvent`、Phase 0Sで新設)とは無関係の別モデルとして併存させる。上記表の該当行は「そのまま維持(PEMとは無関係)」に訂正する。
