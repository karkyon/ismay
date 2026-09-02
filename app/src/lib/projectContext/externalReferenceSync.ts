import { db } from "@/lib/db";
import type { Prisma } from "@/generated/prisma/client";
import { debugServer } from "@/lib/debugServer";

/**
 * V5-M1-A4 External Reference Conflict Queue service。
 * 出典: DOC-04(Project Context・外部連携境界仕様書) 4章「双方向: 明示sync
 * policy、version/etag、conflict queueがある場合のみ…last-write-winsしない」、
 * EVAL・受入テスト仕様書 EV-C-005「external snapshot conflict | conflict
 * queue、LWW 0」。
 *
 * [対象範囲の明記] 外部Providerへの実HTTP通信(Connector/Webhook、署名検証、
 * replay防止)は、統合正本仕様書29章6項「External connector別scope、
 * credential、replay防止」が未確定事項に指定されているため実装しない
 * (external-references/route.ts冒頭の[DEC-9]と同じ判断根拠)。
 * ここで実装するのは「新しいsourceVersionが提示された時、既存の観測値と
 * 異なればqueueへ積み、本人が解決するまでLWWしない」という契約のみである。
 * sourceVersionの提示元(本人の手動登録、または将来のConnector実装)は問わない。
 *
 * [設計方針・revision採番] ProjectContextSnapshotRevisionは(referenceId,
 * workspaceId,revision)複合uniqueでrevision単調増加を保証する既存制約を持つ。
 * サーバー側で「既存最大revision+1」を採番し、呼び出し側にrevision番号の
 * 指定を求めない(insert-only、既存パターンと同じ)。
 *
 * [設計方針・conflict判定] reference.lastObservedVersionが設定されておらず
 * (初回同期)、または新しいsourceVersionが既存のlastObservedVersionと一致する
 * 場合はconflictとしない(想定通りの進行)。それ以外(異なる値が提示された)は
 * 無条件にconflictとして記録し、reference.lastObservedVersionを更新しない
 * (LWW回避)。Snapshot自体は監査のため必ず記録する(EV-A-004等と同じ
 * 「部分失敗0・全て記録」原則)。
 */

export interface RegisterExternalSnapshotParams {
  workspaceId: string;
  referenceId: string;
  sourceVersion: string;
  payload: object;
  actorUserId: string;
}

export type RegisterExternalSnapshotResult =
  | { ok: true; snapshotRevisionId: string; revision: number; conflict: false }
  | { ok: true; snapshotRevisionId: string; revision: number; conflict: true; conflictId: string }
  | { ok: false; error: "NOT_FOUND" };

export async function registerExternalSnapshot(
  params: RegisterExternalSnapshotParams,
): Promise<RegisterExternalSnapshotResult> {
  const { workspaceId, referenceId, sourceVersion, payload, actorUserId } = params;

  return await db.$transaction(async (tx: Prisma.TransactionClient) => {
    const reference = await tx.externalContextReference.findFirst({
      where: { id: referenceId, workspaceId },
    });
    if (!reference) return { ok: false, error: "NOT_FOUND" } as const;

    const lastSnapshot = await tx.projectContextSnapshotRevision.findFirst({
      where: { referenceId, workspaceId },
      orderBy: { revision: "desc" },
      select: { revision: true },
    });
    const nextRevision = (lastSnapshot?.revision ?? 0) + 1;

    const payloadJson = JSON.stringify(payload);
    // Node.js組み込みcryptoはservice層で直接importせず、route層で計算済みの
    // hashを渡す設計も検討したが、payloadHashはSnapshot自体の完全性を表す
    // 属性でありAPI契約の一部ではないため、ここで算出する(既存Formation系の
    // requestPayloadHashはAPI冪等性契約の一部なのでroute層算出、という区別)。
    const { createHash } = await import("node:crypto");
    const payloadHash = createHash("sha256").update(payloadJson).digest("hex");

    const snapshot = await tx.projectContextSnapshotRevision.create({
      data: {
        workspaceId,
        referenceId,
        revision: nextRevision,
        sourceVersion,
        payload,
        payloadHash,
      },
    });

    const isConflict = reference.lastObservedVersion !== null && reference.lastObservedVersion !== sourceVersion;

    if (isConflict) {
      const conflict = await tx.externalReferenceConflict.create({
        data: {
          workspaceId,
          referenceId,
          previousObservedVersion: reference.lastObservedVersion,
          newSourceVersion: sourceVersion,
          newSnapshotRevisionId: snapshot.id,
          status: "PENDING",
        },
      });

      await tx.eventLog.create({
        data: {
          aggregateType: "ExternalContextReference",
          aggregateId: referenceId,
          eventType: "EXTERNAL_SNAPSHOT_CONFLICT_DETECTED",
          beforeJson: { lastObservedVersion: reference.lastObservedVersion },
          afterJson: { newSourceVersion: sourceVersion, conflictId: conflict.id },
          actorType: "USER",
          actorId: actorUserId,
        },
      });
      debugServer.event("projectContext/externalReferenceSync", "EXTERNAL_SNAPSHOT_CONFLICT_DETECTED", {
        referenceId,
        conflictId: conflict.id,
      });

      // [DOC-04 4章「last-write-winsしない」] ここでreference.lastObservedVersionを
      // 更新しない。本人がresolveExternalReferenceConflictを呼ぶまで、既存の
      // 観測値を正としたまま保持する。
      return {
        ok: true,
        snapshotRevisionId: snapshot.id,
        revision: nextRevision,
        conflict: true,
        conflictId: conflict.id,
      } as const;
    }

    await tx.externalContextReference.update({
      where: { id: referenceId },
      data: { lastObservedVersion: sourceVersion, lastSyncedAt: new Date() },
    });

    debugServer.event("projectContext/externalReferenceSync", "EXTERNAL_SNAPSHOT_REGISTERED", {
      referenceId,
      revision: nextRevision,
    });

    return { ok: true, snapshotRevisionId: snapshot.id, revision: nextRevision, conflict: false } as const;
  });
}

