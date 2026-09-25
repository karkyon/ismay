/**
 * [AUTH-EMAIL-01・2026-09-26新設] メール確認・パスワード再設定token規則とメール送信設定のDB非依存テスト。
 * 利用者決定: 確認リンク24時間・1回限り、再送60秒間隔かつ1時間5回まで、新リンク発行で旧リンク無効、
 * SMTP+nodemailer(開発時はログ出力)。
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import {
  EMAIL_TOKEN_MAX_PER_IP_PER_WINDOW,
  EMAIL_TOKEN_MAX_PER_WINDOW,
  EMAIL_TOKEN_POLICY,
  EMAIL_TOKEN_RESEND_INTERVAL_MS,
  buildEmailTokenLink,
  buildEmailTokenMessage,
  classifyEmailTokenState,
  decideIssueAllowance,
  describeTtl,
  generateEmailToken,
  hashEmailToken,
  isWellFormedEmailToken,
} from "../emailTokenCore";
import { normalizeBaseUrl, resolveMailConfig } from "../../mail/mailConfig";

const __dirname = dirname(fileURLToPath(import.meta.url));

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

const MIN = 60 * 1000;
const now = new Date("2026-09-26T03:00:00.000Z");
const ago = (ms: number) => new Date(now.getTime() - ms);

console.log("=== emailTokenCore: 期限(利用者決定) ===");
ok("確認リンクの有効期限は24時間", EMAIL_TOKEN_POLICY.EMAIL_VERIFICATION.ttlMs === 24 * 60 * MIN);
ok("再設定リンクの有効期限は60分", EMAIL_TOKEN_POLICY.PASSWORD_RESET.ttlMs === 60 * MIN);
ok("再送間隔は60秒", EMAIL_TOKEN_RESEND_INTERVAL_MS === 60 * 1000);
ok("1時間あたりの上限は5回", EMAIL_TOKEN_MAX_PER_WINDOW === 5);
ok("期限表示: 24時間", describeTtl(EMAIL_TOKEN_POLICY.EMAIL_VERIFICATION.ttlMs) === "24時間");
ok("期限表示: 60分は1時間", describeTtl(60 * MIN) === "1時間");
ok("期限表示: 30分", describeTtl(30 * MIN) === "30分");

console.log("=== emailTokenCore: token生成・hash・形式 ===");
const t1 = generateEmailToken();
const t2 = generateEmailToken();
ok("tokenは毎回異なる", t1 !== t2);
ok("tokenは43文字のbase64url", t1.length === 43 && /^[A-Za-z0-9_-]+$/.test(t1), t1);
ok("生成tokenは形式検査を通る", isWellFormedEmailToken(t1));
ok("短すぎるtokenは形式外", !isWellFormedEmailToken("abc"));
ok("記号を含むtokenは形式外", !isWellFormedEmailToken(`${t1}'--`));
ok("長すぎるtokenは形式外", !isWellFormedEmailToken("a".repeat(129)));
ok("hashはSHA-256 hex(64文字)", /^[0-9a-f]{64}$/.test(hashEmailToken(t1)));
ok("hashは決定的", hashEmailToken(t1) === hashEmailToken(t1));
ok("hashは平文を含まない", !hashEmailToken(t1).includes(t1));

console.log("=== emailTokenCore: 再送間隔・上限 ===");
ok("発行履歴なしは許可", decideIssueAllowance({ now, recentUserIssues: [], recentIpIssues: [] }).allowed);
{
  const r = decideIssueAllowance({ now, recentUserIssues: [ago(30 * 1000)], recentIpIssues: [] });
  ok("30秒前に発行済みはINTERVAL", !r.allowed && r.reason === "INTERVAL");
  ok("INTERVALの待ち時間は残り30秒", !r.allowed && r.retryAfterMs === 30 * 1000);
}
ok("ちょうど60秒前の発行後は許可", decideIssueAllowance({ now, recentUserIssues: [ago(60 * 1000)], recentIpIssues: [] }).allowed);
ok("59.999秒前の発行後はINTERVAL", !decideIssueAllowance({ now, recentUserIssues: [ago(59_999)], recentIpIssues: [] }).allowed);
{
  const five = [ago(50 * MIN), ago(40 * MIN), ago(30 * MIN), ago(20 * MIN), ago(10 * MIN)];
  const r = decideIssueAllowance({ now, recentUserIssues: five, recentIpIssues: [] });
  ok("1時間以内に5回発行済みはWINDOW_LIMIT", !r.allowed && r.reason === "WINDOW_LIMIT");
  ok("WINDOW_LIMITの待ち時間は最古の発行から1時間後まで(10分)", !r.allowed && r.retryAfterMs === 10 * MIN);
  const four = five.slice(1);
  ok("1時間以内に4回なら許可", decideIssueAllowance({ now, recentUserIssues: four, recentIpIssues: [] }).allowed);
  const withOld = [ago(61 * MIN), ...four];
  ok("1時間より前の発行は数えない", decideIssueAllowance({ now, recentUserIssues: withOld, recentIpIssues: [] }).allowed);
}
{
  const ipIssues = Array.from({ length: EMAIL_TOKEN_MAX_PER_IP_PER_WINDOW }, (_, i) => ago((i + 2) * MIN));
  const r = decideIssueAllowance({ now, recentUserIssues: [], recentIpIssues: ipIssues });
  ok("同一IPから1時間20件でIP_LIMIT", !r.allowed && r.reason === "IP_LIMIT");
  ok("同一IPから19件なら許可", decideIssueAllowance({ now, recentUserIssues: [], recentIpIssues: ipIssues.slice(1) }).allowed);
  ok("IP不明(null)ならIP上限は判定しない", decideIssueAllowance({ now, recentUserIssues: [], recentIpIssues: null }).allowed);
}

console.log("=== emailTokenCore: 消費可否(1回限り・旧リンク無効・期限) ===");
const base = { consumedAt: null, supersededAt: null, expiresAt: new Date(now.getTime() + MIN) };
ok("未消費・期限内はUSABLE", classifyEmailTokenState(base, now) === "USABLE");
ok("消費済みはUSED(1回限り)", classifyEmailTokenState({ ...base, consumedAt: ago(MIN) }, now) === "USED");
ok("新リンク発行済みはSUPERSEDED(旧リンク無効)", classifyEmailTokenState({ ...base, supersededAt: ago(MIN) }, now) === "SUPERSEDED");
ok("ちょうど期限時刻はEXPIRED", classifyEmailTokenState({ ...base, expiresAt: now }, now) === "EXPIRED");
ok("期限の1ms前はUSABLE", classifyEmailTokenState({ ...base, expiresAt: new Date(now.getTime() + 1) }, now) === "USABLE");
ok("消費済みかつ期限切れはUSEDを優先", classifyEmailTokenState({ consumedAt: ago(MIN), supersededAt: null, expiresAt: ago(1) }, now) === "USED");

console.log("=== emailTokenCore: リンク・本文 ===");
const link = buildEmailTokenLink("https://ismay.example.com/", "EMAIL_VERIFICATION", t1);
ok("確認リンクは/verify-email?token=", link === `https://ismay.example.com/verify-email?token=${t1}`, link);
ok("再設定リンクは/reset-password?token=", buildEmailTokenLink("https://x.example", "PASSWORD_RESET", t1) === `https://x.example/reset-password?token=${t1}`);
ok("サブパス配下のbaseUrlを保持する", buildEmailTokenLink("https://x.example/ismay", "PASSWORD_RESET", "abc").startsWith("https://x.example/ismay/reset-password?"));
{
  const m = buildEmailTokenMessage({ purpose: "EMAIL_VERIFICATION", to: "a@example.com", link, displayName: "山田" });
  ok("確認メールの宛先", m.to === "a@example.com");
  ok("確認メールの件名", m.subject === "[ISMAY] メールアドレスの確認");
  ok("確認メール本文にリンクを含む", m.text.includes(link));
  ok("確認メール本文に24時間・1回限りを明記", m.text.includes("24時間") && m.text.includes("1回だけ"));
  ok("確認メール本文に旧リンク無効を明記", m.text.includes("以前のリンクは使えなくなります"));
  const r = buildEmailTokenMessage({ purpose: "PASSWORD_RESET", to: "a@example.com", link: "L", displayName: null });
  ok("再設定メールの件名", r.subject === "[ISMAY] パスワードの再設定");
  ok("再設定メール本文に全端末ログアウトを明記", r.text.includes("すべての端末からログアウト"));
  ok("再設定メール本文に1時間を明記", r.text.includes("1時間"));
}

console.log("=== mailConfig: 送信設定 ===");
{
  const r = resolveMailConfig({});
  ok("未設定はlog transport", r.ok && r.config.transport === "log");
  ok("未設定時のbaseUrlはlocalhost:13000", r.ok && r.config.baseUrl === "http://localhost:13000");
  ok("log transportは警告を出す", r.ok && r.warnings.some((w) => w.includes("送信されず")));
}
ok("不明なMAIL_TRANSPORTは設定エラー", !resolveMailConfig({ MAIL_TRANSPORT: "ses" }).ok);
ok("smtpでAPP_BASE_URL未設定は設定エラー(Hostヘッダから組み立てない)", !resolveMailConfig({ MAIL_TRANSPORT: "smtp", SMTP_HOST: "h", MAIL_FROM: "f@x" }).ok);
ok("smtpでMAIL_FROM未設定は設定エラー", !resolveMailConfig({ MAIL_TRANSPORT: "smtp", SMTP_HOST: "h", APP_BASE_URL: "https://a.example" }).ok);
ok("smtpでSMTP_HOST未設定は設定エラー", !resolveMailConfig({ MAIL_TRANSPORT: "smtp", MAIL_FROM: "f@x", APP_BASE_URL: "https://a.example" }).ok);
{
  const r = resolveMailConfig({ MAIL_TRANSPORT: "smtp", SMTP_HOST: "smtp.example.com", MAIL_FROM: "ISMAY <n@example.com>", APP_BASE_URL: "https://a.example/" });
  ok("smtp最小設定は有効", r.ok && r.config.transport === "smtp");
  ok("SMTP_PORT既定は587・secure=false", r.ok && r.config.transport === "smtp" && r.config.smtp.port === 587 && r.config.smtp.secure === false);
  ok("APP_BASE_URLの末尾スラッシュを除去", r.ok && r.config.baseUrl === "https://a.example");
  ok("認証なし(両方未設定)はauth=null", r.ok && r.config.transport === "smtp" && r.config.smtp.auth === null);
}
{
  const r = resolveMailConfig({ MAIL_TRANSPORT: "SMTP", SMTP_HOST: "h", MAIL_FROM: "f@x", APP_BASE_URL: "https://a.example", SMTP_PORT: "465" });
  ok("port 465は既定でsecure=true(大文字のMAIL_TRANSPORTも受理)", r.ok && r.config.transport === "smtp" && r.config.smtp.secure === true);
}
ok("SMTP_USERのみは設定エラー", !resolveMailConfig({ MAIL_TRANSPORT: "smtp", SMTP_HOST: "h", MAIL_FROM: "f@x", APP_BASE_URL: "https://a.example", SMTP_USER: "u" }).ok);
ok("SMTP_PORT範囲外は設定エラー", !resolveMailConfig({ MAIL_TRANSPORT: "smtp", SMTP_HOST: "h", MAIL_FROM: "f@x", APP_BASE_URL: "https://a.example", SMTP_PORT: "70000" }).ok);
ok("SMTP_SECUREの不正値は設定エラー", !resolveMailConfig({ MAIL_TRANSPORT: "smtp", SMTP_HOST: "h", MAIL_FROM: "f@x", APP_BASE_URL: "https://a.example", SMTP_SECURE: "yes" }).ok);
{
  const r = resolveMailConfig({ MAIL_TRANSPORT: "smtp", SMTP_HOST: "h", MAIL_FROM: "f@x", APP_BASE_URL: "http://192.168.1.11:13000", SMTP_USER: "u", SMTP_PASS: "p" });
  ok("httpのAPP_BASE_URLは有効だが警告", r.ok && r.warnings.some((w) => w.includes("http")));
  ok("SMTP_USER/SMTP_PASS両方でauth設定", r.ok && r.config.transport === "smtp" && r.config.smtp.auth?.user === "u");
}
ok("query付きAPP_BASE_URLは拒否", normalizeBaseUrl("https://a.example/?x=1") === null);
ok("javascript:は拒否", normalizeBaseUrl("javascript:alert(1)") === null);
ok("認証情報付きURLは拒否", normalizeBaseUrl("https://u:p@a.example") === null);

console.log("=== 配線: 旧実装の即時検証が残っていない ===");
{
  const register = readFileSync(resolve(__dirname, "../../../app/api/v1/auth/register/route.ts"), "utf-8");
  ok("register/route.tsはemailVerifiedAtをnullで作成する", register.includes("emailVerifiedAt: null") && !register.includes("emailVerifiedAt: new Date()"));
  const login = readFileSync(resolve(__dirname, "../../../app/api/v1/auth/login/route.ts"), "utf-8");
  ok("login/route.tsは未確認ユーザーをEMAIL_NOT_VERIFIEDで拒否する", login.includes("!user.emailVerifiedAt") && login.includes('reason: "EMAIL_NOT_VERIFIED"'));
  const mfa = readFileSync(resolve(__dirname, "../../../app/api/v1/auth/mfa/verify/route.ts"), "utf-8");
  ok("mfa/verify/route.tsも未確認ユーザーを拒否する", mfa.includes("!user.emailVerifiedAt"));
  const schema = readFileSync(resolve(__dirname, "../../../../prisma/schema.prisma"), "utf-8");
  ok("AuthEmailTokenはusersへCascadeのFKを持つ(アカウントPurgeで削除される)", /model AuthEmailToken \{[\s\S]*?user\s+User\s+@relation\(fields: \[userId\], references: \[id\], onDelete: Cascade\)/.test(schema));
  ok("AuthEmailTokenはtoken平文の列を持たない", !/model AuthEmailToken \{[^}]*\btoken\s+String/.test(schema));
}

console.log(`\n=== 結果: ${passed} passed / ${failed} failed ===`);
if (failed > 0) {
  console.log("失敗一覧:");
  for (const f of failures) console.log(`  - ${f}`);
  process.exit(1);
}
