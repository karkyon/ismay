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
 * [Gate PEM-CONSENT-JOB-CANCELで実装済み] 受入条件の後半「既存Jobも実行前
 * cancel」。`aiExtractJob.ts`のJob claim後・AI Provider呼び出し直前で
 * `checkAiJobConsentAllowed`を呼ぶ。
 *
 * [Gate PEM-CONSENT-ENQUEUE-GATEで追加] 受入条件の前半「撤回と同時に新規Job
 * enqueue不可」。Capture作成/解析要求/文字起こし・OCR完了後の自動チェーンの
 * 計4経路(captures/route.ts、captures/[id]/analyze/route.ts、
 * transcribeAudioJob.ts、ocrImageJob.ts)全てで、CaptureAnalysisRequested.v1
 * (=AI_EXTRACT Jobの発生源)を発行する直前に`isAiProcessingConsentGrantedForUser`
 * または`checkAiJobConsentAllowed`を呼ぶ。
 *
 * [scope宣言・対象Job] `aiExtractJob.ts`(AI_EXTRACT)の実行前チェックのみ実装
 * 済み。`ocrImageJob.ts`/`transcribeAudioJob.ts`/`batchPollJob.ts`自体の
 * AI呼び出し(音声文字起こし・OCR自体)の実行前チェックは、これらがPEM_AI_
 * PROCESSING以外の目的(音声/画像入力自体の変換であり、Formation解析とは
 * 別の処理)に用いられるため対象外とする(そのAI呼び出し自体を止める根拠が
 * 正本に無い)。これらのJobが完了後に自動発行するCaptureAnalysisRequested.v1
 * (=その後のFormation解析への連鎖)だけをゲートする。
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

/**
 * [PEM-CONSENT-ENQUEUE-GATE新設・2026-09-02] DOC-09 9章「撤回と同時に新規Job
 * enqueue不可」の前半部分。まだCaptureが作成されていない時点(POST /captures本体)
 * でも呼べるよう、userId起点でPEM_AI_PROCESSING同意の有無だけを判定する軽量版。
 * captureIdが既に確定している場合はcheckAiJobConsentAllowed(captureId)を使う方が
 * tenant/所有者を検証できるため望ましいが、Capture作成前のゲート判定という
 * 性質上、そちらは使えない箇所(captures/route.ts)向けに用意する。
 */
export async function isAiProcessingConsentGrantedForUser(userId: string): Promise<boolean> {
  const ctx = await buildPemAuthorizationContext(userId, userId);
  return isConsentGranted(ctx, "PEM_AI_PROCESSING");
}
