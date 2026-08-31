import { createHash } from "node:crypto";
import { db } from "@/lib/db";
import type { Prisma } from "@/generated/prisma/client";
import { debugServer } from "@/lib/debugServer";
import { ResponsibilityCandidateSchema } from "@/lib/ai/schema";
import { embedAndStoreResponsibility } from "@/lib/ai/relatedResponsibilities";
import { createResponsibilityWithLinks } from "@/lib/formation/responsibilityMaterializationCore";
import { resolveLegacyProjectionMap } from "@/lib/formation/legacyProjectionResolver";
import { assessAtomicity } from "@/lib/formation/atomicityAssessment";
import {
  resolveFormationSessionTransition,
  isValidFormationSessionTransitionTriple,
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
 * - [B31-04][B31-04b] 同一SessionへのDecision記録・Materializeが並行実行されると、
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
 * [B3.2是正・2026-08-29 監査「Gate M1-B3.2 非課金証跡保証・残存競合是正」]
 * - [B32-05] `B31-06`という監査IDを、上記「相反decision競合」の意味へ後から
 *   差し替えていたのを是正した。元の監査指示における`B31-06`は
 *   「旧`/inferences/[id]/decision`routeとの機能・データ互換性不足
 *   (AiInference.decision、originInferenceId、Tag、BLOCKS Relation、旧API
 *   response等)」を指しており、本ファイルではこの意味のままOPENとして
 *   下記スコープ注記(旧API互換field)にのみ残す。相反decision競合への多層防御には
 *   新ID`B31-04b`を新設して置き換えた(過去監査IDの意味を後から変更しない、という
 *   方針の徹底)。
 * - [B32-01] Materialize commit後のEmbedding配送(`embedAndStoreResponsibility`)を
 *   `materializeFormationSession`の第二引数`deps`経由でdependency injection可能にした。
 *   production API route(materialize/route.ts)は第二引数を渡さないため常に実際の
 *   Embedding providerを使う。受入スクリプト側だけがno-op stubを注入することで、
 *   Workspace設定や環境変数(OPENAI_API_KEY等)の有無に関わらず外部AI通信を
 *   確実に0件にできる。
 * - [B32-03] P2002(一意制約違反)の判別を、`meta.target`のconstraint名文字列一致
 *   から、実際のDB状態を値で再確認する方式へ変更した。Prisma/PostgreSQLの版・
 *   実行環境によっては`meta.target`がconstraint名ではなくcolumn名配列で返る、
 *   または欠落する場合があり、文字列一致に依存するとcross-session(異なる
 *   FormationSession、したがってSession行lockが直接効かない)並行実行時の
 *   P2002を正しく判別できない可能性があったため。
 *
 * [設計方針・スコープ(B3から継続)] このGate(M1-B3/B3.1)は、B1(shadowWrite.ts)が
 * 書き込んだFormationSession/CandidateIdentity/Revisionを対象に、新規API経由での
 * みCandidateDecisionEvent・MaterializationReceipt・Responsibilityを書き込む。
 *
 * 明示的にやらないこと(B1/B2と同じ「blast radius最小化」方針を踏襲):
 * - 既存`/inferences/[id]/decision`route.tsの変更(CHG-011のFeature Flag委譲は
 *   B4のスコープ。監査B31-05が指摘する通り、この2関数を単純に順番へ呼ぶだけの
 *   委譲は非原子的であり、B4では別途共通transaction化が必要)。
 * - [2026-08-30更新・M1-C2A是正] Atomicity Assessment(統合正本§11.1)は
 *   atomicityAssessment.ts(M1-C)で実装済みであり、このファイルのMaterialize
 *   Guardへ接続済み(SHOULD_DECOMPOSE/CONTEXT_LIKEはoverrideが無い限り拒否、
 *   NEEDS_CLARIFICATIONは未解決質問がある限り拒否)。この行の記述は
 *   「B3時点ではまだ未実装だった」という当時の状況説明として残す。
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
  | { ok: false; error: "INVALID_DECISION_VALUE" }
  /** [B4.1新設・3.3節] 対応する旧AiInferenceが既にACCEPTED/EDITEDで、
   *  既存Responsibilityも存在する(=旧経路で既にmaterialize済み)。新しい
   *  Decision Event/Responsibilityは作らない。 */
  | { ok: false; error: "ALREADY_MATERIALIZED_BY_LEGACY"; legacyInferenceId: string; legacyDecision: string }
  /** [B4.1新設・3.3節] 対応する旧AiInferenceがREJECTED/HELD。意味を推測して
   *  Formation decisionへ自動変換しない。 */
  | { ok: false; error: "ALREADY_DECIDED_BY_LEGACY"; legacyInferenceId: string; legacyDecision: string }
  /** [B4.1新設・3.3節] 旧AiInferenceの決定値とResponsibility有無の組合せが
   *  破損している(例: ACCEPTEDなのにResponsibilityが無い)。勝手に修復しない。 */
  | { ok: false; error: "LEGACY_PROJECTION_CONFLICT"; legacyInferenceId: string; legacyDecision: string };

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
  | { ok: false; error: "CANDIDATE_ALREADY_MATERIALIZED" }
  /** [2026-08-30新設・M1-C2A] Atomicity Materialize Guard(統合正本§11.3、
   *  2026-08-30確定指示書Gate M1-C2A)。決定Revisionの最新Atomicity Assessmentが
   *  SHOULD_DECOMPOSE/CONTEXT_LIKEで、かつ本人による明示overrideが無い場合に
   *  拒否する。 */
  | { ok: false; error: "ATOMICITY_BLOCKED"; candidateId: string; assessment: string; reasonCode: string };

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
 *
 * [2026-08-30追加・M1-C] SPLIT/MERGEDも同じ理由でDOC-02 7.3節の16値には専用codeが無い
 * (想像で新codeを発明しない方針を継続)。SPLIT/MERGEDは「元候補が単独では
 * 採否対象でなくなる」という点でDEFERRED/DO_NOT_MATERIALIZEと同じ意味的近さを持つため、
 * 同じCANDIDATE_DEFERREDバケットへ丸める。正確な決定値はCandidateDecisionEvent.decision
 * (SPLIT/MERGED)に残るため、timeline表示の丸めのみで正本データは失わない。
 *
 * [R1-04是正・監査是正指示書2026-08-31] 上記のSPLIT/MERGED丸めは撤回する。
 * 「Session timeline上で分解・統合が延期として見える」ことは、DEC-STATE-001の
 * ような正本データの欠落ではないが、監査運用者がtimelineだけを見て状況を
 * 誤認する実害があるため是正した。FORMATION_EVENT_TYPESへ`CANDIDATE_SPLIT`/
 * `CANDIDATE_MERGED`を新設し(coreTypes.ts参照、CANDIDATE_DECISION_EVENT_VALUESへ
 * SPLIT/MERGEDを追加した際と同じ「実装が追いついた時点でversioned語彙を拡張する」
 * パターン)、SPLIT/MERGEDはそれぞれ専用codeへ記録する。DEFERRED/DO_NOT_MATERIALIZEは
 * 引き続きCANDIDATE_DEFERREDへ丸める(こちらは「専用codeが無い」という前提が今も
 * 真であり、丸め自体は妥当なため変更しない)。旧SPLIT/MERGED決定に対応する既存の
 * CANDIDATE_DEFERRED行は書き換えない(履歴改変しない。isValidFormationEventTypeは
 * 引き続きCANDIDATE_DEFERREDを有効値として受理するため読み取り互換を保つ)。
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
    case "SPLIT":
      return "CANDIDATE_SPLIT";
    case "MERGED":
      return "CANDIDATE_MERGED";
  }
}

