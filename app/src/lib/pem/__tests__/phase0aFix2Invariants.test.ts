/**
 * PEM Phase 0A是正2(Ledger schema v4.0必須列・tenant複合制約) 不変条件テスト。
 * 実行: npx tsx src/lib/pem/__tests__/phase0aFix2Invariants.test.ts
 * (npm run test:pem-phase0a-fix2)
 *
 * db依存の実際の列追加・制約はサンドボックス実DBでの検証(別途実施済み)に委ね、
 * ここではschema.prismaの記述そのものが期待通りかを静的に検査する
 * (db非依存に保ち、tsx単体実行できるようにするため)。
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));

let passed = 0;
function check(name: string, fn: () => void): void {
  fn();
  passed++;
  console.log(`  ok - ${name}`);
}

console.log("PEM Phase 0A是正2 不変条件テスト");

const schemaSrc = readFileSync(resolve(__dirname, "../../../../prisma/schema.prisma"), "utf-8");

check("ResponsibilityExecutionEventがv4.0 5.3節の必須列(requestId等)を持つ", () => {
  for (const field of [
    "requestId",
    "requestPayloadHash",
    "globalSequence",
    "actorServiceId",
    "actorAgentId",
    "delegatedByUserId",
    "authenticationContextId",
    "sourceDeviceId",
    "clientEventId",
    "clientSequence",
    "clockOffsetSeconds",
    "clockOffsetMeasuredAt",
  ]) {
    assert.ok(schemaSrc.includes(field), `${field} 列が見つからない`);
  }
});

check("workspaceIdを含む複合uniqueへ変更されている(tenant境界の二重防御)", () => {
  assert.ok(
    schemaSrc.includes('@@unique([workspaceId, responsibilityId, responsibilitySequence], map: "ree_workspace_responsibility_sequence_uq")'),
    "workspaceId込みの複合uniqueが見つからない",
  );
  assert.ok(
    !schemaSrc.includes("@@unique([responsibilityId, responsibilitySequence])"),
    "workspaceId無しの旧unique制約が残っている",
  );
});

check("Responsibilityへ複合unique(id, workspaceId)が追加され、Eventが複合FK参照している", () => {
  assert.ok(schemaSrc.includes("@@unique([id, workspaceId])"));
  assert.ok(
    schemaSrc.includes(
      "@relation(fields: [responsibilityId, workspaceId], references: [id, workspaceId])",
    ),
  );
});

check("metadataがJson(必須)へ変更されている", () => {
  assert.ok(schemaSrc.includes('metadata                      Json     @default("{}")'));
});

console.log(`\n${passed}件すべて成功`);
