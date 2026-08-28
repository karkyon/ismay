import { createHash } from "node:crypto";
import { db } from "@/lib/db";
import type { Prisma } from "@/generated/prisma/client";
import { debugServer } from "@/lib/debugServer";
import { ResponsibilityCandidateSchema } from "@/lib/ai/schema";
import { initialStatusFor } from "@/lib/responsibility";
import { embedAndStoreResponsibility } from "@/lib/ai/relatedResponsibilities";
import {
  resolveFormationSessionTransition,
  isValidCandidateDecisionEventValue,
  type CandidateDecisionEventValue,
  type FormationEventType,
} from "@/lib/formation/coreTypes";

/**
 * V5-M1-B3/B3.1 Formation Session Materialize service。
 * 出典: ISMAY-V5-DOC-03(Formation Session仕様書) 6章(Materialization Transaction)・
 *       7章(API-F05 `POST /:id/candidates/:candidateId/decisions`、
 *           API-F06 `POST /:id/materialize`)、10章「B3はMaterialize serviceへsingle-write」。
 *       ISMAY_統合正本仕様書_v5_0.md 6.8節(Materialization Transaction、7 steps)。
 *
 * [B3.1是正・2026-08-29] B3直列実装(commit c67b923)を実コード監査した結果、
 * 以下の並行実行不変条件が未保証だったため是正した(監査文書「Gate M1-B3.1
 * 整合性是正・次工程指示」B31-01〜04・06参照。B31-05〜07はB4のスコープであり
 * このファイルでは対応しない)。
 *
 * - [B31-01] `materialization_receipt_items`の一意制約が`(receiptId,candidateId)`
 *   のみで、異なるReceipt/operationIdから同じcandidateを複数回materializeできた。
 *   → schema.prismaへ`(workspaceId,candidateId)`のglobal一意制約を追加
 *     (migration `20260829010000_formation_materialization_invariants`)。
 * - [B31-02] 同一operationIdの並行再送で、事前SELECTだけではraceを防げなかった。
 *   → transaction内でDB unique制約違反(P2002)を捕捉し、勝者のReceiptを
 *     再取得してreplay/IDEMPOTENCY_KEY_REUSEDへ決定論的に変換する。
 * - [B31-03] 異operationIdの並行実行で同一candidateが二重materializeされ得た。
 *   → 同上のglobal一意制約がDB側の最終防衛線。transaction内でP2002を捕捉し
 *     `CANDIDATE_ALREADY_MATERIALIZED`へ変換する(Responsibility/EventLog/
 *     Outbox/Receiptを含むtransaction全体はDBにより自動rollbackされるため、
 *     孤立行は残らない)。
 * - [B31-04][B31-06] 同一SessionへのDecision記録・Materializeが並行実行されると、
 *   `(sessionId,sequence)`一意制約違反や、同一候補への相反decisionが両方成立する
 *   可能性があった。
 *   → `recordCandidateDecision`/`materializeFormationSession`の両方で、
 *     transaction冒頭にSession行を`SELECT ... FOR UPDATE`する(DOC-03 6章
 *     「SELECT ... FOR UPDATE相当」を文字通り実装。Prismaのtyped query builderは
 *     row lock構文を持たないため`$queryRaw`を使う)。これにより同一Session上の
 *     全Decision記録・Materialize呼び出しが直列化される。加えて
 *     `formation_candidate_decision_events`にも`(workspaceId,candidateId)`一意制約を
 *     追加し、lockを経由しない書込み経路が将来入っても多層防御が効くようにした。
 * - `computeMaterializeRequestHash`の対象に`expectedVersion`を追加した(旧実装は
 *   `{sessionId,workspaceId}`のみでバージョンを含まず、client側が異なる前提状態
 *   から送った再送を同一payloadとみなしてしまう余地があった)。
 *
 * [設計方針・スコープ(B3から継続)] このGate(M1-B3/B3.1)は、B1(shadowWrite.ts)が
 * 書き込んだFormationSession/CandidateIdentity/Revisionを対象に、新規API経由での
 * みCandidateDecisionEvent・MaterializationReceipt・Responsibilityを書き込む。
 *
 * 明示的にやらないこと(B1/B2と同じ「blast radius最小化」方針を踏襲):
 * - 既存`/inferences/[id]/decision`route.tsの変更(CHG-011のFeature Flag委譲は
 *   B4のスコープ。監査B31-05が指摘する通り、この2関数を単純に順番へ呼ぶだけの
 *   委譲は非原子的であり、B4では別途共通transaction化が必要)。
 * - Atomicity Assessment(DOC-03 5章 ATOMIC/NEEDS_SPLIT等)の実装。AIが
 *   atomicityAssessmentを出力する経路自体がまだ存在しない(ResponsibilityCandidateSchema
 *   に該当fieldが無い)ため、COMMITのguard「atomicity解決」は現状「常に解決済み扱い」
 *   とする(想像でAssessment値を作らない、という既存方針の踏襲)。
 * - Question Policy/CLARIFYING経路との統合(DEC-010を継続。REVIEW_READY到達済みの
 *   Sessionのみを対象とする)。
 * - Context LinkとRelation候補の自動生成、Tag自動付与、旧API互換field
 *   (originInferenceId・startAfterAt等。監査B31-06参照)。これらはB4で旧経路を
 *   実際に委譲する際に同値性を検討する。
 */

