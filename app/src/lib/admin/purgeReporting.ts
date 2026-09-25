/**
 * 30日Purge運用の結果集計・監査文言・exit code(DB非依存の純粋関数)。
 *
 * [PURGE-AUDIT-02D・2026-09-25新設] 旧CLI(scripts/run_account_purge.ts)は
 * 物理削除成功後のAuditLog書込みを同じtry内で行っていたため、AuditLog書込みが
 * 失敗すると「完了済みの物理削除」を失敗として数え(failed++)、さらにcatch内の
 * FAILURE AuditLog書込みも失敗し得た(削除結果が監査結果で上書きされる誤報)。
 * 以後、削除結果(purgeSucceeded)と監査記録結果(auditRecorded)を別状態として
 * 扱い、exit codeもbitで分離する。
 *
 * `import type`のみでpurgeJob.tsを参照する(実行時にdbをimportしないため、
 * DATABASE_URL無しの単体テストから検証できる)。
 */
import type { PurgeRefusalStatus } from "./purgeJob";

/**
 * exit code(bitmask)。
 *   0: 全対象の削除と監査記録が成功
 *   1: 致命的エラー(引数不正・DB接続不可等、個別処理に入る前の失敗)
 *   2: 1件以上が削除されなかった(再検証による拒否・lock競合・エラー)
 *   4: 1件以上で監査記録(AuditLog)の書込みに失敗した(削除自体の成否とは独立)
 *   6: 2と4の両方
 */
export const PURGE_EXIT = { OK: 0, FATAL: 1, NOT_PURGED: 2, AUDIT_FAILED: 4 } as const;

export type PurgeItemStatus = "PURGED" | PurgeRefusalStatus | "ERROR";

export interface PurgeRunContext {
  runId: string;
  osUser: string;
  hostname: string;
  pid: number;
  /** --operatorで自己申告された名前(真正性は保証されない補足情報)。 */
  operatorDeclared: string | null;
  startedAt: string;
}

export interface PurgeItemOutcome {
  userId: string;
  purgeStatus: PurgeItemStatus;
  purgeSucceeded: boolean;
  totals: { rowsDeleted: number; rowsUpdated: number } | null;
  workspaceRowsDeleted: number | null;
  userRowsDeleted: number | null;
  anonymizedRows: number | null;
  digest: string | null;
  expectedDigest: string | null;
  driftCount: number | null;
  /** 拒否理由またはエラー概要(emailを含めない)。 */
  detail: string | null;
  auditRecorded: boolean;
  auditError: string | null;
}

export interface PurgeRunSummary {
  total: number;
  purged: number;
  notPurged: number;
  errors: number;
  auditFailed: number;
  notPurgedByStatus: Record<string, number>;
  exitCode: number;
}

/** 表示・ログ用のemail最小化(先頭1文字+***@ドメイン)。 */
export function maskEmail(email: string): string {
  const at = email.lastIndexOf("@");
  if (at <= 0) return "***";
  const local = email.slice(0, at);
  const domain = email.slice(at + 1);
  return `${local[0]}***@${domain || "***"}`;
}

/** 自己申告operator名の正規化(制御文字除去・長さ上限)。空ならnull。 */
export function sanitizeOperatorName(raw: string | null | undefined): string | null {
  if (raw == null) return null;
  const cleaned = Array.from(raw)
    .filter((ch) => {
      const code = ch.codePointAt(0) ?? 0;
      return code >= 0x20 && code !== 0x7f;
    })
    .join("")
    .trim()
    .slice(0, 100);
  return cleaned.length > 0 ? cleaned : null;
}

/** AuditLog.reasonへ書く文言(email・本文を含めない)。 */
export function buildPurgeAuditReason(ctx: PurgeRunContext, outcome: PurgeItemOutcome): string {
  const parts = [
    "CLI",
    `run=${ctx.runId}`,
    `osUser=${ctx.osUser}`,
    `host=${ctx.hostname}`,
    `pid=${ctx.pid}`,
    `operator(self-declared)=${ctx.operatorDeclared ?? "-"}`,
    `status=${outcome.purgeStatus}`,
  ];
  if (outcome.totals) {
    parts.push(`rowsDeleted=${outcome.totals.rowsDeleted}`, `rowsUpdated=${outcome.totals.rowsUpdated}`);
    parts.push(`workspaceRows=${outcome.workspaceRowsDeleted ?? 0}`, `userRows=${outcome.userRowsDeleted ?? 0}`, `anonymizedRows=${outcome.anonymizedRows ?? 0}`);
  }
  if (outcome.digest) parts.push(`digest=${outcome.digest}`);
  if (outcome.expectedDigest) parts.push(`dryRunDigest=${outcome.expectedDigest}`);
  if (outcome.driftCount !== null) parts.push(`drift=${outcome.driftCount}`);
  if (outcome.detail) parts.push(`detail=${outcome.detail.slice(0, 400)}`);
  return parts.join(" ");
}

export function summarizePurgeOutcomes(outcomes: PurgeItemOutcome[]): PurgeRunSummary {
  const notPurgedByStatus: Record<string, number> = {};
  let purged = 0;
  let errors = 0;
  let auditFailed = 0;
  for (const o of outcomes) {
    if (o.purgeSucceeded) purged++;
    else notPurgedByStatus[o.purgeStatus] = (notPurgedByStatus[o.purgeStatus] ?? 0) + 1;
    if (o.purgeStatus === "ERROR") errors++;
    if (!o.auditRecorded) auditFailed++;
  }
  const notPurged = outcomes.length - purged;
  let exitCode: number = PURGE_EXIT.OK;
  if (notPurged > 0) exitCode |= PURGE_EXIT.NOT_PURGED;
  if (auditFailed > 0) exitCode |= PURGE_EXIT.AUDIT_FAILED;
  return { total: outcomes.length, purged, notPurged, errors, auditFailed, notPurgedByStatus, exitCode };
}
