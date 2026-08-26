import { randomUUID, createHash } from "node:crypto";
import type { Prisma } from "@/generated/prisma/client";
import { db } from "@/lib/db";
import { debugServer } from "@/lib/debugServer";
import { transitionsForType, isTypeSpecificTerminalStatus, completeActionFor } from "@/lib/responsibility";
import { buildPemAuthorizationContext } from "@/lib/pem/authorizationBoundary";
import { recordExecutionLedgerEvent } from "@/lib/pem/executionLedger";
import { projectAndPersistExecutionSessions } from "@/lib/pem/sessionPersistence";
import { isExecutionLedgerApplicableType } from "@/lib/pem/eventDefinitionRegistry";
import {
  buildCompleteUndoIdempotencyKey,
  buildCompleteUndoRequestPayloadHash,
  decideCompleteUndoAction,
  decideCompleteUndoNextStatus,
  dedupeSnapshotById,
  isCompleteEventStale,
  validateCompleteUndoTarget,
  IdempotencyKeyReusedError,
  InvalidUndoSnapshotError,
} from "@/lib/bulkCompleteUndoDecision";

// [2026-08-25是正・db非依存テストとの分離] 実際の判定ロジック(純粋関数、
// db.ts非依存)はbulkCompleteUndoDecision.tsへ移した。呼び出し元
// (bulk/undo/route.ts、テストコード)のimport経路の互換性のため、ここから再exportする。
export {
  buildCompleteUndoIdempotencyKey,
  buildCompleteUndoRequestPayloadHash,
  IdempotencyKeyReusedError,
  InvalidUndoSnapshotError,
};

/**
 * FN-WK-04 一括操作(2026-08-23新設)。
 * 出典: Webシステム要件定義書v2.1 FR-WK-09「一括操作を提供する。対象件数と影響を確認し、
 * 誤操作を取り消せる」、システム基本設計書v1.2 API-RESP-06。
 *
 * [設計判断・2026-08-23] 「誤操作を取り消せる」をUndo専用テーブル無しで実現するため、
 * 各アクションの実行結果に「元に戻すための最小限の情報」を含めて返す
 * (ステートレスUndo)。フロントはその情報をそのままPOST /bulk/undoへ渡すだけでよい。
 *
 * [スコープ・2026-08-23] 今回実装するアクションはCOMPLETE/DELETE/ADD_TAG/REMOVE_TAGの
 * 4つ。DomainのSET_DOMAIN一括変更は、既存UI(ResponsibilitiesClient)にドメイン選択の
 * 導線が無く新規に追加するとスコープが大きく膨らむため、今回は見送る
 * (想像で新しいドメイン選択UIを作り込まない)。
 *
 * COMPLETEはDECISIONのみ対象外とする。DECISIONの完了(DECIDE)はreason(決定理由)の
 * 個別入力が要件上必須(Webシステム要件定義書v2.1 7.1節)であり、一括操作で理由を
 * 一律に付与するのは実質的な理由の形骸化を招くため、安全側に倒して除外する。
 */

export type BulkAction = "COMPLETE" | "DELETE" | "ADD_TAG" | "REMOVE_TAG";

export interface BulkSkip {
  id: string;
  reason: string;
}

export interface CompleteUndoPayload {
  action: "COMPLETE";
  snapshot: {
    id: string;
    status: string;
    completedAt: string | null;
    /** [2026-08-25新設・外部監査P1-1是正] このBulk Complete操作でExecution
     * Ledgerへ実際に記録されたCOMPLETE Eventのid(Execution Ledger対象外型、または
     * PEM同意未取得等でLedgerへ記録できなかった場合はnull)。
     * 従来Undoは「対象責任の最新COMPLETE Event」をDBから再検索していたため、
     * Bulk Complete後からUndoまでの間に別のREOPEN/COMPLETEが発生していると、
     * このBulk Complete操作とは無関係の別Eventを誤ってREVOKEする恐れがあった。
     * このidをUndo要求へ固定して持ち回ることで、取消対象を一意に特定する。 */
    completeEventId: string | null | undefined;
  }[];
}
export interface DeleteUndoPayload {
  action: "DELETE";
  ids: string[];
}
export interface TagUndoPayload {
  action: "ADD_TAG" | "REMOVE_TAG";
  ids: string[];
  tagId: string;
}
export type UndoPayload = CompleteUndoPayload | DeleteUndoPayload | TagUndoPayload;

