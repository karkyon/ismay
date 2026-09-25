/**
 * [AUTH-EMAIL-01新設・2026-09-26] メール送信設定の解決(pure)。
 *
 * 利用者決定(2026-09-26): 送信はSMTP+nodemailer。providerを差し替え可能な形とし、
 * 開発環境では実送信せずサーバーログへ出力する。
 *
 * 環境変数(`app/.env`):
 *   MAIL_TRANSPORT  "smtp" | "log"(未設定時は"log"。本文・リンクを標準出力へ出す)
 *   APP_BASE_URL    メール内リンクの基点(例: https://ismay.example.com)。smtp時は必須。
 *                   リンクをリクエストのHostヘッダから組み立てると、Host偽装で他ドメインへの
 *                   再設定リンクを送らせる攻撃(host header poisoning)が成立するため、
 *                   必ず設定値から組み立てる。
 *   MAIL_FROM       差出人(例: "ISMAY <no-reply@example.com>")。smtp時は必須。
 *   SMTP_HOST       smtp時は必須
 *   SMTP_PORT       既定587
 *   SMTP_SECURE     "true" | "false"(未設定時はport 465のときtrue)
 *   SMTP_USER / SMTP_PASS  認証が必要な場合に両方設定する(片方だけは設定エラー)
 */

export const MAIL_TRANSPORT_KINDS = ["smtp", "log"] as const;
export type MailTransportKind = (typeof MAIL_TRANSPORT_KINDS)[number];

export const DEFAULT_LOG_BASE_URL = "http://localhost:13000";
export const DEFAULT_LOG_MAIL_FROM = "ISMAY <no-reply@localhost>";
export const DEFAULT_SMTP_PORT = 587;

export interface SmtpSettings {
  host: string;
  port: number;
  secure: boolean;
  auth: { user: string; pass: string } | null;
}

export type MailConfig =
  | { transport: "log"; baseUrl: string; from: string }
  | { transport: "smtp"; baseUrl: string; from: string; smtp: SmtpSettings };

export type MailConfigResult =
  | { ok: true; config: MailConfig; warnings: string[] }
  | { ok: false; error: string };

type Env = Record<string, string | undefined>;

function nonEmpty(value: string | undefined): string | null {
  if (value === undefined) return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

/** http(s)のoriginとpathだけを許可し、末尾の`/`を除去する。query・hash付きは拒否する。 */
export function normalizeBaseUrl(raw: string): string | null {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return null;
  if (url.search || url.hash || url.username || url.password) return null;
  const path = url.pathname.replace(/\/+$/, "");
  return `${url.protocol}//${url.host}${path}`;
}

export function resolveMailConfig(env: Env): MailConfigResult {
  const warnings: string[] = [];
  const kindRaw = nonEmpty(env.MAIL_TRANSPORT)?.toLowerCase() ?? "log";
  if (!(MAIL_TRANSPORT_KINDS as readonly string[]).includes(kindRaw)) {
    return { ok: false, error: `MAIL_TRANSPORT は smtp または log を指定してください(現在値: ${kindRaw})` };
  }
  const kind = kindRaw as MailTransportKind;

  const baseUrlRaw = nonEmpty(env.APP_BASE_URL);
  let baseUrl: string;
  if (baseUrlRaw) {
    const normalized = normalizeBaseUrl(baseUrlRaw);
    if (!normalized) {
      return { ok: false, error: "APP_BASE_URL はquery・hash・認証情報を含まないhttp(s)のURLにしてください" };
    }
    baseUrl = normalized;
  } else if (kind === "log") {
    baseUrl = DEFAULT_LOG_BASE_URL;
    warnings.push(`APP_BASE_URL未設定のため、メール内リンクは${DEFAULT_LOG_BASE_URL}を基点にします`);
  } else {
    return { ok: false, error: "MAIL_TRANSPORT=smtp の場合は APP_BASE_URL が必須です" };
  }

  const fromRaw = nonEmpty(env.MAIL_FROM);
  if (kind === "log") {
    warnings.push("MAIL_TRANSPORT=log: メールは送信されず、本文(確認リンクを含む)がサーバーログへ出力されます");
    return { ok: true, config: { transport: "log", baseUrl, from: fromRaw ?? DEFAULT_LOG_MAIL_FROM }, warnings };
  }

  if (!fromRaw) return { ok: false, error: "MAIL_TRANSPORT=smtp の場合は MAIL_FROM が必須です" };
  const host = nonEmpty(env.SMTP_HOST);
  if (!host) return { ok: false, error: "MAIL_TRANSPORT=smtp の場合は SMTP_HOST が必須です" };

  const portRaw = nonEmpty(env.SMTP_PORT);
  let port = DEFAULT_SMTP_PORT;
  if (portRaw) {
    if (!/^\d+$/.test(portRaw)) return { ok: false, error: "SMTP_PORT は1〜65535の整数にしてください" };
    port = Number(portRaw);
    if (port < 1 || port > 65535) return { ok: false, error: "SMTP_PORT は1〜65535の整数にしてください" };
  }

  const secureRaw = nonEmpty(env.SMTP_SECURE)?.toLowerCase();
  let secure: boolean;
  if (secureRaw === undefined) secure = port === 465;
  else if (secureRaw === "true") secure = true;
  else if (secureRaw === "false") secure = false;
  else return { ok: false, error: "SMTP_SECURE は true または false を指定してください" };

  const user = nonEmpty(env.SMTP_USER);
  const pass = env.SMTP_PASS !== undefined && env.SMTP_PASS.length > 0 ? env.SMTP_PASS : null;
  if ((user === null) !== (pass === null)) {
    return { ok: false, error: "SMTP_USER と SMTP_PASS は両方設定するか、両方未設定にしてください" };
  }
  if (baseUrl.startsWith("http://")) {
    warnings.push("APP_BASE_URL がhttpです。メール内リンクのtokenが平文の通信路を通ります");
  }

  return {
    ok: true,
    config: {
      transport: "smtp",
      baseUrl,
      from: fromRaw,
      smtp: { host, port, secure, auth: user !== null && pass !== null ? { user, pass } : null },
    },
    warnings,
  };
}
