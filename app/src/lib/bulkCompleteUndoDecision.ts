/**
 * 一括操作COMPLETE取消(Undo)の純粋ロジック(db非依存部分)。
 * 出典: ISMAY_PEMサブシステム_統合正本仕様書_v4_0 5.5節(idempotency response
 * contract)・8.1節(Correction)、ISMAY_PEM_v3_3_1整合性修正_用語コード定義書_v1_0 8章。
 *
 * bulkOperations.ts(db.tsを経由し実Prismaクライアントに依存する)から分離し、
 * tsx実行テストがdb.ts解決(DATABASE_URL未設定環境では失敗する)を経由せずに
 * この判定ロジックを検証できるようにする
 * (executionLedgerMapping.ts・Phase 0S consent.tsと同じ設計原則)。
 *
 * [2026-08-26全面改訂・外部監査で指摘された根本問題の是正]
 * これまでの実装は、Bulk Complete APIが返すsnapshot(status/completedAt/
 * completeEventId)をクライアントが保持し、Undo実行時にそのままサーバーへ
 * 送り返す「ステートレスUndo」だった。この設計は繰り返し以下の問題を起こした:
 *   - クライアントが「完了操作の遷移元として有効な別のstatus」へsnapshotを
 *     改ざんすると、実際とは異なる誤った状態へ復元できてしまう
 *   - PEM Execution Ledgerの記録有無(PEM同意任意)に冪等性が依存してしまい、
 *     Ledger未記録の経路(種別固有型、PEM未同意時の完了)では
 *     「同一要求の再送は同じ成功応答を返す」という契約が成立しない
 *
 * 是正: Bulk Complete実行時に、復元先の真の情報(fromStatus/toStatus/
 * completeEventId)をサーバー側insert-onlyのBulkCompleteReceiptへ保存する。
 * クライアントはreceiptIdだけを持ち回り、このファイルの純粋関数は
 * 「receiptIdに対応する冪等記録(BulkCompleteUndoConsumption)が既にあるか」
 * だけを見る。クライアント供給のstatus/completedAtという概念自体が
 * payloadから無くなったため、それらの妥当性検証(旧バージョンの
 * validateCompleteUndoTarget/completeFromStatusesForType呼び出し)は不要になった。
 */
import { createHash } from "node:crypto";

/**
 * [2026-08-26新設] Bulk Complete UndoのidempotencyKey。receiptId自体が既に
 * 「どの完了を取り消すか」を一意に表すため、これをそのまま使う。
 */
export function buildCompleteUndoIdempotencyKey(responsibilityId: string, receiptId: string): string {
  return `${responsibilityId}:UNDO_COMPLETE:${receiptId}`;
}

/**
 * [2026-08-26全面改訂]
 * 冪等判定用のrequestPayloadHash。新設計ではクライアントが送るのはreceiptIdのみ
 * (status/completedAt/completeEventIdはもうpayloadに存在しない。全てサーバー側の
 * BulkCompleteReceiptから読む)。receiptId自体が一意な識別子であるため、
 * このhashは実質的にreceiptIdの正規化表現に過ぎないが、将来payloadへ他の
 * フィールドが追加された場合に備えてhash関数の形は維持する。
 */
export function buildCompleteUndoRequestPayloadHash(params: { receiptId: string }): string {
  return createHash("sha256")
    .update(JSON.stringify({ action: "UNDO_COMPLETE", receiptId: params.receiptId }))
    .digest("hex");
}

export type CompleteUndoDecision =
  /** 初回要求: 実際にResponsibility本体とExecution Ledger/Lifecycle Eventを更新する。 */
  | { kind: "APPLY" }
  /** 同一receiptIdの再送: 何もせず、初回と同じ「成功」として扱う(restoredへ加算する)。 */
  | { kind: "REPLAY_SUCCESS" }
  /** 同一receiptIdだが記録済みpayloadと不一致(通常は起こらないはずの防御的分岐):
   * IDEMPOTENCY_KEY_REUSEDとして拒否する。 */
  | { kind: "REJECT_REUSED" }
  /** 取消対象が既に「レシートが表すtoStatus」ではない(他操作で状態が変わった等):
   * 何もしない。 */
  | { kind: "SKIP_NOT_COMPLETED" };

/**
 * [Completion Gate 2.1・外部監査P0-1是正、2026-08-26全面改訂]
 * COMPLETE取消の分岐判断を、DBアクセスから切り離した純粋関数として独立させる。
 *
 * 是正の背景(P0-1): 当初の実装は現在statusの検査を、既存の冪等記録の確認より
 * 先に行っていたため、初回Undoでstatusが変わった後の再送では、冪等記録の確認へ
 * 到達する前にスキップされ、`restored: 0` が返っていた(v4.0 5.5節が要求する
 * 「同一key・同一payloadなら元の成功応答を返す」を満たしていなかった)。
 * 是正方針: 既存の冪等記録(existingConsumption)の有無を必ず先に確認する。
 *
 * [2026-08-26全面改訂・外部監査で指摘された根本問題の是正]
 * 従来はcurrentStatus(string)や、それを型別に変換したcurrentlyCompleted(boolean)を
 * 受け取っていたが、「何をもって完了状態とみなすか」の判定を型ごとに正しく
 * 実装し続けるのは繰り返しバグの温床になった(COMMITMENT等がずっと動いていな
 * かった重大バグ等)。新設計では、呼び出し元(bulkOperations.ts)が
 * `t.status === receipt.toStatus`(このレシートが表す「完了直後の状態」と現在の
 * statusが一致するか)を直接判定してcurrentlyCompletedとして渡す。これは
 * レシート固有の判定であり、型ごとの完了到達statusを再定義する必要が無い。
 */
export function decideCompleteUndoAction(params: {
  currentlyCompleted: boolean;
  existingConsumption: { requestPayloadHash: string } | null;
  requestPayloadHash: string;
}): CompleteUndoDecision {
  if (params.existingConsumption) {
    return params.existingConsumption.requestPayloadHash === params.requestPayloadHash
      ? { kind: "REPLAY_SUCCESS" }
      : { kind: "REJECT_REUSED" };
  }
  if (!params.currentlyCompleted) {
    return { kind: "SKIP_NOT_COMPLETED" };
  }
  return { kind: "APPLY" };
}

/**
 * [Completion Gate 2.1、v4.0 5.5節「idempotency response contract」をCOMPLETE取消
 * (Undo)へ適用したもの] transitions/route.tsのIDEMPOTENCY_KEY_REUSEDと同じ意味を、
 * bulkOperations層からroute層(apiError呼び出し)へ伝えるための専用エラー型。
 */
export class IdempotencyKeyReusedError extends Error {}

/**
 * [2026-08-26改訂] receiptIdが実在しない・このresponsibility/workspace/actorに
 * 属さない場合に投げる。
 */
export class InvalidUndoSnapshotError extends Error {}

/**
 * [2026-08-25新設・外部監査P1-3是正] snapshot内のid重複を除去する(先勝ち)。
 * 重複を許すと、2件目以降が「同一key・同一payloadの冪等再送」として扱われ、
 * restored件数が水増しされ得た。bulkOperations.ts executeCompleteUndoの
 * トランザクション開始前に呼ぶ。
 */
export function dedupeSnapshotById<T extends { id: string }>(snapshot: readonly T[]): T[] {
  const seen = new Set<string>();
  const result: T[] = [];
  for (const s of snapshot) {
    if (seen.has(s.id)) continue;
    seen.add(s.id);
    result.push(s);
  }
  return result;
}
