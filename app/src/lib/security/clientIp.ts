import { timingSafeEqual } from "node:crypto";
import {
  isTrustedAddress,
  parseForwardedForEntry,
  parseIp,
  parseTrustedProxyCidrs,
  type Cidr,
  type ParsedIp,
} from "@/lib/security/ipAddress";

/**
 * [SECURITY-RATE-02B新設・2026-09-26] client IPの解決(全routeの唯一の入口)。
 * 契約: docs/decisions/DEC-SECURITY-RATE-02.md §3。
 *
 * 旧実装(lib/auth/guard.ts clientIp)は`X-Forwarded-For`の先頭要素(攻撃者が自由に書ける値)を
 * そのままclient IPにしていた。Next.jsのサーバーは`X-Forwarded-For`が無い場合にだけ接続元を
 * 補うため(`??=`、node_modules/next/dist/server/base-server.js)、route handlerからは
 * 「接続元」と「攻撃者が送ったheader」を区別できない。
 *
 * 規則:
 *   1. 直近の接続元(peer)は、custom server(app/server.mjs)が接続socketのremoteAddressを
 *      process内nonce付きで`x-ismay-peer-address`へ書いた値だけを使う。nonceは同じprocessの
 *      globalThisにだけ置かれ、clientは知り得ないため、clientが同名headerを送っても採用されない。
 *      `next start`等でcustom serverを経由しない場合、peerは不明(=client IPも不明)。
 *   2. TRUSTED_PROXY_CIDRS未設定: forwarded系header(X-Forwarded-For・Forwarded・X-Real-IP)を
 *      一切使わず、client IP=peer。
 *   3. TRUSTED_PROXY_CIDRS設定時: peerが信頼proxyの場合だけX-Forwarded-Forを右から走査し、
 *      最初の信頼proxyでないaddressをclient IPとする。不正な要素に当たったら不明とする。
 *   4. NODE_ENVでproxy信頼を暗黙に有効化しない。設定が不正なら不明とする(起動時にerror log)。
 */

export const PEER_ADDRESS_HEADER = "x-ismay-peer-address";
const PEER_STAMP_SYMBOL = Symbol.for("ismay.peerAddressStamp.v1");

/** X-Forwarded-Forとして解析する最大文字数。超える場合は右側(proxyが追記する側)だけを使う。 */
export const MAX_FORWARDED_FOR_LENGTH = 8192;
/** 右から走査する最大hop数。これを超えて信頼proxyが続く場合は不明とする。 */
export const MAX_FORWARDED_HOPS = 16;

export type ClientIpSource = "PEER" | "FORWARDED" | "UNKNOWN";
export type ClientIpUnknownReason =
  | "PEER_UNAVAILABLE"
  | "TRUSTED_PROXY_CONFIG_INVALID"
  | "MALFORMED_FORWARDED"
  | "TOO_MANY_HOPS";

export type ClientIpResolution =
  | { ip: ParsedIp; source: "PEER" | "FORWARDED" }
  | { ip: null; source: "UNKNOWN"; reason: ClientIpUnknownReason };

/** pure: peerとX-Forwarded-Forと信頼proxy一覧からclient IPを決める。 */
export function resolveClientIp(input: {
  peer: ParsedIp | null;
  forwardedFor: string | null;
  trustedProxies: readonly Cidr[];
}): ClientIpResolution {
  const { peer, trustedProxies } = input;
  if (!peer) return { ip: null, source: "UNKNOWN", reason: "PEER_UNAVAILABLE" };
  if (trustedProxies.length === 0 || !isTrustedAddress(trustedProxies, peer)) return { ip: peer, source: "PEER" };

  let header = input.forwardedFor ?? "";
  if (header.trim() === "") return { ip: peer, source: "PEER" };
  let truncated = false;
  if (header.length > MAX_FORWARDED_FOR_LENGTH) {
    header = header.slice(header.length - MAX_FORWARDED_FOR_LENGTH);
    truncated = true;
  }
  const entries = header.split(",");
  // 切り詰めた場合、先頭の要素は途中から始まっている可能性があるため使わない
  if (truncated) entries.shift();

  let hops = 0;
  let leftmostTrusted: ParsedIp | null = null;
  for (let i = entries.length - 1; i >= 0; i--) {
    hops++;
    if (hops > MAX_FORWARDED_HOPS) return { ip: null, source: "UNKNOWN", reason: "TOO_MANY_HOPS" };
    const entry = parseForwardedForEntry(entries[i]!);
    if (!entry) return { ip: null, source: "UNKNOWN", reason: "MALFORMED_FORWARDED" };
    if (!isTrustedAddress(trustedProxies, entry)) return { ip: entry, source: "FORWARDED" };
    leftmostTrusted = entry;
  }
  // 全hopが信頼proxy(proxy自身が発したrequest)。最も左の値を接続元とみなす。
  if (leftmostTrusted) return { ip: leftmostTrusted, source: "FORWARDED" };
  return { ip: peer, source: "PEER" };
}

