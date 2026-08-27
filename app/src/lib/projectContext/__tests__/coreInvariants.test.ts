/**
 * V5-M1-A1 Project Context Domain基盤 不変条件テスト。
 * 出典: Claude向け次期実装指示_M1-A1 2.4節。db.ts を import しない
 * (db非依存tsx runnerで検証できるようにするため。既存 lib/pem/__tests__ と同じ方針)。
 *
 * 実行: npx tsx src/lib/projectContext/__tests__/coreInvariants.test.ts
 *       (npm run test:project-context)
 */
import assert from "node:assert/strict";
import {
  PROJECT_CONTEXT_LIFECYCLE_STATES,
  PROJECT_CONTEXT_LIFECYCLE_TRANSITIONS,
  PROJECT_CONTEXT_LINK_ROLES,
  VISIBILITIES,
  PROJECT_CONTEXT_LINK_SOURCE_KINDS,
  isValidProjectContextLifecycleState,
  isValidProjectContextLifecycleTransition,
  isValidProjectContextLinkRole,
  isValidVisibility,
  isValidProjectContextLinkSourceKind,
  hasConflictingActivePrimaryLink,
  hasConflictingActiveLinkForSamePair,
} from "@/lib/projectContext/coreTypes";

let passed = 0;
function check(name: string, fn: () => void): void {
  fn();
  passed++;
  console.log(`  ok - ${name}`);
}

console.log("V5-M1-A1 Project Context Domain基盤 不変条件テスト");

check("lifecycle状態は4値ちょうど(ACTIVE/PAUSED/COMPLETED/ARCHIVED)", () => {
  assert.deepEqual(
    [...PROJECT_CONTEXT_LIFECYCLE_STATES].sort(),
    ["ACTIVE", "ARCHIVED", "COMPLETED", "PAUSED"],
  );
});

check("lifecycle遷移はDOC-04 3章の表と一致する(7遷移)", () => {
  assert.equal(PROJECT_CONTEXT_LIFECYCLE_TRANSITIONS.length, 7);
  assert.ok(isValidProjectContextLifecycleTransition("ACTIVE", "PAUSED"));
  assert.ok(isValidProjectContextLifecycleTransition("PAUSED", "ACTIVE"));
  assert.ok(isValidProjectContextLifecycleTransition("ACTIVE", "COMPLETED"));
  assert.ok(isValidProjectContextLifecycleTransition("PAUSED", "COMPLETED"));
  assert.ok(isValidProjectContextLifecycleTransition("ACTIVE", "ARCHIVED"));
  assert.ok(isValidProjectContextLifecycleTransition("PAUSED", "ARCHIVED"));
  assert.ok(isValidProjectContextLifecycleTransition("COMPLETED", "ARCHIVED"));
});

check("未許可のlifecycle遷移は拒否される(ARCHIVEDは終端)", () => {
  assert.equal(isValidProjectContextLifecycleTransition("ARCHIVED", "ACTIVE"), false);
  assert.equal(isValidProjectContextLifecycleTransition("COMPLETED", "ACTIVE"), false);
  assert.equal(isValidProjectContextLifecycleTransition("COMPLETED", "PAUSED"), false);
  assert.equal(isValidProjectContextLifecycleTransition("ACTIVE", "ACTIVE"), false);
});

check("未知のlifecycle値は無効", () => {
  assert.equal(isValidProjectContextLifecycleState("IN_PROGRESS"), false);
  assert.equal(isValidProjectContextLifecycleState("ACTIVE"), true);
});

check("Link roleは3値ちょうど(PRIMARY/SUPPORTING/REFERENCE)", () => {
  assert.deepEqual(
    [...PROJECT_CONTEXT_LINK_ROLES].sort(),
    ["PRIMARY", "REFERENCE", "SUPPORTING"],
  );
  assert.ok(isValidProjectContextLinkRole("PRIMARY"));
  assert.equal(isValidProjectContextLinkRole("SECONDARY"), false);
});

check("Visibilityは4値ちょうど(PRIVATE/CONTEXT/WORKSPACE/EXPLICIT)", () => {
  assert.deepEqual([...VISIBILITIES].sort(), ["CONTEXT", "EXPLICIT", "PRIVATE", "WORKSPACE"]);
  assert.ok(isValidVisibility("PRIVATE"));
  assert.equal(isValidVisibility("PUBLIC"), false);
});

check("Link sourceKindは既存Responsibility.sourceKindの語彙を再利用する", () => {
  assert.deepEqual(
    [...PROJECT_CONTEXT_LINK_SOURCE_KINDS].sort(),
    ["AI", "IMPORT", "SYSTEM", "USER"],
  );
  assert.ok(isValidProjectContextLinkSourceKind("AI"));
});

check("同一Responsibilityへの2件目のactive PRIMARYはapplication層で検出される", () => {
  const existing = [
    { role: "PRIMARY", unlinkedAt: null, responsibilityId: "resp-1" },
  ];
  assert.equal(hasConflictingActivePrimaryLink(existing, "resp-1"), true);
  assert.equal(hasConflictingActivePrimaryLink(existing, "resp-2"), false);
});

check("unlink済み(unlinkedAtが非null)のPRIMARYは競合と判定しない", () => {
  const existing = [
    { role: "PRIMARY", unlinkedAt: new Date(), responsibilityId: "resp-1" },
  ];
  assert.equal(hasConflictingActivePrimaryLink(existing, "resp-1"), false);
});

check("SUPPORTING/REFERENCEはactive PRIMARY判定に影響しない", () => {
  const existing = [
    { role: "SUPPORTING", unlinkedAt: null, responsibilityId: "resp-1" },
    { role: "REFERENCE", unlinkedAt: null, responsibilityId: "resp-1" },
  ];
  assert.equal(hasConflictingActivePrimaryLink(existing, "resp-1"), false);
});

check("同一(Context,Responsibility)組はrole問わずactive linkが1件までに制限される", () => {
  const existing = [
    { role: "SUPPORTING", unlinkedAt: null, responsibilityId: "resp-1" },
  ];
  assert.equal(hasConflictingActiveLinkForSamePair(existing, "resp-1"), true);
  assert.equal(hasConflictingActiveLinkForSamePair(existing, "resp-2"), false);
});

console.log(`\n${passed}件成功`);
