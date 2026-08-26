/**
 * PEM Phase0S/0A Completion Gate 2.1 不変条件テスト。
 * 実行: npx tsx src/lib/pem/__tests__/completionGate2_1Invariants.test.ts
 * (npm run test:pem-completion-gate-2-1)
 *
 * 出典: ISMAY_PEMサブシステム_統合正本仕様書_v4_0 5.5節(idempotency response
 * contract)・8.1節(Correction)、ISMAY_PEM_v3_3_1整合性修正_用語コード定義書_v1_0 8章。
 *
 * completionGate1Invariants.test.tsと同じ方針で、db依存の関数
 * (executeUndo/bulkComplete本体等)は実DB統合検証(omega-dev2の実Postgres、
 * scripts/verify_gate_2_1_live.ts)に委ね、ここではdb非依存の純粋関数のみ検証する。
 *
 * [2026-08-26全面改訂・外部監査で指摘された根本問題の是正に伴う書き換え]
 * これまでのCompletion Gate 2.1実装は、クライアントが保持するsnapshot
 * (status/completedAt/completeEventId)をUndoの信頼元にしていた。これは
 * 繰り返しの外部監査で「改ざんによる誤復元」「Ledger記録有無への冪等性の
 * 依存」という2つの根本的な問題を指摘され、Undo Receipt方式
 * (Bulk Complete実行時にサーバー側insert-onlyで保存するBulkCompleteReceiptを
 * 復元先の唯一の正本とし、クライアントはreceiptIdだけを持ち回る)へ全面移行した。
 * これに伴い、旧設計のstatus/completedAt検証関数(validateCompleteUndoTarget等)・
 * type別のnextStatus決定関数(decideCompleteUndoNextStatus)・version鮮度チェック
 * (isCompleteEventStale)は全て不要になり削除した(該当ロジックはbulkOperations.ts
 * 側でreceipt.fromStatus/receipt.toStatusを直接使う形に置き換わったため)。
 */
import assert from "node:assert/strict";
import { apiError } from "@/lib/auth/response";
import { CORRECTION_TYPES, LIFECYCLE_EVENT_KINDS } from "@/lib/pem/coreTypes";
import { isExecutionLedgerApplicableType } from "@/lib/pem/eventDefinitionRegistry";
import { isValidStatusForType, completeFromStatusesForType, completeToStatusForType } from "@/lib/responsibility";
import {
  buildCompleteUndoIdempotencyKey,
  buildCompleteUndoRequestPayloadHash,
  decideCompleteUndoAction,
  dedupeSnapshotById,
  IdempotencyKeyReusedError,
  InvalidUndoSnapshotError,
} from "@/lib/bulkCompleteUndoDecision";

let passed = 0;
function check(name: string, fn: () => void): void {
  fn();
  passed++;
  console.log(`  ok - ${name}`);
}

console.log("PEM Phase0S/0A Completion Gate 2.1 不変条件テスト");

check("IDEMPOTENCY_KEY_REUSEDは409を返す(v4.0 5.5節、旧IDEMPOTENCY_KEY_CONFLICTからの改名)", () => {
  const res = apiError("IDEMPOTENCY_KEY_REUSED", "同一のリクエストキーで内容の異なるリクエストが送信されました");
  assert.equal(res.status, 409);
});

check("CORRECTION_TYPESは用語・状態・コード定義書v1.0 8章の4値ちょうどである", () => {
  assert.deepEqual(
    [...CORRECTION_TYPES].sort(),
    ["REPLACE", "REVOKE", "SPLIT", "MERGE_REQUEST"].sort(),
  );
});

check("LIFECYCLE_EVENT_KINDSはCORRECTION/RECURRENCE_RESETの2値ちょうどである", () => {
  assert.deepEqual([...LIFECYCLE_EVENT_KINDS].sort(), ["CORRECTION", "RECURRENCE_RESET"].sort());
});

