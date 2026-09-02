import { debugServer } from "@/lib/debugServer";
import { closeTimedOutSessions } from "@/lib/pem/sessionPersistence";

/**
 * [PEM-SESSION-TIMEOUT新設・2026-09-02] Execution Session timeout Worker組み込み。
 * 出典: ISMAY_PEMサブシステム_統合正本仕様書_v4.0 7.1節「timeoutは
 * `CLOSED_UNCONFIRMED`としてSessionだけを閉じ、責任状態を変えない」。
 * ISMAY全機能仕様一覧のPEM-SESSION行「Activity Evidence、timeout、Correction、
 * Conflict Queue、checkpoint/rebuildは未完成」のうち、timeoutを閉じる。
 *
 * notificationScanJob.ts/cycleRotationJob.ts/pemObserverJob.tsと同じ
 * 自己スロットリング方式(5秒tickの中で間引く)。
 *
 * [未確定事項の扱い] タイムアウト閾値の具体的数値はv4.0原本に明記が無い
 * (sessionPersistence.ts closeTimedOutSessions()コメント参照)。想像で断定の
 * 数値を選ばず、環境変数PEM_SESSION_TIMEOUT_HOURS(既定8時間=一般的な1営業日の
 * 実働時間相当、運用調整可能)として実装する。
 *
 * このJobの実行間隔自体は、タイムアウト判定の粒度としてこれで十分
 * (閾値が時間単位である以上、分単位の精度は不要)であるため1時間毎とする。
 */
const CHECK_INTERVAL_MS = 60 * 60 * 1000;
let lastCheckAt = 0;

function resolveTimeoutMs(): number {
  const raw = process.env.PEM_SESSION_TIMEOUT_HOURS;
  const hours = raw ? Number(raw) : 8;
  const safeHours = Number.isFinite(hours) && hours > 0 ? hours : 8;
  return safeHours * 60 * 60 * 1000;
}

export async function processSessionTimeouts(): Promise<{ processed: number }> {
  const now = Date.now();
  if (now - lastCheckAt < CHECK_INTERVAL_MS) {
    return { processed: 0 };
  }
  lastCheckAt = now;

  try {
    const result = await closeTimedOutSessions(resolveTimeoutMs());
    if (result.closedCount > 0) {
      debugServer.event("Worker/sessionTimeout", "タイムアウトSession検出・クローズ完了", result);
    }
    return { processed: result.closedCount };
  } catch (err) {
    debugServer.error("Worker/sessionTimeout", "タイムアウト処理失敗", err);
    return { processed: 0 };
  }
}