/** formation_candidate_decision_events_workspace_candidate_uq(B31-04/B31-04b)。
 *  materialization_receipts_operation_uq(B31-02)・materialization_receipt_items_
 *  workspace_candidate_uq(B31-01/03)については、[B3.2是正・B32-03]により
 *  constraint名文字列ではなくDB再クエリによる値判定へ切り替えたため、
 *  ここでの名前定数は使わない(下の`isPrismaUniqueConstraintError`参照)。 */
const DECISION_EVENT_CANDIDATE_UNIQUE_CONSTRAINT = "formation_candidate_decision_events_workspace_candidate_uq";

/**
 * [B3.1新設] Prismaの一意制約違反(P2002)を、対象constraint名で判別する。
 * PrismaClientKnownRequestErrorをimportせずcode/metaを直接見るのは、
 * sandbox環境のPrisma client生成が制約される既知事情(KARKYONメモリ記載)を
 * 踏まえ、型import無しでも動く実装にするため。
 * [B3.2是正・B32-03] `materializeFormationSession`のcatchではこの関数を使わず、
 * 下の`isPrismaUniqueConstraintError`+DB再クエリによる値判定を使う
 * (constraint名文字列/column配列/欠落のいずれでも正しく動くようにするため)。
 * `recordCandidateDecision`のDecisionEvent一意制約判定はSession行lock配下の
 * 深層防御(通常到達しない)であり、このGateの対象(B32-03)ではないため据え置く。
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

/**
 * [B3.2新設・B32-03] Prismaの一意制約違反(P2002)かどうかだけを、code値のみで
 * 判別する。`isUniqueConstraintViolation`と異なり`meta.target`の中身(constraint名
 * 文字列/column配列/欠落)を一切問わない。`materializeFormationSession`のcatchでは
 * この関数でP2002である事実だけを確認したうえで、どちらの一意制約に触れたかを
 * 実際のDB状態への再クエリで値により判別する(target文字列一致より頑健)。
 */