export interface BulkResult {
  affected: number;
  skipped: BulkSkip[];
  undo: UndoPayload | null;
}

interface TargetRow {
  id: string;
  type: string;
  status: string;
  completedAt: Date | null;
  deletedAt: Date | null;
  /// [2026-08-25追加・Completion Gate 2] Execution Ledgerのversion整合に必要。
  version: number;
}

/** workspaceIdスコープで対象を取得する(IDOR対策。他Workspaceのidが混ざっていても無視される)。 */
async function fetchTargets(ids: string[], workspaceId: string): Promise<TargetRow[]> {
  return db.responsibility.findMany({
    where: { id: { in: ids }, workspaceId },
    select: { id: true, type: true, status: true, completedAt: true, deletedAt: true, version: true },
  });
}

/**
 * [2026-08-26移設] completeActionForはresponsibility.tsへ移設した
 * (completeFromStatusesForTypeからも使うため、db非依存の語彙を集約する
 * responsibility.ts側で一元管理する)。
 */

async function bulkComplete(ids: string[], workspaceId: string, userId: string): Promise<BulkResult> {
  const targets = await fetchTargets(ids, workspaceId);
  const skipped: BulkSkip[] = [];
  const snapshot: CompleteUndoPayload["snapshot"] = [];
  const now = new Date();
  // [2026-08-25追加・Completion Gate 2、外部監査「Transition以外の状態変更経路の
  // 棚卸し」対応] 単一アイテムのtransitions/route.tsと同じくExecution Ledgerへ
  // 記録する。requestId/requestPayloadHashはバッチ全体で1つ発行する(バルク操作は
  // 1回のクライアント要求が複数Responsibilityへ及ぶため)。
  const pemCtx = await buildPemAuthorizationContext(userId, userId);
  const bulkRequestId = randomUUID();
  const bulkRequestPayloadHash = createHash("sha256")
    .update(JSON.stringify({ action: "BULK_COMPLETE", ids }))
    .digest("hex");
  // [2026-08-25新設・外部監査P1-1是正] tx内クロージャからtx外のsnapshot.pushへ
  // ledgerResult.idを持ち出すための一時マップ(1 responsibilityId = 1 completeEventId)。
  const completeEventIdByTargetId = new Map<string, string | null>();

  for (const t of targets) {
    if (t.deletedAt) {
      skipped.push({ id: t.id, reason: "削除済みのため対象外" });
      continue;
    }
    if (isTypeSpecificTerminalStatus(t.type, t.status) || t.status === "COMPLETED") {
      skipped.push({ id: t.id, reason: "既に完了状態のため対象外" });
      continue;
    }
    if (t.type === "DECISION") {
      skipped.push({ id: t.id, reason: "判断は理由の記録が必須のため一括完了できません(個別に操作してください)" });
      continue;
    }
    const completeAction = completeActionFor(t.type);
    const rule = transitionsForType(t.type).find(
      (r) => r.action === completeAction && (r.from as readonly string[]).includes(t.status),
    );
    if (!rule) {
      skipped.push({ id: t.id, reason: "現在の状態からは一括完了できません(個別に操作してください)" });
      continue;
    }
    const nextStatus = typeof rule.to === "function" ? rule.to(t.status) : rule.to;
    // [2026-08-25改訂] 個別更新の羅列(部分失敗の余地あり)からトランザクションへ変更。
    // Execution Ledger記録がRegistry不整合等で例外を投げた場合、このResponsibility
    // 1件分のstatus変更・EventLog・Ledger記録が全てrollbackされる(他のidには影響しない)。
    await db.$transaction(async (tx: Prisma.TransactionClient) => {
      await tx.responsibility.update({
        where: { id: t.id },
        data: { status: nextStatus, completedAt: now, updatedById: userId, version: { increment: 1 } },
      });
      await tx.eventLog.create({
        data: {
          aggregateType: "Responsibility",
          aggregateId: t.id,
          eventType: "STATUS_CHANGED",
          beforeJson: { status: t.status },
          afterJson: { status: nextStatus, bulk: true },
          actorType: "USER",
          actorId: userId,
          reason: "一括操作による完了",
        },
      });
      const ledgerResult = await recordExecutionLedgerEvent({
        tx,
        ctx: pemCtx,
        responsibilityId: t.id,
        responsibilityType: t.type,
        action: completeAction,
        fromState: t.status,
        toState: nextStatus,
        versionBefore: t.version,
        versionAfter: t.version + 1,
        clientOccurredAt: now,
        actorType: "USER",
        source: "WEB",
        requestId: bulkRequestId,
        requestPayloadHash: bulkRequestPayloadHash,
      });
      if (ledgerResult) {
        await projectAndPersistExecutionSessions(tx, pemCtx, t.id);
      }
      // [2026-08-25新設・外部監査P1-1是正] このBulk Complete操作で実際に記録された
      // COMPLETE Eventのidをsnapshotへ含める(Undo時の取消対象固定に使う)。
      completeEventIdByTargetId.set(t.id, ledgerResult?.id ?? null);
    });
    snapshot.push({
      id: t.id,
      status: t.status,
      completedAt: t.completedAt?.toISOString() ?? null,
      completeEventId: completeEventIdByTargetId.get(t.id) ?? null,
    });
  }

  debugServer.event("bulkOperations/COMPLETE", "一括完了", { affected: snapshot.length, skipped: skipped.length });
  return {
    affected: snapshot.length,
    skipped,
    undo: snapshot.length > 0 ? { action: "COMPLETE", snapshot } : null,
  };
}

