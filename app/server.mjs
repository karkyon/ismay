/**
 * [SECURITY-RATE-02B新設・2026-09-26] 本番起動用のNext.js custom server(`npm run start`)。
 * 契約: docs/decisions/DEC-SECURITY-RATE-02.md §3.1、運用: docs/runbooks/SECURITY_RATE_RUNBOOK.md。
 *
 * 目的は1つだけ: route handlerへ「直近の接続元(socketのremoteAddress)」を渡すこと。
 * Next.js 16のroute handlerには接続元を取得するAPIが無く(NextRequest.ipはv15で廃止)、
 * `next start`は`X-Forwarded-For`が無い場合にだけ接続元を補う(`??=`)ため、攻撃者が送った
 * `X-Forwarded-For`と区別できない。
 *
 * - 受信した`x-ismay-peer-address`は常に削除し、`<process内nonce> <remoteAddress>`で上書きする。
 * - nonceは起動ごとの乱数で、同じprocessのglobalThisにだけ置く(lib/security/clientIp.tsが照合する)。
 *   clientは値を知り得ないため、同名headerを送っても接続元として採用されない。
 * - それ以外のrequest処理はNext.jsの標準handlerへそのまま渡す(`next start`と同じ)。
 *
 * 環境変数: PORT(既定13000)、ISMAY_LISTEN_HOST(未設定時は全interfaceでlisten、`next start -p 13000`と同じ)。
 * (一般的なHOSTNAME変数はcontainer等で自動設定され意図せずbind先が変わるため使わない)
 * rollback: `npm run start:next`(`next start -p 13000`)。その場合client IPは「不明」として扱われる。
 */
import { createServer } from "node:http";
import { randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";

if (!process.env.NODE_ENV) process.env.NODE_ENV = "production";

const PEER_ADDRESS_HEADER = "x-ismay-peer-address";
const PEER_STAMP_SYMBOL = Symbol.for("ismay.peerAddressStamp.v1");
const nonce = randomBytes(32).toString("base64url");
Object.defineProperty(globalThis, PEER_STAMP_SYMBOL, {
  value: Object.freeze({ header: PEER_ADDRESS_HEADER, nonce }),
  writable: false,
  enumerable: false,
  configurable: false,
});

const port = Number.parseInt(process.env.PORT ?? "13000", 10);
if (!Number.isInteger(port) || port <= 0 || port > 65535) {
  console.error(`[server] PORTが不正です: ${process.env.PORT}`);
  process.exit(1);
}
const listenHost = process.env.ISMAY_LISTEN_HOST;
const hostname = listenHost && listenHost.trim() !== "" ? listenHost.trim() : undefined;
const dev = process.env.NODE_ENV !== "production";

const { default: next } = await import("next");
const dir = dirname(fileURLToPath(import.meta.url));
const app = next({ dev, dir, port, hostname: hostname ?? "localhost" });
const handle = app.getRequestHandler();
await app.prepare();

const server = createServer((req, res) => {
  delete req.headers[PEER_ADDRESS_HEADER];
  req.headers[PEER_ADDRESS_HEADER] = `${nonce} ${req.socket.remoteAddress ?? ""}`;
  handle(req, res).catch((err) => {
    console.error("[server] request handling failed", err);
    if (!res.headersSent) {
      res.statusCode = 500;
      res.end("Internal Server Error");
    }
  });
});

const onListening = () => {
  console.log(`> ISMAY server listening on ${hostname ?? "*"}:${port} (${dev ? "development" : "production"}, peer address stamping enabled)`);
};
if (hostname) server.listen(port, hostname, onListening);
else server.listen(port, onListening);

const shutdown = (signal) => {
  console.log(`[server] ${signal} received, closing`);
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 10_000).unref();
};
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
