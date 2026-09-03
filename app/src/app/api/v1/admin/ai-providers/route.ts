import type { NextRequest } from "next/server";
import { z } from "zod";
import { db } from "@/lib/db";
import { debugServer, redactSensitive } from "@/lib/debugServer";
import { requireAuth, requireCsrf } from "@/lib/auth/guard";
import { ensureDefaultWorkspace } from "@/lib/workspace";
import { apiOk, apiError } from "@/lib/auth/response";
import { requireAdminConsoleRole } from "@/lib/auth/roleGuard";
import {
  AI_CAPABILITIES,
  DEFAULT_PROVIDER_KEY,
  isKnownProviderKey,
  listAvailableProviderKeys,
  listAvailableModels,
} from "@/lib/ai/registry";

/**
 * MOD-10 Admin / MOD-06 AI Gateway: AIプロバイダー切替・モデル選択(2026-08-20新設、
 * 同日追補でAPIキー登録・運用コスト可視化に対応)。
 *
 * [Gate SECURITY-RBAC-01是正・2026-09-03] 従来requireAuth(Workspace所属)のみで
 * 認可していたが、統合正本仕様書v5.0 §20.2にWorkspaceMember.roleの正式語彙
 * (OWNER/ADMIN/MEMBER/VIEWER/SERVICE)が明記されていること、DOC-11 API・Event
 * 仕様書§21.1が「管理APIはrole guard」を明示的に要求していることを確認したため、
 * requireAdminConsoleRole(OWNER/ADMINのみ許可)を追加した。現状はメンバー招待機能が
 * 未実装のため各Workspaceの唯一のmemberは常にOWNERであり、既存の単一利用者運用に
 * 挙動変化は無い(招待機能実装時の先行防御)。
 */

const CAPABILITY_ENUM = z.enum(AI_CAPABILITIES);

const UpdateSchema = z.object({
  capability: CAPABILITY_ENUM,
  providerKey: z.string().min(1).max(100),
  modelName: z.string().max(200).optional(),
});

/** GET /api/v1/admin/ai-providers: 現在の設定＋選択可能なプロバイダー・モデル・登録済みキーの有無を返す。 */
export async function GET(req: NextRequest) {
  const auth = await requireAuth(req);
  if (!auth.authenticated) {
    return apiError("AUTH_REQUIRED", "ログインが必要です");
  }

  const { workspaceId } = await ensureDefaultWorkspace(auth.user.userId, auth.user.email);

  const roleOk = await requireAdminConsoleRole({
    userId: auth.user.userId,
    workspaceId,
    action: "ADMIN_AI_PROVIDERS_VIEW",
  });
  if (!roleOk) {
    return apiError("ACCESS_DENIED", "この操作には管理者権限(OWNER/ADMIN)が必要です");
  }

  const [configRows, credentialRows] = await Promise.all([
    db.aiProviderConfig.findMany({ where: { workspaceId } }),
    db.aiProviderCredential.findMany({ where: { workspaceId } }),
  ]);

  type ConfigRow = { capability: string; providerKey: string; modelName: string | null; updatedAt: Date };
  type CredentialRow = { providerKey: string; last4: string; updatedAt: Date };

  const byCapability = new Map<string, ConfigRow>((configRows as ConfigRow[]).map((r) => [r.capability, r]));
  const credByProvider = new Map<string, CredentialRow>((credentialRows as CredentialRow[]).map((r) => [r.providerKey, r]));

  const capabilities = AI_CAPABILITIES.map((capability) => {
    const row = byCapability.get(capability);
    const activeProviderKey =
      row && isKnownProviderKey(capability, row.providerKey) ? row.providerKey : DEFAULT_PROVIDER_KEY[capability];
    const availableProviderKeys = listAvailableProviderKeys(capability);
    return {
      capability,
      activeProviderKey,
      modelName: row?.modelName ?? listAvailableModels(activeProviderKey)[0]?.modelName ?? null,
      isDefault: !row,
      availableProviderKeys,
      availableModelsByProvider: Object.fromEntries(availableProviderKeys.map((k) => [k, listAvailableModels(k)])),
      updatedAt: row?.updatedAt ?? null,
    };
  });

  // 登場する全プロバイダーキー(EXTRACTION/EMBEDDING両方)についてキー登録状況を返す
  const allProviderKeys = Array.from(new Set(AI_CAPABILITIES.flatMap((c) => listAvailableProviderKeys(c))));
  const credentials = allProviderKeys.map((providerKey) => {
    const cred = credByProvider.get(providerKey);
    return {
      providerKey,
      registered: Boolean(cred),
      last4: cred?.last4 ?? null,
      updatedAt: cred?.updatedAt ?? null,
    };
  });

  return apiOk({ capabilities, credentials });
}