async function bulkDelete(ids: string[], workspaceId: string): Promise<BulkResult> {
  const targets = await fetchTargets(ids, workspaceId);
  const skipped: BulkSkip[] = [];
  const affectedIds: string[] = [];
  const now = new Date();

  for (const t of targets) {
    if (t.deletedAt) {
      skipped.push({ id: t.id, reason: "既に削除済み" });
      continue;
    }
    affectedIds.push(t.id);
  }
  if (affectedIds.length > 0) {
    await db.responsibility.updateMany({ where: { id: { in: affectedIds } }, data: { deletedAt: now } });
  }

  debugServer.event("bulkOperations/DELETE", "一括削除", { affected: affectedIds.length, skipped: skipped.length });
  return {
    affected: affectedIds.length,
    skipped,
    undo: affectedIds.length > 0 ? { action: "DELETE", ids: affectedIds } : null,
  };
}

async function bulkRestore(ids: string[]): Promise<void> {
  if (ids.length === 0) return;
  await db.responsibility.updateMany({ where: { id: { in: ids } }, data: { deletedAt: null } });
}

async function bulkTag(
  action: "ADD_TAG" | "REMOVE_TAG",
  ids: string[],
  workspaceId: string,
  tagId: string,
): Promise<BulkResult> {
  const tag = await db.tag.findFirst({ where: { id: tagId, workspaceId, deletedAt: null }, select: { id: true } });
  if (!tag) {
    return { affected: 0, skipped: ids.map((id) => ({ id, reason: "指定されたタグが見つかりません" })), undo: null };
  }

  const targets = await fetchTargets(ids, workspaceId);
  const existingLinks = await db.responsibilityTag.findMany({
    where: { responsibilityId: { in: targets.map((t) => t.id) }, tagId },
    select: { responsibilityId: true },
  });
  const linkedIds = new Set(existingLinks.map((l: { responsibilityId: string }) => l.responsibilityId));

  const skipped: BulkSkip[] = [];
  const affectedIds: string[] = [];

  if (action === "ADD_TAG") {
    for (const t of targets) {
      if (linkedIds.has(t.id)) {
        skipped.push({ id: t.id, reason: "既にこのタグが付与されています" });
        continue;
      }
      affectedIds.push(t.id);
    }
    if (affectedIds.length > 0) {
      await db.responsibilityTag.createMany({
        data: affectedIds.map((id) => ({ responsibilityId: id, tagId })),
        skipDuplicates: true,
      });
    }
  } else {
    for (const t of targets) {
      if (!linkedIds.has(t.id)) {
        skipped.push({ id: t.id, reason: "このタグは付与されていません" });
        continue;
      }
      affectedIds.push(t.id);
    }
    if (affectedIds.length > 0) {
      await db.responsibilityTag.deleteMany({ where: { responsibilityId: { in: affectedIds }, tagId } });
    }
  }

  debugServer.event(`bulkOperations/${action}`, "タグ一括操作", { affected: affectedIds.length, skipped: skipped.length });
  return {
    affected: affectedIds.length,
    skipped,
    undo: affectedIds.length > 0 ? { action, ids: affectedIds, tagId } : null,
  };
}

