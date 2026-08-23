import { z } from "zod";

/**
 * FN-PEM-03 助言(AI-07)・週次レビュー(AI-08)のスキーマ。
 * 出典: ISMAY_AI・PEM設計書v1.0 9〜10章、機能別詳細設計書v1.1 14章。
 * lib/ai/pemSchema.ts(FN-PEM-01)と同じ二重管理方針。
 */

// ---- AI-07 PEM助言(仮説生成) ----

export const PemHypothesisDraftSchema = z.object({
  /// 「あなたは〜」等の人格断定を避けた仮説文(§10「曖昧さより最初の成果の遠さが影響している
  /// 可能性」のような、可能性止まりの表現)。SafetyValidatorでも二重チェックする。
  statement: z.string().min(1).max(500),
  confidence: z.number().min(0).max(1),
  /// §10「小さな実験」。具体的で試しやすい提案文。
  experimentSuggestion: z.string().min(1).max(300),
});
export type PemHypothesisDraft = z.infer<typeof PemHypothesisDraftSchema>;

export const PEM_HYPOTHESIS_TOOL_NAME = "submit_pem_hypothesis_draft";

export const PEM_HYPOTHESIS_TOOL_JSON_SCHEMA = {
  type: "object",
  properties: {
    statement: { type: "string", description: "観察から示唆される仮説文(可能性止まりの表現、人格断定禁止)" },
    confidence: { type: "number", description: "0〜1。母数・差の大きさから妥当な確度を判断すること" },
    experimentSuggestion: { type: "string", description: "本人が試しやすい具体的な小さな実験の提案文" },
  },
  required: ["statement", "confidence", "experimentSuggestion"],
} as const;

// ---- AI-08 週次レビュー ----

export const PemWeeklyReviewDraftSchema = z.object({
  /// 与えられた実数値(fulfilledCount等)に基づく気づき文。数値を新たに作らないこと。
  strengthStatement: z.string().min(1).max(500).nullable(),
  experimentSuggestion: z.string().min(1).max(300).nullable(),
});
export type PemWeeklyReviewDraft = z.infer<typeof PemWeeklyReviewDraftSchema>;

export const PEM_WEEKLY_REVIEW_TOOL_NAME = "submit_pem_weekly_review_draft";

export const PEM_WEEKLY_REVIEW_TOOL_JSON_SCHEMA = {
  type: "object",
  properties: {
    strengthStatement: {
      type: ["string", "null"],
      description: "与えられた実績データから示唆される強み・気づきの文章(データが無ければnull)。数値を新たに作らないこと",
    },
    experimentSuggestion: {
      type: ["string", "null"],
      description: "来週試すとよい小さな改善実験の提案(根拠が無ければnull)",
    },
  },
  required: ["strengthStatement", "experimentSuggestion"],
} as const;
