/**
 * [SECURITY-RATE-02B新設・2026-09-26] IPアドレス・CIDRの厳格parser(pure)。
 * 契約: docs/decisions/DEC-SECURITY-RATE-02.md §3。
 *
 * - IPv4は10進4組のみ(先頭0・8進/16進表記・省略形は拒否)。
 * - IPv6はRFC 4291の表記(`::`省略・末尾IPv4埋込み)を受け付け、zone ID(`%eth0`)は拒否する。
 * - IPv4-mapped IPv6(`::ffff:a.b.c.d`)はIPv4へ正規化する(同じ端末が2つの表記で別keyにならないように)。
 * - 正規化した文字列表現(`text`)はIPv4が10進4組、IPv6がRFC 5952(小文字・最長の0連続を`::`)。
 */

export interface ParsedIp {
  family: 4 | 6;
  /** IPv4は4byte、IPv6は16byte。 */
  bytes: number[];
  text: string;
}

export interface Cidr {
  family: 4 | 6;
  bytes: number[];
  prefix: number;
  text: string;
}

/** IPアドレス1個として受け付ける最大文字数(IPv6埋込みIPv4の最長45文字に余裕を持たせる)。 */
export const MAX_IP_TEXT_LENGTH = 64;
/** TRUSTED_PROXY_CIDRSに列挙できる最大件数。 */
export const MAX_TRUSTED_PROXY_CIDRS = 32;

function parseIpv4Bytes(raw: string): number[] | null {
  const parts = raw.split(".");
  if (parts.length !== 4) return null;
  const bytes: number[] = [];
  for (const part of parts) {
    if (!/^(0|[1-9][0-9]{0,2})$/.test(part)) return null;
    const n = Number(part);
    if (n > 255) return null;
    bytes.push(n);
  }
  return bytes;
}

function parseIpv6Bytes(raw: string): number[] | null {
  if (raw.includes("%")) return null;
  if (!/^[0-9A-Fa-f:.]+$/.test(raw)) return null;
  const doubleColon = raw.indexOf("::");
  if (doubleColon !== -1 && raw.indexOf("::", doubleColon + 1) !== -1) return null;

  const parseGroups = (segment: string): number[] | null => {
    if (segment === "") return [];
    const groups = segment.split(":");
    const out: number[] = [];
    for (let i = 0; i < groups.length; i++) {
      const g = groups[i]!;
      if (i === groups.length - 1 && g.includes(".")) {
        const v4 = parseIpv4Bytes(g);
        if (!v4) return null;
        out.push((v4[0]! << 8) | v4[1]!, (v4[2]! << 8) | v4[3]!);
        continue;
      }
      if (!/^[0-9A-Fa-f]{1,4}$/.test(g)) return null;
      out.push(parseInt(g, 16));
    }
    return out;
  };

  let groups: number[];
  if (doubleColon === -1) {
    const all = parseGroups(raw);
    if (!all || all.length !== 8) return null;
    groups = all;
  } else {
    const headText = raw.slice(0, doubleColon);
    const tailText = raw.slice(doubleColon + 2);
    // 埋込みIPv4は末尾にのみ置ける
    if (headText.includes(".")) return null;
    const head = parseGroups(headText);
    const tail = parseGroups(tailText);
    if (!head || !tail) return null;
    const missing = 8 - head.length - tail.length;
    if (missing < 1) return null;
    groups = [...head, ...new Array<number>(missing).fill(0), ...tail];
  }
  const bytes: number[] = [];
  for (const g of groups) bytes.push((g >> 8) & 0xff, g & 0xff);
  return bytes;
}

function ipv4Text(bytes: number[]): string {
  return bytes.join(".");
}

function ipv6Text(bytes: number[]): string {
  const groups: number[] = [];
  for (let i = 0; i < 16; i += 2) groups.push((bytes[i]! << 8) | bytes[i + 1]!);
  // RFC 5952: 2個以上連続する最長の0を`::`へ(同長なら最初)
  let bestStart = -1;
  let bestLen = 0;
  for (let i = 0; i < 8; ) {
    if (groups[i] !== 0) {
      i++;
      continue;
    }
    let j = i;
    while (j < 8 && groups[j] === 0) j++;
    if (j - i > bestLen) {
      bestStart = i;
      bestLen = j - i;
    }
    i = j;
  }
  const hex = groups.map((g) => g.toString(16));
  if (bestLen < 2) return hex.join(":");
  const head = hex.slice(0, bestStart).join(":");
  const tail = hex.slice(bestStart + bestLen).join(":");
  return `${head}::${tail}`;
}

function isIpv4Mapped(bytes: number[]): boolean {
  for (let i = 0; i < 10; i++) if (bytes[i] !== 0) return false;
  return bytes[10] === 0xff && bytes[11] === 0xff;
}

/** IPアドレス1個を厳格に解釈する。不正・空・長すぎる値はnull。 */
export function parseIp(raw: string): ParsedIp | null {
  if (typeof raw !== "string") return null;
  if (raw.length === 0 || raw.length > MAX_IP_TEXT_LENGTH) return null;
  if (raw.includes(":")) {
    const bytes = parseIpv6Bytes(raw);
    if (!bytes) return null;
    if (isIpv4Mapped(bytes)) {
      const v4 = bytes.slice(12);
      return { family: 4, bytes: v4, text: ipv4Text(v4) };
    }
    return { family: 6, bytes, text: ipv6Text(bytes) };
  }
  const bytes = parseIpv4Bytes(raw);
  if (!bytes) return null;
  return { family: 4, bytes, text: ipv4Text(bytes) };
}

