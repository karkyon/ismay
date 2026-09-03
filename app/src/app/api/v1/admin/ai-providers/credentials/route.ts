import type { NextRequest } from "next/server";
import { z } from "zod";
import { db } from "@/lib/db";
import { debugServer, redactSensitive } from "@/lib/debugServer";
import { requireAuth, requireCsrf } from "@/lib/auth/guard";
import { ensureDefaultWorkspace } from "@/lib/workspace";
import { apiOk, apiError } from "@/lib/auth/response";
import { requireAdminConsoleRole } from "@/lib/auth/roleGuard";
import { AI_CAPABILITIES, listAvailableProviderKeys } from "@/lib/ai/registry";
import { encryptApiKey, last4Of } from "@/lib/ai/credentialCrypto";

/**
 * APIキー登録・切替(2026-08-20新設)。「APIのキー登録や切り替えを明確にどのモデルで
 * 適用するか切り替えを容易にしろ」への対応。
 *
 * APIキー本体は平文でDBへ保存せず、AES-256-GCM暗号化(lib/ai/credentialCrypto.ts、
 * 環境変数AI_CREDENTIAL_ENCRYPTION_KEYが必要)して保存する。GET応答には末尾4文字のみ
 * 含め、平文キー全体は一切返さない(登録済みかどうかの確認用途に限定)。
 *
 * [Gate SECURITY-RBAC-01是正・2026-09-03] APIキーの登録・削除という特に機微な操作
 * のため、../route.tsと同じrequireAdminConsoleRole(OWNER/ADMINのみ)を追加した。
 * 詳細な根拠は../route.tsのコメント参照。
 */

const RegisteredProviderKeys = Array.from(new Set(AI_CAPABILITIES.flatMap((c) => listAvailableProviderKeys(c))));

const RegisterSchema = z.object({
  providerKey: z.enum(RegisteredProviderKeys as [string, ...string[]]),
  apiKey: z.string().min(8).max(500),
});

const DeleteSchema = z.object({
  providerKey: z.enum(RegisteredProviderKeys as [string, ...string[]]),
});

/** PUT /api/v1/admin/ai-providers/credentials: APIキーを登録・更新する。 */
export async function PUT(req: NextRequest) {
  const auth = await requireAuth(req);
  if (!auth.authenticated) {
    return apiError("AUTH_REQUIRED", "ログインが必要です");
  }
  if (!requireCsrf(req)) {
    return apiError("ACCESS_DENIED", "CSRFトークンが不正です");
  }

  const json = await req.json().catch(() => null);
  debugServer.input("PUT /admin/ai-providers/credentials", "requestBody", redactSensitive(json));
  const parsed = RegisterSchema.safeParse(json);
  if (!parsed.success) {
    return apiError("VALIDATION_FAILED", "入力内容を確認してください", {
      fieldErrors: Object.fromEntries(
        Object.entries(parsed.error.flatten().fieldErrors).map(([k, v]) => [k, v?.[0] ?? "不正な値です"]),
      ),
    });
  }
  const { providerKey, apiKey } = parsed.data;

  let encrypted: string;
  try {
    encrypted = encryptApiKey(apiKey);
  } catch (err) {
    debugServer.error("PUT /admin/ai-providers/credentials", "暗号化に失敗", err);
    return apiError("VALIDATION_FAILED", "サーバー側の暗号化鍵が未設定です。AI_CREDENTIAL_ENCRYPTION_KEYを確認してください");
  }

  const { workspaceId } = await ensureDefaultWorkspace(auth.user.userId, auth.user.email);

  const roleOk = await requireAdminConsoleRole({
    userId: auth.user.userId,
    workspaceId,
    action: "ADMIN_AI_CREDENTIAL_REGISTER",
  });
  if (!roleOk) {
    return apiError("ACCESS_DENIED", "この操作には管理者権限(OWNER/ADMIN)が必要です");
  }

  const saved = await db.aiProviderCredential.upsert({
    where: { workspaceId_providerKey: { workspaceId, providerKey } },
    create: {
      workspaceId,
      providerKey,
      encryptedApiKey: encrypted,
      last4: last4Of(apiKey),
      updatedById: auth.user.userId,
    },
    update: {
      encryptedApiKey: encrypted,
      last4: last4Of(apiKey),
      updatedById: auth.user.userId,
    },
  });
  // 平文キー・暗号化ペイロードともにログへ出さない。末尾4文字と件数のみ記録する。
  debugServer.state("PUT /admin/ai-providers/credentials", "AiProviderCredential", {
    workspaceId,
    providerKey,
    last4: saved.last4,
  });
  debugServer.event("PUT /admin/ai-providers/credentials", "AI_CREDENTIAL_REGISTERED", { workspaceId, providerKey });

  return apiOk({ providerKey, registered: true, last4: saved.last4, updatedAt: saved.updatedAt });
}

/** DELETE /api/v1/admin/ai-providers/credentials: 登録済みAPIキーを削除する(環境変数へフォールバックする)。 */
export async function DELETE(req: NextRequest) {
  const auth = await requireAuth(req);
  if (!auth.authenticated) {
    return apiError("AUTH_REQUIRED", "ログインが必要です");
  }
  if (!requireCsrf(req)) {
    return apiError("ACCESS_DENIED", "CSRFトークンが不正です");
  }

  const json = await req.json().catch(() => null);
  debugServer.input("DELETE /admin/ai-providers/credentials", "requestBody", redactSensitive(json));
  const parsed = DeleteSchema.safeParse(json);
  if (!parsed.success) {
    return apiError("VALIDATION_FAILED", "入力内容を確認してください");
  }
  const { providerKey } = parsed.data;
  const { workspaceId } = await ensureDefaultWorkspace(auth.user.userId, auth.user.email);

  const roleOk = await requireAdminConsoleRole({
    userId: auth.user.userId,
    workspaceId,
    action: "ADMIN_AI_CREDENTIAL_DELETE",
  });
  if (!roleOk) {
    return apiError("ACCESS_DENIED", "この操作には管理者権限(OWNER/ADMIN)が必要です");
  }

  await db.aiProviderCredential.deleteMany({ where: { workspaceId, providerKey } });
  debugServer.state("DELETE /admin/ai-providers/credentials", "AiProviderCredential", {
    workspaceId,
    providerKey,
    deleted: true,
  });
  debugServer.event("DELETE /admin/ai-providers/credentials", "AI_CREDENTIAL_DELETED", { workspaceId, providerKey });

  return apiOk({ providerKey, registered: false });
}