function isPrismaUniqueConstraintError(e: unknown): boolean {
  if (typeof e !== "object" || e === null) return false;
  return (e as { code?: unknown }).code === "P2002";
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
  // [2026-08-30追加・M1-C是正] SPLIT/MERGEDはCANDIDATE_DECISION_EVENT_VALUESとしては
  // 有効だが、この汎用decide経路では受理しない。SPLITは新しい子候補群を同一
  // transaction内で作る専用service(splitCorrection.ts)を必ず経由しなければならず、
  // この経路から直接SPLITを記録できてしまうと「決定はSPLITと記録されたのに
  // 子候補が1件も作られない」という壊れた状態を作れてしまう(§11.4「同一
  // transactionで作る」という不変条件に違反する)。
  // [R1-04是正・監査是正指示書2026-08-31] 元のコメントは「MERGEDも同様(transaction
  // 本体は未実装だが、将来のMERGE serviceでも同じ理由で専用経路必須にする設計を
  // 先取りする)」としていたが、MERGE本体はmergeCorrection.tsで実装済み(2026-08-30・
  // M1-C2B)。このguardは「先取り」ではなく、実装済みのmergeCorrection.tsを必ず
  // 経由させるために現に機能している(理由はSPLITと全く同じ: この経路から直接
  // MERGEDを記録できると、新統合候補・lineage・Anchor継承が1件も作られない壊れた
  // 状態を作れてしまう)。
  if (decision === "SPLIT" || decision === "MERGED") {
    return { ok: false, error: "INVALID_DECISION_VALUE" };
  }

  try {
    return await db.$transaction(async (tx: Prisma.TransactionClient) => {
      // [B3.1是正・B31-04/B31-04b] Session行をFOR UPDATEでlockし、同一Sessionへの
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

      // [B4.1新設・3.3節] 旧新横断guard。Session行lock配下(=このtx)で、対応する
      // 旧AiInferenceの状態を確認する。legacy側が既に確定していれば、Formation側の
      // 新しいDecision Event/Responsibilityは作らない(旧新二重生成防止、B41-02)。
      const legacyMap = await resolveLegacyProjectionMap(tx, { sessionId, workspaceId });
      const legacyEntry = legacyMap?.byCandidateKey.get(identity.candidateKey) ?? null;
      if (legacyEntry) {
        if (legacyEntry.decision === "ACCEPTED" || legacyEntry.decision === "EDITED") {
          if (legacyEntry.responsibilityId) {
            return {
              ok: false,
              error: "ALREADY_MATERIALIZED_BY_LEGACY",
              legacyInferenceId: legacyEntry.inferenceId,
              legacyDecision: legacyEntry.decision,
            } as const;
          }
          // ACCEPTED/EDITEDなのにResponsibilityが見つからない = 破損。想像で
          // 修復せず、conflictとして停止する(3.3節「勝手に修復しない」)。
          return {
            ok: false,
            error: "LEGACY_PROJECTION_CONFLICT",
            legacyInferenceId: legacyEntry.inferenceId,
            legacyDecision: legacyEntry.decision,
          } as const;
        }
        if (legacyEntry.decision === "REJECTED" || legacyEntry.decision === "HELD") {
          return {
            ok: false,
            error: "ALREADY_DECIDED_BY_LEGACY",
            legacyInferenceId: legacyEntry.inferenceId,
            legacyDecision: legacyEntry.decision,
          } as const;
        }
        // legacyEntry.decision === "PENDING": Formation側の決定を許可する(3.3節)。
      }

      // Session行lock配下で直列化されているため、このSELECTは以後race無く
      // 信頼できる(以前はここが「事前SELECTのみ」でDB制約が無かった、B31-04b)。
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

      // [2026-08-30是正・M1-C2A・DEC-STATE-001] 統合正本§6.3の操作名
      // "CONFIRM_SOME"/"CONFIRM_ALL"は「確定(=Materialize)」を意味する操作であり、
      // 単なる候補の採否記録(このrecordCandidateDecision自体)ではSession状態を
      // 変更しない。以前はACCEPTED+pending混在の時点でCONFIRM_SOME遷移を
      // ここで発火していたが、これは§6.8「本人の確定要求は…Decision Event、
      // Responsibility及び種別Detail作成、…Materialization Receipt作成…を
      // 同一transactionで行う」の"確定要求"とDecision記録単体を混同していた
      // (2026-08-30確定指示書 DEC-STATE-001)。Session状態はmaterializeFormationSession
      // 内でのみ、実際にResponsibility/Receiptが作られた結果として遷移する。
      // 候補ごとの見た目(採用済み/却下済み)はCandidate Decision Projection
      // (FormationCandidateDecisionEvent自体)で表現し、Session状態とは独立させる。
      const sessionState: string = session.state;

      debugServer.event("formation/materialize", "CANDIDATE_DECISION_RECORDED", {
        sessionId,
        candidateId: identity.id,
        decision,
      });

      return { ok: true, decisionEventId: decisionEvent.id, sessionState } as const;
    });
  } catch (e: unknown) {
    // [B3.1新設・B31-04/B31-04b多層防御] Session行lockにより通常はここへ来ないが、
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
// [B4.3新設] Bulk decisions: 複数candidateへのACCEPT/REJECT等を1リクエストで処理する。
// 出典: HANDOFF_2026-08-29_B4.1_B4.2.md §4-2「Bulk ACCEPT/REJECT(監査資料B4.2
// 受入項目9)」。
//
// [設計方針・非atomicity の明示] `recordCandidateDecision`は候補1件ごとに
// Session行FOR UPDATEロックを取る独立transactionである(このファイル冒頭
// B31-04/B31-04bのコメント参照)。この関数はその1件用関数を配列分だけ順番に
// 呼び出すだけであり、複数candidateをまたぐ単一transactionには**しない**
// (全件成功/全件失敗のall-or-nothingではない)。理由は2つ:
//   1. 既存`recordCandidateDecision`のSession行lock・旧新横断guard・
//      revision楽観ロック等の不変条件(B31-01〜04b)を、bulk専用の新しい
//      transaction境界の中で再実装すると、想像に基づく再実装になり
//      「絶対ルール: 想像で修正しない」に反する。
//   2. 1件ごとに成否が独立している方が、UIが「10件中8件成功・2件は
//      revision不一致で失敗」のような部分結果を正しく提示できる
//      (bulk operationsの既存実装`executeBulkAction`(responsibilities/bulk)も
//      affected/skippedの部分成功パターンであり、本関数はこの既存方針を踏襲する)。
// 呼び出し元(bulk-decisions/route.ts)は、items内で同一candidateIdを複数回
// 指定した場合も想定内として扱う(2回目はALREADY_DECIDEDとして返る。これは
// bugではなく、1件ずつ順番に処理した結果の自然な挙動)。
// ---------------------------------------------------------------------------

export interface BulkCandidateDecisionItem {
  candidateId: string;
  expectedRevision: number;
  decision: CandidateDecisionEventValue;
  reasonCode?: string;
}

export interface BulkCandidateDecisionItemResult {
  candidateId: string;
  result: RecordCandidateDecisionResult;
}

export async function recordCandidateDecisionsBulk(params: {
  sessionId: string;
  workspaceId: string;
  actorUserId: string;
  items: BulkCandidateDecisionItem[];
}): Promise<BulkCandidateDecisionItemResult[]> {
  const results: BulkCandidateDecisionItemResult[] = [];
  for (const item of params.items) {
    const result = await recordCandidateDecision({
      sessionId: params.sessionId,
      workspaceId: params.workspaceId,
      candidateId: item.candidateId,
      expectedRevision: item.expectedRevision,
      decision: item.decision,
      reasonCode: item.reasonCode,
      actorUserId: params.actorUserId,
    });
    results.push({ candidateId: item.candidateId, result });
  }
  return results;
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

/** [B3.2新設・B32-01] commit後にembedするResponsibilityの最小入力。
 *  [B4.1新設・B31-06] actor/counterpartyを追加(旧route embedding同値性)。 */
export interface EmbedResponsibilityInput {
  responsibilityId: string;
  workspaceId: string;
  domainId: string;
  title: string;
  description?: string | null;
  actor?: string | null;
  counterparty?: string | null;
}

export interface MaterializationPostCommitDeps {
  /** [B3.2新設・B32-01] commit後のEmbedding配送を差し替え可能にする注入点。
   *  デフォルト(`productionMaterializationDeps`)は実際に外部AI Embedding APIを
   *  呼ぶ`embedAndStoreResponsibility`(本番と全く同じ挙動)。受入スクリプトだけが
   *  この一点をno-op stubへ差し替えることで、Workspace設定や環境変数
   *  (OPENAI_API_KEY等)の有無に関わらず外部AI通信を確実に0件にできる
   *  (監査「Gate M1-B3.2」B32-01)。production HTTP requestからこのdepsを
   *  選択できる入力field・headerは存在しない(server内部のtest codeだけに閉じる)。 */
  embedAndStoreResponsibility: (input: EmbedResponsibilityInput) => Promise<{ ok: boolean; reason?: string }>;
}

const productionMaterializationDeps: MaterializationPostCommitDeps = {
  embedAndStoreResponsibility,
};

export async function materializeFormationSession(
  params: MaterializeFormationSessionParams,
  deps: MaterializationPostCommitDeps = productionMaterializationDeps,
): Promise<MaterializeFormationSessionResult> {
  const { sessionId, workspaceId, operationId, expectedVersion, actorUserId } = params;
  // [B3.2新設・B32-03] Materialize transactionが実際にResponsibility化を試みた
  // candidateのidentityId一覧。tx内でP2002が発生した場合、catch側でどのcandidateが
  // 対象だったかをこの値から再確認する(tx callbackのlocal変数`acceptedTargets`は
  // catchブロックから参照できないため)。
  let attemptedCandidateIds: string[] = [];
  // [B4.1新設・B31-06 embedding同値性] post-commit embed呼出しでactor/counterparty
  // を渡すため、tx内で解決した値をcandidateId単位で外側scopeへ持ち出す
  // (txコールバックの戻り値はMaterializeFormationSessionResultに固定されている
  // ため、attemptedCandidateIdsと同じ「外側let変数へ書き込む」方式を踏襲する)。
  const actorCounterpartyByCandidateId = new Map<string, { actor: string | null; counterparty: string | null }>();
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

      // [B4.1新設・3.4節 Partial Materialize] pending count(=Formation
      // Decision Eventが1件も無い候補数)を、この時点のDB実態から再計算する。
      // recordCandidateDecisionの「acceptedとpending混在」判定と同じ定義
      // (FormationCandidateDecisionEventの有無)を踏襲する。
      const allDecisionRows = await tx.formationCandidateDecisionEvent.findMany({
        where: { workspaceId, candidateId: { in: identities.map((c: { id: string }) => c.id) } },
        select: { candidateId: true },
        distinct: ["candidateId"],
      });
      const decidedCandidateIds = new Set(allDecisionRows.map((d: { candidateId: string }) => d.candidateId));
      const pendingCount = identities.filter((c: { id: string }) => !decidedCandidateIds.has(c.id)).length;
      const acceptedMaterializedCountBefore = alreadyMaterializedCandidateIds.size;

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

      // [B4.1是正・3.4節] 新規Acceptedが0件でも、pending=0かつ過去materialized>0
      // なら「明示finalize」として0 item Receiptを許可する(旧仕様は常に
      // NO_ACCEPTED_CANDIDATESで拒否しており、B31-07の一因だった)。
      const isExplicitZeroItemFinalize = acceptedTargets.length === 0 && pendingCount === 0 && acceptedMaterializedCountBefore > 0;
      if (acceptedTargets.length === 0 && !isExplicitZeroItemFinalize) {
        return { ok: false, error: "NO_ACCEPTED_CANDIDATES" } as const;
      }
      // [B3.2新設・B32-03] 以降でP2002が起きた場合にcatch側で使うため、対象
      // candidateId一覧を外側scopeへ記録しておく。
      attemptedCandidateIds = acceptedTargets.map((t) => t.identityId);

      // [B4新設・B31-06] BLOCKS Relation解決のため、「payload上のcandidateId(AI生成の
      // 論理ID) → {今回/過去に作成済みのResponsibility.id, その候補自身の
      // blockedByCandidateIds}」を集約するmap(旧routeの「同一Capture内の他ACCEPTED/
      // EDITED候補」探索を、Session範囲へ翻訳したもの)。DBの物理IDである
      // identity.id/target.identityIdとは別物であることに注意。
      interface CandidateLinkInfo {
        responsibilityId: string;
        blockedByCandidateIds: string[];
      }
      const linkInfoByPayloadCandidateId = new Map<string, CandidateLinkInfo>();

      // 既にmaterialize済み(=別operationIdの過去commitで既にResponsibility化済み)の
      // Session内候補も、BLOCKS解決の相手候補になり得るため事前に引いておく。
      const priorReceiptItems = await tx.materializationReceiptItem.findMany({
        where: { workspaceId, candidateId: { in: identities.map((c: { id: string }) => c.id) } },
        select: { candidateId: true, candidateRevisionId: true, responsibilityId: true },
      });
      if (priorReceiptItems.length > 0) {
        const priorRevisions = await tx.formationCandidateRevision.findMany({
          where: { id: { in: priorReceiptItems.map((i) => i.candidateRevisionId) }, workspaceId },
        });
        const priorRevisionById = new Map(priorRevisions.map((r) => [r.id, r]));
        for (const priorItem of priorReceiptItems) {
          const priorRevision = priorRevisionById.get(priorItem.candidateRevisionId);
          if (!priorRevision) continue;
          const priorParsed = ResponsibilityCandidateSchema.safeParse(priorRevision.proposedFields);
          if (!priorParsed.success) continue;
          linkInfoByPayloadCandidateId.set(priorParsed.data.candidateId, {
            responsibilityId: priorItem.responsibilityId,
            blockedByCandidateIds: priorParsed.data.blockedByCandidateIds,
          });
        }
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

        // [2026-08-30新設・M1-C2A] Atomicity Materialize Guard。
        // [自己修復方針] 決定Revisionに対するAssessment行が既に存在すればそれを
        // 使う(shadowWrite.ts/answerService.ts/splitCorrection.tsは候補作成時に
        // 必ず算出・保存している)。存在しない場合(このRevisionがそれらの経路を
        // 経ずに作られた古いデータ等)は、想像で「未評価だから素通し」にはせず、
        // その場でassessAtomicity()を算出し、監査証跡として保存してから判定に
        // 使う(未評価を「解決済み」とみなさない、という確定指示書の要求に対応)。
        let assessmentRow = await tx.formationAtomicityAssessment.findFirst({
          where: { revisionId: revision.id, workspaceId },
        });
        if (!assessmentRow) {
          const computed = assessAtomicity(candidate);
          assessmentRow = await tx.formationAtomicityAssessment.create({
            data: {
              workspaceId,
              revisionId: revision.id,
              assessment: computed.assessment,
              reasonCode: computed.reasonCode,
              evidence: computed.evidence as unknown as object,
              confidence: computed.confidence,
              algorithmVersion: computed.algorithmVersion,
            },
          });
        }

        if (assessmentRow.assessment === "SHOULD_DECOMPOSE" || assessmentRow.assessment === "CONTEXT_LIKE") {
          // [確定指示書Gate M1-C2A] 「本人の明示override Eventが無い限り拒否」。
          // Split/Merge/Editで解決した場合、その結果生まれる新Revision自体が
          // 別途assessAtomicityで再評価され(shadowWrite.ts/answerService.ts/
          // splitCorrection.tsと同じ経路)、多くの場合ATOMIC/PROBABLY_ATOMICへ
          // 変わるため、ここではoverride行の有無だけを機械的に確認すればよい
          // (「Split/Merge/Editで解決した」という事実そのものは、解決後の
          // 新しいRevisionのAssessmentが変わることで自動的に反映される)。
          const override = await tx.formationAtomicityOverride.findFirst({
            where: { revisionId: revision.id, workspaceId },
          });
          if (!override) {
            throw new MaterializeAbort({
              ok: false,
              error: "ATOMICITY_BLOCKED",
              candidateId: target.identityId,
              assessment: assessmentRow.assessment,
              reasonCode: assessmentRow.reasonCode,
            });
          }
        } else if (assessmentRow.assessment === "NEEDS_CLARIFICATION") {
          // [確定指示書Gate M1-C2A] 「未解決質問がある限り拒否」。Session状態が
          // REVIEW_READY/PARTIALLY_CONFIRMEDへ到達している時点で、そのSession内の
          // FormationQuestionは設計上すべて回答済みのはずだが(CLARIFYING状態を
          // 経由しないとREVIEW_READYへ進めないため)、想像でこの前提を信頼せず、
          // 実データを見て機械的に確認する。
          const questionsForCandidate = await tx.formationQuestion.findMany({
            where: { workspaceId, candidateId: target.identityId },
            select: { id: true },
          });
          if (questionsForCandidate.length > 0) {
            const answeredQuestionIds = new Set(
              (
                await tx.formationAnswerEvent.findMany({
                  where: { workspaceId, questionId: { in: questionsForCandidate.map((q) => q.id) } },
                  select: { questionId: true },
                  distinct: ["questionId"],
                })
              ).map((a) => a.questionId),
            );
            const hasUnresolvedQuestion = questionsForCandidate.some((q) => !answeredQuestionIds.has(q.id));
            if (hasUnresolvedQuestion) {
              throw new MaterializeAbort({
                ok: false,
                error: "ATOMICITY_BLOCKED",
                candidateId: target.identityId,
                assessment: assessmentRow.assessment,
                reasonCode: assessmentRow.reasonCode,
              });
            }
          }
          // 未解決質問が無ければ(このSessionの設計上は通常このケース)、
          // NEEDS_CLARIFICATIONのままでもMaterializeを許可する(確定指示書の
          // 文言どおり「未解決質問がある限り拒否」の裏返し)。
        }
        // ATOMIC/PROBABLY_ATOMICは常に許可。

        const hardDeadlineAt = candidate.dateMentions.find((d) => d.meaning === "HARD_DEADLINE")?.normalizedAt;
        const targetAt = candidate.dateMentions.find((d) => d.meaning === "SOFT_TARGET")?.normalizedAt;

        // [B4新設・B31-06] 順方向: この候補がblockedByCandidateIdsとして指定した
        // 相手が、既に(今回のtx内 or 過去のcommitで)Responsibility化済みであれば
        // そのIDを集める。旧routeの「同一Capture内の他ACCEPTED/EDITED候補」探索を
        // 「同一FormationSession内の他候補」探索へ翻訳したもの。
        const blockedByResponsibilityIds = candidate.blockedByCandidateIds
          .map((cid) => linkInfoByPayloadCandidateId.get(cid)?.responsibilityId)
          .filter((v): v is string => typeof v === "string");

        const created = await createResponsibilityWithLinks(tx, {
          workspaceId,
          domainId: session.domainId,
          originCaptureId: session.captureId,
          type: revision.type,
          title: revision.title,
          description: revision.description ?? null,
          importance: candidate.importance ?? null,
          confidence: revision.confidence,
          hardDeadlineAt: hardDeadlineAt ? new Date(hardDeadlineAt) : null,
          targetAt: targetAt ? new Date(targetAt) : null,
          actorUserId,
          suggestedTags: candidate.suggestedTags,
          // [B4.1是正・B41-01] Formation起源はrecordCandidateDecisionで
          // ACCEPTEDの候補だけがacceptedTargetsへ入るため、常にACCEPTED。
          decisionValue: "ACCEPTED",
          actor: candidate.actor ?? null,
          counterparty: candidate.counterparty ?? null,
          provenance: { kind: "FORMATION_CANDIDATE", sessionId, candidateIdentityId: target.identityId },
          blockedByResponsibilityIds,
          // 逆方向(自分が後発ブロック元になるケース)は、下の逐次スキャンで
          // まとめて解決する(旧routeの「逆方向: 既に採用済みの他候補が...」
          // ループと同義。createResponsibilityWithLinks自体はこの時点で自分より
          // 後に処理される候補の存在を知り得ないため、ここでは常に空で呼ぶ)。
          blocksResponsibilityIds: [],
        });

        // [B4新設・B31-06] 逆方向: 既にResponsibility化済みの他候補(今回のtx内で
        // 先に処理したものを含む)が、この候補(今作成したResponsibility)を
        // blockedByCandidateIdsに含めていた場合、ここで解決する。
        for (const [otherPayloadId, otherInfo] of linkInfoByPayloadCandidateId) {
          if (otherPayloadId === candidate.candidateId) continue;
          if (!otherInfo.blockedByCandidateIds.includes(candidate.candidateId)) continue;
          await tx.responsibilityRelation.create({
            data: {
              fromId: created.id,
              toId: otherInfo.responsibilityId,
              relationType: "BLOCKS",
              status: "CONFIRMED",
              sourceKind: "AI",
              confirmedById: actorUserId,
              confirmedAt: new Date(),
            },
          });
        }

        linkInfoByPayloadCandidateId.set(candidate.candidateId, {
          responsibilityId: created.id,
          blockedByCandidateIds: candidate.blockedByCandidateIds,
        });
        actorCounterpartyByCandidateId.set(target.identityId, {
          actor: candidate.actor ?? null,
          counterparty: candidate.counterparty ?? null,
        });

        // [B3.1] ここでのINSERT失敗(P2002、materialization_receipt_items_
        // workspace_candidate_uq)は、異operationIdの並行実行が同じcandidateを
        // 先にmaterializeしていたことを意味する(B31-01/B31-03)。この時点までに
        // 積んだResponsibility/EventLog/Outbox/Receipt作成は、transaction全体が
        // catchブロックへ抜けることでDBにより自動rollbackされる(孤立行は残らない)。
        items.push({
          candidateId: target.identityId,
          candidateRevisionId: revision.id,
          responsibilityId: created.id,
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

      // [B4.1是正・3.4節 Partial Materialize] pendingCountは新規決定を作らない
      // materializeでは変化しない(recordCandidateDecisionだけがDecision Eventを
      // 作る)。処理後にpending>0なら、SessionはPARTIALLY_CONFIRMEDを維持する
      // (MATERIALIZATION_COMMITTEDは記録するがSESSION_CONFIRMEDは記録しない)。
      // pending=0なら、今回または過去のACCEPTED実績(items.length>0または
      // acceptedMaterializedCountBefore>0)をもってCONFIRMEDへ進める。
      // 全候補が非ACCEPTEDでmaterialized実績も無い場合はこのtx冒頭の
      // NO_ACCEPTED_CANDIDATESで既に弾かれているため、ここへは到達しない。
      let sessionState: string;
      if (pendingCount > 0) {
        if (session.state === "REVIEW_READY") {
          // [2026-08-30是正] 操作名をDOC-03語彙"PARTIAL_DECISIONS"から統合正本§6.3語彙
          // "CONFIRM_SOME"へ置換。
          const toPartial = resolveFormationSessionTransition("REVIEW_READY", "CONFIRM_SOME");
          if (!toPartial) {
            throw new Error("coreTypes不整合: REVIEW_READY--CONFIRM_SOME-->の遷移が定義されていません");
          }
          await tx.formationSession.update({
            where: { id: sessionId },
            data: { state: toPartial, version: { increment: 1 } },
          });
          sessionState = toPartial;
        } else {
          // 既にPARTIALLY_CONFIRMED。stateは変えないがversionは他の更新操作と
          // 同様に前進させる(optimistic lock一貫性のため)。
          await tx.formationSession.update({
            where: { id: sessionId },
            data: { version: { increment: 1 } },
          });
          sessionState = session.state;
        }
        debugServer.event("formation/materialize", "MATERIALIZATION_COMMITTED", {
          sessionId,
          operationId,
          receiptId: receipt.id,
          itemCount: items.length,
          sessionState,
          pendingCount,
        });
        return { ok: true, receiptId: receipt.id, operationId, items, replay: false } as const;
      }

      // pendingCount === 0: REVIEW_READY/PARTIALLY_CONFIRMED --confirm--> CONFIRMED
      // (統合正本§6.3)。[2026-08-30更新・M1-C2A是正] Atomicity Assessmentは
      // 上のacceptedTargetsループ内(Guard)で候補ごとに検査済みであり、ここへ
      // 到達している時点で全acceptedTargetsはATOMIC/PROBABLY_ATOMIC、または
      // override済み、または未解決質問の無いNEEDS_CLARIFICATIONのいずれかで
      // ある(guard未通過ならMaterializeAbortで既にtransaction全体が中断している)。
      // [2026-08-30是正] DOC-03語彙の単一操作"COMMIT"は統合正本§6.3には存在しない。
      // REVIEW_READY起点は"CONFIRM_ALL"(単一終端、resolveFormationSessionTransitionで
      // 解決可能)、PARTIALLY_CONFIRMED起点は"RESOLVE_REMAINING"(CONFIRMED/DISMISSEDの
      // 多終端操作)であり、このMaterialize経路は常にCONFIRMED行きなので
      // isValidFormationSessionTransitionTripleで(from, RESOLVE_REMAINING, CONFIRMED)が
      // 表に実在することだけを検証する。
      let toConfirmed: string | undefined;
      if (session.state === "REVIEW_READY") {
        toConfirmed = resolveFormationSessionTransition("REVIEW_READY", "CONFIRM_ALL");
      } else if (session.state === "PARTIALLY_CONFIRMED") {
        toConfirmed = isValidFormationSessionTransitionTriple("PARTIALLY_CONFIRMED", "RESOLVE_REMAINING", "CONFIRMED")
          ? "CONFIRMED"
          : undefined;
      }
      if (!toConfirmed) {
        throw new Error("coreTypes不整合: " + session.state + "からCONFIRMEDへの遷移が定義されていません");
      }
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
        sessionState: toConfirmed,
        pendingCount,
      });

      return { ok: true, receiptId: receipt.id, operationId, items, replay: false } as const;
    });
  } catch (e: unknown) {
    if (e instanceof MaterializeAbort) {
      txResult = e.result;
    } else if (isPrismaUniqueConstraintError(e)) {
      // [B3.2是正・B32-03] P2002の判別をconstraint名文字列一致からDB再クエリに
      // よる値判定へ変更した(meta.targetがconstraint名/column配列/欠落のいずれで
      // 返る環境でも正しく動く)。
      //
      // 1. まず(workspaceId,operationId)でReceiptを再取得する。見つかれば
      //    materialization_receipts_operation_uq(B31-02)に触れたということ。
      //    hash一致ならreplay、不一致ならIDEMPOTENCY_KEY_REUSED。
      //    [B32-03新設] 同一Session内はSession行lockで直列化されるため、この
      //    catchへ到達するのは実質cross-session(異なるFormationSession、
      //    したがってSession行lockが直接効かない)同一operationId競合の場合のみ
      //    (同一Session・同一operationIdの並行実行は、tx冒頭のlock獲得後の
      //    `existingReceiptInTx`再確認で先にreplay判定されるため、通常この
      //    catchまで来ない)。
      const winner = await db.materializationReceipt.findFirst({
        where: { workspaceId, operationId },
        include: { items: true },
      });
      if (winner) {
        txResult = winner.requestHash === requestHash ? toReplayResult(winner) : { ok: false, error: "IDEMPOTENCY_KEY_REUSED" };
      } else {
        // 2. Receiptが見つからない場合のみ、今回のtransactionが対象にしていた
        //    candidateについてglobal ReceiptItem(materialization_receipt_items_
        //    workspace_candidate_uq、B31-01/03)を再確認する。同一Session内は
        //    Session行lockで直列化されるため、通常はここへも到達しない
        //    (先行transactionがcommit済みなら、後続transactionはtx冒頭の
        //    `alreadyMaterializedCandidateIds`フィルタで対象候補自体を除外し、
        //    P2002ではなくNO_ACCEPTED_CANDIDATESという別経路になる)。到達する
        //    のはcross-sessionで同一candidateを異なるSessionが同時に対象にする
        //    ような、さらに稀なraceのみ。
        const clash =
          attemptedCandidateIds.length > 0
            ? await db.materializationReceiptItem.findFirst({
                where: { workspaceId, candidateId: { in: attemptedCandidateIds } },
              })
            : null;
        if (clash) {
          txResult = { ok: false, error: "CANDIDATE_ALREADY_MATERIALIZED" };
        } else {
          // 3. どちらの値判定にも該当しない場合は、このMaterialize処理とは
          //    無関係な一意制約違反(別バグ・別テーブル等)である可能性が高い。
          //    誤って握りつぶさず、元の例外をそのまま再throwする。
          throw e;
        }
      }
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
      // [B4.1是正・B31-06 embedding同値性] 旧routeはEmbedding生成時にactor/
      // counterpartyを渡すが、Formation側は従来渡していなかった(監査
      // 「Gate M1-B4.1」項目3.1.5)。tx内で解決済みの値をcandidateId経由で渡す。
      const actorCounterparty = actorCounterpartyByCandidateId.get(item.candidateId);
      await deps.embedAndStoreResponsibility({
        responsibilityId: responsibility.id,
        workspaceId: responsibility.workspaceId,
        domainId: responsibility.domainId,
        title: responsibility.title,
        description: responsibility.description,
        actor: actorCounterparty?.actor ?? null,
        counterparty: actorCounterparty?.counterparty ?? null,
      }).catch((err: unknown) => {
        debugServer.error("formation/materialize", "embedAndStoreResponsibility例外", err);
      });
    }
  }

  return txResult;
}