check(
  "buildCompleteUndoIdempotencyKey【2026-08-26改訂】は責任IDとreceiptIdから" +
    "決定論的なキーを生成する(旧設計ではcompleteEventIdを使っていたが、新設計では" +
    "receiptId自体が取消対象を一意に表すためこちらを使う)",
  () => {
    const key1 = buildCompleteUndoIdempotencyKey("resp-1", "receipt-1");
    const key2 = buildCompleteUndoIdempotencyKey("resp-1", "receipt-1");
    const key3 = buildCompleteUndoIdempotencyKey("resp-1", "receipt-2");
    assert.equal(key1, key2, "同一入力からは同一キーが決定論的に生成される(冪等性の基盤)");
    assert.notEqual(key1, key3, "取消対象レシートが異なれば別キーになる");
    assert.equal(key1, "resp-1:UNDO_COMPLETE:receipt-1");
  },
);

check(
  "buildCompleteUndoRequestPayloadHash【2026-08-26全面改訂】はreceiptIdのみを" +
    "入力とする(旧設計ではstatus/completedAt/completeEventIdの組み合わせを" +
    "hashしていたが、新設計ではクライアントが送るのはreceiptIdのみになったため" +
    "単純化された)",
  () => {
    const hashA = buildCompleteUndoRequestPayloadHash({ receiptId: "receipt-1" });
    const hashA2 = buildCompleteUndoRequestPayloadHash({ receiptId: "receipt-1" });
    const hashB = buildCompleteUndoRequestPayloadHash({ receiptId: "receipt-2" });
    assert.equal(hashA, hashA2, "同一receiptIdからは同一hashが決定論的に生成される");
    assert.notEqual(hashA, hashB, "receiptIdが異なれば別hashになる");
  },
);

check(
  "decideCompleteUndoAction: 既存の冪等記録(consumption)が無く、" +
    "currentlyCompleted=trueならAPPLY(初回Undo要求)",
  () => {
    const decision = decideCompleteUndoAction({
      currentlyCompleted: true,
      existingConsumption: null,
      requestPayloadHash: "hash-a",
    });
    assert.deepEqual(decision, { kind: "APPLY" });
  },
);

check(
  "decideCompleteUndoAction: 既存の冪等記録が無く、currentlyCompleted=falseなら" +
    "SKIP_NOT_COMPLETED(レシートのtoStatusと現在statusが不一致 = 他の操作で" +
    "既に状態が変わっている)",
  () => {
    const decision = decideCompleteUndoAction({
      currentlyCompleted: false,
      existingConsumption: null,
      requestPayloadHash: "hash-a",
    });
    assert.deepEqual(decision, { kind: "SKIP_NOT_COMPLETED" });
  },
);

check(
  "decideCompleteUndoAction【外部監査P0-1是正の核心・新設計でも維持】: " +
    "既存の冪等記録があり同一payloadなら、currentlyCompletedが(初回Undoで" +
    "既に変わっている)falseでもREPLAY_SUCCESSを返す(冪等記録の確認をstatus判定" +
    "より前に行うことで、『同一key・同一payloadの再送は元の成功応答を返す』という" +
    "v4.0 5.5節の要件を満たす)",
  () => {
    const decision = decideCompleteUndoAction({
      currentlyCompleted: false, // 初回UndoでtoStatusから離れた後
      existingConsumption: { requestPayloadHash: "hash-a" },
      requestPayloadHash: "hash-a",
    });
    assert.deepEqual(decision, { kind: "REPLAY_SUCCESS" });
  },
);

check(
  "decideCompleteUndoAction: 既存の冪等記録があり異なるpayloadならREJECT_REUSED" +
    "(currentlyCompletedに関わらず拒否する。新設計ではpayloadにreceiptId以外の" +
    "可変フィールドが無いため実質到達しない防御的分岐だが、関数自体の正しさは" +
    "変わらず検証する)",
  () => {
    const decision = decideCompleteUndoAction({
      currentlyCompleted: false,
      existingConsumption: { requestPayloadHash: "hash-a" },
      requestPayloadHash: "hash-b",
    });
    assert.deepEqual(decision, { kind: "REJECT_REUSED" });
  },
);

