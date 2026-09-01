import { db } from "@/lib/db";

/**
 * app/src/lib/ai/consentPolicy.ts
 *
 * [M1-B6C-1新設・2026-08-31指示書§3.3「Consent再評価」]
 * 従来`checkAiPolicyAndConsent`は`ai/extract.ts`内のprivate関数として、
 * `runExtractionForCapture`(REALTIME抽出のqueue取り出し直後)からのみ呼ばれていた。
 * Formation shadow reconciliation worker(shadowCheckpoint.ts)がcheckpoint claim
 * 直後に同じ判定を再評価する必要が生じたため、共通moduleへ抽出した
 * (指示書「Realtime/Batch/OCR/Transcription/Formation reconciliationで同じ
 * policy serviceを使う」の第一歩。Transcription/OCR自体への同サービス接続は
 * このPatchのscope外であり、別Gateで扱う=想像で広げない)。
 *
 * ロジック自体はextract.tsから移動しただけで変更していない。
 */

export interface AiPolicyCheckResult {
  allowed: boolean;
  reason: string;
}

/**
 * Domain AI policyとCapture Consent(MEETING同意)を評価する。
 * 呼び出し時点の最新DB状態を毎回読むため、キャッシュされた古い同意状態を
 * 信頼しない(「Provider呼出し直前・結果永続化直前に再評価する」の基礎)。
 */
export async function checkAiPolicyAndConsent(captureId: string): Promise<AiPolicyCheckResult> {
  const capture = await db.capture.findUniqueOrThrow({
    where: { id: captureId },
    include: { domain: true, consent: true },
  });

  // Domain AI policy: [推論・MVP暫定] aiPolicy.aiReferenceAllowed===false のみ明示的に拒否。
  // 未設定(null)は許可扱い(ensureDefaultWorkspaceが作る既定Domainはaipolicy未設定のため)。
  const policy = capture.domain?.aiPolicy as { aiReferenceAllowed?: boolean } | null | undefined;
  if (policy?.aiReferenceAllowed === false) {
    return { allowed: false, reason: "このDomainはAI参照が許可されていません(Domain AI policy)" };
  }

  // FN-PRV-02: MEETINGは同意必須。撤回済み・期限切れも再解析を拒否する(4.8節の例外規定)。
  if (capture.sourceType === "MEETING") {
    if (!capture.consent) {
      return { allowed: false, reason: "会議録音の同意が未登録です" };
    }
    if (capture.consent.withdrawnAt) {
      return { allowed: false, reason: "会議録音の同意が撤回されています" };
    }
    if (capture.consent.expiresAt && capture.consent.expiresAt.getTime() < Date.now()) {
      return { allowed: false, reason: "会議録音の同意保持期限が切れています" };
    }
  }

  return { allowed: true, reason: "" };
}
