import { NextResponse } from "next/server";
import { randomUUID } from "node:crypto";

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
  return NextResponse.json(
    { data, meta: { requestId: randomUUID(), ...(init?.extraMeta ?? {}) } },
    { status: init?.status ?? 200 },
  );
}

export function apiError(
  code: ErrorCode,
  message: string,
  opts?: { fieldErrors?: Record<string, string>; retryable?: boolean },
) {
  return NextResponse.json(
    {
      error: {
        code,
        message,
        fieldErrors: opts?.fieldErrors,
        retryable: opts?.retryable ?? false,
        requestId: randomUUID(),
      },
    },
    { status: STATUS_BY_CODE[code] },
  );
}
