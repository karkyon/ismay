/**
 * AI Provider レジストリ。
 *
 * カルキョンさんの指示(2026-08-20)「どの事業者でも対応できるよう管理画面で切り替え
 * できる設計にしろ」に対応。新しい事業者を追加する場合、対応するProvider実装
 * (AiExtractionProvider / AiEmbeddingProvider)を作成し、本ファイルの登録表へ
 * 1行追加するだけでよい。管理画面(/admin/ai-providers)はこの登録表のキー一覧を
 * 選択肢として表示するのみで、事業者固有のコードには一切依存しない。
 *
 * APIキー等の秘密情報は環境変数のまま管理する(インフラ・運用設計書v1.1の環境ごとの
 * 秘密分離方針)。本レジストリ・DB(AiProviderConfig)が保持するのは
 * 「どの登録済みプロバイダーを使うか」という選択のみ。
 */

import type { AiExtractionProvider } from "@/lib/ai/provider";
import type { AiEmbeddingProvider } from "@/lib/ai/embeddingProvider";
import type { AiTranscriptionProvider } from "@/lib/ai/transcriptionProvider";
import type { AiOcrProvider } from "@/lib/ai/ocrProvider";
import type { AiSegmentProvider } from "@/lib/ai/segmentProvider";
import { createAnthropicExtractionProvider } from "@/lib/ai/anthropicProvider";
import { createOpenAiEmbeddingProvider } from "@/lib/ai/openaiEmbeddingProvider";
import { createOpenAiTranscriptionProvider } from "@/lib/ai/openaiTranscriptionProvider";
import { createAnthropicOcrProvider } from "@/lib/ai/anthropicOcrProvider";
import { createAnthropicSegmentProvider } from "@/lib/ai/anthropicSegmentProvider";

export const AI_CAPABILITIES = ["EXTRACTION", "EMBEDDING", "TRANSCRIPTION", "OCR", "SEGMENTATION"] as const;
export type AiCapability = (typeof AI_CAPABILITIES)[number];

export interface ProviderFactoryOpts {
  apiKey?: string;
  model?: string;
}

/** 管理画面のモデル選択プルダウンに表示する選択肢。事業者追加時はここも1行追加する。 */
export interface AvailableModel {
  modelName: string;
  label: string;
}

export const EXTRACTION_PROVIDER_REGISTRY: Record<string, (opts?: ProviderFactoryOpts) => AiExtractionProvider> = {
  anthropic: createAnthropicExtractionProvider,
  // 例: openai: createOpenAiExtractionProvider (将来追加時はここに1行足すだけでよい)
};

export const EMBEDDING_PROVIDER_REGISTRY: Record<string, (opts?: ProviderFactoryOpts) => AiEmbeddingProvider> = {
  openai: createOpenAiEmbeddingProvider,
};

// [2026-08-21追加] 文字起こし事業者はOpenAI gpt-transcribeに確定。
export const TRANSCRIPTION_PROVIDER_REGISTRY: Record<string, (opts?: ProviderFactoryOpts) => AiTranscriptionProvider> = {
  openai: createOpenAiTranscriptionProvider,
};

// [2026-08-21追加] 画像OCR事業者はAnthropic Claude(Vision)に確定。
// 専用OCR事業者を別途用意しない方針(anthropicOcrProvider.ts冒頭コメント参照)。
export const OCR_PROVIDER_REGISTRY: Record<string, (opts?: ProviderFactoryOpts) => AiOcrProvider> = {
  anthropic: createAnthropicOcrProvider,
};

// [2026-08-21追加] 音声テーマ自動分割。抽出と同じAnthropic Claude Haiku 4.5を使う
// (segmentProvider.ts冒頭コメント参照)。
export const SEGMENTATION_PROVIDER_REGISTRY: Record<string, (opts?: ProviderFactoryOpts) => AiSegmentProvider> = {
  anthropic: createAnthropicSegmentProvider,
};

