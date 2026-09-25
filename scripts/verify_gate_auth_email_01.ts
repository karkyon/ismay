#!/usr/bin/env node
/**
 * scripts/verify_gate_auth_email_01.ts
 *
 * AUTH-EMAIL-01(メールアドレス確認・パスワード再設定)実DB受入試験。
 * 出典: 全機能仕様一覧 AUTH-RESET「token、期限、rate limit、mail provider、監査」、
 * 利用者決定(2026-09-26): SMTP+nodemailer、未確認はログイン不可、確認リンク24時間・1回限り、
 * 再送60秒間隔かつ1時間5回まで、新リンク発行で旧リンク無効、パスワード再設定も同Gate。
 *
 * 検証内容(メール送信はメモリ上のtransportへ差し替え、実送信0件):
 *   [A1] 発行: DBにはtoken hashのみ、送信メールのリンクから取り出したtokenのhashと一致、監査SUCCESS
 *   [A2] 再送: 60秒以内はINTERVAL、60秒後は発行でき旧tokenはSUPERSEDED(旧リンクで確認不可)
 *   [A3] 上限: 1時間に5回まで、6回目はWINDOW_LIMIT。1時間経過後は再び発行可
 *   [A4] 確認: 成功でemail_verified_atが設定され、同じリンクの2回目はUSED、監査EMAIL_VERIFIED
 *   [A5] 期限: 24時間を過ぎたリンクはEXPIRED(確認されない)
 *   [A6] 対象: 確認済みへの確認メール・未確認への再設定メール・未登録アドレスは発行しない
 *   [A7] 再設定: ポリシー違反ではtokenを消費しない、成功でパスワード変更・全セッション失効・2回目USED
 *   [A8] 同時実行: 同一tokenの同時消費は1件だけ成功、同時再送は1件だけ発行
 *   [A9] 送信失敗: 失敗は監査FAILUREに記録され、tokenは有効なまま(再送で回復可能)
 *   [A10] IP上限: 同一IPから1時間20件を超える発行は拒否
 *   [A11] 削除済みユーザーのリンクは無効(USER_INACTIVE)
 *   [A12] アカウントPurge: auth_email_tokensがuser scopeの削除対象になり、実行後に残らない
 *   [A13] DB制約: purposeのCHECK、token_hashの一意制約
 *   cleanup後の残存0、AI network実通信0。
 *
 * 実行方法:
 *   cd ~/projects/ismay/app
 *   npx tsx ../scripts/verify_gate_auth_email_01.ts
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

function loadDotEnv(envPath: string): void {
  let content: string;
  try {
    content = readFileSync(envPath, "utf-8");
  } catch {
    return;
  }
  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
    if (value.length >= 2 && value[0] === value[value.length - 1] && (value[0] === '"' || value[0] === "'")) {
      value = value.slice(1, -1);
    }
    if (process.env[key] === undefined) process.env[key] = value;
  }
}
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
loadDotEnv(join(__dirname, "..", "app", ".env"));

const RUN_ID = Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
const EMAIL_PREFIX = "gate-auth-email-01-verify-";
const MIN = 60 * 1000;
const HOUR = 60 * MIN;
const DAY_MS = 24 * HOUR;
const STRONG_PASSWORD = `Verify!${RUN_ID}Aa1`;

let passed = 0;
let failed = 0;
const failures: string[] = [];
function ok(name: string, cond: boolean, detail?: string): void {
  if (cond) {
    passed++;
    console.log(`  ok - ${name}`);
  } else {
    failed++;
    failures.push(name + (detail ? ` (${detail})` : ""));
    console.log(`  NG - ${name}${detail ? ` :: ${detail}` : ""}`);
  }
}

async function main(): Promise<void> {
  const { installAiNetworkDenyGuard } = await import("./lib/aiNetworkDenyGuard");
  const guard = installAiNetworkDenyGuard();

  const { db } = await import("../app/src/lib/db");
  const { cleanupFormationVerifyUser } = await import("./lib/formationVerifyCleanup");
  const { createMemoryMailTransport, setMailTransportForTesting } = await import("../app/src/lib/mail/mailer");
  const { issueEmailToken, deliverEmailToken, consumeEmailVerificationToken, consumePasswordResetToken } = await import(
    "../app/src/lib/auth/emailToken"
  );
  const { hashEmailToken } = await import("../app/src/lib/auth/emailTokenCore");
  const { hashPassword, verifyPassword } = await import("../app/src/lib/auth/password");
  const { dryRunPurgeForUser, executePurgeForUser } = await import("../app/src/lib/admin/purgeJob");

  const mail = createMemoryMailTransport();
  setMailTransportForTesting(mail, "https://verify.example.invalid");

  const createdUserIds: string[] = [];

  async function cleanupUsers(userIds: string[]): Promise<string[]> {
    const errors: string[] = [];
    for (const userId of userIds) {
      if (!(await db.user.findUnique({ where: { id: userId }, select: { id: true } }))) continue;
      const r = await cleanupFormationVerifyUser(db, userId);
      if ((await db.user.findUnique({ where: { id: userId }, select: { id: true } })) || r.errors.length > 0) {
        errors.push(`${userId}: ${r.errors.map((x) => x.step).join(",")}`);
      }
    }
    await db.auditLog.deleteMany({ where: { targetId: { in: userIds } } });
    return errors;
  }

  const orphans = await db.user.findMany({
    where: { email: { startsWith: EMAIL_PREFIX, endsWith: "@example.invalid" } },
    select: { id: true },
  });
  if (orphans.length > 0) {
    console.log(`[SWEEP] 過去実行の孤立テストユーザー${orphans.length}件を削除します...`);
    await cleanupUsers(orphans.map((o) => o.id));
  }

  let seq = 0;
  async function makeUser(suffix: string, opts: { verified: boolean; deletedAt?: Date | null }) {
    seq += 1;
    const email = `${EMAIL_PREFIX}${RUN_ID}-${seq}-${suffix}@example.invalid`;
    const user = await db.user.create({
      data: {
        email,
        passwordHash: await hashPassword(STRONG_PASSWORD),
        displayName: `AUTH-EMAIL ${suffix}`,
        emailVerifiedAt: opts.verified ? new Date() : null,
        deletedAt: opts.deletedAt ?? null,
      },
    });
    createdUserIds.push(user.id);
    return { userId: user.id, email };
  }

  function tokenFromLastMail(): string {
    const last = mail.sent[mail.sent.length - 1];
    const m = last?.text.match(/\?token=([A-Za-z0-9_-]+)/);
    return m ? decodeURIComponent(m[1]!) : "";
  }

  // 固定IP(TEST-NET-3)。RUN_IDごとに末尾を変え、前回実行の行とIP上限を共有しない。
  const ipBase = `198.51.100.${(Date.now() % 200) + 1}`;
  const IP = (n: number) => `${ipBase}#${RUN_ID}-${n}`;

  try {
    // ============================================================
    // A1: 発行と送信
    // ============================================================
    console.log("=== [A1] 発行・送信 ===");
    {
      const u = await makeUser("a1", { verified: false });
      const issued = await issueEmailToken({ purpose: "EMAIL_VERIFICATION", userId: u.userId, requestIp: IP(1) });
      ok("[A1] 未確認ユーザーへ発行できる", issued.status === "ISSUED", JSON.stringify(issued.status === "SKIPPED" ? issued : {}));
      if (issued.status === "ISSUED") {
        const before = mail.sent.length;
        const delivered = await deliverEmailToken(issued, IP(1));
        ok("[A1] 送信成功", delivered.sent);
        ok("[A1] メールが1通送られた", mail.sent.length === before + 1);
        const last = mail.sent[mail.sent.length - 1]!;
        ok("[A1] 宛先は登録アドレス", last.to === u.email);
        ok("[A1] リンクはAPP_BASE_URL基点の/verify-email", last.text.includes("https://verify.example.invalid/verify-email?token="));
        const linkToken = tokenFromLastMail();
        ok("[A1] リンクのtokenは発行したtokenと一致", linkToken === issued.token);
        const row = await db.authEmailToken.findUnique({ where: { id: issued.tokenId } });
        ok("[A1] DBにはhashのみ保存(平文と異なる)", !!row && row.tokenHash === hashEmailToken(issued.token) && row.tokenHash !== issued.token);
        ok("[A1] 送信先アドレスを記録", row?.sentToEmail === u.email);
        ok("[A1] 期限は発行から24時間", !!row && row.expiresAt.getTime() - row.createdAt.getTime() === DAY_MS);
        const raw = await db.$queryRawUnsafe<{ n: bigint }[]>(
          `SELECT count(*)::bigint AS n FROM "auth_email_tokens" t WHERE t."id" = $1 AND (t::text LIKE '%' || $2 || '%')`,
          issued.tokenId,
          issued.token,
        );
        ok("[A1] token平文はどの列にも含まれない", Number(raw[0]?.n ?? 1) === 0);
        const audit = await db.auditLog.findFirst({ where: { targetId: u.userId, action: "EMAIL_VERIFICATION_SENT" } });
        ok("[A1] 監査EMAIL_VERIFICATION_SENT(SUCCESS・SYSTEM)", audit?.result === "SUCCESS" && audit.actorType === "SYSTEM");
        ok("[A1] 監査にtoken平文を含まない", !!audit && !(audit.reason ?? "").includes(issued.token));
        ok("[A1] 監査に要求元IPを記録", audit?.ipAddress === IP(1));
      }
    }

    // ============================================================
    // A2: 再送間隔と旧リンク無効
    // ============================================================
    console.log("=== [A2] 再送間隔・旧リンク無効 ===");
    {
      const u = await makeUser("a2", { verified: false });
      const t0 = new Date();
      const first = await issueEmailToken({ purpose: "EMAIL_VERIFICATION", userId: u.userId, requestIp: IP(2), now: t0 });
      const tooSoon = await issueEmailToken({ purpose: "EMAIL_VERIFICATION", userId: u.userId, requestIp: IP(2), now: new Date(t0.getTime() + 30_000) });
      ok("[A2] 30秒後の再送はINTERVAL", tooSoon.status === "SKIPPED" && tooSoon.reason === "INTERVAL");
      ok("[A2] INTERVALの待ち時間は30秒", tooSoon.status === "SKIPPED" && tooSoon.retryAfterMs === 30_000);
      const second = await issueEmailToken({ purpose: "EMAIL_VERIFICATION", userId: u.userId, requestIp: IP(2), now: new Date(t0.getTime() + 61_000) });
      ok("[A2] 61秒後の再送は発行できる", second.status === "ISSUED");
      if (first.status === "ISSUED" && second.status === "ISSUED") {
        const oldRow = await db.authEmailToken.findUnique({ where: { id: first.tokenId } });
        ok("[A2] 旧tokenはsuperseded", oldRow?.supersededAt !== null && oldRow?.supersededAt !== undefined);
        const oldUse = await consumeEmailVerificationToken({ token: first.token, requestIp: IP(2), now: new Date(t0.getTime() + 62_000) });
        ok("[A2] 旧リンクではSUPERSEDEDで確認できない", !oldUse.ok && oldUse.reason === "SUPERSEDED");
        const user = await db.user.findUnique({ where: { id: u.userId } });
        ok("[A2] 旧リンクの試行で確認済みにならない", user?.emailVerifiedAt === null);
        const newUse = await consumeEmailVerificationToken({ token: second.token, requestIp: IP(2), now: new Date(t0.getTime() + 63_000) });
        ok("[A2] 新リンクでは確認できる", newUse.ok);
        const failAudit = await db.auditLog.findFirst({ where: { targetId: u.userId, action: "EMAIL_VERIFIED", result: "FAILURE" } });
        ok("[A2] 旧リンクの失敗は監査FAILURE(SUPERSEDED)", !!failAudit && (failAudit.reason ?? "").startsWith("SUPERSEDED"));
      }
    }

    // ============================================================
    // A3: 1時間5回まで
    // ============================================================
    console.log("=== [A3] 1時間あたりの上限 ===");
    {
      const u = await makeUser("a3", { verified: false });
      const t0 = new Date(Date.now() - 2 * HOUR);
      const results: string[] = [];
      for (let i = 0; i < 6; i++) {
        const r = await issueEmailToken({ purpose: "EMAIL_VERIFICATION", userId: u.userId, requestIp: IP(3), now: new Date(t0.getTime() + i * 61_000) });
        results.push(r.status === "ISSUED" ? "ISSUED" : r.reason);
      }
      ok("[A3] 5回までは発行", results.slice(0, 5).every((r) => r === "ISSUED"), results.join(","));
      ok("[A3] 6回目はWINDOW_LIMIT", results[5] === "WINDOW_LIMIT", results.join(","));
      const after = await issueEmailToken({ purpose: "EMAIL_VERIFICATION", userId: u.userId, requestIp: IP(3), now: new Date(t0.getTime() + HOUR + 1000) });
      ok("[A3] 最初の発行から1時間経過後は再び発行できる", after.status === "ISSUED");
      const active = await db.authEmailToken.count({ where: { userId: u.userId, consumedAt: null, supersededAt: null } });
      ok("[A3] 有効なtokenは常に1件だけ", active === 1, `active=${active}`);
    }

    // ============================================================
    // A4: 確認の成功と1回限り
    // ============================================================
    console.log("=== [A4] 確認成功・1回限り ===");
    {
      const u = await makeUser("a4", { verified: false });
      const issued = await issueEmailToken({ purpose: "EMAIL_VERIFICATION", userId: u.userId, requestIp: IP(4) });
      if (issued.status === "ISSUED") {
        const r1 = await consumeEmailVerificationToken({ token: issued.token, requestIp: IP(4) });
        ok("[A4] 確認成功", r1.ok && !r1.alreadyVerified);
        const user = await db.user.findUnique({ where: { id: u.userId } });
        ok("[A4] email_verified_atが設定される", !!user?.emailVerifiedAt);
        const r2 = await consumeEmailVerificationToken({ token: issued.token, requestIp: IP(4) });
        ok("[A4] 同じリンクの2回目はUSED", !r2.ok && r2.reason === "USED");
        const audit = await db.auditLog.findFirst({ where: { targetId: u.userId, action: "EMAIL_VERIFIED", result: "SUCCESS" } });
        ok("[A4] 監査EMAIL_VERIFIED(SUCCESS・USER)", audit?.actorType === "USER" && audit.actorUserId === u.userId);
        const again = await issueEmailToken({ purpose: "EMAIL_VERIFICATION", userId: u.userId, requestIp: IP(4), now: new Date(Date.now() + 2 * MIN) });
        ok("[A4] 確認済みユーザーへは確認メールを再発行しない", again.status === "SKIPPED" && again.reason === "USER_NOT_ELIGIBLE");
      } else {
        ok("[A4] 発行", false, issued.reason);
      }
      const garbage = await consumeEmailVerificationToken({ token: "x".repeat(43), requestIp: IP(4) });
      ok("[A4] 存在しないtokenはNOT_FOUND", !garbage.ok && garbage.reason === "NOT_FOUND");
      const malformed = await consumeEmailVerificationToken({ token: "'; DROP TABLE users; --", requestIp: IP(4) });
      ok("[A4] 形式外のtokenはNOT_FOUND", !malformed.ok && malformed.reason === "NOT_FOUND");
    }

    // ============================================================
    // A5: 期限切れ
    // ============================================================
    console.log("=== [A5] 24時間の期限 ===");
    {
      const u = await makeUser("a5", { verified: false });
      const issuedAt = new Date(Date.now() - DAY_MS - MIN);
      const issued = await issueEmailToken({ purpose: "EMAIL_VERIFICATION", userId: u.userId, requestIp: IP(5), now: issuedAt });
      if (issued.status === "ISSUED") {
        const justBefore = await consumeEmailVerificationToken({
          token: issued.token,
          requestIp: IP(5),
          now: new Date(issuedAt.getTime() + DAY_MS),
        });
        ok("[A5] ちょうど24時間後はEXPIRED", !justBefore.ok && justBefore.reason === "EXPIRED");
        const late = await consumeEmailVerificationToken({ token: issued.token, requestIp: IP(5) });
        ok("[A5] 24時間を過ぎたリンクはEXPIRED", !late.ok && late.reason === "EXPIRED");
        const user = await db.user.findUnique({ where: { id: u.userId } });
        ok("[A5] 期限切れでは確認済みにならない", user?.emailVerifiedAt === null);
      } else {
        ok("[A5] 発行", false, issued.reason);
      }
    }

    // ============================================================
    // A6: 発行対象
    // ============================================================
    console.log("=== [A6] 発行対象 ===");
    {
      const verified = await makeUser("a6v", { verified: true });
      const unverified = await makeUser("a6u", { verified: false });
      const r1 = await issueEmailToken({ purpose: "EMAIL_VERIFICATION", email: verified.email.toUpperCase(), requestIp: IP(6) });
      ok("[A6] 確認済みユーザーへ確認メールは発行しない(大文字小文字は同一視)", r1.status === "SKIPPED" && r1.reason === "USER_NOT_ELIGIBLE");
      const r2 = await issueEmailToken({ purpose: "PASSWORD_RESET", email: unverified.email, requestIp: IP(6) });
      ok("[A6] 未確認ユーザーへ再設定メールは発行しない(検証済mailのみ)", r2.status === "SKIPPED" && r2.reason === "USER_NOT_ELIGIBLE");
      const r3 = await issueEmailToken({ purpose: "PASSWORD_RESET", email: `${EMAIL_PREFIX}${RUN_ID}-nobody@example.invalid`, requestIp: IP(6) });
      ok("[A6] 未登録アドレスは発行しない", r3.status === "SKIPPED" && r3.reason === "USER_NOT_FOUND");
      const r4 = await issueEmailToken({ purpose: "PASSWORD_RESET", email: verified.email, requestIp: IP(6) });
      ok("[A6] 確認済みユーザーへ再設定メールは発行する", r4.status === "ISSUED");
      const rows = await db.authEmailToken.count({ where: { userId: unverified.userId } });
      ok("[A6] 発行しなかった場合はtoken行を作らない", rows === 0);
    }

    // ============================================================
    // A7: パスワード再設定
    // ============================================================
    console.log("=== [A7] パスワード再設定 ===");
    {
      const u = await makeUser("a7", { verified: true });
      for (let i = 0; i < 2; i++) {
        await db.userSession.create({
          data: {
            userId: u.userId,
            refreshTokenHash: `verify-${RUN_ID}-${i}`,
            refreshTokenFamily: `verify-${RUN_ID}-${i}`,
            expiresAt: new Date(Date.now() + DAY_MS),
          },
        });
      }
      const issued = await issueEmailToken({ purpose: "PASSWORD_RESET", userId: u.userId, requestIp: IP(7) });
      if (issued.status === "ISSUED") {
        ok("[A7] 再設定tokenの期限は60分", issued.expiresAt.getTime() - Date.now() <= HOUR && issued.expiresAt.getTime() - Date.now() > HOUR - MIN);
        const delivered = await deliverEmailToken(issued, IP(7));
        ok("[A7] 再設定メールのリンクは/reset-password", delivered.sent && mail.sent[mail.sent.length - 1]!.text.includes("/reset-password?token="));
        const weak = await consumePasswordResetToken({ token: issued.token, newPassword: "short", requestIp: IP(7) });
        ok("[A7] ポリシー違反はPASSWORD_POLICY", !weak.ok && weak.reason === "PASSWORD_POLICY");
        const rowAfterWeak = await db.authEmailToken.findUnique({ where: { id: issued.tokenId } });
        ok("[A7] ポリシー違反ではtokenを消費しない", rowAfterWeak?.consumedAt === null);
        const newPassword = `Reset!${RUN_ID}Bb2`;
        const done = await consumePasswordResetToken({ token: issued.token, newPassword, requestIp: IP(7) });
        ok("[A7] 再設定成功", done.ok);
        ok("[A7] 有効セッション2件を失効", done.ok && done.revokedSessions === 2);
        const user = await db.user.findUnique({ where: { id: u.userId } });
        ok("[A7] 新しいパスワードで照合できる", !!user && (await verifyPassword(newPassword, user.passwordHash)));
        ok("[A7] 旧パスワードでは照合できない", !!user && !(await verifyPassword(STRONG_PASSWORD, user.passwordHash)));
        const active = await db.userSession.count({ where: { userId: u.userId, revokedAt: null } });
        ok("[A7] 有効セッションは0件", active === 0);
        const reasons = await db.userSession.findMany({ where: { userId: u.userId }, select: { revokedReason: true } });
        ok("[A7] 失効理由はPASSWORD_RESET", reasons.every((r) => r.revokedReason === "PASSWORD_RESET"));
        const again = await consumePasswordResetToken({ token: issued.token, newPassword: `Again!${RUN_ID}Cc3`, requestIp: IP(7) });
        ok("[A7] 同じリンクの2回目はUSED", !again.ok && again.reason === "USED");
        const audit = await db.auditLog.findFirst({ where: { targetId: u.userId, action: "PASSWORD_RESET_COMPLETED", result: "SUCCESS" } });
        ok("[A7] 監査PASSWORD_RESET_COMPLETED(SUCCESS)", !!audit && (audit.reason ?? "").includes("revokedSessions=2"));
        const verifyTokenAsReset = await issueEmailToken({ purpose: "PASSWORD_RESET", userId: u.userId, requestIp: IP(7), now: new Date(Date.now() + 2 * MIN) });
        if (verifyTokenAsReset.status === "ISSUED") {
          const wrongPurpose = await consumeEmailVerificationToken({ token: verifyTokenAsReset.token, requestIp: IP(7) });
          ok("[A7] 再設定tokenはメール確認に使えない(NOT_FOUND)", !wrongPurpose.ok && wrongPurpose.reason === "NOT_FOUND");
        } else {
          ok("[A7] 用途違いの検証用に再発行", false, verifyTokenAsReset.reason);
        }
      } else {
        ok("[A7] 発行", false, issued.reason);
      }
    }

    // ============================================================
    // A8: 同時実行
    // ============================================================
    console.log("=== [A8] 同時実行 ===");
    {
      const u = await makeUser("a8", { verified: false });
      const issued = await issueEmailToken({ purpose: "EMAIL_VERIFICATION", userId: u.userId, requestIp: IP(8) });
      if (issued.status === "ISSUED") {
        const results = await Promise.all(
          Array.from({ length: 4 }, () => consumeEmailVerificationToken({ token: issued.token, requestIp: IP(8) })),
        );
        const okCount = results.filter((r) => r.ok).length;
        ok("[A8] 同一tokenの同時消費は1件だけ成功", okCount === 1, results.map((r) => (r.ok ? "OK" : r.reason)).join(","));
        ok("[A8] 残りはUSED", results.filter((r) => !r.ok).every((r) => !r.ok && r.reason === "USED"));
      }
      const u2 = await makeUser("a8b", { verified: false });
      const at = new Date();
      const burst = await Promise.all(
        Array.from({ length: 4 }, () => issueEmailToken({ purpose: "EMAIL_VERIFICATION", userId: u2.userId, requestIp: IP(9), now: at })),
      );
      const issuedCount = burst.filter((r) => r.status === "ISSUED").length;
      ok("[A8] 同時再送は1件だけ発行(60秒間隔を超えない)", issuedCount === 1, burst.map((r) => (r.status === "ISSUED" ? "ISSUED" : r.reason)).join(","));
      const rows = await db.authEmailToken.count({ where: { userId: u2.userId } });
      ok("[A8] token行も1件だけ", rows === 1, `rows=${rows}`);
    }

    // ============================================================
    // A9: 送信失敗
    // ============================================================
    console.log("=== [A9] 送信失敗 ===");
    {
      const u = await makeUser("a9", { verified: false });
      const issued = await issueEmailToken({ purpose: "EMAIL_VERIFICATION", userId: u.userId, requestIp: IP(10) });
      if (issued.status === "ISSUED") {
        mail.failNext = 1;
        const delivered = await deliverEmailToken(issued, IP(10));
        ok("[A9] 送信失敗はsent=false(例外を投げない)", !delivered.sent);
        const audit = await db.auditLog.findFirst({ where: { targetId: u.userId, action: "EMAIL_VERIFICATION_SENT", result: "FAILURE" } });
        ok("[A9] 監査FAILURE(SEND_FAILED)", !!audit && (audit.reason ?? "").startsWith("SEND_FAILED"));
        const resent = await issueEmailToken({ purpose: "EMAIL_VERIFICATION", userId: u.userId, requestIp: IP(10), now: new Date(Date.now() + 61_000) });
        ok("[A9] 60秒後の再送で回復できる", resent.status === "ISSUED");
        if (resent.status === "ISSUED") {
          const d2 = await deliverEmailToken(resent, IP(10));
          ok("[A9] 再送は成功", d2.sent);
        }
      }
    }

    // ============================================================
    // A10: IP上限
    // ============================================================
    console.log("=== [A10] IP単位の上限 ===");
    {
      const filler = await makeUser("a10f", { verified: false });
      const ip = IP(11);
      const base = Date.now() - 30 * MIN;
      for (let i = 0; i < 20; i++) {
        await db.authEmailToken.create({
          data: {
            userId: filler.userId,
            purpose: "EMAIL_VERIFICATION",
            tokenHash: hashEmailToken(`filler-${RUN_ID}-${i}`),
            sentToEmail: filler.email,
            requestIp: ip,
            expiresAt: new Date(base + i * 1000 + DAY_MS),
            supersededAt: new Date(base + i * 1000 + 1),
            createdAt: new Date(base + i * 1000),
          },
        });
      }
      const target = await makeUser("a10t", { verified: false });
      const r = await issueEmailToken({ purpose: "EMAIL_VERIFICATION", userId: target.userId, requestIp: ip });
      ok("[A10] 同一IPから1時間20件を超える発行はIP_LIMIT", r.status === "SKIPPED" && r.reason === "IP_LIMIT", r.status === "SKIPPED" ? r.reason : "ISSUED");
      const other = await issueEmailToken({ purpose: "EMAIL_VERIFICATION", userId: target.userId, requestIp: IP(12) });
      ok("[A10] 別IPからは発行できる", other.status === "ISSUED");
    }

    // ============================================================
    // A11: 削除済みユーザー
    // ============================================================
    console.log("=== [A11] 削除済みユーザー ===");
    {
      const u = await makeUser("a11", { verified: false });
      const issued = await issueEmailToken({ purpose: "EMAIL_VERIFICATION", userId: u.userId, requestIp: IP(13) });
      await db.user.update({ where: { id: u.userId }, data: { deletedAt: new Date() } });
      if (issued.status === "ISSUED") {
        const r = await consumeEmailVerificationToken({ token: issued.token, requestIp: IP(13) });
        ok("[A11] 削除済みユーザーのリンクはUSER_INACTIVE", !r.ok && r.reason === "USER_INACTIVE");
      }
      const again = await issueEmailToken({ purpose: "EMAIL_VERIFICATION", userId: u.userId, requestIp: IP(13), now: new Date(Date.now() + 2 * MIN) });
      ok("[A11] 削除済みユーザーへは発行しない", again.status === "SKIPPED" && again.reason === "USER_NOT_ELIGIBLE");
    }

    // ============================================================
    // A12: アカウントPurge
    // ============================================================
    console.log("=== [A12] アカウントPurge ===");
    {
      const u = await makeUser("a12", { verified: true });
      const workspace = await db.workspace.create({ data: { name: `AUTH-EMAIL a12 ${RUN_ID}` } });
      await db.workspaceMember.create({ data: { workspaceId: workspace.id, userId: u.userId, role: "OWNER" } });
      const issued = await issueEmailToken({ purpose: "PASSWORD_RESET", userId: u.userId, requestIp: IP(14) });
      ok("[A12] Purge対象ユーザーにtokenを発行", issued.status === "ISSUED");
      const deletedAt = new Date(Date.now() - 31 * DAY_MS);
      await db.user.update({ where: { id: u.userId }, data: { deletedAt } });
      await db.workspace.update({ where: { id: workspace.id }, data: { deletedAt } });
      const plan = await dryRunPurgeForUser({ userId: u.userId });
      const entry = plan.status === "ELIGIBLE" ? plan.manifest.perTable.find((t) => t.tableName === "auth_email_tokens") : undefined;
      ok("[A12] dry-runでauth_email_tokensがuser scopeの削除対象", !!entry && entry.count === 1 && entry.scopeKind === "user", JSON.stringify(entry ?? plan.status));
      ok(
        "[A12] auth_email_tokensは保持表に含まれない",
        plan.status === "ELIGIBLE" && !plan.manifest.retainedUnscopedTables.includes("auth_email_tokens"),
      );
      const executed = await executePurgeForUser({ userId: u.userId });
      ok("[A12] Purge実行", executed.status === "PURGED", `${executed.status}`);
      const left = await db.authEmailToken.count({ where: { userId: u.userId } });
      ok("[A12] Purge後にtoken行が残らない", left === 0);
    }

    // ============================================================
    // A13: DB制約
    // ============================================================
    console.log("=== [A13] DB制約 ===");
    {
      const u = await makeUser("a13", { verified: false });
      let checkRejected = false;
      try {
        await db.authEmailToken.create({
          data: {
            userId: u.userId,
            purpose: "MAGIC_LINK",
            tokenHash: hashEmailToken(`bad-${RUN_ID}`),
            sentToEmail: u.email,
            expiresAt: new Date(Date.now() + HOUR),
            createdAt: new Date(),
          },
        });
      } catch {
        checkRejected = true;
      }
      ok("[A13] 未定義のpurposeはCHECKで拒否", checkRejected);
      const hash = hashEmailToken(`dup-${RUN_ID}`);
      await db.authEmailToken.create({
        data: { userId: u.userId, purpose: "EMAIL_VERIFICATION", tokenHash: hash, sentToEmail: u.email, expiresAt: new Date(Date.now() + HOUR), createdAt: new Date() },
      });
      let uniqueRejected = false;
      try {
        await db.authEmailToken.create({
          data: { userId: u.userId, purpose: "EMAIL_VERIFICATION", tokenHash: hash, sentToEmail: u.email, expiresAt: new Date(Date.now() + HOUR), createdAt: new Date() },
        });
      } catch {
        uniqueRejected = true;
      }
      ok("[A13] token_hashの重複は一意制約で拒否", uniqueRejected);
      const nullVerified = await db.$queryRawUnsafe<{ n: bigint }[]>(
        `SELECT count(*)::bigint AS n FROM "users" WHERE "email_verified_at" IS NULL AND "email" NOT LIKE $1`,
        `${EMAIL_PREFIX}%`,
      );
      ok("[A13] 既存ユーザー(本試験以外)にメール未確認は残っていない(migrationのbackfill)", Number(nullVerified[0]?.n ?? 1) === 0, `n=${nullVerified[0]?.n}`);
    }

  } finally {
    setMailTransportForTesting(null);
    console.log("[CLEANUP] テスト用データを削除します...");
    const errors = await cleanupUsers(createdUserIds);
    ok("[cleanup] cleanup errorなし", errors.length === 0, errors.join(" / "));
    const leftover = await db.user.count({ where: { email: { startsWith: EMAIL_PREFIX, endsWith: "@example.invalid" } } });
    ok("[cleanup] test用Userが1件も残っていない", leftover === 0, `remaining=${leftover}`);
    const leftoverTokens = await db.authEmailToken.count({ where: { sentToEmail: { startsWith: EMAIL_PREFIX } } });
    ok("[cleanup] test用tokenが1件も残っていない", leftoverTokens === 0, `remaining=${leftoverTokens}`);
    guard.restore();
    ok("[AI network] AI networkへの実通信試行は0回", guard.deniedCallAttempts.length === 0, `attempts=${JSON.stringify(guard.deniedCallAttempts)}`);
    await db.$disconnect();
  }

  console.log(`\n合計: ${passed} passed, ${failed} failed`);
  if (failed > 0) {
    console.log("\n失敗一覧:");
    for (const f of failures) console.log(`  - ${f}`);
    process.exitCode = 1;
  }
}

main().catch((err) => {
  console.error("[FATAL]", err);
  process.exitCode = 1;
});
