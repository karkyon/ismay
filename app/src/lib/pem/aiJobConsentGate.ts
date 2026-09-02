/**
 * PEM AI Job Consent実行直前ゲート(v5新設)。
 * 出典: DOC-09(Consent・Data Governance仕様書) 9章「受入条件」
 * 「撤回と同時に新規Job enqueue不可、既存Jobも実行前cancel」、CHG-073
 * 「Job/AiRun: authorizationDecisionIdと実行直前再評価、queue中撤回対応」。
 *
 * [発見・重要] `PEM_AI_PROCESSING`はcoreTypes.tsのPEM_CONSENT_TYPESに定義
 * されて以来、コード全体を検索してもJob実行経路・API経路のどこからも一度も
 * 参照・判定されていなかった(定義されているだけで未配線)。本ファイルが、
 * このConsent種別を実際に使う最初の実装になる。
 *
 * [scope宣言] DOC-09受入条件の後半「既存Jobも実行前cancel」のみを実装する。
 * 前半「撤回と同時に新規Job enqueue不可」は、Capture作成API
 * (captures/route.ts他、audio/image route等の複数経路)全体への影響範囲の
 * 特定・検証に別途時間を要するため、このGateのscope外とし次回以降に回す
 * (想像で影響範囲を過小評価して同時に手を広げない)。
 *
 * [scope宣言・対象Job] このGateでは`aiExtractJob.ts`(AI_EXTRACT)のみが
 * この関数を呼ぶ。`ocrImageJob.ts`/`transcribeAudioJob.ts`/`batchPollJob.ts`
 * も同じConsent種別の対象になり得るが、それぞれのJob構造を個別に確認して
 * からでなければ安全に組み込めないため、このGateでは変更しない。
 */
import { db } from "@/lib/db";
import { buildPemAuthorizationContext } from "./authorizationBoundary";
import { isConsentGranted } from "./consent";

export type AiJobConsentCheckResult =
  | { allowed: true }
  | { allowed: false; reason: "CAPTURE_NOT_FOUND" }
  | { allowed: false; reason: "CONSENT_WITHDRAWN" };

/**
 * 指定されたCaptureの作成者(subjectUserId)について、現時点のPEM_AI_PROCESSING
 * 同意状態を再評価する。Job claim後・実際のAI Provider呼び出し前に呼ぶ想定。
 *
 * Captureが見つからない場合もCAPTURE_NOT_FOUNDとして不許可を返す(Job自体が
 * 無効なpayloadを参照している異常系であり、実行を進めるべきではないため)。
 */
export async function checkAiJobConsentAllowed(captureId: string): Promise<AiJobConsentCheckResult> {
  const capture = await db.capture.findUnique({
    where: { id: captureId },
    select: { workspaceId: true, createdById: true },
  });
  if (!capture) {
    return { allowed: false, reason: "CAPTURE_NOT_FOUND" };
  }

  const ctx = await buildPemAuthorizationContext(capture.createdById, capture.createdById);
  const granted = await isConsentGranted(ctx, "PEM_AI_PROCESSING");
  if (!granted) {
    return { allowed: false, reason: "CONSENT_WITHDRAWN" };
  }
  return { allowed: true };
}
