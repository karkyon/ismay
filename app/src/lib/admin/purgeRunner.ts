/**
 * 30日Purgeの1件実行と監査記録(PURGE-AUDIT-02D・2026-09-25新設)。
 *
 * 物理削除(executePurgeForUser、1ユーザー1 transaction)と監査記録(AuditLog、
 * 削除とは別の書込み)を分離する:
 *   - 削除の成否はpurgeSucceededに確定させ、その後の監査記録の成否で上書きしない。
 *   - 監査記録の失敗はauditRecorded=false/auditErrorに記録し、例外を投げない
 *     (呼出側CLIがstderrと専用exit codeで通知する)。
 *   - AuditLogは`actorUserId=null`・`actorType="SYSTEM"`(削除済みユーザーを
 *     FKで参照しない。fix05の規約を維持)。行為者情報はOS user・hostname・pid・
 *     run IDを自動収集し、--operatorは自己申告の補足として扱う。
 *
 * [DEC-PURGE-02B・未決の注記] AuditLog自体はPurge対象外(FKで削除対象へ到達しない
 * 表)であり、削除された本人を行為者とする行はactor_user_idの匿名化(NULL化)で
 * 保持される。AuditLogの強い永続保証(Purge対象外の運用ledger/outbox)が必要か
 * どうかは、非FK表の保持契約と合わせてDecision Recordで決定する。
 */
import os from "node:os";
import { randomUUID } from "node:crypto";
import { db } from "@/lib/db";
import { executePurgeForUser, type PurgeManifest, type PurgeRunOptions } from "./purgeJob";
import { buildPurgeAuditReason, sanitizeOperatorName, type PurgeItemOutcome, type PurgeRunContext } from "./purgeReporting";

export function collectPurgeRunContext(operatorDeclared: string | null | undefined): PurgeRunContext {
  let osUser = process.env.USER ?? process.env.LOGNAME ?? "unknown";
  try {
    osUser = os.userInfo().username || osUser;
  } catch {
    // コンテナ等でpasswdエントリが無い場合は環境変数の値を使う。
  }
  return {
    runId: randomUUID(),
    osUser: sanitizeOperatorName(osUser) ?? "unknown",
    hostname: sanitizeOperatorName(os.hostname()) ?? "unknown",
    pid: process.pid,
    operatorDeclared: sanitizeOperatorName(operatorDeclared),
    startedAt: new Date().toISOString(),
  };
}

export interface PurgeAuditEntry {
  targetUserId: string;
  result: "SUCCESS" | "FAILURE";
  reason: string;
}

export type PurgeAuditWriter = (entry: PurgeAuditEntry) => Promise<void>;

export const writePurgeAuditLog: PurgeAuditWriter = async (entry) => {
  await db.auditLog.create({
    data: {
      actorUserId: null,
      actorType: "SYSTEM",
      action: "ACCOUNT_PURGE_EXECUTED",
      targetType: "User",
      targetId: entry.targetUserId,
      result: entry.result,
      reason: entry.reason,
    },
  });
};

function errorSummary(err: unknown): string {
  const text = err instanceof Error ? err.message : String(err);
  return text.replace(/\s+/g, " ").trim().slice(0, 400);
}

/**
 * 1ユーザー分のPurgeを実行し、結果を監査記録する。例外は投げない
 * (削除側の例外もstatus="ERROR"として結果へ畳み込む)。
 */
export async function runPurgeItem(params: {
  userId: string;
  context: PurgeRunContext;
  expected?: PurgeManifest | null;
  options?: PurgeRunOptions;
  auditWriter?: PurgeAuditWriter;
}): Promise<PurgeItemOutcome> {
  const { userId, context } = params;
  const auditWriter = params.auditWriter ?? writePurgeAuditLog;

  let outcome: PurgeItemOutcome;
  try {
    const result = await executePurgeForUser({ userId }, { ...(params.options ?? {}), expected: params.expected ?? null });
    if (result.status === "PURGED") {
      const m = result.manifest;
      outcome = {
        userId,
        purgeStatus: "PURGED",
        purgeSucceeded: true,
        totals: m.totals,
        workspaceRowsDeleted: m.workspaceRowsDeleted,
        userRowsDeleted: m.userRowsDeleted,
        anonymizedRows: m.anonymizedReferences.reduce((s, u) => s + u.count, 0),
        digest: m.digest,
        expectedDigest: result.expectedDigest,
        driftCount: result.drift ? result.drift.length : null,
        detail: null,
        auditRecorded: false,
        auditError: null,
      };
    } else {
      outcome = {
        userId,
        purgeStatus: result.status,
        purgeSucceeded: false,
        totals: null,
        workspaceRowsDeleted: null,
        userRowsDeleted: null,
        anonymizedRows: null,
        digest: null,
        expectedDigest: params.expected?.digest ?? null,
        driftCount: null,
        detail: result.detail,
        auditRecorded: false,
        auditError: null,
      };
    }
  } catch (err) {
    outcome = {
      userId,
      purgeStatus: "ERROR",
      purgeSucceeded: false,
      totals: null,
      workspaceRowsDeleted: null,
      userRowsDeleted: null,
      anonymizedRows: null,
      digest: null,
      expectedDigest: params.expected?.digest ?? null,
      driftCount: null,
      detail: errorSummary(err),
      auditRecorded: false,
      auditError: null,
    };
  }

  // 削除結果はここで確定済み。以下の監査記録の成否でpurgeSucceededを変えない。
  try {
    await auditWriter({
      targetUserId: userId,
      result: outcome.purgeSucceeded ? "SUCCESS" : "FAILURE",
      reason: buildPurgeAuditReason(context, outcome),
    });
    outcome = { ...outcome, auditRecorded: true };
  } catch (err) {
    outcome = { ...outcome, auditRecorded: false, auditError: errorSummary(err) };
  }
  return outcome;
}
