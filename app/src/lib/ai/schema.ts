import { z } from "zod";
import { RESPONSIBILITY_TYPES } from "@/lib/responsibility";

/**
 * FN-AI-01 責任候補抽出のスキーマ。
 * 出典: ISMAY_AI・PEM設計書v1.0 3章「責任抽出スキーマ」。
 *
 * [重要] UNKNOWNをHard deadlineへ昇格しない、という設計書の明記事項は
 * スキーマ検証だけでは強制できないため、extract.ts側で追加ガードする。
 */

export const DATE_MEANINGS = ["HARD_DEADLINE", "SOFT_TARGET", "FOLLOW_UP", "EVENT", "UNKNOWN"] as const;

const DateMentionSchema = z.object({
  rawExpression: z.string().min(1).max(200),
  /// ISO 8601。解釈不能な場合はモデルが省略してよい(z.undefined相当)
  normalizedAt: z.string().datetime().optional(),
  meaning: z.enum(DATE_MEANINGS),
  timezone: z.string().min(1).max(64),
  confidence: z.number().min(0).max(1),
});

const EvidenceSpanSchema = z.object({
  /// Capture.rawText内の文字インデックス(0始まり、endは排他的)。UI側でハイライト表示に使う。
  start: z.number().int().min(0),
  end: z.number().int().min(0),
});

export const ResponsibilityCandidateSchema = z
  .object({
    candidateId: z.string().min(1).max(64),
    type: z.enum(RESPONSIBILITY_TYPES),
    title: z.string().min(1).max(300),
    description: z.string().max(20000).optional(),
    actor: z.string().max(200).optional(),
    counterparty: z.string().max(200).optional(),
    dateMentions: z.array(DateMentionSchema).max(10).default([]),
    completionCondition: z.string().max(2000).optional(),
    negationOrChange: z.string().max(2000).optional(),
    evidenceSpans: z.array(EvidenceSpanSchema).min(1).max(20),
    confidence: z.number().min(0).max(1),
    unknowns: z.array(z.string().max(200)).max(10).default([]),
    // [2026-08-20追加] カルキョンさんの指示「重要度・親子関係の自動推定」に対応。
    // 1(低)〜5(高)。原文に重要度の手がかりが無い場合はモデルが省略してよく、
    // その場合はUI側で人手設定を促す(勝手に3等の既定値を作らない)。
    importance: z.number().int().min(1).max(5).optional(),
    // 同一抽出バッチ内(同じCapture由来)の他候補candidateIdのうち、この候補が
    // 完了する前提として必要なもの(前提条件・ブロック元)。責任間関係
    // (ResponsibilityRelation)の自動生成に使う。他Captureの候補までは
    // 参照できない(FN-GR-01の意味照合が別途必要な領域のため、ここでは
    // 同一原文内の明示的な依存関係のみを対象とする)。
    blockedByCandidateIds: z.array(z.string().max(64)).max(10).default([]),
    // [2026-08-21追加] カルキョンさんの指摘「音声ファイルの内容によりカテゴリやタグ付けが
    // 関連付けられるようになっているのか」に対応。既存タグ名と一致・類似するものが
    // あればモデルに挙げさせる(自由入力ではなく、原文の文脈から妥当なラベルを推定させる)。
    // 新規タグの自動作成は候補採用(ACCEPT)時に限り許可し、乱造を防ぐため最大3件に制限する。
    suggestedTags: z.array(z.string().max(50)).max(3).default([]),
  })
  .refine((c) => c.evidenceSpans.every((s) => s.end > s.start), {
    message: "evidenceSpansのendはstartより大きい必要があります",
  });

export const ExtractionResultSchema = z.object({
  candidates: z.array(ResponsibilityCandidateSchema).max(20),
  // [2026-08-21追加] カルキョンさんの指摘「生成データにタイトルと概要説明が
  // 関連付けられるようになっているのか」に対応。Capture一覧(Inbox)で原文の
  // 冒頭を機械的に切り詰めて表示していたのを、内容を要約した一言に置き換える。
  captureSummary: z.string().max(120).optional(),
});

export type ResponsibilityCandidate = z.infer<typeof ResponsibilityCandidateSchema>;
export type ExtractionResult = z.infer<typeof ExtractionResultSchema>;

/**
 * Anthropic Tool Use用のJSON Schema(手書き。上記zodスキーマと意味的に対応させる)。
 * zodスキーマは「保存前の最終防衛線」、こちらは「モデルに構造化出力を強制する側」であり、
 * 二重チェックになる(片方だけでは、モデルがJSON Schemaを無視した出力をした場合に守れない)。
 */
export const EXTRACTION_TOOL_JSON_SCHEMA = {
  type: "object",
  properties: {
    candidates: {
      type: "array",
      maxItems: 20,
      items: {
        type: "object",
        properties: {
          candidateId: { type: "string" },
          type: { type: "string", enum: RESPONSIBILITY_TYPES as unknown as string[] },
          title: { type: "string" },
          description: { type: "string" },
          actor: { type: "string" },
          counterparty: { type: "string" },
          dateMentions: {
            type: "array",
            items: {
              type: "object",
              properties: {
                rawExpression: { type: "string" },
                normalizedAt: { type: "string", description: "ISO 8601。解釈不能なら省略" },
                meaning: { type: "string", enum: DATE_MEANINGS as unknown as string[] },
                timezone: { type: "string" },
                confidence: { type: "number" },
              },
              required: ["rawExpression", "meaning", "timezone", "confidence"],
            },
          },
          completionCondition: { type: "string" },
          negationOrChange: { type: "string" },
          evidenceSpans: {
            type: "array",
            items: {
              type: "object",
              properties: {
                start: { type: "integer" },
                end: { type: "integer" },
              },
              required: ["start", "end"],
            },
          },
          confidence: { type: "number", description: "0〜1" },
          unknowns: { type: "array", items: { type: "string" } },
          importance: {
            type: "integer",
            description: "1(低)〜5(高)。原文に手がかりが無ければ省略してよい",
          },
          blockedByCandidateIds: {
            type: "array",
            items: { type: "string" },
            description: "この候補の完了前提として必要な、同一原文内の他候補のcandidateId",
          },
          suggestedTags: {
            type: "array",
            items: { type: "string" },
            description: "この候補に付けるべきタグ名(最大3件)。既存タグ一覧が渡されている場合はそこから優先的に選ぶ",
          },
        },
        required: ["candidateId", "type", "title", "evidenceSpans", "confidence"],
      },
    },
    captureSummary: {
      type: "string",
      description: "原文全体を要約した一言(120文字以内)。一覧画面での表示用",
    },
  },
  required: ["candidates"],
} as const;
