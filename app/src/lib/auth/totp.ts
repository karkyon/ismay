import { generateSecret, generateURI, verify } from "otplib";
import QRCode from "qrcode";
import { randomBytes, createCipheriv, createDecipheriv, createHash } from "node:crypto";

const ISSUER = "ISMAY";
// FR-AUTH-03: TOTPの許容時刻ずれ。前後30秒(1ステップ)まで許容。
const EPOCH_TOLERANCE_SECONDS = 30;

/**
 * ランダムなBase32秘密鍵を生成する（Google Authenticator等の認証アプリと互換）。
 */
export function generateTotpSecret(): string {
  return generateSecret();
}

/**
 * 認証アプリでスキャンするためのQRコード（Data URL, PNG）を生成する。
 */
export async function generateTotpQrCodeDataUrl(email: string, secret: string): Promise<string> {
  const otpauthUrl = generateURI({ issuer: ISSUER, label: email, secret });
  return QRCode.toDataURL(otpauthUrl, { errorCorrectionLevel: "M", margin: 1, width: 200 });
}

export async function verifyTotpToken(token: string, secret: string): Promise<boolean> {
  try {
    const result = await verify({ secret, token, epochTolerance: EPOCH_TOLERANCE_SECONDS });
    return result.valid;
  } catch {
    return false;
  }
}

// --- TOTP秘密鍵の暗号化保存(TBD-17の暫定方針: アプリ層AES-256-GCM) ---
// 鍵は環境変数 MFA_ENCRYPTION_KEY (32byte, base64) から取得する。
// TBD-17が正式決定されるまでの暫定実装であることを明記する。

function getEncryptionKey(): Buffer {
  const raw = process.env.MFA_ENCRYPTION_KEY;
  if (!raw) {
    throw new Error(
      "MFA_ENCRYPTION_KEY が未設定です。.envに32byte(base64)の鍵を設定してください(例: openssl rand -base64 32)",
    );
  }
  const key = Buffer.from(raw, "base64");
  if (key.length !== 32) {
    throw new Error("MFA_ENCRYPTION_KEY は base64エンコードされた32byteの鍵である必要があります");
  }
  return key;
}

export function encryptTotpSecret(secret: string): string {
  const key = getEncryptionKey();
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const encrypted = Buffer.concat([cipher.update(secret, "utf8"), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return [iv.toString("base64"), authTag.toString("base64"), encrypted.toString("base64")].join(".");
}

export function decryptTotpSecret(payload: string): string {
  const key = getEncryptionKey();
  const [ivB64, tagB64, dataB64] = payload.split(".");
  if (!ivB64 || !tagB64 || !dataB64) {
    throw new Error("TOTP秘密鍵の暗号化ペイロードが不正です");
  }
  const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(ivB64, "base64"));
  decipher.setAuthTag(Buffer.from(tagB64, "base64"));
  const decrypted = Buffer.concat([decipher.update(Buffer.from(dataB64, "base64")), decipher.final()]);
  return decrypted.toString("utf8");
}

// --- 復旧コード(FR-AUTH-03: 復旧コードを提供する) ---

export function generateRecoveryCodes(count = 10): { plain: string[]; hashed: string[] } {
  const plain: string[] = [];
  const hashed: string[] = [];
  for (let i = 0; i < count; i++) {
    const code = randomBytes(5).toString("hex"); // 10桁の16進コード
    plain.push(code);
    hashed.push(createHash("sha256").update(code).digest("hex"));
  }
  return { plain, hashed };
}

export function hashRecoveryCode(code: string): string {
  return createHash("sha256").update(code.trim().toLowerCase()).digest("hex");
}
