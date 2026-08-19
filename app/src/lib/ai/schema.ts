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
  })
  .refine((c) => c.evidenceSpans.every((s) => s.end > s.start), {
    message: "evidenceSpansのendはstartより大きい必要があります",
  });

export const ExtractionResultSchema = z.object({
  candidates: z.array(ResponsibilityCandidateSchema).max(20),
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
        },
        required: ["candidateId", "type", "title", "evidenceSpans", "confidence"],
      },
    },
  },
  required: ["candidates"],
} as const;
