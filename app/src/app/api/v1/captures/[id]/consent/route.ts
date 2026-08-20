import type { NextRequest } from "next/server";
import { z } from "zod";
import { db } from "@/lib/db";
import { debugServer, redactSensitive } from "@/lib/debugServer";
import { requireAuth, requireCsrf } from "@/lib/auth/guard";
import { ensureDefaultWorkspace } from "@/lib/workspace";
import { apiOk, apiError } from "@/lib/auth/response";

const ConsentSchema = z.object({
  purpose: z.string().min(1).max(64),
  participantsNotified: z.boolean().optional().default(false),
  retentionDays: z.number().int().min(1).max(3650).optional(),
});

// FN-PRV-02(TBD-04で確定): 会議録音の既定保持日数
const DEFAULT_RETENTION_DAYS = 7;

/** API-CAP-05: POST /captures/{id}/consent 会議録音の同意・利用目的登録(FN-PRV-02) */
export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const auth = await requireAuth(req);
  if (!auth.authenticated) {
    return apiError("AUTH_REQUIRED", "ログインが必要です");
  }
  if (!requireCsrf(req)) {
    return apiError("ACCESS_DENIED", "CSRFトークンが不正です");
  }

  const json = await req.json().catch(() => null);
  debugServer.input("POST /captures/[id]/consent", "requestBody", redactSensitive(json));
  const parsed = ConsentSchema.safeParse(json);
  if (!parsed.success) {
    return apiError("VALIDATION_FAILED", "入力内容を確認してください", {
      fieldErrors: Object.fromEntries(
        Object.entries(parsed.error.flatten().fieldErrors).map(([k, v]) => [k, v?.[0] ?? "不正な値です"]),
      ),
    });
  }
  const { purpose, participantsNotified, retentionDays } = parsed.data;

  const { id } = await ctx.params;
  const { workspaceId } = await ensureDefaultWorkspace(auth.user.userId, auth.user.email);

  const capture = await db.capture.findFirst({ where: { id, workspaceId, deletedAt: null } });
  if (!capture) {
    return apiError("RESOURCE_NOT_FOUND", "指定されたCaptureが見つかりません");
  }

  const retentionDaysResolved = retentionDays ?? DEFAULT_RETENTION_DAYS;
  const expiresAt = new Date(Date.now() + retentionDaysResolved * 24 * 60 * 60 * 1000);

  const result = await db
    .$transaction(async (tx) => {
      const consent = await tx.consent.create({
        data: {
          captureId: capture.id,
          subjectId: auth.user.userId,
          purpose,
          scope: { participantsNotified, retentionDays: retentionDaysResolved },
          expiresAt,
        },
      });

      const updateResult = await tx.capture.updateMany({
        where: { id: capture.id, version: capture.version },
        data: { consentId: consent.id, version: { increment: 1 } },
      });
      if (updateResult.count === 0) {
        throw new Error("ISMAY_VERSION_CONFLICT");
      }
      debugServer.state("POST /captures/[id]/consent", "Capture.consentId", {
        id: capture.id,
        consentId: consent.id,
      });

      await tx.eventLog.create({
        data: {
          aggregateType: "Capture",
          aggregateId: capture.id,
          eventType: "CONSENT_REGISTERED",
          afterJson: { consentId: consent.id, purpose },
          actorType: "USER",
          actorId: auth.user.userId,
          correlationId: req.headers.get("x-correlation-id") ?? undefined,
        },
      });
      debugServer.event("POST /captures/[id]/consent", "CONSENT_REGISTERED", { aggregateId: capture.id });

      await tx.outboxEvent.create({
        data: {
          eventName: "ConsentRegistered.v1",
          eventVersion: "1",
          aggregateId: capture.id,
          aggregateVersion: capture.version + 1,
          correlationId: req.headers.get("x-correlation-id") ?? undefined,
          payload: { captureId: capture.id, consentId: consent.id },
        },
      });
      debugServer.event("POST /captures/[id]/consent", "ConsentRegistered.v1", { aggregateId: capture.id });

      return consent;
    })
    .catch((e: unknown) => {
      if (e instanceof Error && e.message === "ISMAY_VERSION_CONFLICT") {
        return null;
      }
      throw e;
    });

  if (!result) {
    return apiError("VERSION_CONFLICT", "他の更新と競合しました。もう一度お試しください", { retryable: true });
  }

  return apiOk({ consentId: result.id, expiresAt: result.expiresAt }, { status: 201 });
}
