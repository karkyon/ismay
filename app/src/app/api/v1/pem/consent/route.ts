import type { NextRequest } from "next/server";
import { requireAuth, requireCsrf } from "@/lib/auth/guard";
import { apiOk, apiError } from "@/lib/auth/response";
import { buildPemAuthorizationContext } from "@/lib/pem/authorizationBoundary";
import {
  getConsentState,
  getWithdrawnMetricKeys,
  recordConsentEvent,
  recordMetricConsentEvent,
} from "@/lib/pem/consent";
import { PEM_CONSENT_ACTIONS, PEM_CONSENT_TYPES } from "@/lib/pem/coreTypes";

/**
 * API-PEM-Consent: PEM同意の閲覧・記録(Phase 0S)。
 * 出典: ISMAY_PEMサブシステム_統合正本仕様書_v4_0 16.1節。
 * 既存 app/api/v1/pem/hypotheses/route.ts の規約(requireAuth→apiOk/apiError)を踏襲しつつ、
 * Phase 0Gで新設した buildPemAuthorizationContext を用いてWorkspace membershipも検証する。
 */

export async function GET(req: NextRequest) {
  const auth = await requireAuth(req);
  if (!auth.authenticated) {
    return apiError("AUTH_REQUIRED", "ログインが必要です");
  }

  const ctx = await buildPemAuthorizationContext(auth.user.userId, auth.user.sessionId);
  const state = await getConsentState(ctx);
  return apiOk({ consent: state, policyVersion: state.PEM_DATA_COLLECTION.policyVersion });
}

export async function POST(req: NextRequest) {
  const auth = await requireAuth(req);
  if (!auth.authenticated) {
    return apiError("AUTH_REQUIRED", "ログインが必要です");
  }
  if (!requireCsrf(req)) {
    return apiError("ACCESS_DENIED", "CSRF検証に失敗しました");
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return apiError("VALIDATION_FAILED", "リクエストボディがJSONではありません");
  }

  const { consentType, metricKey, action, source } = (body ?? {}) as Record<string, unknown>;

  if (typeof action !== "string" || !(PEM_CONSENT_ACTIONS as readonly string[]).includes(action)) {
    return apiError("VALIDATION_FAILED", "actionが不正です", {
      fieldErrors: { action: `許可値: ${PEM_CONSENT_ACTIONS.join(", ")}` },
    });
  }
  const resolvedSource = source === "ONBOARDING" ? "ONBOARDING" : "SETTINGS";
  const ctx = await buildPemAuthorizationContext(auth.user.userId, auth.user.sessionId);

  // [2026-08-25追加・Completion Gate 1、v4.0 16.2節] metricKeyが指定されていれば
  // metric単位OFFの記録として扱う(consentTypeとは排他)。
  if (typeof metricKey === "string" && metricKey.length > 0) {
    await recordMetricConsentEvent(ctx, metricKey, action as (typeof PEM_CONSENT_ACTIONS)[number], resolvedSource);
    const withdrawnMetrics = await getWithdrawnMetricKeys(ctx);
    return apiOk({ withdrawnMetricKeys: [...withdrawnMetrics] }, { status: 201 });
  }

  if (typeof consentType !== "string" || !(PEM_CONSENT_TYPES as readonly string[]).includes(consentType)) {
    return apiError("VALIDATION_FAILED", "consentTypeが不正です", {
      fieldErrors: { consentType: `許可値: ${PEM_CONSENT_TYPES.join(", ")}` },
    });
  }
  await recordConsentEvent(
    ctx,
    consentType as (typeof PEM_CONSENT_TYPES)[number],
    action as (typeof PEM_CONSENT_ACTIONS)[number],
    resolvedSource,
  );

  const state = await getConsentState(ctx);
  return apiOk({ consent: state }, { status: 201 });
}