/**
 * X-Forwarded-Forの1要素を解釈する。前後の空白を除き、`[v6]`・`[v6]:port`・`v4:port`の
 * port部分だけを取り除く(proxyによってはportを付けるため)。それ以外はparseIpと同じ。
 */
export function parseForwardedForEntry(entry: string): ParsedIp | null {
  const trimmed = entry.trim();
  if (trimmed.length === 0 || trimmed.length > MAX_IP_TEXT_LENGTH + 8) return null;
  const bracketed = /^\[([^\]]+)\](?::([0-9]{1,5}))?$/.exec(trimmed);
  if (bracketed) {
    if (bracketed[2] !== undefined && Number(bracketed[2]) > 65535) return null;
    const ip = parseIp(bracketed[1]!);
    return ip && bracketed[1]!.includes(":") ? ip : null;
  }
  const v4WithPort = /^([0-9.]+):([0-9]{1,5})$/.exec(trimmed);
  if (v4WithPort) {
    if (Number(v4WithPort[2]) > 65535) return null;
    const ip = parseIp(v4WithPort[1]!);
    return ip && ip.family === 4 ? ip : null;
  }
  return parseIp(trimmed);
}

export type ParseCidrResult = { ok: true; cidr: Cidr } | { ok: false; error: string };

/**
 * CIDR 1個を厳格に解釈する。`addr/prefix`または`addr`(単一host)。
 * host部が0でない値(例: 10.0.0.1/8)、prefix 0(全アドレスを信頼することになる)、
 * IPv4-mapped IPv6表記は設定誤りとして拒否する。
 */
export function parseCidr(raw: string): ParseCidrResult {
  const text = raw.trim();
  if (text.length === 0) return { ok: false, error: "空の要素があります" };
  const slash = text.indexOf("/");
  const addrText = slash === -1 ? text : text.slice(0, slash);
  const prefixText = slash === -1 ? null : text.slice(slash + 1);
  const ip = parseIp(addrText);
  if (!ip) return { ok: false, error: `IPアドレスとして解釈できません: ${text}` };
  if (addrText.includes(":") && ip.family === 4) {
    return { ok: false, error: `IPv4-mapped IPv6表記は使えません。IPv4で記述してください: ${text}` };
  }
  const maxPrefix = ip.family === 4 ? 32 : 128;
  let prefix = maxPrefix;
  if (prefixText !== null) {
    if (!/^(0|[1-9][0-9]{0,2})$/.test(prefixText)) return { ok: false, error: `prefix長が不正です: ${text}` };
    prefix = Number(prefixText);
    if (prefix > maxPrefix) return { ok: false, error: `prefix長が範囲外です: ${text}` };
  }
  if (prefix === 0) return { ok: false, error: `prefix長0(全アドレス)は信頼proxyに指定できません: ${text}` };
  for (let bit = prefix; bit < maxPrefix; bit++) {
    if ((ip.bytes[bit >> 3]! >> (7 - (bit & 7))) & 1) {
      return { ok: false, error: `host部が0ではありません(network addressで記述してください): ${text}` };
    }
  }
  return { ok: true, cidr: { family: ip.family, bytes: ip.bytes, prefix, text: `${ip.text}/${prefix}` } };
}

export type ParseTrustedProxyCidrsResult = { ok: true; cidrs: Cidr[] } | { ok: false; error: string };

/**
 * 環境変数TRUSTED_PROXY_CIDRS(カンマ区切り)を解釈する。未設定・空白のみは「信頼するproxyなし」。
 * 1要素でも不正なら全体を不正とする(部分的に信頼範囲が縮む・広がる設定を黙って受け付けない)。
 */
export function parseTrustedProxyCidrs(value: string | undefined | null): ParseTrustedProxyCidrsResult {
  if (value === undefined || value === null || value.trim() === "") return { ok: true, cidrs: [] };
  const items = value.split(",");
  if (items.length > MAX_TRUSTED_PROXY_CIDRS) {
    return { ok: false, error: `TRUSTED_PROXY_CIDRSは${MAX_TRUSTED_PROXY_CIDRS}件までです` };
  }
  const cidrs: Cidr[] = [];
  for (const item of items) {
    const parsed = parseCidr(item);
    if (!parsed.ok) return { ok: false, error: `TRUSTED_PROXY_CIDRS: ${parsed.error}` };
    cidrs.push(parsed.cidr);
  }
  return { ok: true, cidrs };
}

export function cidrContains(cidr: Cidr, ip: ParsedIp): boolean {
  if (cidr.family !== ip.family) return false;
  const fullBytes = cidr.prefix >> 3;
  for (let i = 0; i < fullBytes; i++) if (cidr.bytes[i] !== ip.bytes[i]) return false;
  const remBits = cidr.prefix & 7;
  if (remBits === 0) return true;
  const mask = (0xff << (8 - remBits)) & 0xff;
  return (cidr.bytes[fullBytes]! & mask) === (ip.bytes[fullBytes]! & mask);
}

export function isTrustedAddress(cidrs: readonly Cidr[], ip: ParsedIp): boolean {
  return cidrs.some((c) => cidrContains(c, ip));
}