// ---------------------------------------------------------------------------
// 型定義
// ---------------------------------------------------------------------------

export interface RecordCandidateDecisionParams {
  sessionId: string;
  workspaceId: string;
  candidateId: string;
  /** 採否対象を固定するため、クライアントが直前に見ていたcurrentRevisionを渡す
   *  (DOC-03 4章「採否対象Revisionを固定」、API-F05「revision必須」)。 */
  expectedRevision: number;
  decision: CandidateDecisionEventValue;
  reasonCode?: string;
  actorUserId: string;
}

export type RecordCandidateDecisionResult =
  | { ok: true; decisionEventId: string; sessionState: string }
  | { ok: false; error: "NOT_FOUND" }
  | { ok: false; error: "REVISION_CONFLICT"; latestRevision: number }
  | { ok: false; error: "ALREADY_DECIDED"; existingDecision: string }
  | { ok: false; error: "INVALID_SESSION_STATE"; sessionState: string }
  | { ok: false; error: "INVALID_DECISION_VALUE" };

export interface MaterializeFormationSessionParams {
  sessionId: string;
  workspaceId: string;
  operationId: string;
  /** 楽観ロック用。クライアントが直前に見ていたFormationSession.versionを渡す。 */
  expectedVersion: number;
  actorUserId: string;
}

export interface MaterializedItem {
  candidateId: string;
  candidateRevisionId: string;
  responsibilityId: string;
}

export type MaterializeFormationSessionResult =
  | { ok: true; receiptId: string; operationId: string; items: MaterializedItem[]; replay: boolean }
  | { ok: false; error: "NOT_FOUND" }
  | { ok: false; error: "VERSION_CONFLICT" }
  | { ok: false; error: "INVALID_SESSION_STATE"; sessionState: string }
  | { ok: false; error: "NO_ACCEPTED_CANDIDATES" }
  | { ok: false; error: "IDEMPOTENCY_KEY_REUSED" }
  | { ok: false; error: "CORRUPTED_CANDIDATE_DATA"; candidateId: string }
  /** [B3.1新設・B31-01/B31-03] 異operationIdの並行実行が同一candidateを先に
   *  materialize済みだった場合。呼び出し元はSessionを再取得し、まだ未決定・
   *  未materializeの候補が残っていれば新しいoperationIdで再試行できる。 */
  | { ok: false; error: "CANDIDATE_ALREADY_MATERIALIZED" };

// ---------------------------------------------------------------------------
// 純粋関数(db非依存、__tests__/coreInvariants.test.tsから直接検証できるようにする)
// ---------------------------------------------------------------------------

