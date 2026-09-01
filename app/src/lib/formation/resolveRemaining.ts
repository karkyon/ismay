import { createHash } from "node:crypto";
import { db } from "@/lib/db";
import type { Prisma } from "@/generated/prisma/client";
import { isValidFormationSessionTransitionTriple, type FormationSessionState } from "@/lib/formation/coreTypes";

/**
 * app/src/lib/formation/resolveRemaining.ts
 *
 * V5-M1-B6C-4 §6.4 resolve remaining。
 * 出典: Claude向け ISMAY c503e72以降 M1-B6C・全残件連続実装指示(2026-08-31) §6.4。
 *
 * [背景・既存の欠落] PARTIALLY_CONFIRMEDのSessionには、既にmaterialize済みの
 * 候補と、未決定(pending)のまま残る候補が混在する。個々の候補は既存の
 * `recordCandidateDecision`(POST /candidates/{id}/decisions)経由でDEFERRED/
 * DO_NOT_MATERIALIZEへ決定できるが、DEC-STATE-001によりSession状態は
 * `materializeFormationSession`内でのみ遷移するため、「残り全部を却下/保留
 * 決定しただけ」ではSessionはPARTIALLY_CONFIRMEDのまま永遠に終端しない
 * (materializeは新規ACCEPTED候補が無いとNO_ACCEPTED_CANDIDATESで拒否する)。
 * この関数はその欠落を埋める専用の終端操作であり、「残りpending候補を
 * DEFERRED/DO_NOT_MATERIALIZEとして明示的に決定 → 同一transactionでSession
 * 自体をCONFIRMED/DISMISSEDへ終端する」を1操作にまとめる。
 *
 * [pending候補を黙って捨てない] このSessionの現在の全pending候補
 * (`decisionEvents`が0件のCandidate)が、`items`に過不足なく含まれていることを
 * 検証する。1件でも漏れていれば`MISSING_PENDING_CANDIDATES`で拒否し、
 * 想像で「残りは自動的にdismiss」等の扱いはしない。
 *
 * [CONFIRMED/DISMISSEDの振り分け・設計判断] coreTypes.tsの遷移表ガードは
 * 「残りpendingがaccepted側で解決」→CONFIRMED、「dismiss側で解決」→DISMISSED
 * とだけ記されており、複数候補が混在する場合の厳密な規則までは正本に明記
 * されていない。このfileでは次の規則を採用する(理由をここに残す):
 *   - 全件DEFERRED(「今回は確定しないが将来また検討しうる」という保留)なら
 *     accepted側の close-outとみなしCONFIRMED。
 *   - 1件でもDO_NOT_MATERIALIZE(「Responsibility化しないと明示的に決定」)が
 *     含まれればdismiss側の要素が入っているとみなしDISMISSED。
 *   これは「明示的な却下が1件でもあれば、そのSessionはdismiss相当の結末を
 *   持つ」という保守的な判断であり、DEFERREDだけの穏当なケースをCONFIRMEDに
 *   倒す非対称ルールである。将来正本がより厳密な規則を明記した場合は
 *   このロジックのみを差し替える。
 *
 * [同一transactionでの整合] Session行FOR UPDATE lock配下で、Candidate Decision
 * Event全件の作成とSession lifecycle event・timeline eventの記録を単一
 * transactionにまとめる(指示書「Candidate decision eventsとSession lifecycle
 * eventを同一transactionで整合させる」)。1件でも失敗すれば全体がrollbackし、
 * 「一部の候補だけ決定済みでSessionは未終端」という中間状態を残さない。
 */

export type ResolveRemainingResolution = "DEFERRED" | "DO_NOT_MATERIALIZE";

export interface ResolveRemainingCandidateItem {
  candidateId: string;
  expectedRevision: number;
  resolution: ResolveRemainingResolution;
  reasonCode?: string;
}

export interface ResolveRemainingParams {
  sessionId: string;
  workspaceId: string;
  clientEventId: string;
  expectedVersion: number;
  actorUserId: string;
  items: ResolveRemainingCandidateItem[];
}

