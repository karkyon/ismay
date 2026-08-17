import { SignJWT, jwtVerify } from "jose";
import { randomBytes, createHash } from "node:crypto";

// システム基本設計書v1.2 7章: 「Access Token短寿命、Refresh Tokenローテーション」に対応。
const ACCESS_TOKEN_TTL_SECONDS = 15 * 60; // 15分
export const REFRESH_TOKEN_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30日

function getJwtSecret(): Uint8Array {
  const raw = process.env.AUTH_JWT_SECRET;
  if (!raw) {
    throw new Error(
      "AUTH_JWT_SECRET が未設定です。.envに設定してください（例: openssl rand -base64 48）",
    );
  }
  return new TextEncoder().encode(raw);
}

export interface AccessTokenPayload {
  sub: string; // userId
  sid: string; // sessionId
  email: string;
}

export async function signAccessToken(payload: AccessTokenPayload): Promise<string> {
  return new SignJWT({ email: payload.email, sid: payload.sid })
    .setProtectedHeader({ alg: "HS256", typ: "JWT" })
    .setSubject(payload.sub)
    .setIssuedAt()
    .setExpirationTime(`${ACCESS_TOKEN_TTL_SECONDS}s`)
    .setIssuer("ismay")
    .sign(getJwtSecret());
}

export interface VerifiedAccessToken {
  userId: string;
  sessionId: string;
  email: string;
}

export async function verifyAccessToken(token: string): Promise<VerifiedAccessToken | null> {
  try {
    const { payload } = await jwtVerify(token, getJwtSecret(), { issuer: "ismay" });
    if (!payload.sub || typeof payload.sid !== "string" || typeof payload.email !== "string") {
      return null;
    }
    return { userId: payload.sub, sessionId: payload.sid, email: payload.email };
  } catch {
    return null;
  }
}

/** 不透明なRefresh Token（平文）を生成する。DBにはハッシュのみ保存する。 */
export function generateRefreshToken(): string {
  return randomBytes(48).toString("base64url");
}

export function hashRefreshToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

/** Refresh Token系列ID（ローテーション世代を束ねる。再利用検知に使用） */
export function generateTokenFamily(): string {
  return randomBytes(16).toString("hex");
}

// --- MFAログインチャレンジ・TOTP登録用の短命トークン ---
// パスワード認証済みだがMFA未完了/未登録の状態を、フルセッションを発行せずに
// 安全に橋渡しするための一時トークン（それぞれ用途をpurpose claimで区別する）。

const MFA_CHALLENGE_TTL = "2m";
const ENROLLMENT_TTL = "10m";

export async function signMfaChallengeToken(userId: string): Promise<string> {
  return new SignJWT({ purpose: "mfa_challenge" })
    .setProtectedHeader({ alg: "HS256", typ: "JWT" })
    .setSubject(userId)
    .setIssuedAt()
    .setExpirationTime(MFA_CHALLENGE_TTL)
    .setIssuer("ismay")
    .sign(getJwtSecret());
}

export async function verifyMfaChallengeToken(token: string): Promise<string | null> {
  try {
    const { payload } = await jwtVerify(token, getJwtSecret(), { issuer: "ismay" });
    if (payload.purpose !== "mfa_challenge" || !payload.sub) return null;
    return payload.sub;
  } catch {
    return null;
  }
}

export async function signEnrollmentToken(userId: string, secretEncrypted: string): Promise<string> {
  return new SignJWT({ purpose: "totp_enrollment", secretEnc: secretEncrypted })
    .setProtectedHeader({ alg: "HS256", typ: "JWT" })
    .setSubject(userId)
    .setIssuedAt()
    .setExpirationTime(ENROLLMENT_TTL)
    .setIssuer("ismay")
    .sign(getJwtSecret());
}

export async function verifyEnrollmentToken(
  token: string,
): Promise<{ userId: string; secretEncrypted: string } | null> {
  try {
    const { payload } = await jwtVerify(token, getJwtSecret(), { issuer: "ismay" });
    if (payload.purpose !== "totp_enrollment" || !payload.sub || typeof payload.secretEnc !== "string") {
      return null;
    }
    return { userId: payload.sub, secretEncrypted: payload.secretEnc };
  } catch {
    return null;
  }
}