export async function executeBulkAction(params: {
  action: BulkAction;
  ids: string[];
  workspaceId: string;
  userId: string;
  tagId?: string;
}): Promise<BulkResult> {
  const { action, ids, workspaceId, userId, tagId } = params;
  switch (action) {
    case "COMPLETE":
      return bulkComplete(ids, workspaceId, userId);
    case "DELETE":
      return bulkDelete(ids, workspaceId);
    case "ADD_TAG":
    case "REMOVE_TAG":
      if (!tagId) return { affected: 0, skipped: ids.map((id) => ({ id, reason: "tagIdが必要です" })), undo: null };
      return bulkTag(action, ids, workspaceId, tagId);
  }
}

/**
 * [2026-08-25新設・Completion Gate 2.1、v4.0 8.1節「Correction」是正]
 * 従来はスナップショットの任意のstatusへ直接書き戻すだけで、Execution Ledgerの正本
 * (ResponsibilityExecutionEvent)には一切触れない「無音の改変」だった。これは
 * v4.0 8.1節が要求する「元Evidenceを更新せず、Correction Eventを追記する」に反する。
 *
 * 是正方針(想像で新しい語彙を発明しない):
 *  - Execution Ledger対象型(TASK/EVENT/CONCERN/HABIT/IDEA)かつ、取消対象のCOMPLETE
 *    Eventが実際にExecution Ledger上に見つかる場合のみ、既存のREOPEN語彙
 *    (Registry固定: COMPLETED/NOT_NEEDED→PLANNED)をそのまま再利用してExecution
 *    Ledgerへ記録する。「元のstatusへ戻す」という従来の挙動は、単一アイテムの
 *    REOPENアクション(常にPLANNEDへ戻り、元のstatusは復元しない)と挙動を揃える形で
 *    置き換える。
 *  - 上記に該当しない場合(COMMITMENT/WAITING/RISK等のExecution Ledger対象外型、
 *    または対象イベントが見つからない場合)は、従来通りスナップショットのstatusへ
 *    直接復元する(Execution Ledgerに対応語彙が無いため、これ以上の対応はしない)。
 *  - ResponsibilityLifecycleEventが記録されるのは、訂正対象の元COMPLETE Eventを
 *    実際に特定できた場合のみ(「いずれの場合も必ず記録する」わけではない)。
 *
 * 冪等性の判定はbulkCompleteUndoDecision.tsのdecideCompleteUndoActionへ分離済み
 * (既存Lifecycle Eventの有無を必ず現在statusの検査より先に確認する。理由は
 * decideCompleteUndoActionのコメントを参照)。
 *
 * [2026-08-25是正・外部監査(内部レビュー)P1対応、4点]
 *
 * P1-1(取消対象のCOMPLETE EventがUndoトークンに固定されていない):
 *   従来は「対象責任の最新COMPLETE Event」をDBから毎回再検索していたため、
 *   Bulk Complete後からUndoまでの間に別のREOPEN/COMPLETEが発生していると、
 *   このBulk Complete操作とは無関係の別Eventを誤ってREVOKEする恐れがあった。
 *   是正: bulkComplete側でsnapshotへcompleteEventIdを固定して持ち回り、Undoは
 *   再検索せずこのidを直接検証(workspaceId/responsibilityId/eventType一致)して使う。
 *   古い形式のsnapshot(completeEventId未設定)を受け取った場合は、安全側に倒して
 *   「対象イベント無し」として扱う(=Execution Ledger対象外型と同じ単純復元のみ。
 *   不確かなIDで別Eventを推測してREVOKEするより安全)。
 *
 * P1-2(バッチUndoが全体トランザクションではない):
 *   従来は各Responsibilityを別々のトランザクションで処理しており、2件目以降で
 *   IdempotencyKeyReusedErrorが発生すると「前半はUndo済み・API全体は409」という
 *   部分適用になり得た。是正: バッチ全体を1つのdb.$transactionで包む
 *   (どこかでエラーが投げられれば、そのバッチ全体がロールバックされる)。
 *
 * P1-3(重複IDでrestored件数が水増しされる):
 *   snapshot内に同一idが複数含まれる場合、2件目以降が「同一key・同一payloadの
 *   冪等再送」として扱われrestoredへ二重加算され得た。是正: 処理前にid単位で
 *   重複排除する(先勝ち)。
 *
 * P1-4(Undoの状態変更がEventLog/Outboxへ記録されない):
 *   bulkComplete本体はEventLog(STATUS_CHANGED)を記録するが、Undo側は
 *   Responsibility/Execution Ledger/Lifecycle Eventのみで、Execution Ledger対象外型や
 *   PEM未同意の場合は外部イベント上「無音の状態変更」になっていた。是正:
 *   実際にstatusを書き換えた場合は必ず、bulkComplete・単一アイテムの
 *   transitions/route.tsと同じ形でEventLog(STATUS_CHANGED)と
 *   OutboxEvent(ResponsibilityTransitioned.v1)を同一トランザクションで記録する。
 *
 * P1-5(種別固有型の復元statusがクライアント任せ):
 *   COMMITMENT等のExecution Ledger対象外型は、クライアントが返してきた
 *   snapshot.statusを無検証で直接DBへ書き戻していた。是正: 書き込み前に
 *   isValidStatusForType(その型で定義済みの状態値集合)で検証し、不正な値を
 *   含むリクエストはバッチ全体を拒否する(部分適用や不正状態のDB混入を防ぐため、
 *   処理開始前の事前検証とする)。
 *
 * [要仕様確認事項・現時点の暫定判断とその理由]
 *   originalCompleteEventが見つかっても、Undo時点でPEM同意が撤回されていると
 *   recordExecutionLedgerEvent()はnullを返し得る(REOPEN Eventを記録できない)。
 *   この場合、「REOPEN+REVOKEを必ず一組にする」か「同意撤回後はREVOKE単独を
 *   許可する」かの製品判断が必要(外部監査で指摘済み、正式な仕様書には未記載)。
 *   本実装は後者(REVOKE単独を許可)を暫定採用する。理由: 前者を採用しPEM同意
 *   撤回時にUndo自体を拒否すると、ユーザーは自分の一括完了操作を取り消す手段を
 *   失い、Responsibilityが誤った完了状態のまま固定されてしまう
 *   (PEM機能への同意はいつでも撤回できるべきだが、それによってコア機能である
 *   Undoが使えなくなるのは本末転倒)。resultingEventIdがnullのままの
 *   ResponsibilityLifecycleEvent(kind=CORRECTION, correctionType=REVOKE)が
 *   記録されるが、これは「Correctionは発生したが、対応するExecution Ledger
 *   Eventの記録はPEM未同意のためスキップされた」という事実を正確に表しており、
 *   Execution Ledger自体が同意任意でスキップされる既存方針(recordExecutionLedgerEvent
 *   のコメント参照)と整合する。正式な製品判断が下れば、ここを起点に変更する。
 */

