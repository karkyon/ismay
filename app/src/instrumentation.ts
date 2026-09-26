/**
 * Next.js instrumentation.ts (公式フック)。
 * register()はサーバープロセス起動時に一度だけ呼ばれる。
 * https://nextjs.org/docs/app/building-your-application/optimizing/instrumentation
 *
 * NEXT_RUNTIME==="nodejs"時のみAI Workerを起動する(edge runtime向けにも
 * このファイルは評価されるため、Node.js専用処理を分離する)。
 */
export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    // [SECURITY-RATE-02B・2026-09-26] rate limit backend・client IP解決の構成を起動時に表示する
    const { logSecurityRateStartupSummary } = await import("@/lib/security/startupCheck");
    logSecurityRateStartupSummary();
    const { startBackgroundWorker } = await import("@/lib/worker");
    startBackgroundWorker();
  }
}