/**
 * Materializeのidempotency用request hash。DOC-03 6章「operationIdとrequestHashの
 * 冪等性を検証。同一key異payloadは409」。
 * [B3.1是正・B31-02] 旧実装は`{sessionId,workspaceId}`のみを対象にしており、
 * クライアントが異なるexpectedVersion(=異なる前提状態)で同一operationIdを
 * 再送した場合でも同一payloadとみなしてreplayしてしまう余地があった。
 * expectedVersionを含めることで、「同じ前提から送られた同じ要求か」を正しく
 * 判定できるようにする。
 */
export function computeMaterializeRequestHash(input: {
  sessionId: string;
  workspaceId: string;
  expectedVersion: number;
}): string {
  return createHash("sha256")
    .update(
      JSON.stringify({
        sessionId: input.sessionId,
        workspaceId: input.workspaceId,
        expectedVersion: input.expectedVersion,
      }),
    )
    .digest("hex");
}

/**
 * CandidateDecisionEventValueから、対応するFormationSessionEvent(timeline)のeventTypeを
 * 決める。Event Catalog(DOC-02 7.3節)にはCANDIDATE_ACCEPTED/CANDIDATE_REJECTED/
 * CANDIDATE_DEFERREDの3種のみ存在し、DO_NOT_MATERIALIZE専用のcatalog値は無い
 * (想像で新しいEvent Codeを発明しない、という既存方針)。DO_NOT_MATERIALIZEは
 * 「延期ではなく明確な非対象化」だが、既存3値のうち意味的に最も近いCANDIDATE_DEFERREDへ
 * 記録する。実際の決定値そのものはCandidateDecisionEvent.decisionに正確に残るため、
 * この対応は診断用timelineの表示上の丸めであり、正本データを失わない。
 */
export function sessionEventTypeForDecision(decision: CandidateDecisionEventValue): FormationEventType {
  switch (decision) {
    case "ACCEPTED":
      return "CANDIDATE_ACCEPTED";
    case "REJECTED":
      return "CANDIDATE_REJECTED";
    case "DEFERRED":
    case "DO_NOT_MATERIALIZE":
      return "CANDIDATE_DEFERRED";
  }
}

/** materialization_receipts_operation_uq(B31-02)、materialization_receipt_items_
 *  workspace_candidate_uq(B31-01/03)、formation_candidate_decision_events_
 *  workspace_candidate_uq(B31-04/06)のいずれか。 */
const RECEIPT_OPERATION_UNIQUE_CONSTRAINT = "materialization_receipts_operation_uq";
const RECEIPT_ITEM_CANDIDATE_UNIQUE_CONSTRAINT = "materialization_receipt_items_workspace_candidate_uq";
const DECISION_EVENT_CANDIDATE_UNIQUE_CONSTRAINT = "formation_candidate_decision_events_workspace_candidate_uq";

/**
 * [B3.1新設] Prismaの一意制約違反(P2002)を、対象constraint名で判別する。
 * PrismaClientKnownRequestErrorをimportせずcode/metaを直接見るのは、
 * sandbox環境のPrisma client生成が制約される既知事情(KARKYONメモリ記載)を
 * 踏まえ、型import無しでも動く実装にするため。
 */
function isUniqueConstraintViolation(e: unknown, constraintName: string): boolean {
  if (typeof e !== "object" || e === null) return false;
  const code = (e as { code?: unknown }).code;
  if (code !== "P2002") return false;
  const meta = (e as { meta?: { target?: unknown } }).meta;
  const target = meta?.target;
  if (typeof target === "string") return target.includes(constraintName);
  if (Array.isArray(target)) {
    return target.some((t) => typeof t === "string" && t.includes(constraintName));
  }
  // targetを判別できない場合は「不明なP2002」として上位のcatchに委ねる
  // (該当constraintと断定できないものを誤って握りつぶさない)。
  return false;
}

/** transaction内から即座に中断してエラー結果を返すための内部signal(B3から継続)。 */
class MaterializeAbort extends Error {
  result: MaterializeFormationSessionResult;
  constructor(result: MaterializeFormationSessionResult) {
    super("MATERIALIZE_ABORT");
    this.result = result;
  }
}

// ---------------------------------------------------------------------------
// API-F05: POST /:id/candidates/:candidateId/decisions
// ---------------------------------------------------------------------------

