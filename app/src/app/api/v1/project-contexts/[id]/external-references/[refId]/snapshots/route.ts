import type { NextRequest } from "next/server";
import { z } from "zod";
import { db } from "@/lib/db";
import { debugServer, redactSensitive } from "@/lib/debugServer";
import { requireAuth, requireCsrf } from "@/lib/auth/guard";
import { ensureDefaultWorkspace } from "@/lib/workspace";
import { apiOk, apiError } from "@/lib/auth/response";
import { registerExternalSnapshot } from "@/lib/projectContext/externalReferenceSync";

/**
 * V5-M1-A4 API: POST /project-contexts/{id}/external-references/{refId}/snapshots
 * 出典: DOC-04 4章、EVAL・受入テスト仕様書 EV-C-005。
 *
 * [scope宣言] このエンドポイントは「外部の現在値(sourceVersion/payload)を
 * 受け取り、conflict検出・queue化を行う」契約のみを実装する。外部Providerへの
 * 実HTTP fetchはこのGateのscope外(external-references/route.ts [DEC-9]と
 * 同じ理由)。呼び出し元は本人の手動登録、または将来のConnector実装のいずれでもよい。
 */

const RegisterSnapshotSchema = z.object({
  sourceVersion: z.string().min(1).max(300),
  payload: z.record(z.string(), z.unknown()),
});

export async function POST(
  req: NextRequest,
  ctx: { params: Promise<{ id: string; refId: string }> },
) {
  const auth = await requireAuth(req);
  if (!auth.authenticated) {
    return apiError("AUTH_REQUIRED", "ログインが必要です");
  }
  if (!requireCsrf(req)) {
    return apiError("ACCESS_DENIED", "CSRFトークンが不正です");
  }

  const json = await req.json().catch(() => null);
  debugServer.input("POST /project-contexts/[id]/external-references/[refId]/snapshots", "requestBody", redactSensitive(json));
  const parsed = RegisterSnapshotSchema.safeParse(json);
  if (!parsed.success) {
    return apiError("VALIDATION_FAILED", "入力内容を確認してください", {
      fieldErrors: Object.fromEntries(
        Object.entries(parsed.error.flatten().fieldErrors).map(([k, v]) => [k, v?.[0] ?? "不正な値です"]),
      ),
    });
  }

  const { id: contextId, refId } = await ctx.params;
  const { workspaceId } = await ensureDefaultWorkspace(auth.user.userId, auth.user.email);

  const context = await db.projectContext.findFirst({ where: { id: contextId, workspaceId, deletedAt: null } });
  if (!context) {
    return apiError("RESOURCE_NOT_FOUND", "指定されたProject Contextが見つかりません");
  }
  const reference = await db.externalContextReference.findFirst({ where: { id: refId, workspaceId, contextId } });
  if (!reference) {
    return apiError("RESOURCE_NOT_FOUND", "指定された外部参照が見つかりません");
  }

  const result = await registerExternalSnapshot({
    workspaceId,
    referenceId: refId,
    sourceVersion: parsed.data.sourceVersion,
    payload: parsed.data.payload,
    actorUserId: auth.user.userId,
  });

  if (!result.ok) {
    return apiError("RESOURCE_NOT_FOUND", "指定された外部参照が見つかりません");
  }

  debugServer.event("POST /project-contexts/[id]/external-references/[refId]/snapshots", "EXTERNAL_SNAPSHOT_REGISTERED", {
    refId,
    revision: result.revision,
    conflict: result.conflict,
  });

  if (result.conflict) {
    // [DOC-04 4章「last-write-winsしない」・統合正本v5.0 21.3節 Conflict分類]
    // Snapshot自体は監査のため記録済みだが、reference.lastObservedVersionは
    // 更新されていない。本人がconflicts/:conflictId/resolveで解決するまで、
    // クライアントへは409 EXTERNAL_VERSION_CONFLICTとして明示する。
    return apiError(
      "EXTERNAL_VERSION_CONFLICT",
      "外部の観測値が現在の記録と異なります。conflict queueへ登録されました",
      { extra: { snapshotRevisionId: result.snapshotRevisionId, revision: result.revision, conflictId: result.conflictId } },
    );
  }

  return apiOk(
    { snapshotRevisionId: result.snapshotRevisionId, revision: result.revision },
    { status: 201 },
  );
}