export type ResolveRemainingResult =
  | { ok: true; replay: boolean; toState: "CONFIRMED" | "DISMISSED"; resolvedCount: number }
  | { ok: false; error: "NOT_FOUND" }
  | { ok: false; error: "INVALID_SESSION_STATE"; sessionState: FormationSessionState }
  | { ok: false; error: "VERSION_CONFLICT"; latestVersion: number }
  | { ok: false; error: "IDEMPOTENCY_KEY_REUSED" }
  | { ok: false; error: "EMPTY_ITEMS" }
  /** [pending候補を黙って捨てない] 現在のpending候補のうち、itemsに含まれて
   *  いなかったcandidateId一覧。 */
  | { ok: false; error: "MISSING_PENDING_CANDIDATES"; missingCandidateIds: string[] }
  | { ok: false; error: "UNKNOWN_CANDIDATE"; candidateId: string }
  | { ok: false; error: "REVISION_CONFLICT"; candidateId: string; latestRevision: number }
  | { ok: false; error: "ALREADY_DECIDED"; candidateId: string }
  | { ok: false; error: "COREYPES_TRANSITION_UNDEFINED" };

function computeRequestHash(input: {
  sessionId: string;
  workspaceId: string;
  expectedVersion: number;
  items: ResolveRemainingCandidateItem[];
}): string {
  // itemsの順序に依存させない(呼び出し元がUIでの表示順を変えても同じ要求は
  // 同じhashになるようにする)。
  const sortedItems = [...input.items]
    .map((i) => ({ candidateId: i.candidateId, expectedRevision: i.expectedRevision, resolution: i.resolution, reasonCode: i.reasonCode ?? null }))
    .sort((a, b) => a.candidateId.localeCompare(b.candidateId));
  return createHash("sha256")
    .update(
      JSON.stringify({
        sessionId: input.sessionId,
        workspaceId: input.workspaceId,
        expectedVersion: input.expectedVersion,
        items: sortedItems,
      }),
    )
    .digest("hex");
}