export async function recordCandidateDecision(
  params: RecordCandidateDecisionParams,
): Promise<RecordCandidateDecisionResult> {
  const { sessionId, workspaceId, candidateId, expectedRevision, decision, reasonCode, actorUserId } = params;

  if (!isValidCandidateDecisionEventValue(decision)) {
    return { ok: false, error: "INVALID_DECISION_VALUE" };
  }

  try {
    return await db.$transaction(async (tx: Prisma.TransactionClient) => {
      // [B3.1是正・B31-04/B31-06] Session行をFOR UPDATEでlockし、同一Sessionへの
      // 並行Decision記録・Materializeを直列化する(DOC-03 6章「SELECT ... FOR UPDATE
      // 相当」)。以前はfindFirst(lock無し)だったため、同一Sessionの別候補を
      // 同時採否すると(sessionId,sequence)一意制約違反や、同一候補への相反
      // decisionが両方成立する可能性があった(2026-08-29監査で指摘)。
      const sessionRows = await tx.$queryRaw<{ id: string; version: number; state: string }[]>`
        SELECT id, version, state FROM formation_sessions
        WHERE id = ${sessionId} AND workspace_id = ${workspaceId}
        FOR UPDATE`;
      const session = sessionRows[0];
      if (!session) return { ok: false, error: "NOT_FOUND" } as const;

      if (session.state !== "REVIEW_READY" && session.state !== "PARTIALLY_CONFIRMED") {
        return { ok: false, error: "INVALID_SESSION_STATE", sessionState: session.state } as const;
      }

      const identity = await tx.formationCandidateIdentity.findFirst({
        where: { id: candidateId, sessionId, workspaceId },
      });
      if (!identity) return { ok: false, error: "NOT_FOUND" } as const;

      if (identity.currentRevision !== expectedRevision) {
        return { ok: false, error: "REVISION_CONFLICT", latestRevision: identity.currentRevision } as const;
      }

      // Session行lock配下で直列化されているため、このSELECTは以後race無く
      // 信頼できる(以前はここが「事前SELECTのみ」でDB制約が無かった、B31-06)。
      const existingDecision = await tx.formationCandidateDecisionEvent.findFirst({
        where: { candidateId: identity.id, workspaceId },
        orderBy: { occurredAt: "desc" },
      });
      if (existingDecision) {
        return { ok: false, error: "ALREADY_DECIDED", existingDecision: existingDecision.decision } as const;
      }

      const revision = await tx.formationCandidateRevision.findFirst({
        where: { candidateId: identity.id, workspaceId, revision: expectedRevision },
      });
      if (!revision) return { ok: false, error: "NOT_FOUND" } as const;

      const decisionEvent = await tx.formationCandidateDecisionEvent.create({
        data: {
          workspaceId,
          candidateId: identity.id,
          revisionId: revision.id,
          decision,
          reasonCode: reasonCode ?? null,
          actorUserId,
        },
      });

      const lastSessionEvent = await tx.formationSessionEvent.findFirst({
        where: { sessionId, workspaceId },
        orderBy: { sequence: "desc" },
      });
      const nextSequence = (lastSessionEvent?.sequence ?? 0) + 1;
      await tx.formationSessionEvent.create({
        data: {
          workspaceId,
          sessionId,
          sequence: nextSequence,
          eventType: sessionEventTypeForDecision(decision),
          actorType: "USER",
          actorUserId,
          payload: { candidateId: identity.id, candidateKey: identity.candidateKey, decision, revisionId: revision.id },
        },
      });

      // REVIEW_READY --partial decisions--> PARTIALLY_CONFIRMED(DOC-03 3章
      // 「acceptedとpending混在」)。acceptedが1件以上あり、かつ未決定の候補が
      // まだ残っている場合にのみ遷移する。全候補決定済みでも自動COMMITはしない
      // (COMMITは別APIの明示操作、DOC-03 3章「REVIEW_READY/PARTIALLY_CONFIRMED --commit--> CONFIRMED」)。
      let sessionState: string = session.state;
      if (session.state === "REVIEW_READY") {
        const allIdentities = await tx.formationCandidateIdentity.findMany({
          where: { sessionId, workspaceId },
          select: { id: true },
        });
        const decidedRows = await tx.formationCandidateDecisionEvent.findMany({
          where: { workspaceId, candidateId: { in: allIdentities.map((c: { id: string }) => c.id) } },
          select: { candidateId: true },
          distinct: ["candidateId"],
        });
        const decidedCandidateIds = new Set(decidedRows.map((d: { candidateId: string }) => d.candidateId));
        const hasAccepted = decision === "ACCEPTED";
        const hasPending = allIdentities.some((c: { id: string }) => !decidedCandidateIds.has(c.id));
        if (hasAccepted && hasPending) {
          const toPartial = resolveFormationSessionTransition("REVIEW_READY", "PARTIAL_DECISIONS");
          if (toPartial) {
            await tx.formationSession.update({
              where: { id: sessionId },
              data: { state: toPartial, version: { increment: 1 } },
            });
            sessionState = toPartial;
          }
        }
      }

      debugServer.event("formation/materialize", "CANDIDATE_DECISION_RECORDED", {
        sessionId,
        candidateId: identity.id,
        decision,
      });

      return { ok: true, decisionEventId: decisionEvent.id, sessionState } as const;
    });
  } catch (e: unknown) {
    // [B3.1新設・B31-04/B31-06多層防御] Session行lockにより通常はここへ来ないが、
    // 万一lockを経由しない経路や想定外のrace窓で一意制約違反が発生した場合、
    // 生の500ではなくALREADY_DECIDEDへ決定論的に変換する。
    if (isUniqueConstraintViolation(e, DECISION_EVENT_CANDIDATE_UNIQUE_CONSTRAINT)) {
      const existing = await db.formationCandidateDecisionEvent.findFirst({
        where: { candidateId, workspaceId },
        orderBy: { occurredAt: "desc" },
      });
      return { ok: false, error: "ALREADY_DECIDED", existingDecision: existing?.decision ?? "UNKNOWN" };
    }
    throw e;
  }
}