/** PATCH /api/v1/admin/ai-providers: 指定capabilityの使用プロバイダー・モデルを切り替える。 */
export async function PATCH(req: NextRequest) {
  const auth = await requireAuth(req);
  if (!auth.authenticated) {
    return apiError("AUTH_REQUIRED", "ログインが必要です");
  }
  if (!requireCsrf(req)) {
    return apiError("ACCESS_DENIED", "CSRFトークンが不正です");
  }

  const json = await req.json().catch(() => null);
  debugServer.input("PATCH /admin/ai-providers", "requestBody", redactSensitive(json));
  const parsed = UpdateSchema.safeParse(json);
  if (!parsed.success) {
    return apiError("VALIDATION_FAILED", "入力内容を確認してください", {
      fieldErrors: Object.fromEntries(
        Object.entries(parsed.error.flatten().fieldErrors).map(([k, v]) => [k, v?.[0] ?? "不正な値です"]),
      ),
    });
  }
  const { capability, providerKey, modelName } = parsed.data;

  if (!isKnownProviderKey(capability, providerKey)) {
    return apiError("VALIDATION_FAILED", "未登録のプロバイダーです", {
      fieldErrors: { providerKey: `選択可能な値: ${listAvailableProviderKeys(capability).join(", ")}` },
    });
  }
  if (modelName) {
    const known = listAvailableModels(providerKey).some((m) => m.modelName === modelName);
    if (!known) {
      return apiError("VALIDATION_FAILED", "未登録のモデルです", {
        fieldErrors: {
          modelName: `選択可能な値: ${listAvailableModels(providerKey)
            .map((m) => m.modelName)
            .join(", ")}`,
        },
      });
    }
  }

  const { workspaceId } = await ensureDefaultWorkspace(auth.user.userId, auth.user.email);

  const roleOk = await requireAdminConsoleRole({
    userId: auth.user.userId,
    workspaceId,
    action: "ADMIN_AI_PROVIDERS_UPDATE",
  });
  if (!roleOk) {
    return apiError("ACCESS_DENIED", "この操作には管理者権限(OWNER/ADMIN)が必要です");
  }

  const updated = await db.aiProviderConfig.upsert({
    where: { workspaceId_capability: { workspaceId, capability } },
    create: {
      workspaceId,
      capability,
      providerKey,
      modelName: modelName ?? null,
      updatedById: auth.user.userId,
    },
    update: {
      providerKey,
      modelName: modelName ?? null,
      updatedById: auth.user.userId,
    },
  });
  debugServer.state("PATCH /admin/ai-providers", "AiProviderConfig", {
    workspaceId,
    capability,
    providerKey: updated.providerKey,
    modelName: updated.modelName,
  });
  debugServer.event("PATCH /admin/ai-providers", "AI_PROVIDER_SWITCHED", {
    workspaceId,
    capability,
    providerKey: updated.providerKey,
  });

  return apiOk({
    capability: updated.capability,
    activeProviderKey: updated.providerKey,
    modelName: updated.modelName,
    updatedAt: updated.updatedAt,
  });
}
