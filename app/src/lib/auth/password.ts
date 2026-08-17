import { argon2id, argon2Verify } from "hash-wasm";
import { randomBytes } from "node:crypto";

// OWASP推奨値ベース（Argon2id, m=19MiB, t=2, p=1相当）。ネイティブビルド不要なWASM実装のため
// サーバーのビルド環境（node-gyp等）に依存しない。
const MEMORY_KIB = 19456;
const ITERATIONS = 2;
const PARALLELISM = 1;
const HASH_LENGTH = 32;

export async function hashPassword(plain: string): Promise<string> {
  const salt = randomBytes(16);
  return argon2id({
    password: plain,
    salt,
    memorySize: MEMORY_KIB,
    iterations: ITERATIONS,
    parallelism: PARALLELISM,
    hashLength: HASH_LENGTH,
    outputType: "encoded",
  });
}

export async function verifyPassword(plain: string, encodedHash: string): Promise<boolean> {
  try {
    return await argon2Verify({ password: plain, hash: encodedHash });
  } catch {
    return false;
  }
}

/**
 * FR-AUTH-01: パスワードポリシー最低要件チェック。
 * 8文字以上、英大小文字・数字・記号のうち3種類以上を要求する。[推論・im-prod踏襲]
 */
export function validatePasswordPolicy(plain: string): { valid: boolean; reason?: string } {
  if (plain.length < 8) {
    return { valid: false, reason: "パスワードは8文字以上にしてください" };
  }
  const classes = [/[a-z]/, /[A-Z]/, /[0-9]/, /[^a-zA-Z0-9]/].filter((re) => re.test(plain)).length;
  if (classes < 3) {
    return { valid: false, reason: "英大文字・英小文字・数字・記号のうち3種類以上を組み合わせてください" };
  }
  return { valid: true };
}
