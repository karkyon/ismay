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
 * [2026-08-25是正・外部監査(内部レビュー)対応] 当初はbulkOperations.ts内に直接
 * 実装しており、completionGate2_1Invariants.test.tsがbulkOperations.tsを
 * importした結果、db.tsの`export const db = createClient()`(モジュール読込時に
 * DATABASE_URL未設定だと即throwする)を巻き込んでテストがクラッシュしていた
 * (他のGate系テストがdb非依存を保っているのと矛盾する状態だった)。
 * このファイルへ分離することで是正する。
 */
import { createHash } from "node:crypto";
import { isValidStatusForType } from "@/lib/responsibility";

/**
 * [Completion Gate 2.1] COMPLETE取消のidempotencyKey。
 * 「どのCOMPLETE Eventを取り消すか」で一意に決まる自然キーとする(呼び出し元が
 * 別途キーを発行・管理する必要が無い。同じEventへ複数回Undoを送っても同一キーになる)。
 */
export function buildCompleteUndoIdempotencyKey(responsibilityId: string, correctionOfEventId: string): string {
  return `${responsibilityId}:UNDO_COMPLETE:${correctionOfEventId}`;
}

/**
 * [Completion Gate 2.1・外部監査P0-2是正、再評価対応で拡張]
 * 冪等判定用のrequestPayloadHash。当初はsnapshotStatusのみをhash対象としており、
 * completedAtだけが異なる別内容のUndo要求を「同一payload」と誤判定していた。
 * さらに[外部監査再評価]、どのCOMPLETE Eventを取消対象にしているか
 * (completeEventId)もhash対象へ含める。これが無いと、同一のstatus/completedAtだが
 * 異なるcompleteEventIdを指す2つの要求が「同一payload」と誤判定されうる。
 */
export function buildCompleteUndoRequestPayloadHash(params: {
  responsibilityId: string;
  snapshotStatus: string;
  snapshotCompletedAt: string | null;
  snapshotCompleteEventId: string | null;
}): string {
  return createHash("sha256")
    .update(
      JSON.stringify({
        action: "UNDO_COMPLETE",
        id: params.responsibilityId,
        snapshotStatus: params.snapshotStatus,
        snapshotCompletedAt: params.snapshotCompletedAt,
        snapshotCompleteEventId: params.snapshotCompleteEventId,
      }),
    )
    .digest("hex");
}

export type CompleteUndoDecision =
  /** 初回要求: 実際にResponsibility本体とExecution Ledger/Lifecycle Eventを更新する。 */
  | { kind: "APPLY" }
  /** 同一key・同一payloadの再送: 何もせず、初回と同じ「成功」として扱う(restoredへ加算する)。 */
  | { kind: "REPLAY_SUCCESS" }
  /** 同一key・異なるpayloadの再利用: IDEMPOTENCY_KEY_REUSEDとして拒否する。 */
  | { kind: "REJECT_REUSED" }
  /** 取消対象が既にCOMPLETED以外(他操作で状態が変わった等): 何もしない。 */
  | { kind: "SKIP_NOT_COMPLETED" };

/**
 * [Completion Gate 2.1・外部監査P0-1是正]
 * COMPLETE取消の分岐判断を、DBアクセスから切り離した純粋関数として独立させる。
 *
 * 是正の背景: 当初の実装は `if (t.status !== "COMPLETED") continue;` を
 * 既存Lifecycle Event(冪等キー)の確認より先に行っていたため、初回Undoで
 * status が COMPLETED→PLANNED へ変わった後の再送では、Lifecycle Eventの確認へ
 * 到達する前にスキップされ、`restored: 0` が返っていた(v4.0 5.5節が要求する
 * 「同一key・同一payloadなら元の成功応答を返す」を満たしていなかった)。
 *
 * 是正方針: 既存Lifecycle Eventの有無を必ず先に確認する。既存が見つかった場合は
 * (初回操作によって現在のstatusが既に変わっているため)現在のstatusを一切見ずに
 * REPLAY_SUCCESS/REJECT_REUSEDを返す。既存が無い場合にのみ、初回要求として
 * 現在のstatusを検査する。
 */
export function decideCompleteUndoAction(params: {
  currentStatus: string;
  existingLifecycleEvent: { requestPayloadHash: string } | null;
  requestPayloadHash: string;
}): CompleteUndoDecision {
  if (params.existingLifecycleEvent) {
    return params.existingLifecycleEvent.requestPayloadHash === params.requestPayloadHash
      ? { kind: "REPLAY_SUCCESS" }
      : { kind: "REJECT_REUSED" };
  }
  if (params.currentStatus !== "COMPLETED") {
    return { kind: "SKIP_NOT_COMPLETED" };
  }
  return { kind: "APPLY" };
}

/**
 * [Completion Gate 2.1、v4.0 5.5節「idempotency response contract」をCOMPLETE取消
 * (Undo)へ適用したもの] transitions/route.tsのIDEMPOTENCY_KEY_REUSEDと同じ意味を、
 * bulkOperations層からroute層(apiError呼び出し)へ伝えるための専用エラー型。
 * executeUndo自体はNext.js Route Handlerに依存させたくないため、ここでは例外として
 * 投げるに留め、実際のHTTP 409応答への変換はbulk/undo/route.ts側で行う。
 */
export class IdempotencyKeyReusedError extends Error {}

/**
 * [外部監査再評価・Gate阻害是正の核心をテスト可能な形で分離]
 * COMPLETE取消で書き戻すstatusの決定ロジック。Execution Ledger対象型
 * (ledgerApplicable)であれば、取消対象のCOMPLETE Eventを実際に特定できたか
 * どうかに関わらず、常にPLANNEDへ固定する(単一アイテムのREOPENアクションと同じ
 * 意味論)。対象外型のみ、クライアントが返したstatusをそのまま使う。
 *
 * [経緯] 当初はこの決定を「Eventを特定できたか」に連動させており、
 * completeEventIdを省略/nullで送るだけで、Execution Ledger対象型であっても
 * 任意のstatusを直接書き込め、v4.0が要求する「COMPLETED→REOPEN→PLANNED」という
 * 許可遷移を迂回できてしまっていた(外部監査で指摘、Gate阻害と判定)。
 */
export function decideCompleteUndoNextStatus(params: {
  ledgerApplicable: boolean;
  clientSnapshotStatus: string;
}): string {
  return params.ledgerApplicable ? "PLANNED" : params.clientSnapshotStatus;
}

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

/**
 * [2026-08-25新設・外部監査P1-5是正] Undo要求に含まれるstatusが、対象の実際の型に
 * とって有効な値かを検証する。用語・状態・コード定義書v1.1 3章が定義する値集合を
 * そのまま使う(想像で新しい値集合を作らない)。
 */
export class InvalidUndoSnapshotError extends Error {}

export function validateSnapshotStatuses(
  snapshot: readonly { id: string; status: string }[],
  typeById: ReadonlyMap<string, string>,
): void {
  for (const s of snapshot) {
    const type = typeById.get(s.id);
    if (!type) continue; // 対象がこのWorkspaceに存在しない場合は後段の処理で無視される
    if (!isValidStatusForType(type, s.status)) {
      throw new InvalidUndoSnapshotError(
        `id=${s.id}: status "${s.status}" は種別 "${type}" にとって不正な値です`,
      );
    }
  }
}
