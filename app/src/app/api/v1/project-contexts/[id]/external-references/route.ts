import type { NextRequest } from "next/server";
import { z } from "zod";
import { db } from "@/lib/db";
import { Prisma } from "@/generated/prisma/client";
import { debugServer, redactSensitive } from "@/lib/debugServer";
import { requireAuth, requireCsrf } from "@/lib/auth/guard";
import { ensureDefaultWorkspace } from "@/lib/workspace";
import { apiOk, apiError } from "@/lib/auth/response";

/**
 * 統合正本仕様書21.2節: POST /project-contexts/{id}/external-references
 *
 * [DEC-9] このGateではExternalContextReferenceの明示的な手動登録のみを実装する。
 *   refresh(`/:refId/refresh`相当のSnapshot非同期更新)、Webhook、Integration/secret
 *   store連携、外部write-backは実装しない。理由:
 *   (a) 統合正本仕様書21.2節にrefreshパスが存在しない([DEC-6]参照)。
 *   (b) DOC-04 4章はWebhookに「署名検証、replay防止、provider event idの冪等制約」を
 *       必須と定めるが、これらの具体的契約は未確定であり、実装すると推測になる。
 *   (c) DOC-04 29章(統合正本仕様書)6項は「External connector別scope、credential、
 *       replay防止」を明示的に未確定事項としている。
 *   したがってProjectContextSnapshotRevisionの作成もこのGateでは行わない。
 * [DEC-5継承] direction/syncPolicy/statusはCode Registry未確定のため、
 *   enum検証はせず文字列の長さ制限のみを課す(値の意味を推測して独自Registryを
 *   発明しない)。
 */

const ExternalReferenceSchema = z.object({
  provider: z.string().min(1).max(100),
  externalWorkspaceKey: z.string().min(1).max(300),
  externalProjectKey: z.string().min(1).max(300),
  canonicalUrl: z.string().url().max(2000).nullable().optional(),
  direction: z.string().min(1).max(50),
  syncPolicy: z.string().min(1).max(50),
  status: z.string().min(1).max(50),
});

export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const auth = await requireAuth(req);
  if (!auth.authenticated) {
    return apiError("AUTH_REQUIRED", "ログインが必要です");
  }
  if (!requireCsrf(req)) {
    return apiError("ACCESS_DENIED", "CSRFトークンが不正です");
  }

  const json = await req.json().catch(() => null);
  debugServer.input("POST /project-contexts/[id]/external-references", "requestBody", redactSensitive(json));
  const parsed = ExternalReferenceSchema.safeParse(json);
  if (!parsed.success) {
    return apiError("VALIDATION_FAILED", "入力内容を確認してください", {
      fieldErrors: Object.fromEntries(
        Object.entries(parsed.error.flatten().fieldErrors).map(([k, v]) => [k, v?.[0] ?? "不正な値です"]),
      ),
    });
  }
  const data = parsed.data;

  const { id: contextId } = await ctx.params;
  const { workspaceId } = await ensureDefaultWorkspace(auth.user.userId, auth.user.email);

  const context = await db.projectContext.findFirst({ where: { id: contextId, workspaceId, deletedAt: null } });
  if (!context) {
    return apiError("RESOURCE_NOT_FOUND", "指定されたProject Contextが見つかりません");
  }

  try {
    const created = await db.$transaction(async (tx: Prisma.TransactionClient) => {
      const reference = await tx.externalContextReference.create({
        data: {
          workspaceId,
          contextId,
          provider: data.provider,
          externalWorkspaceKey: data.externalWorkspaceKey,
          externalProjectKey: data.externalProjectKey,
          canonicalUrl: data.canonicalUrl ?? null,
          direction: data.direction,
          syncPolicy: data.syncPolicy,
          status: data.status,
        },
      });

      // Event Code: DOC-02 7.4節 EXTERNAL_REFERENCE_ATTACHED。
      await tx.eventLog.create({
        data: {
          aggregateType: "ProjectContext",
          aggregateId: contextId,
          eventType: "EXTERNAL_REFERENCE_ATTACHED",
          afterJson: { referenceId: reference.id, provider: reference.provider },
          actorType: "USER",
          actorId: auth.user.userId,
          correlationId: req.headers.get("x-correlation-id") ?? undefined,
        },
      });
      debugServer.event("POST /project-contexts/[id]/external-references", "EXTERNAL_REFERENCE_ATTACHED", {
        contextId,
        referenceId: reference.id,
      });

      await tx.outboxEvent.create({
        data: {
          eventName: "ProjectContextExternalReferenceAttached.v1",
          eventVersion: "1",
          aggregateId: contextId,
          aggregateVersion: context.version,
          correlationId: req.headers.get("x-correlation-id") ?? undefined,
          payload: { contextId, referenceId: reference.id, provider: reference.provider },
        },
      });

      return reference;
    });

    return apiOk(
      {
        externalReference: {
          id: created.id,
          provider: created.provider,
          externalWorkspaceKey: created.externalWorkspaceKey,
          externalProjectKey: created.externalProjectKey,
          canonicalUrl: created.canonicalUrl,
          direction: created.direction,
          syncPolicy: created.syncPolicy,
          status: created.status,
          createdAt: created.createdAt,
        },
      },
      { status: 201 },
    );
  } catch (err) {
    // ecr_provider_key_uq(workspaceId, provider, externalWorkspaceKey, externalProjectKey)違反。
    // 明示的なidempotencyKey列がこのtableには無いため([DEC-9範囲外])、自然keyの重複として
    // 扱い、既存行の内容が完全一致する場合のみ200を返す(それ以外はVALIDATION_FAILED)。
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") {
      const existing = await db.externalContextReference.findFirst({
        where: {
          workspaceId,
          provider: data.provider,
          externalWorkspaceKey: data.externalWorkspaceKey,
          externalProjectKey: data.externalProjectKey,
        },
      });
      if (
        existing &&
        existing.contextId === contextId &&
        existing.canonicalUrl === (data.canonicalUrl ?? null) &&
        existing.direction === data.direction &&
        existing.syncPolicy === data.syncPolicy &&
        existing.status === data.status
      ) {
        return apiOk({
          externalReference: {
            id: existing.id,
            provider: existing.provider,
            externalWorkspaceKey: existing.externalWorkspaceKey,
            externalProjectKey: existing.externalProjectKey,
            canonicalUrl: existing.canonicalUrl,
            direction: existing.direction,
            syncPolicy: existing.syncPolicy,
            status: existing.status,
            createdAt: existing.createdAt,
          },
        });
      }
      return apiError(
        "VALIDATION_FAILED",
        "この provider・externalWorkspaceKey・externalProjectKey の組み合わせは既に(異なる内容で)登録されています",
      );
    }
    throw err;
  }
}
