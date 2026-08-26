/**
 * PEM Phase0S/0A Completion Gate 2.1 不変条件テスト。
 * 実行: npx tsx src/lib/pem/__tests__/completionGate2_1Invariants.test.ts
 * (npm run test:pem-completion-gate-2-1)
 *
 * 出典: ISMAY_PEMサブシステム_統合正本仕様書_v4_0 5.5節(idempotency response
 * contract)・8.1節(Correction)、ISMAY_PEM_v3_3_1整合性修正_用語コード定義書_v1_0 8章。
 *
 * completionGate1Invariants.test.tsと同じ方針で、db依存の関数
 * (executeUndo/resetForNextCycle本体等)は実DB統合検証(omega-dev2の実Postgres、
 * 別途実施)に委ね、ここではdb非依存の語彙・型・純粋関数のみ検証する。
 * ただし[外部監査対応・2026-08-25]、Undoの冪等判定分岐(decideCompleteUndoAction)は
 * DBアクセスから完全に分離した純粋関数として実装したため、ここで分岐網羅を検証できる
 * (「同一冪等キーの再送で重複Eventが生成されない」「異なるpayloadで同一キーを
 * 再利用するとIDEMPOTENCY_KEY_REUSED」の"判断ロジック"はここで検証済み。
 * 実際にDB上でEventが重複作成されないこと自体は、実PostgreSQLに対する実API
 * 呼び出しでの確認が別途必要)。
 *
 * [2026-08-25是正] 純粋関数はbulkOperations.ts経由ではなく、db.tsに依存しない
 * bulkCompleteUndoDecision.tsから直接importする。bulkOperations.tsはdb.tsを
 * importしており、db.tsはモジュール読込時にDATABASE_URLが無いとthrowするため、
 * bulkOperations.ts経由でimportするとこのテストがdb非依存でなくなってしまう
 * (executionLedgerMapping.tsと同じ設計原則。実際にこの分離をしていなかった版で
 * DATABASE_URL未設定環境でのテストクラッシュを引き起こした)。
 */