// ---------------------------------------------------------------------------
// peer(custom serverが書いた接続元)
// ---------------------------------------------------------------------------

interface PeerStamp {
  header: string;
  nonce: string;
}

function readPeerStamp(): PeerStamp | null {
  const value = (globalThis as unknown as Record<symbol, unknown>)[PEER_STAMP_SYMBOL];
  if (!value || typeof value !== "object") return null;
  const stamp = value as Partial<PeerStamp>;
  if (stamp.header !== PEER_ADDRESS_HEADER || typeof stamp.nonce !== "string" || stamp.nonce.length < 32) return null;
  return { header: stamp.header, nonce: stamp.nonce };
}

/** custom server経由で起動しているか(起動時の構成表示・受入試験用)。 */
export function isPeerAddressStampingActive(): boolean {
  return readPeerStamp() !== null;
}

/** pure寄り: stamp値(`<nonce> <remoteAddress>`)を検証してpeerを取り出す。 */
export function parsePeerStampValue(value: string | null, expectedNonce: string): ParsedIp | null {
  if (!value) return null;
  const space = value.indexOf(" ");
  if (space <= 0) return null;
  const nonce = value.slice(0, space);
  const addr = value.slice(space + 1);
  const a = Buffer.from(nonce, "utf8");
  const b = Buffer.from(expectedNonce, "utf8");
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  return parseIp(addr);
}

function readPeer(headers: Headers): ParsedIp | null {
  const stamp = readPeerStamp();
  if (!stamp) return null;
  return parsePeerStampValue(headers.get(stamp.header), stamp.nonce);
}

// ---------------------------------------------------------------------------
// 設定(TRUSTED_PROXY_CIDRS)
// ---------------------------------------------------------------------------

type TrustedProxyConfig = { ok: true; cidrs: Cidr[] } | { ok: false; error: string };
let cachedConfig: { raw: string | undefined; config: TrustedProxyConfig } | null = null;
let reportedInvalidConfig = false;

export function getTrustedProxyConfig(): TrustedProxyConfig {
  const raw = process.env.TRUSTED_PROXY_CIDRS;
  if (!cachedConfig || cachedConfig.raw !== raw) {
    cachedConfig = { raw, config: parseTrustedProxyCidrs(raw) };
    reportedInvalidConfig = false;
  }
  return cachedConfig.config;
}

/** requestからclient IPを解決する。 */
export function resolveRequestClientIp(req: { headers: Headers }): ClientIpResolution {
  const config = getTrustedProxyConfig();
  if (!config.ok) {
    if (!reportedInvalidConfig) {
      reportedInvalidConfig = true;
      console.error(`[SECURITY-RATE] ${config.error}。client IPを不明として扱います`);
    }
    return { ip: null, source: "UNKNOWN", reason: "TRUSTED_PROXY_CONFIG_INVALID" };
  }
  return resolveClientIp({
    peer: readPeer(req.headers),
    forwardedFor: req.headers.get("x-forwarded-for"),
    trustedProxies: config.cidrs,
  });
}

/** 正規化したclient IP文字列。不明ならnull(攻撃者指定のheaderでは埋めない)。 */
export function resolveRequestClientIpText(req: { headers: Headers }): string | null {
  return resolveRequestClientIp(req).ip?.text ?? null;
}