export async function resolveRemainingCandidates(params: ResolveRemainingParams): Promise<ResolveRemainingResult> {
  const { sessionId, workspaceId, clientEventId, expectedVersion, actorUserId, items } = params;

  if (items.length === 0) {
    return { ok: false, error: "EMPTY_ITEMS" };
  }

  const requestHash = computeRequestHash({ sessionId, workspaceId, expectedVersion, items });

  const existing = await db.formationSessionLifecycleEvent.findFirst({ where: { workspaceId, clientEventId } });
  if (existing) {
    if (existing.requestHash !== requestHash) {
      return { ok: false, error: "IDEMPOTENCY_KEY_REUSED" };
    }
    return {
      ok: true,
      replay: true,
      toState: existing.toState as "CONFIRMED" | "DISMISSED",
      resolvedCount: items.length,
    };
  }

  return await db.$transaction(async (tx: Prisma.TransactionClient) => {
    const sessionRows = await tx.$queryRaw<{ id: string; workspaceId: string; state: string; version: number }[]>`
      SELECT id, workspace_id AS "workspaceId", state, version FROM formation_sessions
      WHERE id = ${sessionId} AND workspace_id = ${workspaceId}
      FOR UPDATE`;
    const session = sessionRows[0];
    if (!session) return { ok: false, error: "NOT_FOUND" } as const;

    // [race-safe] lock獲得後の再確認(sessionLifecycle.tsと同じ設計)。
    const existingInTx = await tx.formationSessionLifecycleEvent.findFirst({ where: { workspaceId, clientEventId } });
    if (existingInTx) {
      if (existingInTx.requestHash !== requestHash) {
        return { ok: false, error: "IDEMPOTENCY_KEY_REUSED" } as const;
      }
      return {
        ok: true,
        replay: true,
        toState: existingInTx.toState as "CONFIRMED" | "DISMISSED",
        resolvedCount: items.length,
      } as const;
    }

    if (session.version !== expectedVersion) {
      return { ok: false, error: "VERSION_CONFLICT", latestVersion: session.version } as const;
    }
    if (session.state !== "PARTIALLY_CONFIRMED") {
      return { ok: false, error: "INVALID_SESSION_STATE", sessionState: session.state as FormationSessionState } as const;
    }

    // 「pending候補を黙って捨てない」: このSessionの全pending候補(未決定=
    // decisionEventsが0件)を過不足なくitemsが指定していることを検証する。
    const pendingIdentities = (await tx.formationCandidateIdentity.findMany({
      where: { sessionId, workspaceId, decisionEvents: { none: {} } },
      select: { id: true, currentRevision: true },
    })) as { id: string; currentRevision: number }[];
    const pendingById = new Map(pendingIdentities.map((p) => [p.id, p]));
    const providedIds = new Set(items.map((i) => i.candidateId));
    const missing = [...pendingById.keys()].filter((id) => !providedIds.has(id));
    if (missing.length > 0) {
      return { ok: false, error: "MISSING_PENDING_CANDIDATES", missingCandidateIds: missing } as const;
    }

    let anyDoNotMaterialize = false;
    for (const item of items) {
      const identity = pendingById.get(item.candidateId);
      if (!identity) {
        // items側に、pendingでない(既に決定済み/他Sessionのもの/存在しない)
        // candidateIdが混じっている。想像で無視せず拒否する。
        return { ok: false, error: "UNKNOWN_CANDIDATE", candidateId: item.candidateId } as const;
      }
      if (identity.currentRevision !== item.expectedRevision) {
        return { ok: false, error: "REVISION_CONFLICT", candidateId: item.candidateId, latestRevision: identity.currentRevision } as const;
      }
      const revision = await tx.formationCandidateRevision.findFirst({
        where: { candidateId: item.candidateId, workspaceId, revision: item.expectedRevision },
        select: { id: true },
      });
      if (!revision) {
        return { ok: false, error: "UNKNOWN_CANDIDATE", candidateId: item.candidateId } as const;
      }
      // [race-safe] pendingIdentitiesのSELECTからここまでの間に他経路で決定
      // された可能性は、Session行FOR UPDATE lockが全formation操作
      // (recordCandidateDecision含む)を直列化するため実質発生しないが、
      // 想定外の二重決定はDB一意制約(workspaceId,candidateId)で最終防衛される。
      const alreadyDecided = await tx.formationCandidateDecisionEvent.findFirst({
        where: { candidateId: item.candidateId, workspaceId },
        select: { id: true },
      });
      if (alreadyDecided) {
        return { ok: false, error: "ALREADY_DECIDED", candidateId: item.candidateId } as const;
      }

      await tx.formationCandidateDecisionEvent.create({
        data: {
          workspaceId,
          candidateId: item.candidateId,
          revisionId: revision.id,
          decision: item.resolution,
          reasonCode: item.reasonCode ?? null,
          actorUserId,
        },
      });
      if (item.resolution === "DO_NOT_MATERIALIZE") anyDoNotMaterialize = true;
    }

    // [設計判断・ファイル冒頭コメント参照] 1件でもDO_NOT_MATERIALIZEが
    // 含まれればDISMISSED、全件DEFERREDならCONFIRMED。
    const toState: "CONFIRMED" | "DISMISSED" = anyDoNotMaterialize ? "DISMISSED" : "CONFIRMED";
    if (!isValidFormationSessionTransitionTriple("PARTIALLY_CONFIRMED", "RESOLVE_REMAINING", toState)) {
      return { ok: false, error: "COREYPES_TRANSITION_UNDEFINED" } as const;
    }

    await tx.formationSession.update({
      where: { id: sessionId },
      data: { state: toState, version: { increment: 1 } },
    });

    await tx.formationSessionLifecycleEvent.create({
      data: {
        workspaceId,
        sessionId,
        clientEventId,
        requestHash,
        action: "RESOLVE_REMAINING",
        fromState: session.state,
        toState,
        reasonCode: null,
        actorUserId,
      },
    });

    const lastEvent = await tx.formationSessionEvent.findFirst({
      where: { workspaceId, sessionId },
      orderBy: { sequence: "desc" },
      select: { sequence: true },
    });
    await tx.formationSessionEvent.create({
      data: {
        workspaceId,
        sessionId,
        sequence: (lastEvent?.sequence ?? 0) + 1,
        eventType: toState === "CONFIRMED" ? "SESSION_CONFIRMED" : "SESSION_DISMISSED",
        actorType: "USER",
        actorUserId,
        payload: {
          fromState: session.state,
          toState,
          resolvedCandidateIds: items.map((i) => i.candidateId),
          resolutions: Object.fromEntries(items.map((i) => [i.candidateId, i.resolution])),
        },
      },
    });

    return { ok: true, replay: false, toState, resolvedCount: items.length } as const;
  });
}