check("IdempotencyKeyReusedErrorはErrorのサブクラスであり、message経由でapiErrorへ変換できる", () => {
  const err = new IdempotencyKeyReusedError("同一の取消対象に対して内容の異なる取消要求が送信されました");
  assert.ok(err instanceof Error);
  const res = apiError("IDEMPOTENCY_KEY_REUSED", err.message);
  assert.equal(res.status, 409);
});

check("InvalidUndoSnapshotErrorはErrorのサブクラスであり、message経由でapiErrorへVALIDATION_FAILEDとして変換できる", () => {
  const err = new InvalidUndoSnapshotError("receiptIdに一致するUndo Receiptが見つかりません");
  assert.ok(err instanceof Error);
  const res = apiError("VALIDATION_FAILED", err.message);
  assert.equal(res.status, 400);
});

check(
  "dedupeSnapshotById【外部監査P1-3是正・新設計でも維持】: id重複を先勝ちで除去し、" +
    "restored件数の水増しを防ぐ",
  () => {
    const input: { id: string; receiptId: string }[] = [
      { id: "a", receiptId: "r1" },
      { id: "b", receiptId: "r2" },
      { id: "a", receiptId: "r3" }, // 重複(2件目)
    ];
    const result = dedupeSnapshotById(input);
    assert.equal(result.length, 2);
    assert.deepEqual(result.map((r) => r.id).sort(), ["a", "b"]);
    assert.equal(result.find((r) => r.id === "a")?.receiptId, "r1", "先勝ち(最初の値)を採用する");
  },
);

check(
  "executeUndo(COMPLETE)がExecution Ledger(REOPEN語彙)へ接続できるのは共通状態型のみ" +
    "(COMMITMENT/WAITING/RISK等の種別固有型はExecution Ledger対象外のため、" +
    "レシートのfromStatusへの直接復元のみが行われる。新設計ではこの判定自体は" +
    "変わらないが、復元先の値(fromStatus)は常にサーバー保存の真の値であり、" +
    "クライアントが改ざんする余地は無くなった)",
  () => {
    assert.equal(isExecutionLedgerApplicableType("TASK"), true);
    assert.equal(isExecutionLedgerApplicableType("EVENT"), true);
    assert.equal(isExecutionLedgerApplicableType("CONCERN"), true);
    assert.equal(isExecutionLedgerApplicableType("HABIT"), true);
    assert.equal(isExecutionLedgerApplicableType("IDEA"), true);
    assert.equal(isExecutionLedgerApplicableType("COMMITMENT"), false);
    assert.equal(isExecutionLedgerApplicableType("DECISION"), false);
    assert.equal(isExecutionLedgerApplicableType("WAITING"), false);
    assert.equal(isExecutionLedgerApplicableType("RISK"), false);
  },
);

check(
  "completeToStatusForType/completeFromStatusesForType/isValidStatusForTypeは" +
    "bulkComplete本体の遷移ルール確定(どのtoStatusへ進むか、どのfromStatusを" +
    "許可するか)に引き続き使われる(Undo自体の検証には使わなくなったが、" +
    "bulkComplete側の責務としては変わらず必要)",
  () => {
    assert.equal(completeToStatusForType("TASK"), "COMPLETED");
    assert.equal(completeToStatusForType("COMMITMENT"), "FULFILLED");
    assert.equal(completeToStatusForType("WAITING"), "RESOLVED");
    assert.equal(completeToStatusForType("RISK"), "CLOSED");
    assert.deepEqual([...completeFromStatusesForType("COMMITMENT")].sort(), ["ACTIVE", "AT_RISK"].sort());
    assert.equal(isValidStatusForType("COMMITMENT", "BROKEN"), true);
  },
);

console.log(`\n${passed}件すべて成功`);
