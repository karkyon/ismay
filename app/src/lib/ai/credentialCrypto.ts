import { randomBytes, createCipheriv, createDecipheriv } from "node:crypto";

/**
 * AIプロバイダーAPIキーの暗号化保存(AES-256-GCM)。
 * src/lib/auth/totp.tsのTOTP秘密鍵暗号化と同じ方式だが、鍵を別環境変数
 * (AI_CREDENTIAL_ENCRYPTION_KEY)に分離する。MFA用の鍵と用途を混在させないため。
 * TBD-17(機微データのカラムレベル暗号化)の暫定方針をAPIキーにも適用したもの。
 */

function getEncryptionKey(): Buffer {
  const raw = process.env.AI_CREDENTIAL_ENCRYPTION_KEY;
  if (!raw) {
    throw new Error(
      "AI_CREDENTIAL_ENCRYPTION_KEY が未設定です。.envに32byte(base64)の鍵を設定してください(例: openssl rand -base64 32)",
    );
  }
  const key = Buffer.from(raw, "base64");
  if (key.length !== 32) {
    throw new Error("AI_CREDENTIAL_ENCRYPTION_KEY は base64エンコードされた32byteの鍵である必要があります");
  }
  return key;
}

export function encryptApiKey(plain: string): string {
  const key = getEncryptionKey();
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const encrypted = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return [iv.toString("base64"), authTag.toString("base64"), encrypted.toString("base64")].join(".");
}

export function decryptApiKey(payload: string): string {
  const key = getEncryptionKey();
  const [ivB64, tagB64, dataB64] = payload.split(".");
  if (!ivB64 || !tagB64 || !dataB64) {
    throw new Error("APIキーの暗号化ペイロードが不正です");
  }
  const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(ivB64, "base64"));
  decipher.setAuthTag(Buffer.from(tagB64, "base64"));
  const decrypted = Buffer.concat([decipher.update(Buffer.from(dataB64, "base64")), decipher.final()]);
  return decrypted.toString("utf8");
}

export function last4Of(plain: string): string {
  return plain.length <= 4 ? plain : plain.slice(-4);
}
