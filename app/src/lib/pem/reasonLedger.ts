/**
 * PEM Reason Prompt / Execution Reason Ledger(Phase 0C-1-2)。
 * 出典: ISMAY_PEMサブシステム_統合正本仕様書_v4_0 8.2節・8.3節。
 *
 * Phase 0C-1(旧版)は、reason文字列をResponsibilityExecutionEvent.metadataへ
 * {reason: string}として格納するだけだった。v4.0 8.2節・8.3節は、Reason Promptの
 * 提示・回答状況をinsert-onlyの独立したLedgerとして記録することを要求する。
 * 本ファイルはその記録層を実装する(metadata.reasonは読み取り箇所が無く実害が
 * 無いため削除しない。ExecutionReasonAnswerが正本、metadata.reasonは冗長な
 * 副次コピーとして残る)。
 *
 * [既知の簡略化] 現行UIには、Reason入力を「配信(DELIVERED)→表示(DISPLAYED)→回答」
 * という別々のクライアント往復として区別する仕組みが無い(transitions/route.tsの
 * reasonフィールドは遷移リクエストと同時に1回で送られる)。そのため
 * recordReasonPromptAndAnswer()は、TRIGGERED記録の直後、reasonの有無に応じて
 * ANSWERED(+回答レコード作成)またはSKIPPEDを続けて記録するに留める。
 * DELIVERED/DISPLAYED/EXPIRED/DELIVERY_FAILEDは、将来フロントエンドが配信状況を
 * 通知するAPIを持った際に拡張する(今回は届く信号が無いため生成しない)。
 */
import type { Prisma } from "@/generated/prisma/client";
import type { PemAuthorizationContext } from "./authorizationBoundary";

export const REASON_PROMPT_STATES = [
  "TRIGGERED",
  "DELIVERED",
  "DISPLAYED",
  "ANSWERED",
  "SKIPPED",
  "EXPIRED",
  "DELIVERY_FAILED",
] as const;
export type ReasonPromptState = (typeof REASON_PROMPT_STATES)[number];

export const EXECUTION_REASON_QUESTION_VERSION = "v1";

/** db非依存の純粋判定(テスト容易性のため分離)。 */
export function decidePromptOutcome(reason: string | undefined | null): "ANSWERED" | "SKIPPED" {
  const trimmed = reason?.trim();
  return trimmed ? "ANSWERED" : "SKIPPED";
}

export interface RecordReasonPromptParams {
  tx: Prisma.TransactionClient;
  ctx: PemAuthorizationContext;
  /** このPromptを発生させたResponsibilityExecutionEvent.id。 */
  triggerEventId: string;
  reason?: string;
}

/**
 * requiresReasonPrompt=trueのExecution Event記録直後に呼ぶ(executionLedger.ts参照)。
 * 同一triggerEventIdに対し複数回呼ばれることは無い想定(Execution Event自体が
 * 1回しか作られないため)だが、reason_prompts.trigger_event_idのunique制約が
 * 二重記録に対する最終防御線となる。
 */
export async function recordReasonPromptAndAnswer(params: RecordReasonPromptParams): Promise<void> {
  const { tx, ctx, triggerEventId, reason } = params;

  const prompt = await tx.reasonPrompt.create({
    data: {
      workspaceId: ctx.tenantId,
      subjectUserId: ctx.subjectUserId,
      triggerEventId,
    },
  });

  await tx.reasonPromptStateEvent.create({
    data: { promptId: prompt.id, state: "TRIGGERED" satisfies ReasonPromptState },
  });

  const outcome = decidePromptOutcome(reason);

  if (outcome === "SKIPPED") {
    await tx.reasonPromptStateEvent.create({
      data: { promptId: prompt.id, state: "SKIPPED" satisfies ReasonPromptState },
    });
    return;
  }

  await tx.reasonPromptStateEvent.create({
    data: { promptId: prompt.id, state: "ANSWERED" satisfies ReasonPromptState },
  });

  const answeredAt = new Date();
  await tx.executionReasonAnswer.create({
    data: {
      workspaceId: ctx.tenantId,
      subjectUserId: ctx.subjectUserId,
      promptId: prompt.id,
      triggerEventId,
      reasonCode: null,
      aiClassifiedReasonCode: null,
      freeText: reason!.trim(),
      structuredDetail: undefined,
      questionVersion: EXECUTION_REASON_QUESTION_VERSION,
      revisionOfAnswerId: null,
      answeredAt,
    },
  });
}
