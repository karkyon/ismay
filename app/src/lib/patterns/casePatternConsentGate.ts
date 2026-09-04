/**
 * Case Pattern学習(Embedding送信)向けConsent実行直前ゲート(PATTERN-DETECT-02A新設・2026-09-04)。
 * 出典: 09_ISMAY_v5_Consent_DataGovernance仕様書.md §2 Consent Catalog
 * 「CASE_PATTERN_LEARNING | 複数Contextパターン集約 | OFF」、Claude向け
 * 再監査是正・CasePattern実機能完遂指示_2026-09-04.md §3.1「必要なconsent/
 * AI送信policyを満たす」。
 *
 * [設計是正・2026-09-04、omega-dev2実DB test:all失敗を受けて] 当初案は
 * `CASE_PATTERN_LEARNING`をlib/pem/coreTypes.ts PEM_CONSENT_TYPESへ追加し、
 * 既存lib/pem/consent.ts(isConsentGranted/buildPemAuthorizationContext)を
 * そのまま再利用する設計だった。しかし
 * `src/lib/pem/__tests__/completionGate1Invariants.test.ts`が
 * 「PEM_CONSENT_TYPES/PEM_CONSENT_ACTIONSは既存語彙のまま不変」という
 * 名前どおりの不変条件を明示的に固定長5値でassert.deepEqual検証しており、
 * この追加は既存invariantへの違反だった(omega-dev2実DB test:allで実際に
 * 検出、exit 123)。
 *
 * PEM_CONSENT_TYPESはPEM(Personal Execution Model)固有のconsent語彙として
 * 意図的に閉じたunionであり、DOC-09が定める一般Consent Catalog全体(11種)の
 * サブセットに過ぎない。CASE_PATTERN_LEARNINGはPEM固有種別ではないため、
 * この閉じたunionを拡張するのではなく、PemConsentEventテーブル
 * (insert-only Consent Ledger、consentType列はDB CHECK制約の無い自由文字列)
 * を直接問い合わせる独立した経路として実装する。lib/pem/consent.tsの
 * PemConsentType型付きAPI(isConsentGranted等)は経由しない。
 *
 * [撤回時の扱い] DOC-09 §5 削除伝播に準じ、本Gateでは新規学習(embedding生成・
 * SourceLink作成・新規Pattern作成)を停止するのみとし、既存CasePattern/
 * SourceLinkの遡及削除はこのGateのscope外(削除伝播は別途専用Gateが必要、
 * 想像で実装しない)。
 */
import { db } from "@/lib/db";
import { PEM_CONSENT_POLICY_VERSION } from "@/lib/pem/consent";

/** DOC-09 §2 Consent Catalogの値そのもの。PEM_CONSENT_TYPESには含めない(上記是正参照)。 */
const CASE_PATTERN_LEARNING_CONSENT_TYPE = "CASE_PATTERN_LEARNING";

/**
 * この本人(ownerSubjectUserId)についてCASE_PATTERN_LEARNING同意が現在GRANTEDかを判定する。
 * worker(caseDetectQueueJob.ts)がeligible sourceを処理する直前に呼ぶ想定。
 *
 * lib/pem/consent.ts getConsentStateと同じ規則: 最新イベントのpolicyVersionが
 * 現在のPEM_CONSENT_POLICY_VERSIONと一致しない場合はGRANTEDとみなさない
 * (文言改定後に旧GRANTEDが自動的に有効扱いになる問題を防ぐ、既存踏襲)。
 */
export async function isCasePatternLearningConsentGrantedForOwner(
  workspaceId: string,
  ownerSubjectUserId: string,
): Promise<boolean> {
  const latest = await db.pemConsentEvent.findFirst({
    where: { userId: ownerSubjectUserId, workspaceId, consentType: CASE_PATTERN_LEARNING_CONSENT_TYPE },
    orderBy: { occurredAt: "desc" },
    select: { action: true, policyVersion: true },
  });
  if (!latest) return false;
  if (latest.policyVersion !== PEM_CONSENT_POLICY_VERSION) return false;
  return latest.action === "GRANTED";
}
