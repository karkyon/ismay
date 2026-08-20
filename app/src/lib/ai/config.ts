import { db } from "@/lib/db";
import { debugServer } from "@/lib/debugServer";
import {
  DEFAULT_PROVIDER_KEY,
  isKnownProviderKey,
  resolveExtractionProvider,
  resolveEmbeddingProvider,
  type AiCapability,
} from "@/lib/ai/registry";
import type { AiExtractionProvider } from "@/lib/ai/provider";
import type { AiEmbeddingProvider } from "@/lib/ai/embeddingProvider";

/**
 * Workspaceに設定された有効プロバイダーキーを返す。未設定・不明なキーの場合は
 * DEFAULT_PROVIDER_KEYへフォールバックする(fail-open。管理画面の誤操作でAI機能
 * 全体が止まらないようにするため)。
 */
export async function getActiveProviderKey(workspaceId: string, capability: AiCapability): Promise<string> {
  const row = await db.aiProviderConfig.findUnique({
    where: { workspaceId_capability: { workspaceId, capability } },
  });
  if (row && isKnownProviderKey(capability, row.providerKey)) {
    return row.providerKey;
  }
  if (row) {
    debugServer.error("ai/config", "未登録のproviderKeyが設定されていたためデフォルトへフォールバック", {
      workspaceId,
      capability,
      providerKey: row.providerKey,
    });
  }
  return DEFAULT_PROVIDER_KEY[capability];
}

export async function getActiveExtractionProvider(workspaceId: string): Promise<AiExtractionProvider> {
  const key = await getActiveProviderKey(workspaceId, "EXTRACTION");
  return resolveExtractionProvider(key);
}

export async function getActiveEmbeddingProvider(workspaceId: string): Promise<AiEmbeddingProvider> {
  const key = await getActiveProviderKey(workspaceId, "EMBEDDING");
  return resolveEmbeddingProvider(key);
}
