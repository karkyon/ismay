import { NextResponse } from "next/server";
import { randomUUID } from "node:crypto";
import { debugServer } from "@/lib/debugServer";

export type ErrorCode =
  | "VALIDATION_FAILED"
  | "AUTH_REQUIRED"
  | "ACCESS_DENIED"
  | "RESOURCE_NOT_FOUND"
  | "VERSION_CONFLICT"
  | "STATE_TRANSITION_INVALID"
  | "RATE_LIMITED"
  | "AI_TEMPORARILY_UNAVAILABLE"
  | "MFA_REQUIRED"
  | "MFA_INVALID"
  | "CREDENTIALS_INVALID"
  | "ACCOUNT_LOCKED";

const STATUS_BY_CODE: Record<ErrorCode, number> = {
  VALIDATION_FAILED: 400,
  AUTH_REQUIRED: 401,
  CREDENTIALS_INVALID: 401,
  MFA_REQUIRED: 401,
  MFA_INVALID: 401,
  ACCESS_DENIED: 403,
  ACCOUNT_LOCKED: 403,
  RESOURCE_NOT_FOUND: 404,
  VERSION_CONFLICT: 409,
  STATE_TRANSITION_INVALID: 422,
  RATE_LIMITED: 429,
  AI_TEMPORARILY_UNAVAILABLE: 503,
};

export function apiOk<T>(data: T, init?: { status?: number; extraMeta?: Record<string, unknown> }) {
  const status = init?.status ?? 200;
  // 全API成功応答を一元的にログ出力(個別Route Handlerでの呼び出し漏れを防ぐ)。
  debugServer.event("apiOk", `status=${status}`, data);
  return NextResponse.json(
    { data, meta: { requestId: randomUUID(), ...(init?.extraMeta ?? {}) } },
    { status },
  );
}

export function apiError(
  code: ErrorCode,
  message: string,
  opts?: {
    fieldErrors?: Record<string, string>;
    retryable?: boolean;
    /** 409競合応答等でlatestVersion等の追加情報を返す場合に使う(機能別詳細設計書v1.1 18章) */
    extra?: Record<string, unknown>;
  },
) {
  const status = STATUS_BY_CODE[code];
  // 全APIエラー応答を一元的にログ出力(個別Route Handlerでの呼び出し漏れを防ぐ)。
  debugServer.error("apiError", `${code} (status=${status})`, { message, fieldErrors: opts?.fieldErrors });
  return NextResponse.json(
    {
      error: {
        code,
        message,
        fieldErrors: opts?.fieldErrors,
        retryable: opts?.retryable ?? false,
        requestId: randomUUID(),
        ...(opts?.extra ?? {}),
      },
    },
    { status },
  );
}