// ---------------------------------------------------------------------------
// API-F06: POST /:id/materialize
// ---------------------------------------------------------------------------

interface ReceiptForReplay {
  id: string;
  operationId: string;
  items: MaterializedItem[];
}

function toReplayResult(receipt: ReceiptForReplay): MaterializeFormationSessionResult {
  return {
    ok: true,
    receiptId: receipt.id,
    operationId: receipt.operationId,
    replay: true,
    items: receipt.items.map((i) => ({
      candidateId: i.candidateId,
      candidateRevisionId: i.candidateRevisionId,
      responsibilityId: i.responsibilityId,
    })),
  };
}

export async function materializeFormationSession(
  params: MaterializeFormationSessionParams,
): Promise<MaterializeFormationSessionResult> {
  const { sessionId, workspaceId, operationId, expectedVersion, actorUserId } = params;
  const requestHash = computeMaterializeRequestHash({ sessionId, workspaceId, expectedVersion });

  // 冪等性チェック(DOC-03 6章2「operationIdとrequestHashの冪等性を検証。
  // 同一key異payloadは409」)。tx外で先に見て、既にcommit済みなら書込みを一切
  // 行わずreplay結果を返す(統合正本6.8節 step7「idempotency response保存」)。
  // [B3.1是正・B31-02] これは高速path用の事前確認であり、真の排他性はDB unique
  // 制約(materialization_receipts_operation_uq)と下のtry/catchで保証する。
  // 事前確認だけでは、2並行requestが共に「まだ存在しない」と判定して両方
  // transactionへ進むraceを防げない。
  const existingReceipt = await db.materializationReceipt.findFirst({
    where: { workspaceId, operationId },
    include: { items: true },
  });
  if (existingReceipt) {
    if (existingReceipt.requestHash !== requestHash) {
      return { ok: false, error: "IDEMPOTENCY_KEY_REUSED" };
    }
    return toReplayResult(existingReceipt);
  }

  let txResult: MaterializeFormationSessionResult;
  try {
    txResult = await db.$transaction(async (tx: Prisma.TransactionClient) => {
      // [B3.1是正・B31-03/B31-04] Session行をFOR UPDATEでlockする(DOC-03 6章1
      // 「SELECT ... FOR UPDATE相当」を文字通り実装)。以前はfindFirst+CAS
      // (updateMany + count確認)だったが、CASはupdateの瞬間しか排他しないため、
      // その前段のSELECT(識別子一覧・既存決定・既存materialize状況の読み取り)
      // 自体は無防備だった。行lockにより、この関数とrecordCandidateDecisionの
      // 両方が同一Sessionに対して完全に直列化される。
      const sessionRows = await tx.$queryRaw<
        { id: string; version: number; state: string; domainId: string; captureId: string }[]
      >`
        SELECT id, version, state, domain_id AS "domainId", capture_id AS "captureId"
        FROM formation_sessions
        WHERE id = ${sessionId} AND workspace_id = ${workspaceId}
        FOR UPDATE`;
      const session = sessionRows[0];
      if (!session) return { ok: false, error: "NOT_FOUND" } as const;

      // [B3.1新設] tx外の事前確認(冒頭)はfast pathに過ぎず、並行request同士の
      // raceは防げない。Session行lock獲得後(=先行transactionがcommit/rollback
      // 済み)に再度ここでoperationIdの存在を確認する。これが無いと、winnerの
      // commitでSessionが既にCONFIRMEDへ進んだ後にlockを獲得したloser(同一
      // operationIdの再送)が、後段のstate check(REVIEW_READY/PARTIALLY_CONFIRMED
      // 以外を拒否)でINVALID_SESSION_STATEという誤った非replay結果を返してしまう
      // (2026-08-29監査B31-02「片方commit、片方replay」を満たすために必須)。
      const existingReceiptInTx = await tx.materializationReceipt.findFirst({
        where: { workspaceId, operationId },
        include: { items: true },
      });
      if (existingReceiptInTx) {
        if (existingReceiptInTx.requestHash !== requestHash) {
          return { ok: false, error: "IDEMPOTENCY_KEY_REUSED" } as const;
        }
        return toReplayResult(existingReceiptInTx) as Extract<MaterializeFormationSessionResult, { ok: true }>;
      }

      if (session.state !== "REVIEW_READY" && session.state !== "PARTIALLY_CONFIRMED") {
        return { ok: false, error: "INVALID_SESSION_STATE", sessionState: session.state } as const;
      }
      if (session.version !== expectedVersion) {
        return { ok: false, error: "VERSION_CONFLICT" } as const;
      }

      const identities = await tx.formationCandidateIdentity.findMany({
        where: { sessionId, workspaceId },
      });

      const alreadyMaterializedRows = await tx.materializationReceiptItem.findMany({
        where: { workspaceId, candidateId: { in: identities.map((c: { id: string }) => c.id) } },
        select: { candidateId: true },
      });
      const alreadyMaterializedCandidateIds = new Set(
        alreadyMaterializedRows.map((i: { candidateId: string }) => i.candidateId),
      );

      const acceptedTargets: { identityId: string; candidateKey: string; decisionRevisionId: string }[] = [];
      for (const identity of identities) {
        if (alreadyMaterializedCandidateIds.has(identity.id)) continue;
        const latestDecision = await tx.formationCandidateDecisionEvent.findFirst({
          where: { candidateId: identity.id, workspaceId },
          orderBy: { occurredAt: "desc" },
        });
        if (latestDecision?.decision === "ACCEPTED") {
          acceptedTargets.push({
            identityId: identity.id,
            candidateKey: identity.candidateKey,
            decisionRevisionId: latestDecision.revisionId,
          });
        }
      }

      if (acceptedTargets.length === 0) {
        return { ok: false, error: "NO_ACCEPTED_CANDIDATES" } as const;
      }

      const items: MaterializedItem[] = [];
      for (const target of acceptedTargets) {
        // 採否対象Revisionを固定(決定時点のrevisionId、currentRevisionではない。
        // DOC-03 4章「採否対象Revisionを固定」、EV-F-003)。
        const revision = await tx.formationCandidateRevision.findFirst({
          where: { id: target.decisionRevisionId, workspaceId },
        });
        if (!revision) {
          throw new MaterializeAbort({ ok: false, error: "CORRUPTED_CANDIDATE_DATA", candidateId: target.identityId });
        }
        const candidateParsed = ResponsibilityCandidateSchema.safeParse(revision.proposedFields);
        if (!candidateParsed.success) {
          throw new MaterializeAbort({ ok: false, error: "CORRUPTED_CANDIDATE_DATA", candidateId: target.identityId });
        }
        const candidate = candidateParsed.data;

        const hardDeadlineAt = candidate.dateMentions.find((d) => d.meaning === "HARD_DEADLINE")?.normalizedAt;
        const targetAt = candidate.dateMentions.find((d) => d.meaning === "SOFT_TARGET")?.normalizedAt;

        const responsibility = await tx.responsibility.create({
          data: {
            workspaceId,
            domainId: session.domainId,
            originCaptureId: session.captureId,
            type: revision.type,
            title: revision.title,
            description: revision.description ?? null,
            status: initialStatusFor(revision.type),
            importance: candidate.importance ?? null,
            confidence: revision.confidence,
            sourceKind: "AI",
            hardDeadlineAt: hardDeadlineAt ? new Date(hardDeadlineAt) : null,
            targetAt: targetAt ? new Date(targetAt) : null,
            createdById: actorUserId,
            updatedById: actorUserId,
          },
        });

        await tx.eventLog.create({
          data: {
            aggregateType: "Responsibility",
            aggregateId: responsibility.id,
            eventType: "AI_CANDIDATE_DECIDED",
            beforeJson: { candidateId: target.identityId, decision: "PENDING" },
            afterJson: { candidateId: target.identityId, decision: "ACCEPTED", responsibilityId: responsibility.id },
            actorType: "USER",
            actorId: actorUserId,
          },
        });

        await tx.outboxEvent.create({
          data: {
            eventName: "ResponsibilityCreated.v1",
            eventVersion: "1",
            aggregateId: responsibility.id,
            aggregateVersion: responsibility.version,
            payload: {
              responsibilityId: responsibility.id,
              workspaceId,
              domainId: responsibility.domainId,
              type: responsibility.type,
              fromFormationSessionId: sessionId,
              fromCandidateId: target.identityId,
            },
          },
        });

        // [B3.1] ここでのINSERT失敗(P2002、materialization_receipt_items_
        // workspace_candidate_uq)は、異operationIdの並行実行が同じcandidateを
        // 先にmaterializeしていたことを意味する(B31-01/B31-03)。この時点までに
        // 積んだResponsibility/EventLog/Outbox/Receipt作成は、transaction全体が
        // catchブロックへ抜けることでDBにより自動rollbackされる(孤立行は残らない)。
        items.push({
          candidateId: target.identityId,
          candidateRevisionId: revision.id,
          responsibilityId: responsibility.id,
        });
      }

      const receipt = await tx.materializationReceipt.create({
        data: { workspaceId, sessionId, operationId, requestHash },
      });
      for (const item of items) {
        await tx.materializationReceiptItem.create({
          data: {
            workspaceId,
            receiptId: receipt.id,
            candidateId: item.candidateId,
            candidateRevisionId: item.candidateRevisionId,
            responsibilityId: item.responsibilityId,
          },
        });
      }

      const lastSessionEvent = await tx.formationSessionEvent.findFirst({
        where: { sessionId, workspaceId },
        orderBy: { sequence: "desc" },
      });
      const nextSequence = (lastSessionEvent?.sequence ?? 0) + 1;
      await tx.formationSessionEvent.create({
        data: {
          workspaceId,
          sessionId,
          sequence: nextSequence,
          eventType: "MATERIALIZATION_COMMITTED",
          actorType: "USER",
          actorUserId,
          payload: { operationId, receiptId: receipt.id, responsibilityIds: items.map((i) => i.responsibilityId) },
        },
      });

      // REVIEW_READY/PARTIALLY_CONFIRMED --commit--> CONFIRMED(DOC-03 3章)。
      // atomicity Assessmentは未実装のため常に「解決済み」として扱う
      // (このファイル冒頭コメントのスコープ注記を参照)。
      const toConfirmed = resolveFormationSessionTransition(session.state, "COMMIT");
      if (!toConfirmed) {
        throw new Error("coreTypes不整合: " + session.state + "--commit-->の遷移が定義されていません");
      }
      // [B3.1是正] Session行はこのtransaction冒頭でFOR UPDATE済みのため、
      // ここでのupdateは単純なwhere:{id}で安全(CAS updateMany+count確認は
      // もう不要。lockが同じ保証をより強く与える)。
      await tx.formationSession.update({
        where: { id: sessionId },
        data: { state: toConfirmed, version: { increment: 1 } },
      });
      await tx.formationSessionEvent.create({
        data: {
          workspaceId,
          sessionId,
          sequence: nextSequence + 1,
          eventType: "SESSION_CONFIRMED",
          actorType: "USER",
          actorUserId,
          payload: { operationId, receiptId: receipt.id },
        },
      });

      debugServer.event("formation/materialize", "MATERIALIZATION_COMMITTED", {
        sessionId,
        operationId,
        receiptId: receipt.id,
        itemCount: items.length,
      });

      return { ok: true, receiptId: receipt.id, operationId, items, replay: false } as const;
    });
  } catch (e: unknown) {
    if (e instanceof MaterializeAbort) {
      txResult = e.result;
    } else if (isUniqueConstraintViolation(e, RECEIPT_OPERATION_UNIQUE_CONSTRAINT)) {
      // [B3.1新設・B31-02] 同一operationIdの並行実行race。相手が先にcommitした。
      // このtransaction自体はDBにより自動rollbackされている。勝者のReceiptを
      // 再取得し、payloadが一致すればreplay、不一致ならIDEMPOTENCY_KEY_REUSEDへ
      // 決定論的に変換する。
      const winner = await db.materializationReceipt.findFirst({
        where: { workspaceId, operationId },
        include: { items: true },
      });
      if (!winner) {
        // 理論上到達しない(unique違反が起きた以上、誰かがcommitしているはず)。
        // 万一のtransient状態なら、呼び出し元に単純な再試行を促す。
        throw e;
      }
      txResult = winner.requestHash === requestHash ? toReplayResult(winner) : { ok: false, error: "IDEMPOTENCY_KEY_REUSED" };
    } else if (isUniqueConstraintViolation(e, RECEIPT_ITEM_CANDIDATE_UNIQUE_CONSTRAINT)) {
      // [B3.1新設・B31-01/B31-03] 異operationIdの並行Materializeが同一candidateを
      // 先にmaterialize済みだった。このtransaction全体(今回分のResponsibility等)は
      // DBにより自動rollbackされている。
      txResult = { ok: false, error: "CANDIDATE_ALREADY_MATERIALIZED" };
    } else {
      throw e;
    }
  }

  if (txResult.ok && !txResult.replay) {
    // 統合正本6.8節 step7 / DOC-03 6章7「commit後にAI/Embedding Jobを配送。
    // 失敗してもResponsibilityを巻き戻さない」(既存/inferences/[id]/decision
    // route.tsと同じtransaction外best-effort呼出パターン)。replay時は前回既に
    // 配送済みのため再送しない。
    for (const item of txResult.items) {
      const responsibility = await db.responsibility.findUnique({
        where: { id: item.responsibilityId },
        select: { id: true, workspaceId: true, domainId: true, title: true, description: true },
      });
      if (!responsibility) continue;
      await embedAndStoreResponsibility({
        responsibilityId: responsibility.id,
        workspaceId: responsibility.workspaceId,
        domainId: responsibility.domainId,
        title: responsibility.title,
        description: responsibility.description,
      }).catch((err: unknown) => {
        debugServer.error("formation/materialize", "embedAndStoreResponsibility例外", err);
      });
    }
  }

  return txResult;
}
