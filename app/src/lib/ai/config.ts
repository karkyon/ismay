import { db } from "@/lib/db";
import { debugServer } from "@/lib/debugServer";
import {
  DEFAULT_PROVIDER_KEY,
  isKnownProviderKey,
  resolveExtractionProvider,
  resolveEmbeddingProvider,
  resolveTranscriptionProvider,
  resolveOcrProvider,
  resolveSegmentProvider,
  resolvePemDialogueProvider,
  resolvePemAdviceProvider,
  type AiCapability,
} from "@/lib/ai/registry";
import { decryptApiKey } from "@/lib/ai/credentialCrypto";
import type { AiExtractionProvider } from "@/lib/ai/provider";
import type { AiEmbeddingProvider } from "@/lib/ai/embeddingProvider";
import type { AiTranscriptionProvider } from "@/lib/ai/transcriptionProvider";
import type { AiOcrProvider } from "@/lib/ai/ocrProvider";
import type { AiSegmentProvider } from "@/lib/ai/segmentProvider";
import type { PemDialogueProvider } from "@/lib/ai/pemProvider";
import type { PemAdviceProvider } from "@/lib/ai/pemAdviceProvider";

/**
 * Workspaceに設定された有効プロバイダーキー・モデル名を返す。未設定・不明なキーの場合は
 * DEFAULT_PROVIDER_KEYへフォールバックする(fail-open。管理画面の誤操作でAI機能
 * 全体が止まらないようにするため)。
 */
export async function getActiveProviderSelection(
  workspaceId: string,
  capability: AiCapability,
): Promise<{ providerKey: string; modelName?: string }> {
  const row = await db.aiProviderConfig.findUnique({
    where: { workspaceId_capability: { workspaceId, capability } },
  });
  if (row && isKnownProviderKey(capability, row.providerKey)) {
    return { providerKey: row.providerKey, modelName: row.modelName ?? undefined };
  }
  if (row) {
    debugServer.error("ai/config", "未登録のproviderKeyが設定されていたためデフォルトへフォールバック", {
      workspaceId,
      capability,
      providerKey: row.providerKey,
    });
  }
  return { providerKey: DEFAULT_PROVIDER_KEY[capability] };
}

/**
 * providerKey(事業者)に対応する復号済みAPIキーを取得する。管理画面未登録の場合は
 * undefinedを返し、各Provider実装側で環境変数(ANTHROPIC_API_KEY等)へフォールバックさせる。
 */
export async function getDecryptedApiKey(workspaceId: string, providerKey: string): Promise<string | undefined> {
  const cred = await db.aiProviderCredential.findUnique({
    where: { workspaceId_providerKey: { workspaceId, providerKey } },
  });
  if (!cred) return undefined;
  try {
    return decryptApiKey(cred.encryptedApiKey);
  } catch (err) {
    debugServer.error("ai/config", "APIキー復号に失敗しました。環境変数へフォールバックします", {
      workspaceId,
      providerKey,
      err,
    });
    return undefined;
  }
}

export async function getActiveExtractionProvider(workspaceId: string): Promise<AiExtractionProvider> {
  const { providerKey, modelName } = await getActiveProviderSelection(workspaceId, "EXTRACTION");
  const apiKey = await getDecryptedApiKey(workspaceId, providerKey);
  return resolveExtractionProvider(providerKey, { apiKey, model: modelName });
}

export async function getActiveEmbeddingProvider(workspaceId: string): Promise<AiEmbeddingProvider> {
  const { providerKey, modelName } = await getActiveProviderSelection(workspaceId, "EMBEDDING");
  const apiKey = await getDecryptedApiKey(workspaceId, providerKey);
  return resolveEmbeddingProvider(providerKey, { apiKey, model: modelName });
}

export async function getActiveTranscriptionProvider(workspaceId: string): Promise<AiTranscriptionProvider> {
  const { providerKey, modelName } = await getActiveProviderSelection(workspaceId, "TRANSCRIPTION");
  const apiKey = await getDecryptedApiKey(workspaceId, providerKey);
  return resolveTranscriptionProvider(providerKey, { apiKey, model: modelName });
}

export async function getActiveOcrProvider(workspaceId: string): Promise<AiOcrProvider> {
  const { providerKey, modelName } = await getActiveProviderSelection(workspaceId, "OCR");
  const apiKey = await getDecryptedApiKey(workspaceId, providerKey);
  return resolveOcrProvider(providerKey, { apiKey, model: modelName });
}

export async function getActiveSegmentProvider(workspaceId: string): Promise<AiSegmentProvider> {
  const { providerKey, modelName } = await getActiveProviderSelection(workspaceId, "SEGMENTATION");
  const apiKey = await getDecryptedApiKey(workspaceId, providerKey);
  return resolveSegmentProvider(providerKey, { apiKey, model: modelName });
}

export async function getActivePemDialogueProvider(workspaceId: string): Promise<PemDialogueProvider> {
  const { providerKey, modelName } = await getActiveProviderSelection(workspaceId, "PEM_DIALOGUE");
  const apiKey = await getDecryptedApiKey(workspaceId, providerKey);
  return resolvePemDialogueProvider(providerKey, { apiKey, model: modelName });
}

export async function getActivePemAdviceProvider(workspaceId: string): Promise<PemAdviceProvider> {
  const { providerKey, modelName } = await getActiveProviderSelection(workspaceId, "PEM_ADVICE");
  const apiKey = await getDecryptedApiKey(workspaceId, providerKey);
  return resolvePemAdviceProvider(providerKey, { apiKey, model: modelName });
}
