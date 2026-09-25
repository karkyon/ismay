/**
 * scripts/lib/testEmailVerification.ts
 *
 * [AUTH-EMAIL-01・2026-09-26新設] 登録後はメール確認が済むまでログインできなくなったため、
 * HTTP経由でregister→loginする受入scriptのテスト用ユーザーを確認済みにする。
 * 確認メールのリンク操作そのものは verify_gate_auth_email_01.ts で検証しており、ここでは省略する。
 * 誤って実ユーザーへ適用しないよう、テスト用ドメイン(@example.invalid)以外は拒否する。
 */

type Db = typeof import("../../app/src/lib/db")["db"];

export async function markTestUserEmailVerified(db: Db, email: string): Promise<void> {
  const normalized = email.trim().toLowerCase();
  if (!normalized.endsWith("@example.invalid")) {
    throw new Error(`markTestUserEmailVerifiedはテスト用アドレス(@example.invalid)専用です: ${email}`);
  }
  const user = await db.user.findUnique({ where: { email: normalized }, select: { id: true, emailVerifiedAt: true } });
  if (!user) throw new Error(`テストユーザーが見つかりません: ${email}`);
  if (!user.emailVerifiedAt) {
    await db.user.update({ where: { id: user.id }, data: { emailVerifiedAt: new Date() } });
  }
}
