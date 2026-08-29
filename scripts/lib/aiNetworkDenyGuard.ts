/**
 * scripts/lib/aiNetworkDenyGuard.ts
 *
 * [B3.2新設・監査「Gate M1-B3.2 非課金証跡保証・残存競合是正」B32-01]
 *
 * 受入スクリプトの冒頭で`installAiNetworkDenyGuard()`を呼ぶと、そのプロセス内の
 * `globalThis.fetch`が外部AI provider host(既定でapi.openai.com/api.anthropic.com)
 * 宛のrequestを検知した時点で、実際にネットワークへ送信する前に例外をthrowする。
 *
 * これはdependency injection(materializeFormationSessionの`deps`引数でstub
 * embedを注入する等)の「二重防御」の片方(監査B32-01「依存注入+通信guardの
 * 二重防御」)。DI経路の実装漏れや、将来Registryへ追加される別providerが
 * あっても、この guard が最後の砦としてAPIキーが有効でも通信を機械的に0件へ
 * 保証する。
 *
 * DB接続(Postgres)やlocalhostへの通信は対象外。deny対象はAI provider hostのみ。
 */

export interface AiNetworkDenyGuardHandle {
  /** guard稼働中に検知した(=deny/throwした)呼び出し先URLの一覧。 */
  readonly deniedCallAttempts: string[];
  /** globalThis.fetchを元に戻す。 */
  restore(): void;
}

const DEFAULT_DENIED_HOSTS = [
  "api.openai.com",
  "api.anthropic.com",
  // 将来Registry(app/src/lib/ai/registry.ts)へ新しいAI provider hostが
  // 追加された場合は、ここにも追記する(監査B32-01 4番目の箇条書き)。
];

function hostOf(input: unknown): string | null {
  try {
    if (typeof input === "string") return new URL(input).hostname;
    if (input instanceof URL) return input.hostname;
    if (typeof Request !== "undefined" && input instanceof Request) return new URL(input.url).hostname;
    if (input && typeof (input as { url?: unknown }).url === "string") {
      return new URL((input as { url: string }).url).hostname;
    }
  } catch {
    return null;
  }
  return null;
}

/**
 * globalThis.fetchへdeny guardを設置する。denyHostsは既定でOpenAI/Anthropicの
 * 本番AI endpointを含む。denyHostsに一致するhostへの呼び出しは、実際の
 * ネットワークI/Oを一切行わずに即throwする(dummy requestすら送らない)。
 */
export function installAiNetworkDenyGuard(
  denyHosts: string[] = DEFAULT_DENIED_HOSTS,
): AiNetworkDenyGuardHandle {
  const originalFetch = globalThis.fetch;
  const deniedCallAttempts: string[] = [];

  const guardedFetch: typeof fetch = (input: any, init?: any) => {
    const host = hostOf(input);
    if (host && denyHosts.some((h) => host === h || host.endsWith(`.${h}`))) {
      const url = typeof input === "string" ? input : host;
      deniedCallAttempts.push(url);
      throw new Error(
        `[aiNetworkDenyGuard] 外部AI provider host(${host})への通信は受入スクリプト実行中は禁止されています: ${url}`,
      );
    }
    return originalFetch(input, init);
  };

  (globalThis as { fetch: typeof fetch }).fetch = guardedFetch;

  return {
    deniedCallAttempts,
    restore() {
      (globalThis as { fetch: typeof fetch }).fetch = originalFetch;
    },
  };
}

/**
 * guard自体が正しく機能していることのpure self-test。実際のdummy requestは
 * 送信せず(=guard内でthrowするため到達しない)、guardがthrowすることだけを
 * 確認する(監査B32-01「global fetch deny guardがAI hostへの意図的dummy call
 * を確実にFAILさせるpure self-testを最初に行う。実際のdummy requestは送信せず、
 * guard内でthrowさせる」)。
 */
export async function selfTestAiNetworkDenyGuard(handle: AiNetworkDenyGuardHandle): Promise<boolean> {
  const before = handle.deniedCallAttempts.length;
  let threw = false;
  try {
    // fetchは同期的にguard内でthrowする実装のため、await不要だが将来の実装
    // 変化に備えてPromise.resolve().then経由でも捕捉できるようにしておく。
    await Promise.resolve().then(() => fetch("https://api.openai.com/v1/embeddings"));
  } catch {
    threw = true;
  }
  const after = handle.deniedCallAttempts.length;
  return threw && after === before + 1;
}