import assert from "node:assert/strict";
import { apiError } from "@/lib/auth/response";
import { CORRECTION_TYPES, LIFECYCLE_EVENT_KINDS } from "@/lib/pem/coreTypes";
import { isExecutionLedgerApplicableType } from "@/lib/pem/eventDefinitionRegistry";
import { isValidStatusForType, completeFromStatusesForType } from "@/lib/responsibility";
import {
  buildCompleteUndoIdempotencyKey,
  buildCompleteUndoRequestPayloadHash,
  decideCompleteUndoAction,
  decideCompleteUndoNextStatus,
  dedupeSnapshotById,
  isCompleteEventStale,
  validateSnapshotStatuses,
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

check("buildCompleteUndoIdempotencyKeyは責任IDと取消対象EventIDから決定論的なキーを生成する", () => {
  const key1 = buildCompleteUndoIdempotencyKey("resp-1", "event-1");
  const key2 = buildCompleteUndoIdempotencyKey("resp-1", "event-1");
  const key3 = buildCompleteUndoIdempotencyKey("resp-1", "event-2");
  assert.equal(key1, key2, "同一入力からは同一キーが決定論的に生成される(冪等性の基盤)");
  assert.notEqual(key1, key3, "取消対象Eventが異なれば別キーになる");
  assert.equal(key1, "resp-1:UNDO_COMPLETE:event-1");
});

check(
  "buildCompleteUndoRequestPayloadHashはcompletedAtの差分も検出する" +
    "(外部監査P0-2是正: 当初snapshotStatusのみをhash対象としており、" +
    "completedAtだけが異なる別内容のUndo要求を同一payloadと誤判定していた)",
  () => {
    const hashA = buildCompleteUndoRequestPayloadHash({
      responsibilityId: "resp-1",
      snapshotStatus: "IN_PROGRESS",
      snapshotCompletedAt: "2026-08-01T00:00:00.000Z",
      snapshotCompleteEventId: "event-1",
    });
    const hashB = buildCompleteUndoRequestPayloadHash({
      responsibilityId: "resp-1",
      snapshotStatus: "IN_PROGRESS",
      snapshotCompletedAt: "2026-08-02T00:00:00.000Z",
      snapshotCompleteEventId: "event-1",
    });
    const hashA2 = buildCompleteUndoRequestPayloadHash({
      responsibilityId: "resp-1",
      snapshotStatus: "IN_PROGRESS",
      snapshotCompletedAt: "2026-08-01T00:00:00.000Z",
      snapshotCompleteEventId: "event-1",
    });
    assert.notEqual(hashA, hashB, "completedAtが異なれば別hashになる");
    assert.equal(hashA, hashA2, "同一入力からは同一hashが決定論的に生成される");
  },
);

check(
  "buildCompleteUndoRequestPayloadHash【外部監査再評価対応】: completeEventIdの差分も" +
    "検出する(status/completedAtが同じでも取消対象Eventが異なれば別hashになる必要がある)",
  () => {
    const hashA = buildCompleteUndoRequestPayloadHash({
      responsibilityId: "resp-1",
      snapshotStatus: "COMPLETED",
      snapshotCompletedAt: null,
      snapshotCompleteEventId: "event-1",
    });
    const hashB = buildCompleteUndoRequestPayloadHash({
      responsibilityId: "resp-1",
      snapshotStatus: "COMPLETED",
      snapshotCompletedAt: null,
      snapshotCompleteEventId: "event-2",
    });
    assert.notEqual(hashA, hashB, "completeEventIdが異なれば別hashになる");
  },
);

check(
  "decideCompleteUndoAction: 既存Lifecycle Eventが無く、現在statusがCOMPLETEDならAPPLY" +
    "(初回Undo要求)",
  () => {
    const decision = decideCompleteUndoAction({
      currentStatus: "COMPLETED",
      existingLifecycleEvent: null,
      requestPayloadHash: "hash-a",
    });
    assert.deepEqual(decision, { kind: "APPLY" });
  },
);

check(
  "decideCompleteUndoAction: 既存Lifecycle Eventが無く、現在statusがCOMPLETED以外なら" +
    "SKIP_NOT_COMPLETED",
  () => {
    const decision = decideCompleteUndoAction({
      currentStatus: "IN_PROGRESS",
      existingLifecycleEvent: null,
      requestPayloadHash: "hash-a",
    });
    assert.deepEqual(decision, { kind: "SKIP_NOT_COMPLETED" });
  },
);

check(
  "decideCompleteUndoAction【外部監査P0-1是正の核心】: 既存Lifecycle Eventがあり" +
    "同一payloadなら、現在statusが(初回Undoで既に変わっている)COMPLETED以外でも" +
    "REPLAY_SUCCESSを返す(status判定より前にLifecycle Event確認を行うことで、" +
    "『同一key・同一payloadの再送は元の成功応答を返す』というv4.0 5.5節の要件を満たす。" +
    "是正前はここでSKIP_NOT_COMPLETED相当となりrestored:0を返す不具合があった)",
  () => {
    const decision = decideCompleteUndoAction({
      currentStatus: "PLANNED", // 初回UndoでCOMPLETED→PLANNEDへ既に変わった後
      existingLifecycleEvent: { requestPayloadHash: "hash-a" },
      requestPayloadHash: "hash-a",
    });
    assert.deepEqual(decision, { kind: "REPLAY_SUCCESS" });
  },
);

check(
  "decideCompleteUndoAction: 既存Lifecycle Eventがあり異なるpayloadならREJECT_REUSED" +
    "(currentStatusに関わらず拒否する)",
  () => {
    const decision = decideCompleteUndoAction({
      currentStatus: "PLANNED",
      existingLifecycleEvent: { requestPayloadHash: "hash-a" },
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

check(
  "executeUndo(COMPLETE)がExecution Ledger(REOPEN語彙)へ接続できるのは共通状態型のみ" +
    "(COMMITMENT/WAITING/RISK等の種別固有型はExecution Ledger対象外のため、" +
    "スナップショットstatusへの直接復元のみが行われ、Lifecycle Eventも記録されない。" +
    "外部監査P1: 「いずれの場合も必ず記録する」という当初のコメントは誤りであり、" +
    "訂正対象の元Eventを特定できた場合のみ記録される、とbulkOperations.tsのコメントを" +
    "訂正した)",
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
  "dedupeSnapshotById【外部監査P1-3是正】: id重複を先勝ちで除去し、restored件数の" +
    "水増しを防ぐ",
  () => {
    const input: { id: string; v: number }[] = [
      { id: "a", v: 1 },
      { id: "b", v: 2 },
      { id: "a", v: 3 }, // 重複(2件目)
    ];
    const result = dedupeSnapshotById(input);
    assert.equal(result.length, 2);
    assert.deepEqual(result.map((r) => r.id).sort(), ["a", "b"]);
    assert.equal(result.find((r) => r.id === "a")?.v, 1, "先勝ち(最初の値)を採用する");
  },
);

check(
  "validateSnapshotStatuses【外部監査P1-5是正、Gate阻害2是正で強化】: " +
    "完了操作の遷移元として許可されているstatusのみ通過させる。単純なenum検査では" +
    "なく、completeFromStatusesForTypeで検証する",
  () => {
    const typeById = new Map([["resp-1", "COMMITMENT"]]);
    // ACTIVE/AT_RISKはCOMMITMENT/FULFILLの遷移元として正しい。
    assert.doesNotThrow(() =>
      validateSnapshotStatuses([{ id: "resp-1", status: "ACTIVE", completedAt: null }], typeById),
    );
    assert.doesNotThrow(() =>
      validateSnapshotStatuses([{ id: "resp-1", status: "AT_RISK", completedAt: null }], typeById),
    );
    // IN_PROGRESSはCOMMITMENTに存在しない値そのものなので不正。
    assert.throws(
      () => validateSnapshotStatuses([{ id: "resp-1", status: "IN_PROGRESS", completedAt: null }], typeById),
      InvalidUndoSnapshotError,
    );
  },
);

check(
  "validateSnapshotStatuses【外部監査再評価Gate阻害2是正の核心】: BROKENはCOMMITMENTの" +
    "有効な状態値だが、FULFILL(完了操作)の遷移元としては不正なため拒否される" +
    "(単純なenum検査(isValidStatusForType)だけでは通過してしまっていた不具合の是正。" +
    "外部監査で指摘: 「FULFILLED→BROKENのような不正な復元が可能」)",
  () => {
    const typeById = new Map([["resp-1", "COMMITMENT"]]);
    assert.equal(isValidStatusForType("COMMITMENT", "BROKEN"), true, "BROKEN自体はCOMMITMENTの有効な値");
    assert.equal(
      completeFromStatusesForType("COMMITMENT").includes("BROKEN"),
      false,
      "しかしFULFILLの遷移元としては定義されていない",
    );
    assert.throws(
      () => validateSnapshotStatuses([{ id: "resp-1", status: "BROKEN", completedAt: null }], typeById),
      InvalidUndoSnapshotError,
    );
  },
);

check(
  "validateSnapshotStatuses: completedAtがnullでない場合はInvalidUndoSnapshotErrorで拒否する" +
    "(完了操作の遷移元=未完了状態へ復元するのに完了日時が設定されているのは矛盾するため)",
  () => {
    const typeById = new Map([["resp-1", "COMMITMENT"]]);
    assert.throws(
      () =>
        validateSnapshotStatuses(
          [{ id: "resp-1", status: "ACTIVE", completedAt: "2026-08-01T00:00:00.000Z" }],
          typeById,
        ),
      InvalidUndoSnapshotError,
    );
  },
);

check(
  "decideCompleteUndoNextStatus【外部監査再評価・Gate阻害是正の回帰防止】: " +
    "Execution Ledger対象型では、クライアントが何を送ってきても常にPLANNEDに" +
    "固定される(completeEventId省略時に任意statusへ直接書き込めてしまい" +
    "COMPLETED→REOPEN→PLANNEDの許可遷移を迂回できた問題の是正)",
  () => {
    assert.equal(
      decideCompleteUndoNextStatus({ ledgerApplicable: true, clientSnapshotStatus: "IN_PROGRESS" }),
      "PLANNED",
      "クライアントがIN_PROGRESSを送ってきてもPLANNEDに固定される",
    );
    assert.equal(
      decideCompleteUndoNextStatus({ ledgerApplicable: true, clientSnapshotStatus: "ANYTHING_MALICIOUS" }),
      "PLANNED",
      "不正な値を送ってきてもPLANNEDに固定される(ledgerApplicableな限りclientSnapshotStatusは無視される)",
    );
    assert.equal(
      decideCompleteUndoNextStatus({ ledgerApplicable: false, clientSnapshotStatus: "ACTIVE" }),
      "ACTIVE",
      "Execution Ledger対象外型(COMMITMENT等)は従来通りクライアント供給値を使う",
    );
  },
);

check("isValidStatusForType【外部監査P1-5是正】: 共通状態型と種別固有型それぞれで" +
    "定義済みの値のみ有効と判定する(用語・状態・コード定義書v1.1 3章)",
  () => {
    assert.equal(isValidStatusForType("TASK", "IN_PROGRESS"), true);
    assert.equal(isValidStatusForType("TASK", "ACTIVE"), false, "ACTIVEはCOMMITMENT用でTASKには無い");
    assert.equal(isValidStatusForType("COMMITMENT", "ACTIVE"), true);
    assert.equal(isValidStatusForType("COMMITMENT", "IN_PROGRESS"), false, "IN_PROGRESSは共通状態型用でCOMMITMENTには無い");
    assert.equal(isValidStatusForType("COMMITMENT", "not_a_real_status"), false);
  },
);

check(
  "isCompleteEventStale【実行時に発見した不具合の回帰防止】: 一致すればfalse、" +
    "不一致ならtrueを返す(この判定はdecideCompleteUndoActionがAPPLYと判定した" +
    "場合にのみ使うこと。冪等再送(REPLAY_SUCCESS/REJECT_REUSED)の判定より前に" +
    "version不一致で弾くと、正しく機能していた冪等判定に到達できず、同一payload" +
    "再送や混在バッチでのREJECT_REUSED検出が壊れることを実際にomega-dev2での" +
    "実行で確認した)",
  () => {
    assert.equal(
      isCompleteEventStale({ responsibilityVersionAfter: 3, currentVersion: 3 }),
      false,
      "一致すればfalse(新規適用してよい)",
    );
    assert.equal(
      isCompleteEventStale({ responsibilityVersionAfter: 3, currentVersion: 4 }),
      true,
      "不一致ならtrue(このEventは既に古い状態を指しているため拒否すべき)",
    );
  },
);

console.log(`\n${passed}件すべて成功`);