/** 管理画面でモデル名を選べるようにするための一覧(価格根拠はlib/ai/pricing.ts)。 */
export const AVAILABLE_MODELS: Record<string, AvailableModel[]> = {
  anthropic: [{ modelName: "claude-haiku-4-5-20251001", label: "Claude Haiku 4.5($1/$5 per Mtok)" }],
  openai: [
    { modelName: "text-embedding-3-small", label: "text-embedding-3-small($0.02 per Mtok)" },
    { modelName: "gpt-transcribe", label: "gpt-transcribe($0.0045/分)" },
  ],
};

export const DEFAULT_PROVIDER_KEY: Record<AiCapability, string> = {
  // TBD-05(2026-08-18解消): 抽出はAnthropic Claude Haiku 4.5
  EXTRACTION: "anthropic",
  // 2026-08-20合意: EmbeddingはOpenAI text-embedding-3-small
  EMBEDDING: "openai",
  // 2026-08-21合意: 文字起こしはOpenAI gpt-transcribe
  TRANSCRIPTION: "openai",
  // 2026-08-21合意: 画像OCRはAnthropic Claude(Vision)。専用OCR事業者は用意しない
  OCR: "anthropic",
  // 2026-08-21合意: 音声テーマ自動分割は抽出と同じAnthropic Claude Haiku 4.5
  SEGMENTATION: "anthropic",
};

function registryFor(capability: AiCapability): Record<string, unknown> {
  if (capability === "EXTRACTION") return EXTRACTION_PROVIDER_REGISTRY;
  if (capability === "EMBEDDING") return EMBEDDING_PROVIDER_REGISTRY;
  if (capability === "TRANSCRIPTION") return TRANSCRIPTION_PROVIDER_REGISTRY;
  if (capability === "OCR") return OCR_PROVIDER_REGISTRY;
  return SEGMENTATION_PROVIDER_REGISTRY;
}

export function listAvailableProviderKeys(capability: AiCapability): string[] {
  return Object.keys(registryFor(capability));
}

export function listAvailableModels(providerKey: string): AvailableModel[] {
  return AVAILABLE_MODELS[providerKey] ?? [];
}

export function isKnownProviderKey(capability: AiCapability, providerKey: string): boolean {
  return listAvailableProviderKeys(capability).includes(providerKey);
}

export function resolveExtractionProvider(providerKey: string, opts?: ProviderFactoryOpts): AiExtractionProvider {
  const factory = EXTRACTION_PROVIDER_REGISTRY[providerKey];
  if (!factory) {
    throw new Error(`未登録の抽出プロバイダーです: ${providerKey}`);
  }
  return factory(opts);
}

export function resolveEmbeddingProvider(providerKey: string, opts?: ProviderFactoryOpts): AiEmbeddingProvider {
  const factory = EMBEDDING_PROVIDER_REGISTRY[providerKey];
  if (!factory) {
    throw new Error(`未登録のEmbeddingプロバイダーです: ${providerKey}`);
  }
  return factory(opts);
}

export function resolveTranscriptionProvider(providerKey: string, opts?: ProviderFactoryOpts): AiTranscriptionProvider {
  const factory = TRANSCRIPTION_PROVIDER_REGISTRY[providerKey];
  if (!factory) {
    throw new Error(`未登録の文字起こしプロバイダーです: ${providerKey}`);
  }
  return factory(opts);
}

export function resolveOcrProvider(providerKey: string, opts?: ProviderFactoryOpts): AiOcrProvider {
  const factory = OCR_PROVIDER_REGISTRY[providerKey];
  if (!factory) {
    throw new Error(`未登録のOCRプロバイダーです: ${providerKey}`);
  }
  return factory(opts);
}

export function resolveSegmentProvider(providerKey: string, opts?: ProviderFactoryOpts): AiSegmentProvider {
  const factory = SEGMENTATION_PROVIDER_REGISTRY[providerKey];
  if (!factory) {
    throw new Error(`未登録の話題分割プロバイダーです: ${providerKey}`);
  }
  return factory(opts);
}
