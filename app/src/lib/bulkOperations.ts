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
  dedupeSnapshotById,
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
  /** [2026-08-26全面改訂・外部監査で指摘された根本問題の是正]
   * 従来はstatus/completedAt/completeEventIdをクライアントが保持・送信する
   * 「ステートレスUndo」だったが、これはクライアントによるsnapshot改ざんで
   * 誤った状態へ復元できてしまう脆弱性の温床だった。新設計では、Bulk Complete
   * 実行時にサーバー側insert-onlyで保存したBulkCompleteReceipt.idだけを
   * クライアントが持ち回る。実際の復元先(fromStatus)・Ledger接続
   * (completeEventId)は常にDBのレシートから読み、クライアントの主張は
   * 一切信用しない。 */
  snapshot: {
    id: string;
    receiptId: string;
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
    // 1件分のstatus変更・EventLog・Ledger記録・レシート作成が全てrollbackされる
    // (他のidには影響しない)。
    // [2026-08-26追加・外部監査P1-1是正]
    // fetchTargetsでtを取得した後、この更新を実行するまでの間に別操作が状態を
    // 変えている可能性がある(このループ自体はバッチ全体を1トランザクションに
    // していないため、他のidの処理中に別クライアントがこのidを操作できる)。
    // 従来はwhereにidしか指定していなかったため、取得直後のt.status(既に古い
    // かもしれない)をfromStatusとしてレシートへ書き込んでしまい、実際の状態と
    // 食い違うレシートが作られ得た。version/status/workspaceId/deletedAtを
    // whereへ含め、更新0件(競合検出)ならレシートも作らずskip扱いにする。
    const receiptId = await db.$transaction(async (tx: Prisma.TransactionClient) => {
      const updateResult = await tx.responsibility.updateMany({
        where: { id: t.id, workspaceId, version: t.version, status: t.status, deletedAt: null },
        data: { status: nextStatus, completedAt: now, updatedById: userId, version: { increment: 1 } },
      });
      if (updateResult.count === 0) {
        return null; // 競合検出。この時点までのtx内変更は無い(まだ何も書いていない)。
      }
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
      // [2026-08-26新設・外部監査で指摘された根本問題の是正]
      // Execution Ledger対象型か・PEM同意の有無かに関わらず、必ずレシートを
      // 作成する。これにより、Undoの冪等性がLedger記録の有無に依存しなくなる
      // (COMMITMENT等の種別固有型、PEM未同意時の完了でも同一契約が成立する)。
      // fromStatus(=t.status、完了前の真の状態)はサーバーがここで確定させ、
      // クライアントへ生の値として渡すことは無い(receiptIdだけを渡す)。
      // responsibilityVersionAfter(=t.version+1、上のupdateManyで実際に到達した
      // version)は、Undo時に「このレシートが今のResponsibilityにとって最新の
      // 完了サイクルに対応しているか」を判定するために使う(外部監査P0-1是正)。
      const receipt = await tx.bulkCompleteReceipt.create({
        data: {
          workspaceId,
          subjectUserId: userId,
          responsibilityId: t.id,
          operationId: bulkRequestId,
          fromStatus: t.status,
          toStatus: nextStatus,
          responsibilityVersionAfter: t.version + 1,
          completeEventId: ledgerResult?.id ?? null,
        },
        select: { id: true },
      });
      return receipt.id;
    });
    if (receiptId === null) {
      skipped.push({ id: t.id, reason: "更新直前に他の操作と競合しました(個別に操作してください)" });
      continue;
    }
    snapshot.push({ id: t.id, receiptId });
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
 * [2026-08-25新設・Completion Gate 2.1、v4.0 8.1節「Correction」是正、
 *  2026-08-26全面改訂・外部監査で指摘された根本問題(クライアント編集可能な
 *  snapshotをUndoの信頼元にしている)の是正]
 *
 * 従来はスナップショットの任意のstatusへ直接書き戻すだけで、Execution Ledgerの正本
 * (ResponsibilityExecutionEvent)には一切触れない「無音の改変」だった。これは
 * v4.0 8.1節が要求する「元Evidenceを更新せず、Correction Eventを追記する」に反する。
 * さらにその後の是正過程で、「クライアントが保持するsnapshot(status/completedAt/
 * completeEventId)を毎回サーバーへ送り返す」という設計自体が、以下2つの問題の
 * 温床であることが判明した(繰り返しの外部監査で指摘):
 *   (a) クライアントが「完了操作の遷移元として有効な別のstatus」へsnapshotを
 *       改ざんすると、実際とは異なる誤った状態へ復元されてしまう
 *   (b) PEM Execution Ledgerの記録有無(PEM同意任意)に冪等性が依存してしまい、
 *       Ledger未記録の経路(種別固有型、PEM未同意時の完了)では「同一要求の
 *       再送は同じ成功応答を返す」というv4.0 5.5節の契約が成立しない
 *
 * 是正(Undo Receipt方式への全面移行):
 *  - Bulk Complete実行時に、復元先の真の情報(fromStatus/toStatus/completeEventId)を
 *    サーバー側insert-onlyのBulkCompleteReceiptへ必ず保存する(型・PEM同意の
 *    有無に関わらず、100%のケースで作成する)。
 *  - クライアントはreceiptIdだけを持ち回る。status/completedAt/completeEventIdという
 *    概念自体がpayloadから無くなったため、それらをクライアントから受け取って
 *    検証する処理も不要になった(改ざんの余地そのものが無い)。
 *  - Execution Ledger対象型(TASK等)は、レシートにcompleteEventIdがあれば
 *    既存のREOPEN語彙(Registry固定: COMPLETED/NOT_NEEDED→PLANNED)で
 *    Execution Ledgerへも記録する(監査証跡としての追加記録。復元先の決定には
 *    使わない)。復元先そのものは常にレシートのfromStatus(真の元状態)を使う。
 *  - 冪等記録(BulkCompleteUndoConsumption)はreceiptId単位でinsert-onlyに記録する。
 *    PEM Execution Ledgerの記録有無に一切依存しないため、全ての型・全ての
 *    同意状態で同一の冪等契約が成立する。
 *
 * P1-2(バッチUndoが全体トランザクションではない、是正済み・変更なし):
 *   バッチ全体を1つのdb.$transactionで包む(どこかでエラーが投げられれば、
 *   そのバッチ全体がロールバックされる)。
 *
 * P1-3(重複IDでrestored件数が水増しされる、是正済み・変更なし):
 *   処理前にid単位で重複排除する(先勝ち)。
 *
 * P1-4(Undoの状態変更がEventLog/Outboxへ記録されない、是正済み・変更なし):
 *   実際にstatusを書き換えた場合は必ず、EventLog(STATUS_CHANGED)と
 *   OutboxEvent(ResponsibilityTransitioned.v1)を同一トランザクションで記録する。
 *
 * [要仕様確認事項・現時点の暫定判断とその理由・変更なし]
 *   レシートにcompleteEventIdがあっても、Undo時点でPEM同意が撤回されていると
 *   recordExecutionLedgerEvent()はnullを返し得る(REOPEN Eventを記録できない)。
 *   この場合、「REOPEN+REVOKEを必ず一組にする」か「同意撤回後はREVOKE単独を
 *   許可する」かの製品判断が必要(外部監査で指摘済み、正式な仕様書には未記載)。
 *   本実装は後者(REVOKE単独を許可)を暫定採用する。理由: 前者を採用しPEM同意
 *   撤回時にUndo自体を拒否すると、ユーザーは自分の一括完了操作を取り消す手段を
 *   失い、Responsibilityが誤った完了状態のまま固定されてしまう。
 */

async function executeCompleteUndo(
  payload: CompleteUndoPayload,
  workspaceId: string,
  userId: string,
): Promise<{ restored: number }> {
  // [P1-3是正] 重複id除去は、DBアクセスより前に行う。
  // [2026-08-26追加・外部監査P0-2是正]
  // このバッチ内での処理順序をreceiptId昇順に固定する。後述のFOR UPDATE行ロックを
  // 複数レシートに跨って取得する際、異なるバッチが異なる順序でロックを取得すると
  // デッドロックが起こり得るため、全ての呼び出しが同じ(receiptId昇順)順序で
  // ロックを取得するよう統一する。restoredの集計順序には影響しない。
  const snapshot = dedupeSnapshotById(payload.snapshot).sort((a, b) => a.receiptId.localeCompare(b.receiptId));
  const ids = snapshot.map((s) => s.id);
  const targets = await fetchTargets(ids, workspaceId);
  const targetById = new Map(targets.map((t) => [t.id, t]));

  const pemCtx = await buildPemAuthorizationContext(userId, userId);

  // [P1-2是正、外部監査再評価「200件バッチのtransaction timeoutリスク」対応]
  // バッチ全体を1つのトランザクションに統一する。途中でエラーが投げられれば
  // (IdempotencyKeyReusedError等)、バッチ全体がロールバックされ、「前半だけ
  // Undo済み」という部分適用が起こらない。要求数が多いとPrismaの既定interactive
  // transactionタイムアウト(5秒)に達する恐れがあるため、30秒へ緩和する応急対応も
  // 行う。200件規模での実測(2,700〜2,900ms程度)はomega-dev2で確認済み。
  const restored = await db.$transaction(
    async (tx: Prisma.TransactionClient) => {
      let count = 0;
      for (const s of snapshot) {
        const t = targetById.get(s.id);
        if (!t) continue; // 対象が存在しない(他Workspace混入等。fetchTargetsで既に除外済み)

        // [2026-08-26新設・外部監査で指摘された根本問題の是正の核心、
        //  2026-08-26さらに是正・外部監査P0-2(同時再送の競合)対応]
        // クライアントから受け取るのはreceiptIdのみ。実際の復元先(fromStatus)・
        // Execution Ledger接続(completeEventId)は常にこのレシートから読み、
        // クライアントが送ってくる値は一切信用しない。receiptIdが実在しない、
        // またはこのresponsibility/workspace/actorに属さない場合は
        // VALIDATION_FAILEDとしてバッチ全体を拒否する(値の不整合を握り潰さない)。
        //
        // [経緯・P0-2] 当初は`findFirst`(通常のSELECT、行ロック無し)でレシートを
        // 読んだ後、別途冪等記録の有無を確認し、無ければ更新→冪等記録作成という
        // 順序だった。同一receiptIdへの2つのUndo要求がほぼ同時に実行されると、
        // 両方とも「冪等記録なし」を確認できてしまい、片方はresponsibility.
        // updateManyのversion条件で更新0件(→SKIP相当)になり得た。これは
        // 「同一要求の再送は同じ成功応答を返す」というv4.0 5.5節の契約に反する。
        // 是正: `SELECT ... FOR UPDATE`でレシート行自体をロックしてから読む。
        // 同一レシートへの同時Undo要求は、片方のトランザクションが完了(commit)
        // するまでもう片方がこのロック取得で待たされるため、後続の冪等記録確認が
        // 必ず正しい最新状態を見られるようになる(直列化される)。
        const receiptRows = await tx.$queryRaw<
          {
            id: string;
            from_status: string;
            to_status: string;
            complete_event_id: string | null;
            responsibility_version_after: number;
          }[]
        >`
          SELECT id, from_status, to_status, complete_event_id, responsibility_version_after
          FROM bulk_complete_receipts
          WHERE id = ${s.receiptId}
            AND workspace_id = ${workspaceId}
            AND subject_user_id = ${userId}
            AND responsibility_id = ${t.id}
          FOR UPDATE
        `;
        const receiptRow = receiptRows[0];
        if (!receiptRow) {
          throw new InvalidUndoSnapshotError(
            `id=${t.id}: receiptId "${s.receiptId}" に一致するUndo Receiptが` +
              `見つかりません(workspace/responsibility/actorのいずれかが不一致です)`,
          );
        }
        const receipt = {
          id: receiptRow.id,
          fromStatus: receiptRow.from_status,
          toStatus: receiptRow.to_status,
          completeEventId: receiptRow.complete_event_id,
          responsibilityVersionAfter: receiptRow.responsibility_version_after,
        };

        const requestPayloadHash = buildCompleteUndoRequestPayloadHash({ receiptId: receipt.id });

        // [2026-08-26新設] 冪等記録はreceiptId単位(BulkCompleteUndoConsumption)。
        // PEM Execution Ledgerの記録有無に一切依存しないため、種別固有型や
        // PEM未同意時の完了でも「同一要求の再送は同じ成功応答を返す」という
        // v4.0 5.5節の契約が一様に成立する(外部監査で指摘されていた問題の是正)。
        // 上のFOR UPDATEロックにより、ここで読む値は同一レシートへの並行要求
        // 間で正しく直列化されている。
        const existingConsumption = await tx.bulkCompleteUndoConsumption.findUnique({
          where: { receiptId: receipt.id },
          select: { requestPayloadHash: true },
        });

        // [2026-08-26新設、さらに2026-08-26改訂・外部監査P0-1是正]
        // 「現在完了状態か」は、レシート自体が表すtoStatusと現在のstatusが
        // 一致するかで判定していたが、これだけでは「古い(既に別サイクルで
        // Undo/再完了された)レシートが、たまたま現在のstatusと同じtoStatusを
        // 持っている」場合に誤って「現在も有効」と判定されてしまう恐れがあった。
        // 例: TASK完了→Receipt A(toStatus=COMPLETED)→個別REOPEN→再START→
        // 再度完了→Receipt B(toStatus=COMPLETED)→古いReceipt AでUndoを送ると、
        // 現在statusは(Receipt Bによって)再びCOMPLETEDなので、
        // status一致だけで判定するとReceipt Aが誤って「有効」とみなされ、
        // 無関係な別の完了サイクル(B)を取り消してしまっていた
        // (Responsibility状態とCorrection履歴が不整合になる、外部監査で指摘)。
        // 是正: responsibilityVersionAfter(この完了操作が直後に到達したversion)
        // が現在のversionと一致するかも必ず確認する。versionは完了・Undoの
        // たびに必ず+1されるため、これと一致することで「まさにこのレシートが
        // 生んだ状態そのものか」を一意に判定できる。
        const currentlyCompleted =
          t.status === receipt.toStatus && t.version === receipt.responsibilityVersionAfter;
        const decision = decideCompleteUndoAction({
          currentlyCompleted,
          existingConsumption,
          requestPayloadHash,
        });

        if (decision.kind === "REPLAY_SUCCESS") {
          count++;
          continue;
        }
        if (decision.kind === "REJECT_REUSED") {
          // [P1-2] ここで投げることでバッチ全体がロールバックされる。
          // (新設計ではpayloadにreceiptId以外の可変フィールドが無いため、
          // このAPIを正規のクライアントから呼ぶ限りこの分岐は実質到達しない。
          // 将来payloadが拡張された場合の防御的分岐として保持する。)
          throw new IdempotencyKeyReusedError(
            "同一の取消対象に対して内容の異なる取消要求が送信されました",
          );
        }
        if (decision.kind === "SKIP_NOT_COMPLETED") {
          continue;
        }

        // decision.kind === "APPLY"
        // [2026-08-26新設・外部監査で指摘された根本問題の是正の核心]
        // Execution Ledger対象型はREOPEN語彙に合わせ常にPLANNEDへ(v4.0が
        // 定める許可遷移COMPLETED→REOPEN→PLANNEDそのもの)。対象外型は
        // receipt.fromStatus(サーバーが完了実行時に記録した真の元状態。
        // クライアントからは一切受け取っていない)を使う。これにより、
        // AT_RISKから完了したものはAT_RISKへ、ACTIVEから完了したものはACTIVEへ、
        // それぞれ正確に復元される(改ざんの余地が無い)。
        const ledgerApplicable = isExecutionLedgerApplicableType(t.type);
        const canRecordReopen = ledgerApplicable && Boolean(receipt.completeEventId);
        const nextStatus = ledgerApplicable ? "PLANNED" : receipt.fromStatus;
        const nextCompletedAt = null;

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
        if (canRecordReopen && receipt.completeEventId) {
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

        // [2026-08-26新設] 冪等記録はreceiptId単位で必ず作成する(型・Ledger記録の
        // 有無に関わらず)。これがUndoの冪等性の唯一の正本になる。
        await tx.bulkCompleteUndoConsumption.create({
          data: {
            receiptId: receipt.id,
            workspaceId,
            subjectUserId: userId,
            requestPayloadHash,
          },
        });

        // Lifecycle Event(v4.0 8.1節のCorrection監査証跡)は、Execution Ledgerへの
        // 接続が実際にできた場合(completeEventIdがある)のみ記録する
        // (「いずれの場合も必ず記録する」わけではない。訂正対象が存在しない
        // Correctionは作れないため)。
        if (receipt.completeEventId) {
          await tx.responsibilityLifecycleEvent.create({
            data: {
              workspaceId,
              subjectUserId: userId,
              responsibilityId: t.id,
              kind: "CORRECTION",
              correctionType: "REVOKE",
              correctionOfEventId: receipt.completeEventId,
              resultingEventId,
              fromState: "COMPLETED",
              toState: nextStatus,
              reason: "一括完了の取消(Undo)",
              actorType: "USER",
              actorUserId: userId,
              idempotencyKey: buildCompleteUndoIdempotencyKey(t.id, receipt.id),
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
