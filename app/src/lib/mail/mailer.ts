import { createTransport } from "nodemailer";
import { resolveMailConfig, type MailConfig } from "@/lib/mail/mailConfig";

/**
 * [AUTH-EMAIL-01新設・2026-09-26] メール送信の差し替え可能な窓口。
 * 実装は MAIL_TRANSPORT で選ぶ(smtp=nodemailer / log=標準出力)。
 * 受入試験は setMailTransportForTesting() でメモリ上のtransportへ差し替える。
 */

export interface OutgoingMail {
  to: string;
  subject: string;
  text: string;
}

export interface MailTransport {
  readonly kind: "smtp" | "log" | "memory";
  send(mail: OutgoingMail & { from: string }): Promise<void>;
}

export type MailerResolution =
  | { ok: true; transport: MailTransport; config: MailConfig }
  | { ok: false; error: string };

function createSmtpTransport(config: Extract<MailConfig, { transport: "smtp" }>): MailTransport {
  const transporter = createTransport({
    host: config.smtp.host,
    port: config.smtp.port,
    secure: config.smtp.secure,
    auth: config.smtp.auth ?? undefined,
    connectionTimeout: 10_000,
    greetingTimeout: 10_000,
    socketTimeout: 20_000,
  });
  return {
    kind: "smtp",
    async send(mail) {
      await transporter.sendMail({ from: mail.from, to: mail.to, subject: mail.subject, text: mail.text });
    },
  };
}

function createLogTransport(): MailTransport {
  return {
    kind: "log",
    async send(mail) {
      // debugServerは本番(NODE_ENV=production)で無効のため、console.logで常に出す。
      console.log(
        [
          "===== [ISMAY MAIL:log] 送信されていません(MAIL_TRANSPORT=log) =====",
          `From: ${mail.from}`,
          `To: ${mail.to}`,
          `Subject: ${mail.subject}`,
          "",
          mail.text,
          "===== [ISMAY MAIL:log] end =====",
        ].join("\n"),
      );
    },
  };
}

/** 受入試験・単体試験用。送信内容を配列に保持する。 */
export function createMemoryMailTransport(): MailTransport & { sent: (OutgoingMail & { from: string })[]; failNext: number } {
  const state = {
    kind: "memory" as const,
    sent: [] as (OutgoingMail & { from: string })[],
    failNext: 0,
    async send(mail: OutgoingMail & { from: string }) {
      if (state.failNext > 0) {
        state.failNext -= 1;
        throw new Error("memory transport: 注入された送信失敗");
      }
      state.sent.push({ ...mail });
    },
  };
  return state;
}

let testOverride: { transport: MailTransport; config: MailConfig } | null = null;
let cached: { key: string; resolution: MailerResolution; warned: boolean } | null = null;

export function setMailTransportForTesting(transport: MailTransport | null, baseUrl = "http://localhost:13000"): void {
  testOverride = transport ? { transport, config: { transport: "log", baseUrl, from: "ISMAY <test@localhost>" } } : null;
}

const MAIL_ENV_KEYS = [
  "MAIL_TRANSPORT",
  "APP_BASE_URL",
  "MAIL_FROM",
  "SMTP_HOST",
  "SMTP_PORT",
  "SMTP_SECURE",
  "SMTP_USER",
  "SMTP_PASS",
] as const;

export function getMailer(): MailerResolution {
  if (testOverride) return { ok: true, transport: testOverride.transport, config: testOverride.config };
  const key = MAIL_ENV_KEYS.map((k) => `${k}=${process.env[k] ?? ""}`).join("\u0000");
  if (!cached || cached.key !== key) {
    const result = resolveMailConfig(process.env);
    let resolution: MailerResolution;
    if (!result.ok) {
      resolution = { ok: false, error: result.error };
    } else {
      const transport = result.config.transport === "smtp" ? createSmtpTransport(result.config) : createLogTransport();
      resolution = { ok: true, transport, config: result.config };
    }
    cached = { key, resolution, warned: false };
    if (result.ok && result.warnings.length > 0 && !cached.warned) {
      cached.warned = true;
      for (const w of result.warnings) console.warn(`[ISMAY MAIL] ${w}`);
    }
    if (!result.ok) console.error(`[ISMAY MAIL] 設定エラー: ${result.error}`);
  }
  return cached.resolution;
}
