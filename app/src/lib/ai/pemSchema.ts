import { z } from "zod";

/**
 * FN-PEM-01 初回対話(AI-06 PEM対話)のスキーマ。
 * 出典: ISMAY_AI・PEM設計書v1.0 7章(PEM情報モデル)・8章(初回対話)、
 *       API・イベント設計書v1.1 4.5節(POST /pem/onboarding/messages)。
 *
 * lib/ai/schema.ts(FN-AI-01)と同じ二重管理方針: zodスキーマは「保存前の最終防衛線」、
 * PEM_ONBOARDING_TOOL_JSON_SCHEMAは「モデルに構造化出力を強制する側」。
 */

export const CONVERSATION_STATES = [
  "ROLE",
  "CURRENT_LOAD",
  "FIXED_CONSTRAINTS",
  "EXECUTION_CONTEXT",
  "VALUES",
  "REVIEW",
  "DONE",
] as const;
export type ConversationState = (typeof CONVERSATION_STATES)[number];

/** PEM設計書8.1節の会話ブロック順序。REVIEW/DONEは対話ブロックではなく確認・終了状態。 */
export const CONVERSATION_STATE_ORDER: ConversationState[] = [
  "ROLE",
  "CURRENT_LOAD",
  "FIXED_CONSTRAINTS",
  "EXECUTION_CONTEXT",
  "VALUES",
  "REVIEW",
  "DONE",
];

const ProposedFactSchema = z.object({
  /// PEM設計書7章の区分。初回対話ではFACT(本人確認済み)とSELF_REPORT(未確認発言)のみを扱う。
  kind: z.enum(["FACT", "SELF_REPORT"]),
  statement: z.string().min(1).max(500),
});

const ProposedHypothesisSchema = z.object({
  statement: z.string().min(1).max(500),
  confidence: z.number().min(0).max(1),
});

export const PemOnboardingTurnResultSchema = z.object({
  /// ユーザーへ表示するメッセージ本文(次の質問を含む場合がある)。1ターン最大3問(FR-PEM-01/02)。
  assistantMessage: z.string().min(1).max(2000),
  proposedFacts: z.array(ProposedFactSchema).max(10).default([]),
  proposedHypotheses: z.array(ProposedHypothesisSchema).max(5).default([]),
  /// このモデルが「現在のブロックについて最低限の情報が得られた」と判断したか。
  /// trueの場合、呼び出し元(pemOnboarding.ts)が次のConversationStateへ進める。
  blockComplete: z.boolean(),
});
export type PemOnboardingTurnResult = z.infer<typeof PemOnboardingTurnResultSchema>;

export const PEM_ONBOARDING_TOOL_NAME = "submit_pem_onboarding_turn";

export const PEM_ONBOARDING_TOOL_JSON_SCHEMA = {
  type: "object",
  properties: {
    assistantMessage: { type: "string", description: "ユーザーへ表示する返答・次の質問(1ターン最大3問)" },
    proposedFacts: {
      type: "array",
      items: {
        type: "object",
        properties: {
          kind: { type: "string", enum: ["FACT", "SELF_REPORT"] },
          statement: { type: "string" },
        },
        required: ["kind", "statement"],
      },
      description: "ユーザーの発言から抽出した事実・自己申告候補",
    },
    proposedHypotheses: {
      type: "array",
      items: {
        type: "object",
        properties: {
          statement: { type: "string" },
          confidence: { type: "number", description: "0〜1" },
        },
        required: ["statement", "confidence"],
      },
      description: "初回対話時点で示唆される暫定仮説(母数1件のため、確度は低めに申告すること)",
    },
    blockComplete: {
      type: "boolean",
      description: "現在の会話ブロックについて最低限の情報が得られたか(次ブロックへ進めてよいか)",
    },
  },
  required: ["assistantMessage", "blockComplete"],
} as const;
