/**
 * 30日Purge運用台帳の純粋関数(PURGE-OPS-03B・2026-09-25新設、DB非依存)。
 * phaseはDEC-PURGE-02B §7.1(利用者決定)の工程順:
 *   NONE → 1) OBJECTS_SNAPSHOTTED → 2) OBJECTS_DELETED → 3) OBJECTS_VERIFIED
 *   → 4) DB_PURGED → 5) AUDITED → 6) COMPLETED
 */
import { createHash } from "node:crypto";

export const PURGE_PHASES = ["NONE", "OBJECTS_SNAPSHOTTED", "OBJECTS_DELETED", "OBJECTS_VERIFIED", "DB_PURGED", "AUDITED", "COMPLETED"] as const;
export type PurgePhase = (typeof PURGE_PHASES)[number];
export type PurgeItemStatus = "PENDING" | "IN_PROGRESS" | "RETRY_WAIT" | "COMPLETED" | "SKIPPED" | "DEAD_LETTER";

export function phaseIndex(phase: string): number {
  const i = (PURGE_PHASES as readonly string[]).indexOf(phase);
  if (i < 0) throw new Error(`[purgeLedger] 未知のphaseです: ${phase}`);
  return i;
}

/** run全体のplan digest(各itemのdry-run manifest digest、拒否ならstatus。item順序に依存しない)。 */
export function computePlanDigest(entries: { userId: string; plannedDigest: string | null; refusalStatus: string | null }[]): string {
  const lines = entries.map((e) => `${e.userId}:${e.plannedDigest ?? `REFUSED:${e.refusalStatus ?? "UNKNOWN"}`}`).sort();
  return createHash("sha256").update(lines.join("\n")).digest("hex");
}
