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
    const { startBackgroundWorker } = await import("@/lib/worker");
    startBackgroundWorker();
  }
}