async function executeCompleteUndo(
  payload: CompleteUndoPayload,
  workspaceId: string,
  userId: string,
): Promise<{ restored: number }> {
  // [P1-3是正] 重複id除去は、DBアクセスより前に行う。
  const snapshot = dedupeSnapshotById(payload.snapshot);
  const ids = snapshot.map((s) => s.id);
  const targets = await fetchTargets(ids, workspaceId);
  const targetById = new Map(targets.map((t) => [t.id, t]));

  // [2026-08-26是正・実行時に発見した順序バグ] statusの妥当性検証(旧:ここで
  // バッチ全体を事前検証していた)は、APPLY分岐(真に新規の取消要求)でのみ行う
  // よう移動した(isCompleteEventStaleと同じ理由。詳細はvalidateCompleteUndoTarget
  // のコメントを参照)。ループ内でt.typeを直接使うため、ここでの事前算出は不要。

  const pemCtx = await buildPemAuthorizationContext(userId, userId);

  // [P1-2是正、外部監査再評価「200件バッチのtransaction timeoutリスク」対応]
  // バッチ全体を1つのトランザクションに統一する。途中でエラーが投げられれば
  // (IdempotencyKeyReusedError等)、バッチ全体がロールバックされ、「前半だけ
  // Undo済み」という部分適用が起こらない。要求数が多いとPrismaの既定interactive
  // transactionタイムアウト(5秒)に達する恐れがあるため、30秒へ緩和する応急対応も
  // 行う。200件規模での実測(所要時間・タイムアウト有無)はまだ実施できていない
  // 既知の残課題であり、omega-dev2上での実測が必要(想像で「これで十分」と断定しない)。
  const restored = await db.$transaction(
    async (tx: Prisma.TransactionClient) => {
    let count = 0;
    for (const s of snapshot) {
      const t = targetById.get(s.id);
      if (!t) continue; // 対象が存在しない(他Workspace混入等。fetchTargetsで既に除外済み)

      // [外部監査再評価・Gate阻害是正] 「最新のCOMPLETE Eventを検索する」のではなく、
      // bulkComplete時に固定されたcompleteEventIdを検証して使う。
      //
      // completeEventIdが明示的に指定されている場合は、それが実在し・このresponsibility・
      // このworkspace・このuserId(subjectUserId)に一致することを要求する(以前は
      // workspaceId/responsibilityId/eventTypeのみの緩い一致だった)。一致しなければ
      // 「対象イベント無し」として静かに単純復元へ倒すのではなく、
      // InvalidUndoSnapshotErrorでバッチ全体を拒否する(値の不整合を握り潰さない)。
      //
      // completeEventId自体が未指定(旧形式クライアント等)の場合のみ、
      // 「対象イベント無し」の後方互換パスとして扱う(originalCompleteEvent=null)。
      //
      // [2026-08-26是正・実行時に発見した不具合]
      // 当初はこのクエリに`responsibilityVersionAfter: t.version`(現在バージョン)も
      // 条件へ含めていたが、これは「同一payload再送」「混在バッチでのREJECT_REUSED
      // 検出」を実際に壊すバグだった。初回Undoが成功するとresponsibility.versionは
      // 加算されるため、2回目の呼び出しで再取得したt.versionは初回完了時点の
      // responsibilityVersionAfterと一致しなくなり、本来decideCompleteUndoActionの
      // 冪等判定(REPLAY_SUCCESS/REJECT_REUSED)へ到達すべき所より前に
      // InvalidUndoSnapshotErrorで弾かれてしまっていた(omega-dev2での実行で
      // 実際に再現・特定した)。
      // 是正: イベントの実在確認(id/workspace/responsibility/eventType/actor)には
      // versionを含めない。version一致確認は、後述のdecision.kind==="APPLY"
      // (=既存Lifecycle Eventが無い、真に新規の取消要求)の場合にのみ行う
      // (「このCOMPLETE Eventの後に他の変更が加わっていないか」という鮮度確認は、
      // 新規適用時にのみ意味を持ち、冪等再送の検出より後で良い)。
      // [外部監査再評価・Gate阻害是正の核心の前提]
      // ledgerApplicableはtypeのみで決まるため、completeEventId省略時の
      // 監査記録回避チェック(直後)より前にここで算出しておく。
      const ledgerApplicable = isExecutionLedgerApplicableType(t.type);

      let originalCompleteEvent: { id: string; responsibilityVersionAfter: number } | null = null;
      if (s.completeEventId) {
        originalCompleteEvent = await tx.responsibilityExecutionEvent.findFirst({
          where: {
            id: s.completeEventId,
            workspaceId,
            responsibilityId: t.id,
            eventType: "COMPLETE",
            subjectUserId: userId,
          },
          select: { id: true, responsibilityVersionAfter: true },
        });
        if (!originalCompleteEvent) {
          throw new InvalidUndoSnapshotError(
            `id=${t.id}: completeEventId "${s.completeEventId}" に一致するCOMPLETE Eventが` +
              `見つかりません(workspace/responsibility/actorのいずれかが不一致です)`,
          );
        }
      } else if (ledgerApplicable) {
        // [2026-08-26新設・外部監査Gate阻害1是正]
        // completeEventIdが省略されている場合、従来はそのまま「対象イベント無し」の
        // 後方互換パスとして扱っていた。しかしこれは、悪意あるまたは壊れたクライアントが
        // completeEventIdを単に省略するだけでCorrection追跡(REOPEN Execution Event・
        // REVOKE Lifecycle Event)を回避できてしまう抜け道だった(外部監査で指摘、
        // Gate阻害)。
        // 是正: completeEventIdが無くても、現在のversionに対応するCOMPLETE Eventが
        // 実際にDB上に存在するかを必ずサーバー側で確認する。存在するのに
        // completeEventIdが省略されている場合は、正規の後方互換ケース(旧形式
        // クライアント)ではなく評価回避の疑いがあるため拒否する。
        // 「本当に存在しない」場合(PEM同意未取得で記録自体がスキップされていた場合)
        // のみ、後方互換の単純復元パスを許可する。
        const existingCompleteEvent = await tx.responsibilityExecutionEvent.findFirst({
          where: {
            workspaceId,
            responsibilityId: t.id,
            eventType: "COMPLETE",
            subjectUserId: userId,
            responsibilityVersionAfter: t.version,
          },
          select: { id: true },
        });
        if (existingCompleteEvent) {
          throw new InvalidUndoSnapshotError(
            `id=${t.id}: 現在のversion(${t.version})に対応するCOMPLETE Event` +
              `(id=${existingCompleteEvent.id})がDB上に存在するにもかかわらず、` +
              `completeEventIdが指定されていません。取消対象のcompleteEventIdを` +
              `明示的に指定してください`,
          );
        }
      }

      // [外部監査再評価・Gate阻害是正の核心]
      // 従来は`useReopenVocabulary = Boolean(originalCompleteEvent)`とし、これが
      // そのままnextStatusの決定(PLANNEDへ固定するか、クライアント供給のs.statusを
      // そのまま書き込むか)にも使われていた。このため、completeEventIdを省略/nullで
      // 送るだけで、Execution Ledger対象型(TASK等)であっても「クライアントが指定した
      // 任意のstatus」を直接書き込めてしまい、v4.0が要求する
      // 「COMPLETED→REOPEN→PLANNED」という許可遷移を迂回できた(重大な指摘)。
      //
      // 是正: nextStatusの決定を「Execution Ledgerへ記録できるか」から完全に分離する。
      // Execution Ledger対象型(ledgerApplicable)であれば、Eventを特定できるか否かに
      // 関わらず、常にPLANNEDへ固定する(単一アイテムのREOPENアクションと同じ意味論)。
      // Eventを特定できた場合のみ、追加でExecution Ledger/Lifecycle Eventへ記録する。
      const canRecordReopen = ledgerApplicable && Boolean(originalCompleteEvent);
      const nextStatus = decideCompleteUndoNextStatus({
        ledgerApplicable,
        clientSnapshotStatus: s.status,
      });
      const nextCompletedAt = nextStatus === "PLANNED" ? null : s.completedAt ? new Date(s.completedAt) : null;

      const requestPayloadHash = buildCompleteUndoRequestPayloadHash({
        responsibilityId: t.id,
        snapshotStatus: s.status,
        snapshotCompletedAt: s.completedAt,
        // [外部監査再評価対応] 取消対象イベントをhash対象へ含める。
        snapshotCompleteEventId: s.completeEventId ?? null,
      });
      const undoIdempotencyKey = originalCompleteEvent
        ? buildCompleteUndoIdempotencyKey(t.id, originalCompleteEvent.id)
        : null;

      const existingLifecycleEvent = undoIdempotencyKey
        ? await tx.responsibilityLifecycleEvent.findFirst({
            where: { workspaceId, subjectUserId: userId, idempotencyKey: undoIdempotencyKey },
            select: { requestPayloadHash: true },
          })
        : null;

      const decision = decideCompleteUndoAction({
        currentStatus: t.status,
        existingLifecycleEvent,
        requestPayloadHash,
      });

      if (decision.kind === "REPLAY_SUCCESS") {
        count++;
        continue;
      }
      if (decision.kind === "REJECT_REUSED") {
        // [P1-2] ここで投げることでバッチ全体がロールバックされる。
        throw new IdempotencyKeyReusedError(
          "同一の取消対象に対して内容の異なる取消要求が送信されました",
        );
      }
      if (decision.kind === "SKIP_NOT_COMPLETED") {
        continue;
      }

      // decision.kind === "APPLY"
      // (nextStatus/nextCompletedAt/canRecordReopenは上で既に算出済み)
      //
      // [2026-08-26新設] 真に新規の取消要求の場合のみ、参照したCOMPLETE Eventが
      // 「まだ最新の状態を表しているか(その後に他の変更が加わっていないか)」を
      // 確認する。REPLAY_SUCCESS/REJECT_REUSEDの場合はこのチェックを行わない
      // (versionは初回適用で既に進んでいるのが正常なため)。
      if (originalCompleteEvent && isCompleteEventStale({
        responsibilityVersionAfter: originalCompleteEvent.responsibilityVersionAfter,
        currentVersion: t.version,
      })) {
        throw new InvalidUndoSnapshotError(
          `id=${t.id}: completeEventId "${s.completeEventId}" は実在しますが、` +
            `その後に他の変更が加わっており現在のversion(${t.version})と一致しません` +
            `(このCOMPLETE Eventは既に古い状態を指しています)`,
        );
      }

      // [2026-08-26新設・外部監査Gate阻害2是正、実行時に発見した順序バグの是正]
      // status/completedAtの妥当性検証も、isCompleteEventStaleと同じ理由で
      // APPLY分岐でのみ行う(冪等判定より前に行うと、REJECT_REUSED判定に使う
      // 「異なるpayload」がVALIDATION_FAILEDに化けてしまう)。
      validateCompleteUndoTarget({ id: t.id, type: t.type, status: s.status, completedAt: s.completedAt });

      const updateResult = await tx.responsibility.updateMany({
        where: { id: t.id, version: t.version },
        data: { status: nextStatus, completedAt: nextCompletedAt, updatedById: userId, version: { increment: 1 } },
      });
      // 楽観ロック競合(取消の直前に他操作でversionが進んでいた): このidはスキップする。
      if (updateResult.count === 0) continue;

      // [P1-4是正] 実際にstatusを書き換えたので、bulkComplete・単一アイテムの
      // transitions/route.tsと同じ形でEventLog/OutboxEventを必ず記録する
      // (Execution Ledger対象外型やPEM未同意でも「無音の状態変更」にしない)。
      await tx.eventLog.create({
        data: {
          aggregateType: "Responsibility",
          aggregateId: t.id,
          eventType: "STATUS_CHANGED",
          beforeJson: { status: t.status },
          afterJson: { status: nextStatus, bulkUndo: true },
          actorType: "USER",
          actorId: userId,
          reason: "一括完了の取消(Undo)",
        },
      });
      await tx.outboxEvent.create({
        data: {
          eventName: "ResponsibilityTransitioned.v1",
          eventVersion: "1",
          aggregateId: t.id,
          aggregateVersion: t.version + 1,
          payload: { responsibilityId: t.id, action: "UNDO_COMPLETE", fromStatus: t.status, toStatus: nextStatus },
        },
      });

      let resultingEventId: string | null = null;
      if (canRecordReopen) {
        const reopenEvent = await recordExecutionLedgerEvent({
          tx,
          ctx: pemCtx,
          responsibilityId: t.id,
          responsibilityType: t.type,
          action: "REOPEN",
          fromState: "COMPLETED",
          toState: "PLANNED",
          versionBefore: t.version,
          versionAfter: t.version + 1,
          clientOccurredAt: new Date(),
          actorType: "USER",
          source: "WEB",
          requestId: randomUUID(),
          requestPayloadHash,
          reason: "一括完了の取消(Undo)",
        });
        resultingEventId = reopenEvent?.id ?? null;
        if (reopenEvent) {
          await projectAndPersistExecutionSessions(tx, pemCtx, t.id);
        }
        // resultingEventId===nullの場合(PEM同意撤回等)の扱いはファイル冒頭コメントの
        // 「要仕様確認事項」を参照。本実装はREVOKE単独記録を許容する(暫定判断)。
      }

      if (undoIdempotencyKey && originalCompleteEvent) {
        await tx.responsibilityLifecycleEvent.create({
          data: {
            workspaceId,
            subjectUserId: userId,
            responsibilityId: t.id,
            kind: "CORRECTION",
            correctionType: "REVOKE",
            correctionOfEventId: originalCompleteEvent.id,
            resultingEventId,
            fromState: "COMPLETED",
            toState: nextStatus,
            reason: "一括完了の取消(Undo)",
            actorType: "USER",
            actorUserId: userId,
            idempotencyKey: undoIdempotencyKey,
            requestPayloadHash,
          },
        });
      }
      count++;
    }
    return count;
    },
    { timeout: 30000 },
  );

  return { restored };
}

/** POST /bulk/undo本体。undoペイロードの種類ごとに元へ戻す。 */
export async function executeUndo(
  payload: UndoPayload,
  workspaceId: string,
  userId: string,
): Promise<{ restored: number }> {
  if (payload.action === "COMPLETE") {
    return executeCompleteUndo(payload, workspaceId, userId);
  }
  if (payload.action === "DELETE") {
    const targets = await fetchTargets(payload.ids, workspaceId);
    const validIds = targets.map((t) => t.id);
    await bulkRestore(validIds);
    return { restored: validIds.length };
  }
  // ADD_TAG/REMOVE_TAGの取り消しは逆操作を実行するだけでよい
  // (executeBulkActionのbulkTagは既存リンク有無を見て冪等に振る舞うため安全)。
  const inverse = payload.action === "ADD_TAG" ? "REMOVE_TAG" : "ADD_TAG";
  const result = await bulkTag(inverse, payload.ids, workspaceId, payload.tagId);
  return { restored: result.affected };
}