export interface ResolveExternalReferenceConflictParams {
  workspaceId: string;
  conflictId: string;
  /** KEEP_LOCAL=既存観測を維持、APPLY_REMOTE=新しい値を採用。 */
  action: "KEEP_LOCAL" | "APPLY_REMOTE";
  actorUserId: string;
}

export type ResolveExternalReferenceConflictResult =
  | { ok: true; referenceLastObservedVersion: string | null }
  | { ok: false; error: "NOT_FOUND" }
  | { ok: false; error: "ALREADY_RESOLVED" };

export async function resolveExternalReferenceConflict(
  params: ResolveExternalReferenceConflictParams,
): Promise<ResolveExternalReferenceConflictResult> {
  const { workspaceId, conflictId, action, actorUserId } = params;

  return await db.$transaction(async (tx: Prisma.TransactionClient) => {
    const conflict = await tx.externalReferenceConflict.findFirst({
      where: { id: conflictId, workspaceId },
    });
    if (!conflict) return { ok: false, error: "NOT_FOUND" } as const;
    if (conflict.status !== "PENDING") return { ok: false, error: "ALREADY_RESOLVED" } as const;

    await tx.externalReferenceConflict.update({
      where: { id: conflictId },
      data: {
        status: "RESOLVED",
        resolutionAction: action,
        resolvedById: actorUserId,
        resolvedAt: new Date(),
      },
    });

    let referenceLastObservedVersion: string | null = null;
    if (action === "APPLY_REMOTE") {
      const updated = await tx.externalContextReference.update({
        where: { id: conflict.referenceId },
        data: { lastObservedVersion: conflict.newSourceVersion, lastSyncedAt: new Date() },
      });
      referenceLastObservedVersion = updated.lastObservedVersion;
    } else {
      const current = await tx.externalContextReference.findUniqueOrThrow({
        where: { id: conflict.referenceId },
        select: { lastObservedVersion: true },
      });
      referenceLastObservedVersion = current.lastObservedVersion;
    }

    await tx.eventLog.create({
      data: {
        aggregateType: "ExternalContextReference",
        aggregateId: conflict.referenceId,
        eventType: "EXTERNAL_SNAPSHOT_CONFLICT_RESOLVED",
        beforeJson: { status: "PENDING" },
        afterJson: { conflictId, resolutionAction: action },
        actorType: "USER",
        actorId: actorUserId,
      },
    });
    debugServer.event("projectContext/externalReferenceSync", "EXTERNAL_SNAPSHOT_CONFLICT_RESOLVED", {
      conflictId,
      action,
    });

    return { ok: true, referenceLastObservedVersion } as const;
  });
}
